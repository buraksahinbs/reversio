/**
 * Replay verification: prove that a spec and its generated SDK reproduce
 * recorded traffic.
 *
 * For every recorded API call reversio finds the matching operation, rebuilds
 * the SDK call's arguments from the recorded request, and runs the generated
 * client against a fake `fetch` that answers with the recorded response. A
 * call passes when the SDK sends the same request (method, URL, query, body),
 * returns the recorded result, and the recorded payloads satisfy the spec's
 * schemas. No network traffic is made.
 *
 * Verifying a spec against a capture it was not generated from is how drift
 * shows up: new endpoints, parameters, fields or status codes.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { Exchange } from "./har.js";
import type { JsonSchema } from "./schema.js";
import type { Spec, SpecOperation, SpecParameter } from "./spec.js";
import { generateTypeScriptSdk, pathArgName, sdkMethodName } from "./sdk/typescript.js";

export interface OperationReport {
  operationId: string;
  method: string;
  path: string;
  samples: number;
  passed: number;
  /** Distinct failure reasons, most frequent first. */
  failures: { reason: string; count: number }[];
}

export interface VerifyReport {
  total: number;
  passed: number;
  operations: OperationReport[];
  /** Recorded API calls that no operation in the spec matches. */
  unmatched: { method: string; url: string }[];
}

type SdkClient = Record<string, (args?: unknown, init?: RequestInit) => Promise<unknown>>;
type SdkModule = { ApiClient: new (options: Record<string, unknown>) => SdkClient };

interface CapturedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: string | null;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function segments(path: string): string[] {
  return path.split("/").filter(Boolean).map(safeDecode);
}

/** Find the operation for an exchange. Literal segments win over parameters (`/users/me` over `/users/{id}`). */
export function matchOperation(
  spec: Spec,
  ex: Exchange,
): { op: SpecOperation; pathValues: Record<string, string> } | undefined {
  const actual = segments(ex.url.pathname);
  let best: { op: SpecOperation; pathValues: Record<string, string>; literals: number } | undefined;

  for (const op of spec.operations) {
    if (op.method !== ex.method) continue;
    if (op.server && new URL(op.server).origin !== ex.url.origin) continue;
    const template = op.path.split("/").filter(Boolean);
    if (template.length !== actual.length) continue;

    const pathValues: Record<string, string> = {};
    let literals = 0;
    const matches = template.every((part, i) => {
      const param = /^\{([^}]+)\}$/.exec(part);
      if (param) {
        pathValues[param[1]!] = actual[i]!;
        return true;
      }
      literals++;
      return safeDecode(part) === actual[i];
    });
    if (matches && (!best || literals > best.literals)) best = { op, pathValues, literals };
  }
  return best && { op: best.op, pathValues: best.pathValues };
}

function schemaTypes(schema: JsonSchema): string[] {
  if (Array.isArray(schema.anyOf)) return (schema.anyOf as JsonSchema[]).flatMap(schemaTypes);
  if (Array.isArray(schema.type)) return schema.type as string[];
  return typeof schema.type === "string" ? [schema.type] : [];
}

/** Convert a raw string to the value the SDK caller would pass, guided by the schema. */
function coerceToSchema(raw: string, schema: JsonSchema): unknown {
  const types = schemaTypes(schema);
  if ((types.includes("integer") || types.includes("number")) && raw.trim() !== "" && Number.isFinite(Number(raw))) {
    // Only when the number prints back identically, so the SDK sends the same text.
    if (String(Number(raw)) === raw) return Number(raw);
  }
  if (types.includes("boolean") && (raw === "true" || raw === "false")) return raw === "true";
  return raw;
}

function queryArgs(params: SpecParameter[], url: URL): Record<string, unknown> | undefined {
  const query: Record<string, unknown> = {};
  for (const p of params) {
    const values = url.searchParams.getAll(p.name);
    if (values.length === 0) continue;
    const isArray = schemaTypes(p.schema).includes("array");
    const itemSchema = isArray ? ((p.schema.items as JsonSchema | undefined) ?? {}) : p.schema;
    const coerced = values.map((v) => coerceToSchema(v, itemSchema));
    query[p.name] = isArray || coerced.length > 1 ? coerced : coerced[0];
  }
  return Object.keys(query).length > 0 ? query : undefined;
}

function queryMultiset(url: URL): string[] {
  return [...url.searchParams].map(([k, v]) => `${k}=${v}`).sort();
}

function describeQueryDiff(sent: URL, recorded: URL): string {
  const a = queryMultiset(sent);
  const b = queryMultiset(recorded);
  const missing = b.filter((x) => !a.includes(x)).map((x) => x.split("=")[0]);
  const extra = a.filter((x) => !b.includes(x)).map((x) => x.split("=")[0]);
  const parts: string[] = [];
  if (missing.length) parts.push(`not sent: ${[...new Set(missing)].join(", ")}`);
  if (extra.length) parts.push(`unexpected: ${[...new Set(extra)].join(", ")}`);
  return `query differs (${parts.join("; ")})`;
}

function decodeSentBody(captured: CapturedRequest): unknown {
  if (captured.body === null) return undefined;
  const type = captured.headers.get("content-type") ?? "";
  if (type.startsWith("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(captured.body));
  try {
    return JSON.parse(captured.body);
  } catch {
    return captured.body;
  }
}

function recordedResponse(ex: Exchange): Response {
  const nullBody = ex.status === 204 || ex.status === 205 || ex.status === 304;
  const body = nullBody || ex.responseBody === undefined ? null : JSON.stringify(ex.responseBody);
  const headers = new Headers();
  if (body !== null) headers.set("content-type", ex.responseContentType ?? "application/json");
  return new Response(body, { status: ex.status, headers });
}

/** Load generated TypeScript as an ES module via Node's type stripping. */
async function loadSdk(source: string): Promise<SdkModule> {
  const emit = process.emitWarning;
  // stripTypeScriptTypes is stable in practice but flagged experimental; keep CLI output clean.
  process.emitWarning = (() => {}) as typeof process.emitWarning;
  let js: string;
  try {
    js = stripTypeScriptTypes(source);
  } finally {
    process.emitWarning = emit;
  }
  const dir = await mkdtemp(join(tmpdir(), "reversio-sdk-"));
  try {
    const file = join(dir, "client.mjs");
    await writeFile(file, js);
    return (await import(pathToFileURL(file).href)) as SdkModule;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function formatAjvErrors(errors: { instancePath: string; message?: string }[] | null | undefined): string {
  const first = errors?.[0];
  return first ? `${first.instancePath || "(root)"} ${first.message ?? "is invalid"}` : "is invalid";
}

/**
 * Verify recorded exchanges (already filtered to API calls) against a spec and
 * its generated TypeScript SDK.
 */
export async function verifyReplay(spec: Spec, exchanges: Exchange[], sdkSource?: string): Promise<VerifyReport> {
  const sdk = await loadSdk(sdkSource ?? generateTypeScriptSdk(spec));
  const ajv = new Ajv2020({ allErrors: false, strict: false });
  addFormats.default(ajv);
  const validators = new Map<JsonSchema, ReturnType<typeof ajv.compile>>();
  const validate = (schema: JsonSchema, value: unknown): string | undefined => {
    let fn = validators.get(schema);
    if (!fn) {
      fn = ajv.compile(schema);
      validators.set(schema, fn);
    }
    return fn(value) ? undefined : formatAjvErrors(fn.errors);
  };

  const reports = new Map<SpecOperation, { samples: number; passed: number; failures: Map<string, number> }>();
  for (const op of spec.operations) reports.set(op, { samples: 0, passed: 0, failures: new Map() });
  const unmatched: VerifyReport["unmatched"] = [];

  for (const ex of exchanges) {
    if (ex.status < 200 || ex.status > 599) continue;
    const match = matchOperation(spec, ex);
    if (!match) {
      unmatched.push({ method: ex.method, url: `${ex.url.origin}${ex.url.pathname}` });
      continue;
    }
    const { op, pathValues } = match;
    const report = reports.get(op)!;
    report.samples++;
    const problems = await replayOne(sdk, op, pathValues, ex, validate);
    if (problems.length === 0) report.passed++;
    for (const p of problems) report.failures.set(p, (report.failures.get(p) ?? 0) + 1);
  }

  const operations: OperationReport[] = spec.operations.map((op) => {
    const r = reports.get(op)!;
    return {
      operationId: op.operationId,
      method: op.method,
      path: op.path,
      samples: r.samples,
      passed: r.passed,
      failures: [...r.failures].sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count })),
    };
  });
  return {
    total: operations.reduce((n, o) => n + o.samples, 0),
    passed: operations.reduce((n, o) => n + o.passed, 0),
    operations,
    unmatched,
  };
}

async function replayOne(
  sdk: SdkModule,
  op: SpecOperation,
  pathValues: Record<string, string>,
  ex: Exchange,
  validate: (schema: JsonSchema, value: unknown) => string | undefined,
): Promise<string[]> {
  const problems: string[] = [];

  const args: Record<string, unknown> = {};
  for (const p of op.pathParams) args[pathArgName(p.name)] = coerceToSchema(pathValues[p.name] ?? "", p.schema);
  const query = queryArgs(op.queryParams, ex.url);
  if (query) args.query = query;
  if (ex.requestBody !== undefined) args.body = ex.requestBody;
  else if (op.body?.required) problems.push("recorded request has no body but the spec requires one");

  let captured: CapturedRequest | undefined;
  const fakeFetch = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    captured = {
      method: init?.method ?? "GET",
      url: new URL(input instanceof Request ? input.url : String(input)),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
    };
    return recordedResponse(ex);
  };

  // Primary-server operations may be recorded on any origin (staging, regional hosts), so the
  // client is pointed at the recorded one; path-level servers are exercised as generated.
  const client = new sdk.ApiClient({ fetch: fakeFetch, ...(!op.server && { baseUrl: ex.url.origin }) });
  const method = client[sdkMethodName(op.operationId)];
  if (typeof method !== "function") return [`SDK has no method ${sdkMethodName(op.operationId)}`];

  let result: unknown;
  let error: unknown;
  try {
    result = await method.call(client, args);
  } catch (err) {
    error = err;
  }

  if (!captured) {
    problems.push(`SDK did not send a request (${error instanceof Error ? error.message : String(error)})`);
    return problems;
  }

  // Request fidelity.
  if (captured.method !== ex.method) problems.push(`method ${captured.method} != ${ex.method}`);
  if (captured.url.origin !== ex.url.origin) problems.push(`origin ${captured.url.origin} != ${ex.url.origin}`);
  if (!isDeepStrictEqual(segments(captured.url.pathname), segments(ex.url.pathname))) {
    problems.push(`path ${captured.url.pathname} != ${ex.url.pathname}`);
  }
  if (!isDeepStrictEqual(queryMultiset(captured.url), queryMultiset(ex.url))) {
    problems.push(describeQueryDiff(captured.url, ex.url));
  }
  if (!isDeepStrictEqual(decodeSentBody(captured), ex.requestBody)) problems.push("request body differs");

  // Response handling.
  const expected = ex.status === 204 || ex.status === 205 || ex.status === 304 ? undefined : ex.responseBody;
  if (ex.status >= 200 && ex.status < 300) {
    if (error) problems.push(`SDK threw on a ${ex.status} response`);
    else if (!isDeepStrictEqual(result, expected)) problems.push("SDK result differs from recorded response");
  } else {
    const status = (error as { status?: unknown } | undefined)?.status;
    if (status !== ex.status) problems.push(`expected ApiError with status ${ex.status}`);
    else if (!isDeepStrictEqual((error as { body?: unknown }).body, expected)) problems.push("ApiError body differs");
  }

  // Schema conformance of the recorded payloads.
  const response = op.responses.find((r) => r.status === String(ex.status));
  if (!response) {
    problems.push(`status ${ex.status} not in spec`);
  } else if (response.schema && ex.responseBody !== undefined) {
    const invalid = validate(response.schema, ex.responseBody);
    if (invalid) problems.push(`response ${ex.status} schema: ${invalid}`);
  }
  if (op.body && ex.requestBody !== undefined) {
    const invalid = validate(op.body.schema, ex.requestBody);
    if (invalid) problems.push(`request body schema: ${invalid}`);
  }
  return problems;
}

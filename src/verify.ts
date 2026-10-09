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

import { spawn } from "node:child_process";
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
import { generatePythonSdk, pyMethodName } from "./sdk/python.js";
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
  language: SdkLanguage;
  total: number;
  passed: number;
  operations: OperationReport[];
  /** Recorded API calls that no operation in the spec matches. */
  unmatched: { method: string; url: string }[];
}

type SdkClient = Record<string, (args?: unknown, init?: RequestInit) => Promise<unknown>>;
type SdkModule = { ApiClient: new (options: Record<string, unknown>) => SdkClient };

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

/** Path prefix of a server URL (`https://x.com/api/v2` → ["api", "v2"]). Relative URLs are allowed. */
function serverPrefix(server: string | undefined): string[] {
  if (!server) return [];
  try {
    return segments(new URL(server, "http://localhost").pathname);
  } catch {
    return [];
  }
}

/** Find the operation for an exchange. Literal segments win over parameters (`/users/me` over `/users/{id}`). */
export function matchOperation(
  spec: Spec,
  ex: Exchange,
): { op: SpecOperation; pathValues: Record<string, string> } | undefined {
  const fullPath = segments(ex.url.pathname);
  let best: { op: SpecOperation; pathValues: Record<string, string>; literals: number } | undefined;

  for (const op of spec.operations) {
    if (op.method !== ex.method) continue;
    if (op.server && /^https?:/i.test(op.server) && new URL(op.server).origin !== ex.url.origin) continue;
    // Templates are relative to the server URL, which may carry a base path.
    const prefix = serverPrefix(op.server ?? spec.servers[0]);
    if (!prefix.every((seg, i) => fullPath[i] === seg)) continue;
    const actual = fullPath.slice(prefix.length);
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

function decodeSentBody(request: ExecutedRequest): unknown {
  if (request.body === null) return undefined;
  if ((request.contentType ?? "").startsWith("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(request.body));
  }
  try {
    return JSON.parse(request.body);
  } catch {
    return request.body;
  }
}

function formatAjvErrors(errors: { instancePath: string; message?: string }[] | null | undefined): string {
  const first = errors?.[0];
  return first ? `${first.instancePath || "(root)"} ${first.message ?? "is invalid"}` : "is invalid";
}

export type SdkLanguage = "typescript" | "python";

export interface VerifyOptions {
  /** SDK language to replay through. Default: typescript. */
  language?: SdkLanguage;
  /** Use this SDK source instead of generating one from the spec. */
  sdkSource?: string;
  /** Python interpreter for language "python". Default: $REVERSIO_PYTHON or python3. */
  python?: string;
}

/** A recorded call turned into language-neutral SDK arguments and a canned response. */
export interface ReplayCase {
  op: SpecOperation;
  ex: Exchange;
  /** Base URL to construct the client with, for operations on the primary server. */
  baseUrl?: string;
  /** Path parameter values in declaration order. */
  pathArgs: { name: string; value: unknown }[];
  query?: Record<string, unknown>;
  body?: unknown;
  response: { status: number; contentType: string | null; body: string | null };
}

interface ExecutedRequest {
  method: string;
  url: string;
  contentType: string | null;
  body: string | null;
}

/** What happened when an SDK ran one replay case. */
export interface Execution {
  request?: ExecutedRequest;
  result?: unknown;
  error?: { status?: number; body?: unknown; message: string };
}

function buildCase(spec: Spec, op: SpecOperation, pathValues: Record<string, string>, ex: Exchange): ReplayCase {
  const nullBody = ex.status === 204 || ex.status === 205 || ex.status === 304;
  const body = nullBody || ex.responseBody === undefined ? null : JSON.stringify(ex.responseBody);
  const replay: ReplayCase = {
    op,
    ex,
    pathArgs: op.pathParams.map((p) => ({ name: p.name, value: coerceToSchema(pathValues[p.name] ?? "", p.schema) })),
    response: { status: ex.status, contentType: body === null ? null : (ex.responseContentType ?? "application/json"), body },
  };
  // Primary-server operations may be recorded on any origin (staging, regional hosts), so the
  // client is pointed at the recorded one; path-level servers are exercised as generated.
  if (!op.server) {
    const prefix = serverPrefix(spec.servers[0]).map(encodeURIComponent).join("/");
    replay.baseUrl = prefix ? `${ex.url.origin}/${prefix}` : ex.url.origin;
  }
  const query = queryArgs(op.queryParams, ex.url);
  if (query) replay.query = query;
  if (ex.requestBody !== undefined) replay.body = ex.requestBody;
  return replay;
}

/** Load generated TypeScript as an ES module via Node's type stripping. */
async function loadTypeScriptSdk(source: string): Promise<SdkModule> {
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

async function runTypeScript(source: string, cases: ReplayCase[]): Promise<Execution[]> {
  const sdk = await loadTypeScriptSdk(source);
  const executions: Execution[] = [];
  for (const c of cases) {
    const execution: Execution = {};
    const fakeFetch = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      execution.request = {
        method: init?.method ?? "GET",
        url: input instanceof Request ? input.url : String(input),
        contentType: headers.get("content-type"),
        body: typeof init?.body === "string" ? init.body : null,
      };
      const responseHeaders = new Headers();
      if (c.response.contentType) responseHeaders.set("content-type", c.response.contentType);
      return new Response(c.response.body, { status: c.response.status, headers: responseHeaders });
    };

    const client = new sdk.ApiClient({ fetch: fakeFetch, ...(c.baseUrl !== undefined && { baseUrl: c.baseUrl }) });
    const name = sdkMethodName(c.op.operationId);
    const method = client[name];
    if (typeof method !== "function") {
      executions.push({ error: { message: `SDK has no method ${name}` } });
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const p of c.pathArgs) args[pathArgName(p.name)] = p.value;
    if (c.query) args.query = c.query;
    if ("body" in c) args.body = c.body;
    try {
      execution.result = await method.call(client, args);
    } catch (err) {
      const e = err as { status?: unknown; body?: unknown; message?: unknown };
      execution.error = {
        ...(typeof e.status === "number" && { status: e.status, body: e.body }),
        message: err instanceof Error ? err.message : String(err),
      };
    }
    executions.push(execution);
  }
  return executions;
}

const PYTHON_RUNNER = String.raw`
import importlib.util, json, sys

spec = importlib.util.spec_from_file_location("reversio_client", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
sys.modules["reversio_client"] = mod
spec.loader.exec_module(mod)

out = []
for case in json.load(sys.stdin):
    entry = {}
    response = case["response"]

    def transport(request, response=response, entry=entry):
        entry["request"] = {
            "method": request.method,
            "url": request.url,
            "contentType": {k.lower(): v for k, v in request.headers.items()}.get("content-type"),
            "body": None if request.body is None else request.body.decode("utf-8"),
        }
        headers = {"content-type": response["contentType"]} if response["contentType"] else {}
        return mod.HttpResponse(response["status"], headers, (response["body"] or "").encode("utf-8"))

    kwargs = {"transport": transport}
    if case.get("baseUrl") is not None:
        kwargs["base_url"] = case["baseUrl"]
    client = mod.ApiClient(**kwargs)
    method = getattr(client, case["method"], None)
    if method is None:
        entry["error"] = {"message": "SDK has no method " + case["method"]}
    else:
        call_kwargs = {}
        if "query" in case:
            call_kwargs["query"] = case["query"]
        if "body" in case:
            call_kwargs["body"] = case["body"]
        try:
            entry["result"] = method(*case["pathArgs"], **call_kwargs)
        except mod.ApiError as err:
            entry["error"] = {"status": err.status, "body": err.body, "message": str(err)}
        except Exception as err:
            entry["error"] = {"message": type(err).__name__ + ": " + str(err)}
    out.append(entry)

json.dump(out, sys.stdout)
`;

async function runPython(source: string, cases: ReplayCase[], python: string): Promise<Execution[]> {
  const dir = await mkdtemp(join(tmpdir(), "reversio-py-"));
  try {
    const client = join(dir, "client.py");
    const runner = join(dir, "runner.py");
    await writeFile(client, source);
    await writeFile(runner, PYTHON_RUNNER);
    const input = JSON.stringify(
      cases.map((c) => ({
        method: pyMethodName(c.op.operationId),
        pathArgs: c.pathArgs.map((p) => p.value),
        ...(c.baseUrl !== undefined && { baseUrl: c.baseUrl }),
        ...(c.query && { query: c.query }),
        ...("body" in c && { body: c.body }),
        response: c.response,
      })),
    );
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(python, ["-I", runner, client], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
      child.on("error", (e: NodeJS.ErrnoException) =>
        reject(new Error(e.code === "ENOENT" ? `Python interpreter not found: ${python} (set REVERSIO_PYTHON)` : e.message)),
      );
      child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`Python SDK failed to run:\n${err.trim()}`))));
      child.stdin.end(input);
    });
    const executions = JSON.parse(stdout) as Execution[];
    // Python has one "no value" (None) for both an empty body and JSON null.
    return executions.map((e) => (e.result === null ? { ...e, result: undefined } : e));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function compare(c: ReplayCase, execution: Execution, validate: (schema: JsonSchema, value: unknown) => string | undefined): string[] {
  const { op, ex } = c;
  const problems: string[] = [];
  if (ex.requestBody === undefined && op.body?.required) problems.push("recorded request has no body but the spec requires one");

  const request = execution.request;
  if (!request) {
    problems.push(`SDK did not send a request (${execution.error?.message ?? "no error"})`);
    return problems;
  }

  // Request fidelity.
  const sent = new URL(request.url);
  if (request.method !== ex.method) problems.push(`method ${request.method} != ${ex.method}`);
  if (sent.origin !== ex.url.origin) problems.push(`origin ${sent.origin} != ${ex.url.origin}`);
  if (!isDeepStrictEqual(segments(sent.pathname), segments(ex.url.pathname))) {
    problems.push(`path ${sent.pathname} != ${ex.url.pathname}`);
  }
  if (!isDeepStrictEqual(queryMultiset(sent), queryMultiset(ex.url))) problems.push(describeQueryDiff(sent, ex.url));
  if (!isDeepStrictEqual(decodeSentBody(request), ex.requestBody)) problems.push("request body differs");

  // Response handling.
  const expected = c.response.body === null ? undefined : ex.responseBody;
  const error = execution.error;
  if (ex.status >= 200 && ex.status < 300) {
    if (error) problems.push(`SDK threw on a ${ex.status} response`);
    else if (!isDeepStrictEqual(execution.result, expected)) problems.push("SDK result differs from recorded response");
  } else if (error?.status !== ex.status) {
    problems.push(`expected ApiError with status ${ex.status}`);
  } else if (!isDeepStrictEqual(error.body ?? undefined, expected)) {
    problems.push("ApiError body differs");
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

/**
 * Verify recorded exchanges (already filtered to API calls) against a spec and
 * its generated SDK.
 */
export async function verifyReplay(spec: Spec, exchanges: Exchange[], options: VerifyOptions = {}): Promise<VerifyReport> {
  const language = options.language ?? "typescript";
  const cases: ReplayCase[] = [];
  const unmatched: VerifyReport["unmatched"] = [];
  for (const ex of exchanges) {
    if (ex.status < 200 || ex.status > 599) continue;
    const match = matchOperation(spec, ex);
    if (match) cases.push(buildCase(spec, match.op, match.pathValues, ex));
    else unmatched.push({ method: ex.method, url: `${ex.url.origin}${ex.url.pathname}` });
  }

  const executions =
    language === "python"
      ? await runPython(
          options.sdkSource ?? generatePythonSdk(spec),
          cases,
          options.python ?? process.env.REVERSIO_PYTHON ?? "python3",
        )
      : await runTypeScript(options.sdkSource ?? generateTypeScriptSdk(spec), cases);

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
  cases.forEach((c, i) => {
    const report = reports.get(c.op)!;
    report.samples++;
    const problems = compare(c, executions[i] ?? {}, validate);
    if (problems.length === 0) report.passed++;
    for (const p of problems) report.failures.set(p, (report.failures.get(p) ?? 0) + 1);
  });

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
    language,
    total: operations.reduce((n, o) => n + o.samples, 0),
    passed: operations.reduce((n, o) => n + o.passed, 0),
    operations,
    unmatched,
  };
}

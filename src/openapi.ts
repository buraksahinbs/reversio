/**
 * Build an OpenAPI 3.1 document from observed API exchanges.
 */

import { STATUS_CODES } from "node:http";
import type { Exchange } from "./har.js";
import { extractParamValues, templatePaths, type PathTemplate } from "./paths.js";
import { inferNode, toJsonSchema, type JsonSchema, type RenderOptions } from "./schema.js";

export type OpenApiDocument = Record<string, unknown>;

export interface BuildOptions extends RenderOptions {
  title?: string;
  version?: string;
}

interface Operation {
  method: string;
  origin: string;
  template: PathTemplate;
  exchanges: { ex: Exchange; rawPath: string }[];
}

interface SecurityScheme {
  key: string;
  scheme: JsonSchema;
}

const HTTP_METHODS = new Set(["GET", "PUT", "POST", "DELETE", "PATCH", "OPTIONS", "HEAD", "TRACE"]);
const API_KEY_HEADER = /^(?:x-)?(?:api[-_]?key|auth[-_]?token|access[-_]?token|x-token)$/i;
const SESSION_COOKIE = /sess|auth|token|sid|jwt/i;

/** Turn a query-string or path value into the most specific JSON value. */
function coerce(value: string): unknown {
  if (/^-?(?:0|[1-9]\d{0,15})$/.test(value)) return Number(value);
  if (/^-?\d+\.\d+$/.test(value)) return Number(value);
  if (value === "true" || value === "false") return value === "true";
  return value;
}

function pascal(word: string): string {
  return word
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

function operationId(method: string, template: PathTemplate): string {
  const parts = template.template.split("/").filter(Boolean);
  const literals = parts.filter((p) => !p.startsWith("{") && !/^v\d+$/i.test(p) && p.toLowerCase() !== "api");
  let id = method.toLowerCase() + literals.map((p) => pascal(decodeURIComponent(p))).join("");
  if (parts.at(-1)?.startsWith("{")) id += "ById";
  return id;
}

function tagFor(template: PathTemplate): string | undefined {
  return template.template
    .split("/")
    .filter(Boolean)
    .find((p) => !p.startsWith("{") && !/^v\d+$/i.test(p) && !["api", "rest", "rpc"].includes(p.toLowerCase()));
}

function detectSecurity(ex: Exchange): SecurityScheme[] {
  const found: SecurityScheme[] = [];
  const auth = ex.requestHeaders["authorization"];
  if (auth) {
    const scheme = auth.split(" ")[0]?.toLowerCase();
    if (scheme === "bearer") found.push({ key: "bearerAuth", scheme: { type: "http", scheme: "bearer" } });
    else if (scheme === "basic") found.push({ key: "basicAuth", scheme: { type: "http", scheme: "basic" } });
    else found.push({ key: "authorizationHeader", scheme: { type: "apiKey", in: "header", name: "Authorization" } });
  }
  for (const name of Object.keys(ex.requestHeaders)) {
    if (API_KEY_HEADER.test(name)) {
      found.push({ key: `${pascal(name).replace(/^./, (c) => c.toLowerCase())}`, scheme: { type: "apiKey", in: "header", name } });
    }
  }
  const cookie = ex.requestHeaders["cookie"];
  if (cookie) {
    for (const pair of cookie.split(";")) {
      const name = pair.split("=")[0]?.trim();
      if (name && SESSION_COOKIE.test(name)) {
        found.push({ key: `cookie${pascal(name)}`, scheme: { type: "apiKey", in: "cookie", name } });
      }
    }
  }
  return found;
}

function responseDescription(status: string): string {
  return STATUS_CODES[Number(status)] ?? "Response";
}

/** Group exchanges into operations keyed by path template and method. */
function groupOperations(exchanges: Exchange[]): Operation[] {
  const byOrigin = new Map<string, Exchange[]>();
  for (const ex of exchanges) {
    if (!HTTP_METHODS.has(ex.method)) continue;
    byOrigin.set(ex.url.origin, [...(byOrigin.get(ex.url.origin) ?? []), ex]);
  }

  const operations = new Map<string, Operation>();
  for (const [origin, list] of byOrigin) {
    const templates = templatePaths(list.map((ex) => ex.url.pathname));
    for (const ex of list) {
      const rawPath = ex.url.pathname;
      const template = templates.get(rawPath)!;
      // The same template on two origins (e.g. api. and api-eu.) is one operation.
      const key = `${ex.method} ${template.template}`;
      const op = operations.get(key) ?? { method: ex.method, origin, template, exchanges: [] };
      op.exchanges.push({ ex, rawPath });
      operations.set(key, op);
    }
  }
  return [...operations.values()];
}

function buildParameters(op: Operation, options: RenderOptions): JsonSchema[] {
  const params: JsonSchema[] = [];
  for (const p of op.template.params) {
    const values = op.exchanges.map(({ rawPath }) => coerce(extractParamValues(rawPath, op.template)[p.name] ?? ""));
    params.push({ name: p.name, in: "path", required: true, schema: toJsonSchema(inferNode(values), options) });
  }

  const queryValues = new Map<string, unknown[]>();
  for (const { ex } of op.exchanges) {
    for (const name of new Set(ex.url.searchParams.keys())) {
      const all = ex.url.searchParams.getAll(name).map(coerce);
      queryValues.set(name, [...(queryValues.get(name) ?? []), all.length > 1 ? all : all[0]]);
    }
  }
  for (const [name, values] of [...queryValues].sort(([a], [b]) => a.localeCompare(b))) {
    params.push({
      name,
      in: "query",
      required: values.length === op.exchanges.length,
      schema: toJsonSchema(inferNode(values), options),
    });
  }
  return params;
}

function buildOperation(op: Operation, usedIds: Set<string>, options: RenderOptions, security: Map<string, JsonSchema>): JsonSchema {
  let id = operationId(op.method, op.template);
  for (let n = 2; usedIds.has(id); n++) id = `${operationId(op.method, op.template)}${n}`;
  usedIds.add(id);

  const operation: JsonSchema = { operationId: id };
  const tag = tagFor(op.template);
  if (tag) operation.tags = [decodeURIComponent(tag)];

  const parameters = buildParameters(op, options);
  if (parameters.length > 0) operation.parameters = parameters;

  // Request bodies, grouped by media type.
  const bodies = new Map<string, unknown[]>();
  for (const { ex } of op.exchanges) {
    if (ex.requestBody === undefined) continue;
    const type = ex.requestContentType ?? "application/json";
    bodies.set(type, [...(bodies.get(type) ?? []), ex.requestBody]);
  }
  if (bodies.size > 0) {
    const withBody = [...bodies.values()].reduce((n, b) => n + b.length, 0);
    operation.requestBody = {
      required: withBody === op.exchanges.length,
      content: Object.fromEntries(
        [...bodies].map(([type, samples]) => [type, { schema: toJsonSchema(inferNode(samples), options) }]),
      ),
    };
  }

  // Responses, grouped by status code then media type.
  const responses = new Map<string, { types: Map<string, unknown[]>; bare: boolean }>();
  for (const { ex } of op.exchanges) {
    const status = String(ex.status);
    const entry = responses.get(status) ?? { types: new Map(), bare: false };
    if (ex.responseBody !== undefined) {
      const type = ex.responseContentType ?? "application/json";
      entry.types.set(type, [...(entry.types.get(type) ?? []), ex.responseBody]);
    } else {
      entry.bare = true;
    }
    responses.set(status, entry);
  }
  operation.responses = Object.fromEntries(
    [...responses].sort(([a], [b]) => a.localeCompare(b)).map(([status, { types }]) => {
      const response: JsonSchema = { description: responseDescription(status) };
      if (types.size > 0) {
        response.content = Object.fromEntries(
          [...types].map(([type, samples]) => [type, { schema: toJsonSchema(inferNode(samples), options) }]),
        );
      }
      return [status, response];
    }),
  );

  // Security requirements present on every observed call.
  let common: Map<string, JsonSchema> | undefined;
  for (const { ex } of op.exchanges) {
    const found = new Map(detectSecurity(ex).map((s) => [s.key, s.scheme]));
    common = common ? new Map([...common].filter(([k]) => found.has(k))) : found;
  }
  if (common && common.size > 0) {
    operation.security = [Object.fromEntries([...common.keys()].map((k) => [k, []]))];
    for (const [k, scheme] of common) security.set(k, scheme);
  }

  operation["x-reversio-samples"] = op.exchanges.length;
  return operation;
}

/** Build an OpenAPI 3.1 document. `exchanges` should already be filtered to API calls. */
export function buildOpenApi(exchanges: Exchange[], options: BuildOptions = {}): OpenApiDocument {
  const operations = groupOperations(exchanges);

  const originCounts = new Map<string, number>();
  for (const op of operations) originCounts.set(op.origin, (originCounts.get(op.origin) ?? 0) + op.exchanges.length);
  const origins = [...originCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([o]) => o);
  const primary = origins[0];

  const paths: Record<string, JsonSchema> = {};
  const usedIds = new Set<string>();
  const security = new Map<string, JsonSchema>();
  const sorted = operations.sort(
    (a, b) =>
      a.template.template.localeCompare(b.template.template) ||
      [...HTTP_METHODS].indexOf(a.method) - [...HTTP_METHODS].indexOf(b.method),
  );
  for (const op of sorted) {
    const item = (paths[op.template.template] ??= {});
    if (op.origin !== primary && item.servers === undefined) item.servers = [{ url: op.origin }];
    const method = op.method.toLowerCase();
    item[method] = buildOperation(op, usedIds, options, security);
  }

  const doc: OpenApiDocument = {
    openapi: "3.1.0",
    info: {
      title: options.title ?? (primary ? `${new URL(primary).host} API` : "Recovered API"),
      version: options.version ?? "0.0.0-recovered",
      description: "Generated by reversio from observed traffic. Shapes reflect only what was captured.",
    },
    servers: origins.map((url) => ({ url })),
    paths,
  };
  if (security.size > 0) {
    doc.components = { securitySchemes: Object.fromEntries([...security].sort(([a], [b]) => a.localeCompare(b))) };
  }
  return doc;
}

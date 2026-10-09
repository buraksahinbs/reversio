/**
 * Generate a dependency-free, single-file TypeScript client from a spec.
 *
 * The output uses only erasable TypeScript syntax (no enums, namespaces or
 * parameter properties) so that it runs under Node's type stripping and any
 * bundler, and it relies only on the standard `fetch` API.
 */

import type { Spec, SpecOperation } from "../spec.js";
import { propertyKey, toTsType, typeName } from "./tsTypes.js";

const RESERVED_ARGS = new Set(["query", "body"]);

/** Name of the argument property that carries a path parameter. */
export function pathArgName(name: string): string {
  return RESERVED_ARGS.has(name) ? `${name}Param` : name;
}

function accessor(object: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${object}.${key}` : `${object}[${JSON.stringify(key)}]`;
}

function methodName(operationId: string): string {
  const name = typeName(operationId);
  return name.charAt(0).toLowerCase() + name.slice(1);
}

function escapeTemplateLiteral(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

function pathExpression(op: SpecOperation): string {
  const parts = op.path.split(/(\{[^}]+\})/);
  const rendered = parts.map((part) => {
    const match = /^\{([^}]+)\}$/.exec(part);
    if (!match) return escapeTemplateLiteral(part);
    return `\${encodeURIComponent(String(${accessor("args", pathArgName(match[1]!))}))}`;
  });
  return "`" + rendered.join("") + "`";
}

function successType(op: SpecOperation): string {
  const success = op.responses.filter((r) => /^2\d\d$/.test(r.status));
  if (success.length === 0) return "unknown";
  const types = success.map((r) => (r.schema ? toTsType(r.schema) : "undefined"));
  return [...new Set(types)].join(" | ");
}

function docComment(lines: string[], pad: string): string {
  return [`${pad}/**`, ...lines.map((l) => `${pad} * ${l}`), `${pad} */`].join("\n");
}

interface GeneratedOperation {
  types: string[];
  method: string;
}

function generateOperation(op: SpecOperation): GeneratedOperation {
  const base = typeName(op.operationId);
  const types: string[] = [];
  const fields: string[] = [];
  let anyRequired = false;

  for (const p of op.pathParams) {
    fields.push(`${propertyKey(pathArgName(p.name))}: ${toTsType(p.schema)};`);
    anyRequired = true;
  }
  if (op.queryParams.length > 0) {
    const queryRequired = op.queryParams.some((p) => p.required);
    const props = op.queryParams.map((p) => `  ${propertyKey(p.name)}${p.required ? "" : "?"}: ${toTsType(p.schema)};`);
    types.push(`export type ${base}Query = {\n${props.join("\n")}\n};`);
    fields.push(`query${queryRequired ? "" : "?"}: ${base}Query;`);
    anyRequired ||= queryRequired;
  }
  if (op.body) {
    types.push(`export type ${base}Body = ${toTsType(op.body.schema)};`);
    fields.push(`body${op.body.required ? "" : "?"}: ${base}Body;`);
    anyRequired ||= op.body.required;
  }
  types.push(`export type ${base}Response = ${successType(op)};`);

  const params: string[] = [];
  if (fields.length > 0) {
    types.push(`export type ${base}Args = {\n${fields.map((f) => `  ${f}`).join("\n")}\n};`);
    params.push(anyRequired ? `args: ${base}Args` : `args: ${base}Args = {}`);
  }
  params.push("init?: RequestInit");

  const request = [
    `method: ${JSON.stringify(op.method)}`,
    ...(op.server ? [`server: ${JSON.stringify(op.server)}`] : []),
    `path: ${pathExpression(op)}`,
    ...(op.queryParams.length > 0 ? ["query: args.query"] : []),
    ...(op.body ? ["body: args.body", `bodyType: ${JSON.stringify(op.body.contentType)}`] : []),
    `security: ${JSON.stringify(op.security)}`,
  ];

  const method = [
    docComment([`${op.method} ${op.path}`], "  "),
    `  async ${methodName(op.operationId)}(${params.join(", ")}): Promise<${base}Response> {`,
    `    return (await this.#request({ ${request.join(", ")} }, init)) as ${base}Response;`,
    `  }`,
  ].join("\n");

  return { types, method };
}

const RUNTIME = `
type RequestSpec = {
  method: string;
  server?: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  bodyType?: string;
  security: string[][];
};

/** Thrown for non-2xx responses. \`body\` is the parsed response body. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly response: Response;

  constructor(response: Response, body: unknown) {
    super(\`HTTP \${response.status} \${response.statusText}\`.trim());
    this.name = "ApiError";
    this.status = response.status;
    this.body = body;
    this.response = response;
  }
}

function encodeBase64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}
`;

const CLIENT_INTERNALS = `
  readonly #baseUrl: string;
  readonly #servers: Record<string, string>;
  readonly #auth: AuthCredentials;
  readonly #headers: Record<string, string>;
  readonly #fetch: typeof fetch;

  constructor(options: ClientOptions = {}) {
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.#servers = options.servers ?? {};
    this.#auth = options.auth ?? {};
    this.#headers = options.headers ?? {};
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async #request(spec: RequestSpec, init?: RequestInit): Promise<unknown> {
    const base = spec.server ? (this.#servers[spec.server] ?? spec.server) : this.#baseUrl;
    const url = new URL(base.replace(/\\/+$/, "") + spec.path);
    for (const [key, value] of Object.entries(spec.query ?? {})) {
      if (value === undefined || value === null) continue;
      for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
    }

    const headers = new Headers(this.#headers);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    if (!headers.has("accept")) headers.set("accept", "application/json");
    this.#applyAuth(spec.security, headers, url);

    let body: string | undefined;
    if (spec.body !== undefined) {
      const type = spec.bodyType ?? "application/json";
      body =
        type === "application/x-www-form-urlencoded"
          ? new URLSearchParams(
              Object.entries(spec.body as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
            ).toString()
          : JSON.stringify(spec.body);
      headers.set("content-type", type);
    }

    const response = await this.#fetch(url, { ...init, method: spec.method, headers, body: body ?? null });
    const text = await response.text();
    let data: unknown = undefined;
    if (text.length > 0) {
      try {
        data = /json/i.test(response.headers.get("content-type") ?? "") ? JSON.parse(text) : text;
      } catch {
        data = text;
      }
    }
    if (!response.ok) throw new ApiError(response, data);
    return data;
  }

  #applyAuth(requirements: string[][], headers: Headers, url: URL): void {
    // Use the first requirement the caller has credentials for, else the first one.
    const chosen =
      requirements.find((names) => names.every((n) => this.#auth[n as SchemeName] !== undefined)) ?? requirements[0] ?? [];
    for (const name of chosen) {
      const value = this.#auth[name as SchemeName];
      const scheme = SECURITY_SCHEMES[name as SchemeName] as SecurityScheme | undefined;
      if (value === undefined || !scheme) continue;
      if (scheme.type === "http" && scheme.scheme === "bearer") headers.set("authorization", \`Bearer \${value}\`);
      else if (scheme.type === "http" && scheme.scheme === "basic") headers.set("authorization", \`Basic \${encodeBase64(value)}\`);
      else if (scheme.in === "header" && scheme.name) headers.set(scheme.name, value);
      else if (scheme.in === "query" && scheme.name) url.searchParams.set(scheme.name, value);
      else if (scheme.in === "cookie" && scheme.name) {
        const cookie = headers.get("cookie");
        headers.set("cookie", (cookie ? cookie + "; " : "") + \`\${scheme.name}=\${value}\`);
      }
    }
  }
`;

export interface TypeScriptSdkOptions {
  /** Class name of the generated client. Default: ApiClient. */
  className?: string;
}

/** Generate the client source code. */
export function generateTypeScriptSdk(spec: Spec, options: TypeScriptSdkOptions = {}): string {
  const className = options.className ?? "ApiClient";
  const schemes = Object.entries(spec.securitySchemes);
  const operations = spec.operations.map(generateOperation);

  const authFields = schemes.map(([name, s]) => {
    const hint =
      s.type === "http" && s.scheme === "basic"
        ? `"username:password" for HTTP Basic auth`
        : s.type === "http"
          ? `Token for the Authorization: ${s.scheme ?? "Bearer"} header`
          : `Value for the ${s.in} "${s.name}"`;
    return `  /** ${hint}. */\n  ${propertyKey(name)}?: string;`;
  });

  const securityTable = schemes.map(([name, s]) => {
    const fields = Object.entries({ type: s.type, scheme: s.scheme, in: s.in, name: s.name })
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
    return `  ${propertyKey(name)}: { ${fields.join(", ")} },`;
  });

  return [
    `// Generated by reversio from "${spec.title.replace(/[\r\n]/g, " ")}". Do not edit by hand.`,
    `// Shapes reflect observed traffic only; fields never seen in a capture are absent.`,
    ``,
    `const DEFAULT_BASE_URL = ${JSON.stringify(spec.servers[0] ?? "http://localhost")};`,
    ``,
    `type SecurityScheme = { type: string; scheme?: string; in?: string; name?: string };`,
    `const SECURITY_SCHEMES = {\n${securityTable.join("\n")}\n} satisfies Record<string, SecurityScheme>;`,
    `type SchemeName = keyof typeof SECURITY_SCHEMES;`,
    ``,
    `export type AuthCredentials = {\n${authFields.join("\n")}\n};`,
    ``,
    `export interface ClientOptions {`,
    `  /** Base URL of the primary server. Default: ${spec.servers[0] ?? "http://localhost"} */`,
    `  baseUrl?: string;`,
    `  /** Replacement URLs for other servers, keyed by the URL in the spec. */`,
    `  servers?: Record<string, string>;`,
    `  auth?: AuthCredentials;`,
    `  /** Headers sent with every request. */`,
    `  headers?: Record<string, string>;`,
    `  /** Custom fetch implementation (for proxies, retries or tests). */`,
    `  fetch?: typeof fetch;`,
    `}`,
    RUNTIME,
    operations.flatMap((o) => o.types).join("\n\n"),
    ``,
    `export class ${className} {${CLIENT_INTERNALS}`,
    operations.map((o) => o.method).join("\n\n"),
    `}`,
    ``,
  ].join("\n");
}

/** Method name used for an operation in the generated client. */
export { methodName as sdkMethodName };

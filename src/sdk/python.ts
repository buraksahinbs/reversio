/**
 * Generate a single-file Python client (Python 3.11+, standard library only).
 *
 * Types use functional `TypedDict` syntax so that any JSON key, including
 * ones that are not Python identifiers, can be represented. Requests go
 * through a pluggable `transport`, which defaults to urllib.
 */

import type { JsonSchema } from "../schema.js";
import type { Spec, SpecOperation } from "../spec.js";
import { typeName } from "./tsTypes.js";

const PY_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del",
  "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
  "not", "or", "pass", "raise", "return", "try", "while", "with", "yield", "match", "case", "type",
  // Names used by generated methods themselves.
  "self", "query", "body",
]);

/** snake_case a name and make it a safe Python identifier. */
export function pyIdentifier(name: string): string {
  let id = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  if (id === "") id = "value";
  if (/^[0-9]/.test(id)) id = `_${id}`;
  return PY_KEYWORDS.has(id) ? `${id}_` : id;
}

/** Python method name for an operation. */
export function pyMethodName(operationId: string): string {
  return pyIdentifier(operationId);
}

/** A Python string literal (JSON string syntax is valid Python). */
function str(value: string): string {
  return JSON.stringify(value);
}

class TypeRenderer {
  readonly definitions: string[] = [];
  readonly #used = new Set<string>();

  /** Reserve a unique type name derived from `hint`. */
  uniqueName(hint: string): string {
    let name = typeName(hint);
    for (let n = 2; this.#used.has(name); n++) name = `${typeName(hint)}${n}`;
    this.#used.add(name);
    return name;
  }

  /** Render a schema to a Python type expression, emitting TypedDicts for objects. */
  render(schema: JsonSchema | undefined, hint: string): string {
    if (!schema || Object.keys(schema).length === 0) return "Any";
    if (Array.isArray(schema.anyOf)) {
      return this.#union((schema.anyOf as JsonSchema[]).map((s, i) => this.render(s, `${hint}${i + 1}`)));
    }
    if (Array.isArray(schema.enum)) {
      const values = schema.enum as unknown[];
      const literals = values.filter((v) => v !== null).map((v) => (typeof v === "string" ? str(v) : String(v)));
      const parts = literals.length > 0 ? [`Literal[${literals.join(", ")}]`] : [];
      if (values.includes(null)) parts.push("None");
      return this.#union(parts);
    }
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : schema.type ? [schema.type as string] : [];
    if (types.length === 0) return "Any";
    return this.#union(
      types.map((type) => {
        switch (type) {
          case "string":
            return "str";
          case "integer":
            return "int";
          case "number":
            return "float";
          case "boolean":
            return "bool";
          case "null":
            return "None";
          case "array":
            return `list[${this.render(schema.items as JsonSchema | undefined, `${hint}Item`)}]`;
          case "object":
            return this.#object(schema, hint);
          default:
            return "Any";
        }
      }),
    );
  }

  #object(schema: JsonSchema, hint: string): string {
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    const additional = schema.additionalProperties;
    const keys = Object.keys(properties);
    if (keys.length === 0) {
      const value = additional && typeof additional === "object" ? this.render(additional as JsonSchema, `${hint}Value`) : "Any";
      return `dict[str, ${value}]`;
    }
    const required = new Set((schema.required ?? []) as string[]);
    const fields = keys.map((key) => {
      const type = this.render(properties[key], `${hint}${typeName(key)}`);
      return `    ${str(key)}: ${required.has(key) ? type : `NotRequired[${type}]`},`;
    });
    const name = this.uniqueName(hint);
    this.definitions.push(`${name} = TypedDict(${str(name)}, {\n${fields.join("\n")}\n})`);
    return name;
  }

  #union(parts: string[]): string {
    const unique = [...new Set(parts)];
    if (unique.includes("Any")) return "Any";
    return unique.join(" | ");
  }

  /** Emit a named alias (or reuse the TypedDict name when the type already is one). */
  alias(name: string, schema: JsonSchema | undefined): string {
    const type = this.render(schema, name);
    if (type === name) return name;
    const aliasName = this.uniqueName(name);
    this.definitions.push(`${aliasName} = ${type}`);
    return aliasName;
  }
}

function pathExpression(op: SpecOperation, argNames: Map<string, string>): string {
  const parts = op.path.split(/(\{[^}]+\})/).filter((p) => p.length > 0);
  if (parts.length === 0) return str("");
  return parts
    .map((part) => {
      const match = /^\{([^}]+)\}$/.exec(part);
      return match ? `_path(${argNames.get(match[1]!) ?? pyIdentifier(match[1]!)})` : str(part);
    })
    .join(" + ");
}

function generateOperation(op: SpecOperation, types: TypeRenderer): string {
  const base = typeName(op.operationId);
  const params = ["self"];
  const argNames = new Map<string, string>();
  for (const p of op.pathParams) {
    let name = pyIdentifier(p.name);
    while ([...argNames.values()].includes(name)) name = `${name}_`;
    argNames.set(p.name, name);
    params.push(`${name}: ${types.render(p.schema, `${base}${typeName(p.name)}`)}`);
  }

  const keywordOnly: string[] = [];
  if (op.queryParams.length > 0) {
    const fields = op.queryParams.map((p) => {
      const type = types.render(p.schema, `${base}Query${typeName(p.name)}`);
      return `    ${str(p.name)}: ${p.required ? type : `NotRequired[${type}]`},`;
    });
    const queryType = types.uniqueName(`${base}Query`);
    types.definitions.push(`${queryType} = TypedDict(${str(queryType)}, {\n${fields.join("\n")}\n})`);
    const required = op.queryParams.some((p) => p.required);
    keywordOnly.push(required ? `query: ${queryType}` : `query: ${queryType} | None = None`);
  }
  if (op.body) {
    const bodyType = types.alias(`${base}Body`, op.body.schema);
    keywordOnly.push(op.body.required ? `body: ${bodyType}` : `body: ${bodyType} | None = None`);
  }
  // Required keyword-only arguments must come before optional ones for readability (Python allows any order).
  keywordOnly.sort((a, b) => Number(a.includes("=")) - Number(b.includes("=")));
  if (keywordOnly.length > 0) params.push("*", ...keywordOnly);

  const success = op.responses.filter((r) => /^2\d\d$/.test(r.status));
  let responseType = "Any";
  if (success.length > 0) {
    const withBody = success.filter((r) => r.schema);
    const parts = withBody.length > 0 ? [types.alias(`${base}Response`, withBody[0]!.schema)] : [];
    if (success.some((r) => !r.schema)) parts.push("None");
    responseType = parts.join(" | ");
  }

  const call = [
    str(op.method),
    op.server ? str(op.server) : "None",
    pathExpression(op, argNames),
    op.queryParams.length > 0 ? "query" : "None",
    op.body ? "body" : "None",
    op.body ? str(op.body.contentType) : "None",
    JSON.stringify(op.security),
  ];

  return [
    `    def ${pyMethodName(op.operationId)}(${params.join(", ")}) -> ${responseType}:`,
    `        """${op.method} ${op.path.replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"')}"""`,
    `        return cast(${str(responseType)}, self._request(${call.join(", ")}))`,
  ].join("\n");
}

const RUNTIME = `
@dataclass
class HttpRequest:
    method: str
    url: str
    headers: dict[str, str]
    body: bytes | None


@dataclass
class HttpResponse:
    status: int
    headers: dict[str, str]
    """Lower-cased header names."""
    body: bytes


Transport = Callable[[HttpRequest], HttpResponse]


class ApiError(Exception):
    """Raised for non-2xx responses. \`body\` is the parsed response body."""

    def __init__(self, response: HttpResponse, body: Any) -> None:
        super().__init__(f"HTTP {response.status}")
        self.status = response.status
        self.body = body
        self.response = response


def urllib_transport(timeout: float = 30.0) -> Transport:
    """Default transport built on urllib from the standard library."""

    def send(request: HttpRequest) -> HttpResponse:
        req = urllib.request.Request(request.url, data=request.body, method=request.method, headers=request.headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return HttpResponse(resp.status, {k.lower(): v for k, v in resp.headers.items()}, resp.read())
        except urllib.error.HTTPError as err:
            return HttpResponse(err.code, {k.lower(): v for k, v in err.headers.items()}, err.read())

    return send


def _format(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _path(value: Any) -> str:
    return urllib.parse.quote(_format(value), safe="")
`;

const CLIENT_INTERNALS = `
    def __init__(
        self,
        base_url: str | None = None,
        *,
        auth: AuthCredentials | None = None,
        headers: dict[str, str] | None = None,
        servers: dict[str, str] | None = None,
        transport: Transport | None = None,
    ) -> None:
        """
        base_url: primary server URL (default DEFAULT_BASE_URL).
        auth: credentials keyed by security scheme name.
        headers: headers sent with every request.
        servers: replacement URLs for other servers, keyed by the URL in the spec.
        transport: custom HTTP transport (for proxies, retries or tests).
        """
        self._base_url = base_url or DEFAULT_BASE_URL
        self._auth: dict[str, str] = {k: v for k, v in (auth or {}).items() if isinstance(v, str)}
        self._headers = {k.lower(): v for k, v in (headers or {}).items()}
        self._servers = servers or {}
        self._transport = transport or urllib_transport()

    def _request(
        self,
        method: str,
        server: str | None,
        path: str,
        query: Mapping[str, Any] | None,
        body: Any,
        body_type: str | None,
        security: list[list[str]],
    ) -> Any:
        base = self._servers.get(server, server) if server else self._base_url
        url = base.rstrip("/") + path
        pairs: list[tuple[str, str]] = []
        for key, value in (query or {}).items():
            if value is None:
                continue
            for item in value if isinstance(value, list) else [value]:
                pairs.append((key, _format(item)))

        headers = {"accept": "application/json", **self._headers}
        self._apply_auth(security, headers, pairs)
        if pairs:
            url += "?" + urllib.parse.urlencode(pairs)

        data: bytes | None = None
        if body is not None:
            content_type = body_type or "application/json"
            if content_type == "application/x-www-form-urlencoded":
                data = urllib.parse.urlencode({k: _format(v) for k, v in body.items()}).encode()
            else:
                data = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode()
            headers["content-type"] = content_type

        response = self._transport(HttpRequest(method, url, headers, data))
        text = response.body.decode("utf-8", errors="replace")
        parsed: Any = None
        if text:
            try:
                parsed = json.loads(text) if "json" in response.headers.get("content-type", "").lower() else text
            except ValueError:
                parsed = text
        if not 200 <= response.status < 300:
            raise ApiError(response, parsed)
        return parsed

    def _apply_auth(self, requirements: list[list[str]], headers: dict[str, str], pairs: list[tuple[str, str]]) -> None:
        # Use the first requirement the caller has credentials for, else the first one.
        chosen = next((r for r in requirements if all(n in self._auth for n in r)), requirements[0] if requirements else [])
        for name in chosen:
            value = self._auth.get(name)
            scheme = SECURITY_SCHEMES.get(name)
            if value is None or scheme is None:
                continue
            kind, location, key = scheme.get("type"), scheme.get("in"), scheme.get("name")
            if kind == "http" and scheme.get("scheme") == "bearer":
                headers["authorization"] = f"Bearer {value}"
            elif kind == "http" and scheme.get("scheme") == "basic":
                headers["authorization"] = "Basic " + base64.b64encode(value.encode()).decode()
            elif location == "header" and key:
                headers[key.lower()] = value
            elif location == "query" and key:
                pairs.append((key, value))
            elif location == "cookie" and key:
                cookie = headers.get("cookie")
                headers["cookie"] = (cookie + "; " if cookie else "") + f"{key}={value}"
`;

export interface PythonSdkOptions {
  /** Class name of the generated client. Default: ApiClient. */
  className?: string;
}

/** Generate the Python client source code. */
export function generatePythonSdk(spec: Spec, options: PythonSdkOptions = {}): string {
  const className = options.className ?? "ApiClient";
  const types = new TypeRenderer();
  const methods = spec.operations.map((op) => generateOperation(op, types));

  const schemes = Object.entries(spec.securitySchemes).map(([name, s]) => {
    const fields = Object.entries({ type: s.type, scheme: s.scheme, in: s.in, name: s.name })
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${str(k)}: ${str(String(v))}`);
    return `    ${str(name)}: {${fields.join(", ")}},`;
  });
  const authFields = Object.keys(spec.securitySchemes).map((name) => `    ${str(name)}: str,`);

  return [
    `# Generated by reversio from ${str(spec.title.replace(/[\r\n]/g, " "))}. Do not edit by hand.`,
    `# Shapes reflect observed traffic only; fields never seen in a capture are absent.`,
    `# Requires Python 3.11+ and only the standard library.`,
    `from __future__ import annotations`,
    ``,
    `import base64`,
    `import json`,
    `import urllib.error`,
    `import urllib.parse`,
    `import urllib.request`,
    `from collections.abc import Callable, Mapping`,
    `from dataclasses import dataclass`,
    `from typing import Any, Literal, NotRequired, TypedDict, cast`,
    ``,
    `DEFAULT_BASE_URL = ${str(spec.servers[0] ?? "http://localhost")}`,
    ``,
    `SECURITY_SCHEMES: dict[str, dict[str, str]] = {\n${schemes.join("\n")}\n}`,
    ``,
    `AuthCredentials = TypedDict("AuthCredentials", {\n${authFields.join("\n")}\n}, total=False)`,
    RUNTIME,
    ``,
    types.definitions.join("\n\n"),
    ``,
    ``,
    `class ${className}:${CLIENT_INTERNALS}`,
    methods.join("\n\n"),
    ``,
    `__all__ = ["${className}", "ApiError", "AuthCredentials", "HttpRequest", "HttpResponse", "Transport", "urllib_transport"]`,
    ``,
  ].join("\n");
}

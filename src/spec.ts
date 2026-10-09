/**
 * A flat, validated view of an OpenAPI 3.x document: the parts the SDK
 * generator and the replay verifier need.
 */

import { parse as parseYaml } from "yaml";
import type { JsonSchema } from "./schema.js";

export interface SpecParameter {
  name: string;
  required: boolean;
  schema: JsonSchema;
}

export interface SpecBody {
  required: boolean;
  contentType: string;
  schema: JsonSchema;
}

export interface SpecResponse {
  status: string;
  contentType?: string;
  schema?: JsonSchema;
}

export interface SpecOperation {
  operationId: string;
  method: string;
  path: string;
  /** Path-level server override, if any. */
  server?: string;
  pathParams: SpecParameter[];
  queryParams: SpecParameter[];
  body?: SpecBody;
  responses: SpecResponse[];
  /** Alternative security requirements; each entry lists scheme names that apply together. */
  security: string[][];
}

export interface SecuritySchemeSpec {
  type: string;
  scheme?: string;
  in?: string;
  name?: string;
}

export interface Spec {
  title: string;
  servers: string[];
  operations: SpecOperation[];
  securitySchemes: Record<string, SecuritySchemeSpec>;
}

export class SpecError extends Error {
  override name = "SpecError";
}

const METHODS = ["get", "put", "post", "delete", "patch", "options", "head", "trace"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** Parse JSON or YAML OpenAPI text. */
export function parseSpecText(text: string): Record<string, unknown> {
  let doc: unknown;
  try {
    doc = text.trimStart().startsWith("{") ? JSON.parse(text) : parseYaml(text);
  } catch (err) {
    throw new SpecError(`Cannot parse spec: ${(err as Error).message}`);
  }
  if (!isRecord(doc) || typeof doc.openapi !== "string" || !doc.openapi.startsWith("3.")) {
    throw new SpecError("Not an OpenAPI 3.x document");
  }
  return doc;
}

function fallbackOperationId(method: string, path: string): string {
  const words = path.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return method + words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

/** Build the flat spec model. `$ref`s are not resolved: reversio's own output has none. */
export function readSpec(doc: Record<string, unknown>): Spec {
  const servers = (Array.isArray(doc.servers) ? doc.servers : [])
    .map((s) => asRecord(s).url)
    .filter((u): u is string => typeof u === "string");
  const components = asRecord(doc.components);
  const securitySchemes = asRecord(components.securitySchemes) as Record<string, SecuritySchemeSpec>;
  const globalSecurity = Array.isArray(doc.security) ? doc.security : [];

  const operations: SpecOperation[] = [];
  const usedIds = new Set<string>();
  for (const [path, rawItem] of Object.entries(asRecord(doc.paths))) {
    const item = asRecord(rawItem);
    const pathServer = Array.isArray(item.servers) ? asRecord(item.servers[0]).url : undefined;
    const sharedParams = Array.isArray(item.parameters) ? item.parameters : [];

    for (const method of METHODS) {
      if (!isRecord(item[method])) continue;
      const op = item[method] as Record<string, unknown>;

      const baseId = typeof op.operationId === "string" ? op.operationId : fallbackOperationId(method, path);
      let operationId = baseId;
      for (let n = 2; usedIds.has(operationId); n++) operationId = `${baseId}${n}`;
      usedIds.add(operationId);

      const params = [...sharedParams, ...(Array.isArray(op.parameters) ? op.parameters : [])].map(asRecord);
      const toParam = (p: Record<string, unknown>): SpecParameter => ({
        name: String(p.name),
        required: p.in === "path" || p.required === true,
        schema: asRecord(p.schema),
      });

      let body: SpecBody | undefined;
      const requestBody = asRecord(op.requestBody);
      const bodyContent = Object.entries(asRecord(requestBody.content));
      if (bodyContent.length > 0) {
        const [contentType, media] = bodyContent[0]!;
        body = { required: requestBody.required === true, contentType, schema: asRecord(asRecord(media).schema) };
      }

      const responses: SpecResponse[] = Object.entries(asRecord(op.responses)).map(([status, raw]) => {
        const content = Object.entries(asRecord(asRecord(raw).content));
        if (content.length === 0) return { status };
        const [contentType, media] = content[0]!;
        return { status, contentType, schema: asRecord(asRecord(media).schema) };
      });

      const security = (Array.isArray(op.security) ? op.security : globalSecurity).map((req) => Object.keys(asRecord(req)));

      operations.push({
        operationId,
        method: method.toUpperCase(),
        path,
        ...(typeof pathServer === "string" && { server: pathServer }),
        pathParams: params.filter((p) => p.in === "path").map(toParam),
        queryParams: params.filter((p) => p.in === "query").map(toParam),
        ...(body && { body }),
        responses,
        security,
      });
    }
  }

  const info = asRecord(doc.info);
  return {
    title: typeof info.title === "string" ? info.title : "API",
    servers,
    operations,
    securitySchemes,
  };
}

/** Load and flatten a spec from JSON or YAML text. */
export function loadSpec(text: string): Spec {
  return readSpec(parseSpecText(text));
}

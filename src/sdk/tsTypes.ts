/**
 * Render JSON Schema (as produced by reversio's inference) to TypeScript types.
 */

import type { JsonSchema } from "../schema.js";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Quote an object key unless it is a valid identifier. */
export function propertyKey(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

/** PascalCase an operationId or other name into a type name. */
export function typeName(name: string): string {
  const pascal = name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
  return /^[0-9]/.test(pascal) ? `T${pascal}` : pascal || "Anonymous";
}

function indent(text: string, by: string): string {
  return text.replace(/\n/g, `\n${by}`);
}

function scalar(type: string): string {
  switch (type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    default:
      return "unknown";
  }
}

function union(members: string[]): string {
  const unique = [...new Set(members)];
  if (unique.includes("unknown")) return "unknown";
  return unique.length === 0 ? "never" : unique.join(" | ");
}

function objectType(schema: JsonSchema): string {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((schema.required ?? []) as string[]);
  const additional = schema.additionalProperties as JsonSchema | boolean | undefined;
  const keys = Object.keys(properties);

  if (keys.length === 0) {
    if (additional && typeof additional === "object") return `Record<string, ${toTsType(additional)}>`;
    return "Record<string, unknown>";
  }
  const lines = keys.map((key) => {
    const optional = required.has(key) ? "" : "?";
    return `  ${propertyKey(key)}${optional}: ${indent(toTsType(properties[key]!), "  ")};`;
  });
  const body = `{\n${lines.join("\n")}\n}`;
  if (additional && typeof additional === "object") return `${body} & Record<string, ${toTsType(additional)}>`;
  return body;
}

/** Convert a JSON Schema to a TypeScript type expression. */
export function toTsType(schema: JsonSchema | undefined): string {
  if (!schema || Object.keys(schema).length === 0) return "unknown";

  if (Array.isArray(schema.anyOf)) return union((schema.anyOf as JsonSchema[]).map(toTsType));
  if (Array.isArray(schema.enum)) {
    return union((schema.enum as unknown[]).map((v) => (v === null ? "null" : JSON.stringify(v))));
  }

  const types = Array.isArray(schema.type) ? (schema.type as string[]) : schema.type ? [schema.type as string] : [];
  if (types.length === 0) return "unknown";
  return union(
    types.map((type) => {
      if (type === "object") return objectType(schema);
      if (type === "array") return `Array<${toTsType(schema.items as JsonSchema | undefined)}>`;
      return scalar(type);
    }),
  );
}

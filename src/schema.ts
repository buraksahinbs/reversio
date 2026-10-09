/**
 * JSON Schema inference from observed sample values.
 *
 * Samples are folded into a statistics tree (`SchemaNode`) and then rendered
 * as JSON Schema 2020-12, which OpenAPI 3.1 uses natively. Merging many
 * samples is what makes the output useful: a field present in every sample is
 * required, a field that is sometimes null is nullable, and a short set of
 * recurring strings becomes an enum.
 */

import { isIdLike } from "./paths.js";

export type JsonSchema = Record<string, unknown>;

type JsonType = "null" | "boolean" | "integer" | "number" | "string" | "object" | "array";

const STRING_FORMATS: [string, RegExp][] = [
  ["date-time", /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/],
  ["date", /^\d{4}-\d{2}-\d{2}$/],
  ["uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i],
  ["email", /^[^\s@]+@[^\s@]+\.[^\s@]+$/],
  ["uri", /^https?:\/\/\S+$/],
];

const MAX_DEPTH = 32;
const MAX_TRACKED_VALUES = 50;
const ENUM_MAX_VALUES = 8;
const ENUM_MIN_SAMPLES = 4;
const MAP_MIN_KEYS = 3;
/**
 * Enum values must look like codes (`active`, `in-progress`, `IN_PROGRESS`).
 * Free text such as names or titles is data, and listing it would leak it.
 */
const ENUM_CODE = /^(?:[a-z][a-z0-9]*(?:[_.:-][a-z0-9]+)*|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)$/;

export interface SchemaNode {
  /** Number of samples folded into this node. */
  count: number;
  types: Map<JsonType, number>;
  stringValues: Set<string>;
  stringOverflow: boolean;
  stringFormats: Map<string, number>;
  stringCount: number;
  example?: unknown;
  /** Objects with fixed keys. */
  objectCount: number;
  properties: Map<string, SchemaNode>;
  /** Objects whose keys are identifiers (maps), merged into one value node. */
  mapCount: number;
  mapValues?: SchemaNode;
  items?: SchemaNode;
}

export function emptyNode(): SchemaNode {
  return {
    count: 0,
    types: new Map(),
    stringValues: new Set(),
    stringOverflow: false,
    stringFormats: new Map(),
    stringCount: 0,
    objectCount: 0,
    properties: new Map(),
    mapCount: 0,
  };
}

function typeOf(value: unknown): JsonType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "boolean":
      return "boolean";
    case "number":
      return Number.isInteger(value) ? "integer" : "number";
    case "string":
      return "string";
    default:
      return "object";
  }
}

function bump<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Fold one sample value into a node (mutates and returns it). */
export function addSample(node: SchemaNode, value: unknown, depth = 0): SchemaNode {
  node.count++;
  const type = typeOf(value);
  bump(node.types, type);
  if (depth >= MAX_DEPTH) return node;

  switch (type) {
    case "string": {
      const s = value as string;
      node.stringCount++;
      if (node.example === undefined) node.example = s;
      if (!node.stringOverflow) {
        node.stringValues.add(s);
        if (node.stringValues.size > MAX_TRACKED_VALUES) {
          node.stringOverflow = true;
          node.stringValues.clear();
        }
      }
      for (const [format, re] of STRING_FORMATS) {
        if (re.test(s)) {
          bump(node.stringFormats, format);
          break;
        }
      }
      break;
    }
    case "integer":
    case "number":
    case "boolean":
      if (node.example === undefined) node.example = value;
      break;
    case "array":
      node.items ??= emptyNode();
      for (const item of value as unknown[]) addSample(node.items, item, depth + 1);
      break;
    case "object": {
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj);
      if (keys.length >= MAP_MIN_KEYS && keys.every(isIdLike)) {
        node.mapCount++;
        node.mapValues ??= emptyNode();
        for (const key of keys) addSample(node.mapValues, obj[key], depth + 1);
      } else {
        node.objectCount++;
        for (const key of keys) {
          const child = node.properties.get(key) ?? emptyNode();
          addSample(child, obj[key], depth + 1);
          node.properties.set(key, child);
        }
      }
      break;
    }
    case "null":
      break;
  }
  return node;
}

/** Infer a node from a list of samples. */
export function inferNode(samples: Iterable<unknown>): SchemaNode {
  const node = emptyNode();
  for (const s of samples) addSample(node, s);
  return node;
}

export interface RenderOptions {
  /** Include one observed example value per scalar field. Off by default: traffic may hold personal data. */
  examples?: boolean;
}

/** Render a statistics node as JSON Schema. */
export function toJsonSchema(node: SchemaNode, options: RenderOptions = {}): JsonSchema {
  const types = new Set(node.types.keys());
  if (types.has("integer") && types.has("number")) types.delete("integer");
  const nullable = types.delete("null");

  if (types.size === 0) return nullable ? { type: "null" } : {};
  if (types.size > 1) {
    const branches = [...types].map((t) => renderType(t, node, options));
    if (nullable) branches.push({ type: "null" });
    return { anyOf: branches };
  }

  const [only] = types;
  const schema = renderType(only!, node, options);
  if (nullable) {
    schema.type = [schema.type, "null"];
    if (Array.isArray(schema.enum)) schema.enum = [...schema.enum, null];
  }
  return schema;
}

function renderType(type: JsonType, node: SchemaNode, options: RenderOptions): JsonSchema {
  switch (type) {
    case "string":
      return renderString(node, options);
    case "integer":
    case "number":
    case "boolean": {
      const schema: JsonSchema = { type };
      const expected = type === "boolean" ? "boolean" : "number";
      if (options.examples && typeof node.example === expected) {
        schema.examples = [node.example];
      }
      return schema;
    }
    case "array":
      return { type: "array", items: node.items && node.items.count > 0 ? toJsonSchema(node.items, options) : {} };
    case "object":
      return renderObject(node, options);
    case "null":
      return { type: "null" };
  }
}

function renderString(node: SchemaNode, options: RenderOptions): JsonSchema {
  const schema: JsonSchema = { type: "string" };
  for (const [format, hits] of node.stringFormats) {
    if (hits === node.stringCount) {
      schema.format = format;
      break;
    }
  }
  const distinct = node.stringValues.size;
  if (
    schema.format === undefined &&
    !node.stringOverflow &&
    node.stringCount >= ENUM_MIN_SAMPLES &&
    distinct <= ENUM_MAX_VALUES &&
    distinct * 2 <= node.stringCount &&
    [...node.stringValues].every((v) => v.length <= 40 && ENUM_CODE.test(v))
  ) {
    schema.enum = [...node.stringValues].sort();
  }
  if (options.examples && typeof node.example === "string" && schema.enum === undefined) {
    schema.examples = [node.example];
  }
  return schema;
}

function renderObject(node: SchemaNode, options: RenderOptions): JsonSchema {
  const schema: JsonSchema = { type: "object" };
  if (node.objectCount > 0) {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [key, child] of [...node.properties].sort(([a], [b]) => a.localeCompare(b))) {
      properties[key] = toJsonSchema(child, options);
      // A key is required only if every fixed-key object carried it.
      if (child.count === node.objectCount && node.mapCount === 0) required.push(key);
    }
    schema.properties = properties;
    if (required.length > 0) schema.required = required;
  }
  if (node.mapValues) {
    schema.additionalProperties = toJsonSchema(node.mapValues, options);
  }
  return schema;
}

/** Convenience: infer and render in one step. */
export function inferSchema(samples: Iterable<unknown>, options: RenderOptions = {}): JsonSchema {
  return toJsonSchema(inferNode(samples), options);
}

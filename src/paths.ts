/**
 * Path templating: collapse concrete request paths such as `/users/42` and
 * `/users/97` into `/users/{userId}`.
 *
 * Two passes:
 *  1. Segments that look like identifiers (numbers, UUIDs, long hex or token
 *     strings) become parameters on their own.
 *  2. Among paths of equal length, a position whose value varies while every
 *     other position stays the same becomes a parameter when the variation
 *     looks like data rather than distinct resources (see `shouldCollapse`).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTEGER = /^-?\d+$/;
const HEX = /^[0-9a-f]{12,}$/i;
const TOKEN = /^[A-Za-z0-9_-]{16,}$/;
const DATE = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?$/;

/** Minimum distinct values at one position before pass 2 collapses it. */
const MIN_DISTINCT_VALUES = 3;

/** True when a single path segment is very likely an identifier value. */
export function isIdLike(segment: string): boolean {
  if (INTEGER.test(segment) || UUID.test(segment) || DATE.test(segment)) return true;
  if (HEX.test(segment) && /\d/.test(segment)) return true;
  // Long opaque tokens mix letters and digits; long plain words do not.
  return TOKEN.test(segment) && /\d/.test(segment) && /[A-Za-z]/.test(segment);
}

export interface PathParam {
  name: string;
  /** Index into the path's segment list. */
  position: number;
}

export interface PathTemplate {
  /** OpenAPI-style template, e.g. `/users/{userId}/posts`. */
  template: string;
  params: PathParam[];
}

const PARAM = Symbol("param");
type Shape = (string | typeof PARAM)[];

function splitPath(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0).map(safeDecode);
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function shouldCollapse(values: Set<string>, hasLiteralSuffix: boolean): boolean {
  if (values.size < MIN_DISTINCT_VALUES) return false;
  // `/repos/{x}/issues`: a shared continuation means x is a value, not a resource.
  if (hasLiteralSuffix) return true;
  // `/api/users`, `/api/orders`, `/api/items` are distinct resources unless the
  // values look like data (contain digits, e.g. slugs like `post-2024-01`).
  const withDigits = [...values].filter((v) => /\d/.test(v)).length;
  return withDigits * 2 >= values.size;
}

function singular(word: string): string {
  if (/ies$/i.test(word)) return word.slice(0, -3) + "y";
  if (/(?:ss|us|is)$/i.test(word)) return word;
  if (/(?:xes|ches|shes|sses)$/i.test(word)) return word.slice(0, -2);
  if (/s$/i.test(word)) return word.slice(0, -1);
  return word;
}

function camelCase(word: string): string {
  const parts = word.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return parts
    .map((p, i) => (i === 0 ? p.charAt(0).toLowerCase() + p.slice(1) : p.charAt(0).toUpperCase() + p.slice(1)))
    .join("");
}

function paramName(previous: string | typeof PARAM | undefined): string {
  if (typeof previous !== "string" || !/[A-Za-z]/.test(previous) || /^v\d+$/i.test(previous)) return "id";
  const base = camelCase(singular(previous));
  return base ? `${base}Id` : "id";
}

/**
 * Compute a template for each distinct raw path. Paths are the URL pathname
 * only (no query string). Returns a map keyed by the raw path.
 */
export function templatePaths(rawPaths: Iterable<string>): Map<string, PathTemplate> {
  const unique = [...new Set(rawPaths)];
  const segments = new Map(unique.map((p) => [p, splitPath(p)]));
  const shapes = new Map<string, Shape>(
    unique.map((p) => [p, segments.get(p)!.map((s) => (isIdLike(s) ? PARAM : s))]),
  );

  // Pass 2, per path length, repeated until no position changes so that
  // collapsing one position can reveal variation at another.
  const byLength = new Map<number, string[]>();
  for (const p of unique) {
    const len = segments.get(p)!.length;
    byLength.set(len, [...(byLength.get(len) ?? []), p]);
  }
  for (const [length, paths] of byLength) {
    let changed = true;
    while (changed) {
      changed = false;
      for (let pos = 0; pos < length; pos++) {
        const groups = new Map<string, { values: Set<string>; members: string[] }>();
        for (const p of paths) {
          const shape = shapes.get(p)!;
          const value = shape[pos];
          if (value === PARAM || value === undefined) continue;
          const key = shape.map((s, i) => (i === pos ? "*" : s === PARAM ? "\u0000" : s)).join("/");
          const group = groups.get(key) ?? { values: new Set(), members: [] };
          group.values.add(value);
          group.members.push(p);
          groups.set(key, group);
        }
        for (const group of groups.values()) {
          // Only a literal continuation (`/repos/{x}/issues`) is evidence; `/{x}/{id}` is not.
          const hasLiteralSuffix = shapes.get(group.members[0]!)!.slice(pos + 1).some((s) => s !== PARAM);
          if (shouldCollapse(group.values, hasLiteralSuffix)) {
            for (const p of group.members) shapes.get(p)![pos] = PARAM;
            changed = true;
          }
        }
      }
    }
  }

  const result = new Map<string, PathTemplate>();
  for (const p of unique) {
    const shape = shapes.get(p)!;
    const params: PathParam[] = [];
    const used = new Set<string>();
    const parts = shape.map((s, position) => {
      if (s !== PARAM) return s;
      let name = paramName(shape[position - 1]);
      for (let n = 2; used.has(name); n++) name = `${paramName(shape[position - 1])}${n}`;
      used.add(name);
      params.push({ name, position });
      return `{${name}}`;
    });
    result.set(p, { template: "/" + parts.map(encodeLiteral).join("/"), params });
  }
  return result;
}

function encodeLiteral(part: string): string {
  return part.startsWith("{") && part.endsWith("}") ? part : encodeURIComponent(part);
}

/** Extract the raw values of a template's parameters from a concrete path. */
export function extractParamValues(rawPath: string, template: PathTemplate): Record<string, string> {
  const segs = splitPath(rawPath);
  return Object.fromEntries(template.params.map((p) => [p.name, segs[p.position] ?? ""]));
}

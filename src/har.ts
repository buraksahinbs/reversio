/**
 * HAR (HTTP Archive) loading and normalization.
 *
 * Only the fields reversio needs are modeled; everything else in the HAR is
 * ignored. Input is treated as untrusted and validated defensively.
 */

/** One observed HTTP request/response pair, normalized for analysis. */
export interface Exchange {
  method: string;
  url: URL;
  requestHeaders: Record<string, string>;
  /** Parsed JSON request body, or undefined when absent or not JSON. */
  requestBody?: unknown;
  requestContentType?: string;
  status: number;
  responseHeaders: Record<string, string>;
  responseContentType?: string;
  /** Parsed JSON response body, or undefined when absent or not JSON. */
  responseBody?: unknown;
}

export class HarParseError extends Error {
  override name = "HarParseError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function headerMap(raw: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!Array.isArray(raw)) return headers;
  for (const h of raw) {
    if (isRecord(h) && typeof h.name === "string" && typeof h.value === "string") {
      // HTTP/2 pseudo headers (":authority") carry no API information.
      if (h.name.startsWith(":")) continue;
      headers[h.name.toLowerCase()] = h.value;
    }
  }
  return headers;
}

function mediaType(contentType: string | undefined): string | undefined {
  const base = contentType?.split(";")[0]?.trim().toLowerCase();
  return base || undefined;
}

/** True for application/json and structured-syntax suffixes like application/problem+json. */
export function isJsonMediaType(type: string | undefined): boolean {
  return type !== undefined && (type === "application/json" || type.endsWith("+json"));
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function decodeText(text: string, encoding: unknown): string {
  return encoding === "base64" ? Buffer.from(text, "base64").toString("utf8") : text;
}

/**
 * Parse HAR JSON text into normalized exchanges. Entries that are malformed
 * (missing URL, unparseable URL, aborted requests with status 0) are skipped.
 */
export function parseHar(text: string): Exchange[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new HarParseError(`Input is not valid JSON: ${(err as Error).message}`);
  }
  if (!isRecord(doc) || !isRecord(doc.log) || !Array.isArray(doc.log.entries)) {
    throw new HarParseError("Input is not a HAR file: missing log.entries");
  }

  const exchanges: Exchange[] = [];
  for (const entry of doc.log.entries) {
    if (!isRecord(entry) || !isRecord(entry.request) || !isRecord(entry.response)) continue;
    const { request, response } = entry;
    if (typeof request.url !== "string" || typeof request.method !== "string") continue;
    const status = typeof response.status === "number" ? response.status : 0;
    if (status === 0) continue;

    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      continue;
    }

    const requestHeaders = headerMap(request.headers);
    const responseHeaders = headerMap(response.headers);
    const exchange: Exchange = {
      method: request.method.toUpperCase(),
      url,
      requestHeaders,
      status,
      responseHeaders,
    };

    const postData = isRecord(request.postData) ? request.postData : undefined;
    const reqType = mediaType(
      (typeof postData?.mimeType === "string" ? postData.mimeType : undefined) ??
        requestHeaders["content-type"],
    );
    if (reqType) exchange.requestContentType = reqType;
    if (postData && typeof postData.text === "string" && postData.text.length > 0) {
      if (isJsonMediaType(reqType)) {
        const body = tryParseJson(postData.text);
        if (body !== undefined) exchange.requestBody = body;
      } else if (reqType === "application/x-www-form-urlencoded") {
        exchange.requestBody = Object.fromEntries(new URLSearchParams(postData.text));
      }
    }

    const content = isRecord(response.content) ? response.content : undefined;
    const resType = mediaType(
      (typeof content?.mimeType === "string" ? content.mimeType : undefined) ??
        responseHeaders["content-type"],
    );
    if (resType) exchange.responseContentType = resType;
    if (content && typeof content.text === "string" && isJsonMediaType(resType)) {
      const body = tryParseJson(decodeText(content.text, content.encoding));
      if (body !== undefined) exchange.responseBody = body;
    }

    exchanges.push(exchange);
  }
  return exchanges;
}

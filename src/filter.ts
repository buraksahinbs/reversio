import { isJsonMediaType, type Exchange } from "./har.js";

const STATIC_EXTENSIONS =
  /\.(?:js|mjs|css|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf|html?|wasm)$/i;

const NON_API_MEDIA = /^(?:text\/(?:html|css|javascript)|image\/|font\/|video\/|audio\/|application\/(?:javascript|wasm|font))/;

const API_PATH_HINT = /(?:^|\/)(?:api|graphql|rest|rpc|v\d+)(?:\/|$)/i;

export interface FilterOptions {
  /** Keep only these hosts (exact match, case-insensitive). Empty = all hosts. */
  hosts?: string[];
}

/**
 * Heuristically decide whether an exchange is an API call rather than a page,
 * asset, or CORS preflight.
 */
export function isApiExchange(ex: Exchange): boolean {
  if (ex.method === "OPTIONS" || ex.method === "HEAD") return false;
  if (STATIC_EXTENSIONS.test(ex.url.pathname)) return false;
  if (ex.responseContentType && NON_API_MEDIA.test(ex.responseContentType)) return false;
  if (isJsonMediaType(ex.responseContentType) || isJsonMediaType(ex.requestContentType)) return true;
  if (ex.requestBody !== undefined) return true;
  return API_PATH_HINT.test(ex.url.pathname);
}

export function filterExchanges(exchanges: Exchange[], options: FilterOptions = {}): Exchange[] {
  const hosts = options.hosts?.map((h) => h.toLowerCase()) ?? [];
  return exchanges.filter(
    (ex) => isApiExchange(ex) && (hosts.length === 0 || hosts.includes(ex.url.host.toLowerCase())),
  );
}

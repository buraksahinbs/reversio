/** Build HAR documents for tests without hand-writing the full format. */

export interface FakeEntry {
  method?: string;
  url: string;
  status?: number;
  requestHeaders?: Record<string, string>;
  requestBody?: unknown;
  requestMime?: string;
  response?: unknown;
  responseMime?: string;
  base64?: boolean;
}

export function makeHar(entries: FakeEntry[]): string {
  return JSON.stringify({
    log: {
      version: "1.2",
      creator: { name: "test", version: "1" },
      entries: entries.map((e) => {
        const responseMime = e.responseMime ?? (e.response === undefined ? "text/plain" : "application/json");
        const text = e.response === undefined ? "" : typeof e.response === "string" ? e.response : JSON.stringify(e.response);
        return {
          request: {
            method: e.method ?? "GET",
            url: e.url,
            headers: Object.entries(e.requestHeaders ?? {}).map(([name, value]) => ({ name, value })),
            ...(e.requestBody !== undefined && {
              postData: {
                mimeType: e.requestMime ?? "application/json",
                text: typeof e.requestBody === "string" ? e.requestBody : JSON.stringify(e.requestBody),
              },
            }),
          },
          response: {
            status: e.status ?? 200,
            headers: [{ name: "Content-Type", value: responseMime }],
            content: {
              mimeType: responseMime,
              text: e.base64 ? Buffer.from(text).toString("base64") : text,
              ...(e.base64 && { encoding: "base64" }),
            },
          },
        };
      }),
    },
  });
}

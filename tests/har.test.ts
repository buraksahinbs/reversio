import { describe, expect, it } from "vitest";
import { filterExchanges } from "../src/filter.js";
import { HarParseError, parseHar } from "../src/har.js";
import { makeHar } from "./helpers.js";

describe("parseHar", () => {
  it("rejects non-HAR input", () => {
    expect(() => parseHar("not json")).toThrow(HarParseError);
    expect(() => parseHar("{}")).toThrow(/log.entries/);
  });

  it("normalizes requests, decodes base64 bodies and parses form bodies", () => {
    const [json, form] = parseHar(
      makeHar([
        { url: "https://api.x.com/a?q=1", response: { ok: true }, base64: true, requestHeaders: { Authorization: "Bearer t" } },
        { method: "post", url: "https://api.x.com/login", requestBody: "user=a&pass=b", requestMime: "application/x-www-form-urlencoded" },
      ]),
    );
    expect(json!.responseBody).toEqual({ ok: true });
    expect(json!.requestHeaders.authorization).toBe("Bearer t");
    expect(form!.method).toBe("POST");
    expect(form!.requestBody).toEqual({ user: "a", pass: "b" });
  });

  it("skips aborted and malformed entries", () => {
    const har = JSON.parse(makeHar([{ url: "https://x.com/a", status: 0 }, { url: "https://x.com/b" }]));
    har.log.entries.push({ request: { method: "GET", url: "::bad" }, response: { status: 200 } }, null);
    expect(parseHar(JSON.stringify(har)).map((e) => e.url.pathname)).toEqual(["/b"]);
  });
});

describe("filterExchanges", () => {
  const exchanges = parseHar(
    makeHar([
      { url: "https://x.com/app.js", response: "x", responseMime: "application/javascript" },
      { url: "https://x.com/", response: "<html>", responseMime: "text/html" },
      { url: "https://x.com/logo.png", response: "", responseMime: "image/png" },
      { method: "OPTIONS", url: "https://api.x.com/users" },
      { url: "https://api.x.com/users", response: [] },
      { method: "DELETE", url: "https://api.x.com/v2/users/1" },
      { url: "https://cdn.other.com/data", response: {} },
    ]),
  );

  it("keeps JSON calls and API-looking paths only", () => {
    expect(filterExchanges(exchanges).map((e) => `${e.method} ${e.url.host}${e.url.pathname}`)).toEqual([
      "GET api.x.com/users",
      "DELETE api.x.com/v2/users/1",
      "GET cdn.other.com/data",
    ]);
  });

  it("restricts to the requested hosts", () => {
    expect(filterExchanges(exchanges, { hosts: ["API.X.COM"] })).toHaveLength(2);
  });
});

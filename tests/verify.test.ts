import { describe, expect, it } from "vitest";
import { filterExchanges } from "../src/filter.js";
import { parseHar } from "../src/har.js";
import { buildOpenApi } from "../src/openapi.js";
import { generateTypeScriptSdk } from "../src/sdk/typescript.js";
import { readSpec } from "../src/spec.js";
import { matchOperation, verifyReplay } from "../src/verify.js";
import { shopEntries } from "./fixtures/shop.js";
import { makeHar, type FakeEntry } from "./helpers.js";

const calls = (entries: FakeEntry[]) => filterExchanges(parseHar(makeHar(entries)));
const shopCalls = calls(shopEntries);
const shopSpec = readSpec(buildOpenApi(shopCalls));

function failuresOf(report: Awaited<ReturnType<typeof verifyReplay>>): Record<string, string[]> {
  return Object.fromEntries(
    report.operations.filter((o) => o.failures.length > 0).map((o) => [o.operationId, o.failures.map((f) => f.reason)]),
  );
}

describe("verifyReplay", () => {
  it("reproduces every recorded call of the capture the spec was built from", async () => {
    const report = await verifyReplay(shopSpec, shopCalls);
    expect(failuresOf(report)).toEqual({});
    expect(report.passed).toBe(report.total);
    expect(report.total).toBe(shopCalls.length);
    expect(report.unmatched).toEqual([]);
  });

  it("reports drift in a newer capture", async () => {
    const newer = calls([
      // New response field type and a new query parameter.
      {
        url: "https://api.shop.example.com/v1/products/10?expand=reviews",
        response: { id: "10", name: "Mug", price: 9.5, createdAt: "2024-03-01T12:00:00Z" },
      },
      // A status code never seen before.
      { method: "POST", url: "https://api.shop.example.com/v1/cart/items", status: 409, requestBody: { productId: 1, quantity: 1 }, response: { error: "conflict" } },
      // A brand new endpoint.
      { url: "https://api.shop.example.com/v1/wishlist", response: [] },
    ]);
    const report = await verifyReplay(shopSpec, newer);
    expect(failuresOf(report)).toEqual({
      getProductsById: ["query differs (not sent: expand)", "response 200 schema: /id must be integer"],
      postCartItems: ["status 409 not in spec"],
    });
    expect(report.unmatched).toEqual([{ method: "GET", url: "https://api.shop.example.com/v1/wishlist" }]);
  });

  it("catches an SDK that builds requests incorrectly", async () => {
    const broken = generateTypeScriptSdk(shopSpec).replace("`/v1/products/${", "`/v1/product/${");
    const report = await verifyReplay(shopSpec, shopCalls, broken);
    expect(failuresOf(report).getProductsById).toEqual([
      "path /v1/product/10 != /v1/products/10",
      "path /v1/product/11 != /v1/products/11",
      "path /v1/product/12 != /v1/products/12",
      "path /v1/product/999 != /v1/products/999",
    ]);
  });

  it("catches an SDK that mishandles responses", async () => {
    const broken = generateTypeScriptSdk(shopSpec).replace("if (!response.ok) throw new ApiError(response, data);", "");
    const report = await verifyReplay(shopSpec, shopCalls, broken);
    expect(failuresOf(report)).toEqual({ getProductsById: ["expected ApiError with status 404"] });
  });
});

describe("matchOperation", () => {
  it("prefers literal segments over parameters", () => {
    const spec = readSpec(
      buildOpenApi(
        calls([
          ...[1, 2, 3].map((id) => ({ url: `https://x.dev/api/users/${id}`, response: { id } })),
          { url: "https://x.dev/api/users/me", response: { id: 1 } },
        ]),
      ),
    );
    const [me] = calls([{ url: "https://x.dev/api/users/me", response: {} }]);
    const [seven] = calls([{ url: "https://x.dev/api/users/7", response: {} }]);
    expect(matchOperation(spec, me!)?.op.path).toBe("/api/users/me");
    expect(matchOperation(spec, seven!)).toMatchObject({ op: { path: "/api/users/{userId}" }, pathValues: { userId: "7" } });
  });
});

describe("servers with a base path", () => {
  it("matches and replays operations relative to the server path", async () => {
    const doc = buildOpenApi(calls([{ url: "https://x.dev/api/v2/items/1", response: { id: 1 } }])) as any;
    // Move the shared prefix into the server URL, as hand-written specs usually do.
    doc.servers = [{ url: "https://x.dev/api/v2" }];
    doc.paths = { "/items/{itemId}": doc.paths["/api/v2/items/{itemId}"] };
    const spec = readSpec(doc);
    const recorded = calls([2, 3].map((id) => ({ url: `https://x.dev/api/v2/items/${id}`, response: { id } })));
    const report = await verifyReplay(spec, recorded);
    expect(report.unmatched).toEqual([]);
    expect(report.passed).toBe(2);
  });
});

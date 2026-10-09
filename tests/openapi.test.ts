import SwaggerParser from "@apidevtools/swagger-parser";
import { describe, expect, it } from "vitest";
import { filterExchanges } from "../src/filter.js";
import { parseHar } from "../src/har.js";
import { buildOpenApi } from "../src/openapi.js";
import { makeHar, type FakeEntry } from "./helpers.js";

const auth = { Authorization: "Bearer abc.def.ghi", Cookie: "theme=dark; session_id=xyz" };

/** A small shop API as a browser would capture it, including noise. */
const entries: FakeEntry[] = [
  { url: "https://shop.example.com/", response: "<html></html>", responseMime: "text/html" },
  { url: "https://shop.example.com/static/app.js", response: "x", responseMime: "application/javascript" },
  ...[1, 2, 3].map((page) => ({
    url: `https://api.shop.example.com/v1/products?page=${page}&limit=20${page === 3 ? "&sort=price" : ""}`,
    requestHeaders: auth,
    response: {
      items: [
        { id: page * 10, name: "Mug", price: 9.5, status: "active", tags: ["kitchen"] },
        { id: page * 10 + 1, name: "Pen", price: 2, status: "archived", tags: [], discount: null },
      ],
      next: page < 3 ? `https://api.shop.example.com/v1/products?page=${page + 1}` : null,
    },
  })),
  ...[10, 11, 12].map((id) => ({
    url: `https://api.shop.example.com/v1/products/${id}`,
    requestHeaders: auth,
    response: { id, name: "Mug", price: 9.5, createdAt: "2024-03-01T12:00:00Z" },
  })),
  { url: "https://api.shop.example.com/v1/products/999", requestHeaders: auth, status: 404, response: { error: "not_found" } },
  {
    method: "POST",
    url: "https://api.shop.example.com/v1/cart/items",
    requestHeaders: auth,
    requestBody: { productId: 10, quantity: 2 },
    status: 201,
    response: { cartId: "550e8400-e29b-41d4-a716-446655440000", total: 19 },
  },
  { method: "DELETE", url: "https://api.shop.example.com/v1/cart/items/10", requestHeaders: auth, status: 204 },
  {
    method: "POST",
    url: "https://auth.shop.example.com/oauth/token",
    requestBody: "grant_type=password&username=a&password=b",
    requestMime: "application/x-www-form-urlencoded",
    response: { access_token: "t", expires_in: 3600, token_type: "Bearer" },
  },
];

const doc = buildOpenApi(filterExchanges(parseHar(makeHar(entries)))) as any;

describe("buildOpenApi", () => {
  it("produces a valid OpenAPI 3.1 document", async () => {
    await expect(SwaggerParser.validate(structuredClone(doc))).resolves.toBeDefined();
  });

  it("recovers every operation and nothing else", () => {
    const ops = Object.entries(doc.paths).flatMap(([path, item]: [string, any]) =>
      Object.keys(item).filter((k) => k !== "servers").map((m) => `${m.toUpperCase()} ${path}`),
    );
    expect(ops.sort()).toEqual([
      "DELETE /v1/cart/items/{itemId}",
      "GET /v1/products",
      "GET /v1/products/{productId}",
      "POST /oauth/token",
      "POST /v1/cart/items",
    ]);
  });

  it("puts the busiest origin first and pins other origins per path", () => {
    expect(doc.servers[0]).toEqual({ url: "https://api.shop.example.com" });
    expect(doc.paths["/oauth/token"].servers).toEqual([{ url: "https://auth.shop.example.com" }]);
    expect(doc.paths["/v1/products"].servers).toBeUndefined();
  });

  it("infers query parameters with types and requiredness", () => {
    const params = doc.paths["/v1/products"].get.parameters;
    expect(params).toEqual([
      { name: "limit", in: "query", required: true, schema: { type: "integer" } },
      { name: "page", in: "query", required: true, schema: { type: "integer" } },
      { name: "sort", in: "query", required: false, schema: { type: "string" } },
    ]);
  });

  it("types path parameters from observed values", () => {
    const op = doc.paths["/v1/products/{productId}"].get;
    expect(op.operationId).toBe("getProductsById");
    expect(op.parameters).toEqual([{ name: "productId", in: "path", required: true, schema: { type: "integer" } }]);
  });

  it("merges response samples into one schema per status", () => {
    const op = doc.paths["/v1/products/{productId}"].get;
    expect(Object.keys(op.responses)).toEqual(["200", "404"]);
    expect(op.responses["200"].content["application/json"].schema.properties.createdAt).toEqual({
      type: "string",
      format: "date-time",
    });
    const list = doc.paths["/v1/products"].get.responses["200"].content["application/json"].schema;
    expect(list.properties.next).toEqual({ type: ["string", "null"], format: "uri" });
    expect(list.properties.items.items.required).toEqual(["id", "name", "price", "status", "tags"]);
    expect(list.properties.items.items.properties.status).toEqual({ type: "string", enum: ["active", "archived"] });
  });

  it("records request bodies and bodiless responses", () => {
    const post = doc.paths["/v1/cart/items"].post;
    expect(post.requestBody.required).toBe(true);
    expect(post.requestBody.content["application/json"].schema.required).toEqual(["productId", "quantity"]);
    expect(doc.paths["/v1/cart/items/{itemId}"].delete.responses).toEqual({ "204": { description: "No Content" } });
    expect(Object.keys(doc.paths["/oauth/token"].post.requestBody.content)).toEqual(["application/x-www-form-urlencoded"]);
  });

  it("detects auth schemes used on every call", () => {
    expect(doc.components.securitySchemes).toEqual({
      bearerAuth: { type: "http", scheme: "bearer" },
      cookieSessionId: { type: "apiKey", in: "cookie", name: "session_id" },
    });
    expect(doc.paths["/v1/products"].get.security).toEqual([{ bearerAuth: [], cookieSessionId: [] }]);
    expect(doc.paths["/oauth/token"].post.security).toBeUndefined();
  });

  it("never leaks observed values unless examples are requested", () => {
    const text = JSON.stringify(doc);
    expect(text).not.toContain("abc.def.ghi");
    expect(text).not.toContain("Mug");
    const withExamples = JSON.stringify(buildOpenApi(filterExchanges(parseHar(makeHar(entries))), { examples: true }));
    expect(withExamples).toContain("Mug");
    expect(withExamples).not.toContain("abc.def.ghi");
  });
});

describe("demo fixture", () => {
  it("recovers the demo API's operations from a browser-style HAR", async () => {
    const { readFile } = await import("node:fs/promises");
    const har = await readFile(new URL("./fixtures/demo.har", import.meta.url), "utf8");
    const demo = buildOpenApi(filterExchanges(parseHar(har))) as any;
    expect(Object.keys(demo.paths).sort()).toEqual(["/repos/octo/x/issues/{issueId}", "/users/{userId}/repos"]);
    await expect(SwaggerParser.validate(demo)).resolves.toBeDefined();
  });
});

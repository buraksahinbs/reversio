import SwaggerParser from "@apidevtools/swagger-parser";
import { describe, expect, it } from "vitest";
import { filterExchanges } from "../src/filter.js";
import { parseHar } from "../src/har.js";
import { buildOpenApi } from "../src/openapi.js";
import { shopEntries as entries } from "./fixtures/shop.js";
import { makeHar } from "./helpers.js";

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

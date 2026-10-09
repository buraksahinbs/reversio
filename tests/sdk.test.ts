import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { filterExchanges } from "../src/filter.js";
import { parseHar } from "../src/har.js";
import { buildOpenApi } from "../src/openapi.js";
import { toTsType } from "../src/sdk/tsTypes.js";
import { generateTypeScriptSdk } from "../src/sdk/typescript.js";
import { readSpec, type Spec } from "../src/spec.js";
import { shopEntries } from "./fixtures/shop.js";
import { makeHar } from "./helpers.js";

const shopSpec = readSpec(buildOpenApi(filterExchanges(parseHar(makeHar(shopEntries)))));

/** Type-check sources (written to a temp dir) with strict settings; returns diagnostics as text. */
async function typecheck(files: Record<string, string>): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "reversio-tsc-"));
  try {
    const paths = await Promise.all(
      Object.entries(files).map(async ([name, text]) => {
        const path = join(dir, name);
        await writeFile(path, text);
        return path;
      }),
    );
    const program = ts.createProgram(paths, {
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true,
      lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
      types: [],
    });
    return ts
      .getPreEmitDiagnostics(program)
      .map((d) => `${d.file?.fileName.replace(dir, "") ?? ""}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function importSdk(source: string): Promise<any> {
  const dir = await mkdtemp(join(tmpdir(), "reversio-test-"));
  try {
    const file = join(dir, "client.mjs");
    await writeFile(file, stripTypeScriptTypes(source));
    return await import(pathToFileURL(file).href);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("toTsType", () => {
  it("renders nullable, enum, map and nested shapes", () => {
    expect(toTsType({ type: ["string", "null"] })).toBe("string | null");
    expect(toTsType({ type: ["string", "null"], enum: ["a", "b", null] })).toBe('"a" | "b" | null');
    expect(toTsType({ type: "object", additionalProperties: { type: "integer" } })).toBe("Record<string, number>");
    expect(toTsType({ type: "array", items: {} })).toBe("Array<unknown>");
    expect(toTsType({ type: "object", properties: { "x-id": { type: "string" } }, required: [] })).toBe(
      '{\n  "x-id"?: string;\n}',
    );
  });
});

describe("generateTypeScriptSdk", () => {
  it("type-checks under strict settings and is usable from calling code", async () => {
    const usage = `
      import { ApiClient, ApiError } from "./client.ts";
      const client = new ApiClient({ auth: { bearerAuth: "t", cookieSessionId: "s" } });
      async function main(): Promise<void> {
        const list = await client.getProducts({ query: { page: 1, limit: 20 } });
        const first: number | undefined = list.items[0]?.id;
        const status: "active" | "archived" | undefined = list.items[0]?.status;
        const one = await client.getProductsById({ productId: 10 });
        const created: string = one.createdAt;
        const cart = await client.postCartItems({ body: { productId: 1, quantity: 2 } });
        const cartId: string = cart.cartId;
        await client.deleteCartItemsById({ itemId: 3 });
        await client.postOauthToken({ body: { grant_type: "password", username: "a", password: "b" } });
        // @ts-expect-error path parameter is required
        await client.getProductsById({});
        try { await client.getProductsById({ productId: 1 }); } catch (e) { if (e instanceof ApiError) e.status.toFixed(); }
        void first; void status; void created; void cartId;
      }
      void main;
    `;
    const source = generateTypeScriptSdk(shopSpec);
    expect(await typecheck({ "client.ts": source, "usage.ts": usage })).toEqual([]);
  });

  it("type-checks for an API without auth or parameters", async () => {
    const spec: Spec = {
      title: "Bare",
      servers: [],
      securitySchemes: {},
      operations: [{ operationId: "ping", method: "GET", path: "/ping", pathParams: [], queryParams: [], responses: [{ status: "204" }], security: [] }],
    };
    expect(await typecheck({ "client.ts": generateTypeScriptSdk(spec) })).toEqual([]);
  });

  it("sends requests with auth, query and body as the spec describes", async () => {
    const { ApiClient } = await importSdk(generateTypeScriptSdk(shopSpec));
    const sent: { url: string; method: string; headers: Headers; body: unknown }[] = [];
    const client = new ApiClient({
      auth: { bearerAuth: "tok", cookieSessionId: "abc" },
      headers: { "x-app": "1" },
      fetch: async (url: URL, init: RequestInit) => {
        sent.push({ url: String(url), method: init.method!, headers: new Headers(init.headers), body: init.body });
        return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
      },
    });

    await expect(client.getProducts({ query: { page: 2, limit: 20 } })).resolves.toEqual({ ok: true });
    await client.postCartItems({ body: { productId: 1, quantity: 2 } });
    await client.postOauthToken({ body: { grant_type: "password", username: "a b", password: "p" } });

    expect(sent[0]!.url).toBe("https://api.shop.example.com/v1/products?page=2&limit=20");
    expect(sent[0]!.headers.get("authorization")).toBe("Bearer tok");
    expect(sent[0]!.headers.get("cookie")).toBe("session_id=abc");
    expect(sent[0]!.headers.get("x-app")).toBe("1");
    expect(sent[1]!.body).toBe('{"productId":1,"quantity":2}');
    expect(sent[2]!.url).toBe("https://auth.shop.example.com/oauth/token");
    expect(sent[2]!.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(sent[2]!.body).toBe("grant_type=password&username=a+b&password=p");
    expect(sent[2]!.headers.get("authorization")).toBeNull();
  });

  it("throws ApiError with the parsed body on error responses", async () => {
    const { ApiClient, ApiError } = await importSdk(generateTypeScriptSdk(shopSpec));
    const client = new ApiClient({
      fetch: async () => new Response('{"error":"not_found"}', { status: 404, headers: { "content-type": "application/json" } }),
    });
    const error = await client.getProductsById({ productId: 9 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, body: { error: "not_found" } });
  });

  it("lets callers redirect secondary servers", async () => {
    const { ApiClient } = await importSdk(generateTypeScriptSdk(shopSpec));
    let url = "";
    const client = new ApiClient({
      servers: { "https://auth.shop.example.com": "http://localhost:9999" },
      fetch: async (u: URL) => ((url = String(u)), new Response(null, { status: 204 })),
    });
    await client.postOauthToken({ body: { grant_type: "x", username: "u", password: "p" } });
    expect(url).toBe("http://localhost:9999/oauth/token");
  });
});

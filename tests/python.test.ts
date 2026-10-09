import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { filterExchanges } from "../src/filter.js";
import { parseHar } from "../src/har.js";
import { buildOpenApi } from "../src/openapi.js";
import { generatePythonSdk, pyIdentifier } from "../src/sdk/python.js";
import { readSpec } from "../src/spec.js";
import { verifyReplay } from "../src/verify.js";
import { shopEntries } from "./fixtures/shop.js";
import { makeHar, type FakeEntry } from "./helpers.js";

const PYTHON = process.env.REVERSIO_PYTHON ?? "python3";
const pythonVersion = spawnSync(PYTHON, ["-c", "import sys; print(sys.version_info >= (3, 11))"], { encoding: "utf8" });
const hasPython = pythonVersion.stdout?.trim() === "True";
/** mypy command, e.g. "mypy" or "python3 -m mypy". Type-checking is skipped when unset and unavailable. */
const MYPY = (process.env.REVERSIO_MYPY ?? `${PYTHON} -m mypy`).split(" ");
const hasMypy = hasPython && spawnSync(MYPY[0]!, [...MYPY.slice(1), "--version"]).status === 0;

const calls = (entries: FakeEntry[]) => filterExchanges(parseHar(makeHar(entries)));
const shopCalls = calls(shopEntries);
const shopSpec = readSpec(buildOpenApi(shopCalls));

/** Run Python code next to a generated client.py; returns stdout. */
function runPython(clientSource: string, code: string): string {
  const dir = mkdtempSync(join(tmpdir(), "reversio-pytest-"));
  try {
    writeFileSync(join(dir, "client.py"), clientSource);
    writeFileSync(join(dir, "main.py"), code);
    const result = spawnSync(PYTHON, ["main.py"], { cwd: dir, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("pyIdentifier", () => {
  it.each([
    ["getProductsById", "get_products_by_id"],
    ["HTMLParser", "html_parser"],
    ["per-page", "per_page"],
    ["class", "class_"],
    ["2fa", "_2fa"],
    ["query", "query_"],
  ])("%s → %s", (input, output) => expect(pyIdentifier(input)).toBe(output));
});

describe.skipIf(!hasPython)("Python SDK", () => {
  it("reproduces every recorded call through replay", async () => {
    const report = await verifyReplay(shopSpec, shopCalls, { language: "python" });
    expect(report.operations.flatMap((o) => o.failures)).toEqual([]);
    expect(report.passed).toBe(shopCalls.length);
    expect(report.language).toBe("python");
  });

  it("reports drift exactly like the TypeScript SDK", async () => {
    const newer = calls([
      { url: "https://api.shop.example.com/v1/products/10?expand=reviews", response: { id: "10", name: "Mug", price: 9.5, createdAt: "2024-03-01T12:00:00Z" } },
      { method: "POST", url: "https://api.shop.example.com/v1/cart/items", status: 409, requestBody: { productId: 1, quantity: 1 }, response: { error: "conflict" } },
    ]);
    const [py, ts] = await Promise.all([
      verifyReplay(shopSpec, newer, { language: "python" }),
      verifyReplay(shopSpec, newer, { language: "typescript" }),
    ]);
    expect(py.operations).toEqual(ts.operations);
    expect(py.passed).toBe(0);
  });

  it("catches a Python SDK that builds requests incorrectly", async () => {
    const source = generatePythonSdk(shopSpec);
    const broken = source.replace('"/v1/products/" + _path(', '"/v1/product/" + _path(');
    expect(broken).not.toBe(source);
    const report = await verifyReplay(shopSpec, shopCalls, { language: "python", sdkSource: broken });
    const op = report.operations.find((o) => o.operationId === "getProductsById")!;
    expect(op.passed).toBe(0);
    expect(op.failures[0]!.reason).toMatch(/^path \/v1\/product\/\d+ != \/v1\/products\/\d+$/);
  });

  it("applies auth, headers and form encoding", () => {
    const out = runPython(
      generatePythonSdk(shopSpec),
      `
import json
from client import ApiClient, HttpResponse
sent = []
def transport(req):
    sent.append({"url": req.url, "headers": req.headers, "body": None if req.body is None else req.body.decode()})
    return HttpResponse(200, {"content-type": "application/json"}, b'{"ok": true}')
c = ApiClient(auth={"bearerAuth": "tok", "cookieSessionId": "abc"}, headers={"X-App": "1"}, transport=transport,
              servers={"https://auth.shop.example.com": "http://localhost:9"})
result = c.get_products(query={"page": 2, "limit": 20})
c.post_oauth_token(body={"grant_type": "password", "username": "a b", "password": "p"})
print(json.dumps({"result": result, "sent": sent}))
`,
    );
    const { result, sent } = JSON.parse(out);
    expect(result).toEqual({ ok: true });
    expect(sent[0].url).toBe("https://api.shop.example.com/v1/products?page=2&limit=20");
    expect(sent[0].headers).toMatchObject({ authorization: "Bearer tok", cookie: "session_id=abc", "x-app": "1" });
    expect(sent[1].url).toBe("http://localhost:9/oauth/token");
    expect(sent[1].headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(sent[1].headers.authorization).toBeUndefined();
    expect(sent[1].body).toBe("grant_type=password&username=a+b&password=p");
  });

  it("raises ApiError with the parsed body", () => {
    const out = runPython(
      generatePythonSdk(shopSpec),
      `
from client import ApiClient, ApiError, HttpResponse
c = ApiClient(transport=lambda req: HttpResponse(404, {"content-type": "application/json"}, b'{"error": "not_found"}'))
try:
    c.get_products_by_id(9)
except ApiError as e:
    print(e.status, e.body["error"])
`,
    );
    expect(out.trim()).toBe("404 not_found");
  });

  it.skipIf(!hasMypy)("passes mypy --strict, including calling code", () => {
    const dir = mkdtempSync(join(tmpdir(), "reversio-mypy-"));
    try {
      writeFileSync(join(dir, "client.py"), generatePythonSdk(shopSpec));
      writeFileSync(
        join(dir, "usage.py"),
        `
from client import ApiClient
c = ApiClient(auth={"bearerAuth": "t"})
page = c.get_products(query={"page": 1, "limit": 20})
status: str = page["items"][0]["status"]
created: str = c.get_products_by_id(10)["createdAt"]
cart_id: str = c.post_cart_items(body={"productId": 1, "quantity": 2})["cartId"]
c.delete_cart_items_by_id(3)
`,
      );
      const result = spawnSync(MYPY[0]!, [...MYPY.slice(1), "--strict", "client.py", "usage.py"], { cwd: dir, encoding: "utf8" });
      expect(result.stdout).toContain("Success");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

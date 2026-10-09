import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { filterExchanges } from "../src/filter.js";
import { parseHar } from "../src/har.js";
import { buildOpenApi } from "../src/openapi.js";
import { launchBrowser, launchCandidates, record } from "../src/record.js";
import { readSpec } from "../src/spec.js";
import { verifyReplay } from "../src/verify.js";
import { startAppServer } from "./fixtures/server.js";

// Prefer the preinstalled Playwright Chromium in CI-like containers.
const LOCAL_CHROMIUM = "/opt/pw-browsers/chromium";
const browserPath = process.env.REVERSIO_BROWSER ?? (existsSync(LOCAL_CHROMIUM) ? LOCAL_CHROMIUM : undefined);
const hasBrowser = await launchBrowser(true, browserPath).then(
  (b) => b.close().then(() => true),
  () => false,
);

describe("launchCandidates", () => {
  it("uses an explicit browser only", () => {
    expect(launchCandidates("/x/chrome")).toEqual([{ label: "/x/chrome", options: { executablePath: "/x/chrome" } }]);
  });
  it("falls back from installed browsers to Playwright's Chromium", () => {
    const saved = process.env.REVERSIO_BROWSER;
    delete process.env.REVERSIO_BROWSER;
    try {
      expect(launchCandidates().map((c) => c.label)).toEqual(["Google Chrome", "Microsoft Edge", "Playwright Chromium"]);
    } finally {
      if (saved !== undefined) process.env.REVERSIO_BROWSER = saved;
    }
  });
});

describe.skipIf(!hasBrowser)("record", () => {
  let app: Awaited<ReturnType<typeof startAppServer>>;
  let dir: string;
  beforeAll(async () => {
    app = await startAppServer();
    dir = await mkdtemp(join(tmpdir(), "reversio-record-"));
  });
  afterAll(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("records a session that becomes a verified spec and SDK", async () => {
    const harPath = join(dir, "session.har");
    const controller = new AbortController();
    const seen: string[] = [];
    const result = await record({
      url: app.url,
      harPath,
      headless: true,
      ...(browserPath && { executablePath: browserPath }),
      signal: controller.signal,
      timeoutMs: 20_000,
      onRequest: ({ method, url, resourceType }) => {
        if (resourceType !== "fetch") return;
        seen.push(`${method} ${new URL(url).pathname}`);
        if (seen.length === 6) controller.abort();
      },
    });
    expect(result.stoppedBy).toBe("signal");
    expect(seen).toHaveLength(6);

    const api = filterExchanges(parseHar(await readFile(harPath, "utf8")));
    const doc = buildOpenApi(api) as any;
    expect(Object.keys(doc.paths).sort()).toEqual(["/api/items", "/api/items/{itemId}"]);
    expect(doc.paths["/api/items"].post.requestBody.content["application/json"].schema.required).toEqual(["name", "qty"]);

    const report = await verifyReplay(readSpec(doc), api);
    expect(report.operations.flatMap((o) => o.failures)).toEqual([]);
    expect(report.passed).toBe(6);
  });

  it("stops at the time limit and still writes the HAR", async () => {
    const harPath = join(dir, "timeout.har");
    const result = await record({
      url: app.url,
      harPath,
      headless: true,
      ...(browserPath && { executablePath: browserPath }),
      timeoutMs: 1500,
    });
    expect(result.stoppedBy).toBe("timeout");
    expect(parseHar(await readFile(harPath, "utf8")).length).toBeGreaterThan(0);
  });
});

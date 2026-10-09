/**
 * Record a browsing session to a HAR file with Playwright.
 *
 * The user drives a real browser window; every request and response body is
 * embedded in the HAR, which `generate` turns into a spec and SDKs. Recording
 * stops when the user closes the window, when the abort signal fires (Ctrl+C)
 * or when the optional time limit is reached.
 */

import type { Browser, LaunchOptions, Page } from "playwright-core";

export interface RecordOptions {
  url: string;
  /** Where the HAR is written. */
  harPath: string;
  headless?: boolean;
  /** Stop after this many milliseconds. */
  timeoutMs?: number;
  /** Browser executable. Default: $REVERSIO_BROWSER, then installed Chrome/Edge, then Playwright's Chromium. */
  executablePath?: string;
  /** Stop recording when aborted. */
  signal?: AbortSignal;
  /** Called for every finished request, e.g. for progress output. */
  onRequest?: (info: { method: string; url: string; status: number; resourceType: string }) => void;
}

export interface RecordResult {
  requests: number;
  stoppedBy: "closed" | "signal" | "timeout";
}

/** Launch attempts in order of preference. */
export function launchCandidates(executablePath?: string): { label: string; options: LaunchOptions }[] {
  const explicit = executablePath ?? process.env.REVERSIO_BROWSER;
  if (explicit) return [{ label: explicit, options: { executablePath: explicit } }];
  return [
    { label: "Google Chrome", options: { channel: "chrome" } },
    { label: "Microsoft Edge", options: { channel: "msedge" } },
    { label: "Playwright Chromium", options: {} },
  ];
}

/** Launch the first available browser. */
export async function launchBrowser(headless: boolean, executablePath?: string): Promise<Browser> {
  const { chromium } = await import("playwright-core");
  const failures: string[] = [];
  for (const candidate of launchCandidates(executablePath)) {
    try {
      // reversio handles Ctrl+C itself so the HAR can be flushed before the browser closes.
      return await chromium.launch({ ...candidate.options, headless, handleSIGINT: false });
    } catch (err) {
      failures.push(`${candidate.label}: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  throw new Error(
    `No usable browser found. Install Google Chrome, or pass --browser <path> (or set REVERSIO_BROWSER).\n` +
      failures.map((f) => `  - ${f}`).join("\n"),
  );
}

/** Open `url`, record until stopped, and write the HAR. */
export async function record(options: RecordOptions): Promise<RecordResult> {
  const browser = await launchBrowser(options.headless ?? false, options.executablePath);
  let requests = 0;
  let stoppedBy: RecordResult["stoppedBy"] = "closed";
  try {
    const context = await browser.newContext({
      recordHar: { path: options.harPath, content: "embed", mode: "full" },
    });
    context.on("requestfinished", (request) => {
      requests++;
      void request
        .response()
        .then((response) =>
          options.onRequest?.({
            method: request.method(),
            url: request.url(),
            status: response?.status() ?? 0,
            resourceType: request.resourceType(),
          }),
        )
        .catch(() => {});
    });

    let stop!: (reason: RecordResult["stoppedBy"]) => void;
    const stopped = new Promise<void>((resolve) => {
      let settled = false;
      stop = (reason) => {
        // Closing the context at the end fires page "close" events too; keep the first reason.
        if (settled) return;
        settled = true;
        stoppedBy = reason;
        resolve();
      };
    });
    const watchPage = (page: Page) => page.on("close", () => context.pages().length === 0 && stop("closed"));
    context.on("page", watchPage);
    browser.on("disconnected", () => stop("closed"));
    if (options.signal?.aborted) stop("signal");
    options.signal?.addEventListener("abort", () => stop("signal"));
    if (options.timeoutMs !== undefined) setTimeout(() => stop("timeout"), options.timeoutMs).unref();

    const page = await context.newPage();
    watchPage(page);
    await page.goto(options.url).catch((err: Error) => {
      // A window closed during navigation simply ends the session.
      if (browser.isConnected() && !page.isClosed()) throw err;
    });
    await stopped;

    // Closing the context flushes the HAR to disk.
    if (browser.isConnected()) await context.close();
    else throw new Error("The browser quit before the recording could be saved. Close the tab or window instead, or press Ctrl+C.");
  } finally {
    if (browser.isConnected()) await browser.close();
  }
  return { requests, stoppedBy };
}

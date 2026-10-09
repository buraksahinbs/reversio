#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { stringify as toYaml } from "yaml";
import { filterExchanges } from "./filter.js";
import { parseHar, type Exchange } from "./har.js";
import { buildOpenApi, type OpenApiDocument } from "./openapi.js";
import { generateTypeScriptSdk } from "./sdk/typescript.js";
import { loadSpec, readSpec } from "./spec.js";
import { verifyReplay, type VerifyReport } from "./verify.js";

const USAGE = `reversio — turn captured API traffic into an OpenAPI spec and a verified SDK

Usage:
  reversio generate <capture.har>... -o <dir>   Spec + TypeScript SDK + replay verification
  reversio openapi  <capture.har>... [-o file]  OpenAPI 3.1 spec only
  reversio sdk      <spec.yaml|json> -o client.ts
  reversio verify   <spec.yaml|json> <capture.har>...

Options:
  -o, --output <path>   Output file (openapi, sdk) or directory (generate).
      --host <host>     Only include this host (repeatable), e.g. api.example.com.
      --title <title>   API title in the spec.
      --class <name>    Class name of the generated client (default ApiClient).
      --examples        Include observed example values in the spec. Off by default
                        because captures can contain personal data and secrets.
      --yaml            openapi: print YAML instead of JSON on stdout.
      --json            verify: print the report as JSON.
      --strict          verify: also fail on recorded calls the spec does not cover.
  -h, --help            Show this help.

Capture a HAR from your browser: DevTools → Network → right click →
"Save all as HAR with content".
`;

const OPTIONS = {
  output: { type: "string", short: "o" },
  host: { type: "string", multiple: true },
  title: { type: "string" },
  class: { type: "string" },
  examples: { type: "boolean", default: false },
  yaml: { type: "boolean", default: false },
  json: { type: "boolean", default: false },
  strict: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

class UsageError extends Error {}

async function loadApiCalls(files: string[], values: Values): Promise<{ all: number; api: Exchange[] }> {
  if (files.length === 0) throw new UsageError("No HAR file given.");
  const exchanges: Exchange[] = [];
  for (const file of files) exchanges.push(...parseHar(await readFile(file, "utf8")));
  const api = filterExchanges(exchanges, values.host ? { hosts: values.host } : {});
  if (api.length === 0) {
    throw new Error(
      `No API calls found among ${exchanges.length} requests. ` +
        `Make sure the HAR includes response bodies ("Save all as HAR with content").`,
    );
  }
  return { all: exchanges.length, api };
}

function specFrom(api: Exchange[], values: Values): OpenApiDocument {
  return buildOpenApi(api, {
    examples: values.examples,
    ...(values.title !== undefined && { title: values.title }),
  });
}

function countOperations(doc: OpenApiDocument): number {
  return Object.values(doc.paths as Record<string, object>).reduce(
    (n, item) => n + Object.keys(item).filter((k) => k !== "servers").length,
    0,
  );
}

function formatReport(report: VerifyReport): string {
  const lines: string[] = [];
  for (const op of report.operations) {
    if (op.samples === 0) {
      lines.push(`  -    ${op.method} ${op.path}  (no recorded calls)`);
      continue;
    }
    const mark = op.passed === op.samples ? "ok  " : "FAIL";
    lines.push(`  ${mark} ${op.method} ${op.path}  ${op.passed}/${op.samples}`);
    for (const f of op.failures.slice(0, 5)) lines.push(`         - ${f.reason}${f.count > 1 ? ` (×${f.count})` : ""}`);
  }
  if (report.unmatched.length > 0) {
    const distinct = [...new Set(report.unmatched.map((u) => `${u.method} ${u.url}`))];
    lines.push(`  Not covered by the spec (${report.unmatched.length} calls):`);
    for (const u of distinct.slice(0, 10)) lines.push(`         ${u}`);
    if (distinct.length > 10) lines.push(`         … and ${distinct.length - 10} more`);
  }
  lines.push(`Replay: ${report.passed}/${report.total} recorded calls reproduced by the SDK`);
  return lines.join("\n") + "\n";
}

function verifyExitCode(report: VerifyReport, strict: boolean): number {
  return report.passed < report.total || (strict && report.unmatched.length > 0) ? 1 : 0;
}

async function runOpenApi(files: string[], values: Values): Promise<number> {
  const { all, api } = await loadApiCalls(files, values);
  const doc = specFrom(api, values);
  const asYaml = values.output ? /\.ya?ml$/i.test(values.output) : values.yaml;
  const text = asYaml ? toYaml(doc, { aliasDuplicateObjects: false }) : JSON.stringify(doc, null, 2) + "\n";
  const summary = `${all} requests → ${api.length} API calls → ${countOperations(doc)} operations`;
  if (values.output) {
    await writeFile(values.output, text);
    process.stderr.write(`${summary}\nWrote ${values.output}\n`);
  } else {
    process.stdout.write(text);
    process.stderr.write(`${summary}\n`);
  }
  return 0;
}

async function runSdk(files: string[], values: Values): Promise<number> {
  if (files.length !== 1) throw new UsageError("sdk takes exactly one spec file.");
  const spec = loadSpec(await readFile(files[0]!, "utf8"));
  const source = generateTypeScriptSdk(spec, values.class ? { className: values.class } : {});
  if (values.output) {
    await writeFile(values.output, source);
    process.stderr.write(`${spec.operations.length} operations → ${values.output}\n`);
  } else {
    process.stdout.write(source);
  }
  return 0;
}

async function runVerify(files: string[], values: Values): Promise<number> {
  const [specFile, ...hars] = files;
  if (!specFile || hars.length === 0) throw new UsageError("verify takes a spec file and at least one HAR file.");
  const spec = loadSpec(await readFile(specFile, "utf8"));
  const { api } = await loadApiCalls(hars, values);
  const report = await verifyReplay(spec, api);
  process.stdout.write(values.json ? JSON.stringify(report, null, 2) + "\n" : formatReport(report));
  return verifyExitCode(report, values.strict);
}

async function runGenerate(files: string[], values: Values): Promise<number> {
  if (!values.output) throw new UsageError("generate needs an output directory: -o <dir>");
  const { all, api } = await loadApiCalls(files, values);
  const doc = specFrom(api, values);
  const spec = readSpec(doc);
  const source = generateTypeScriptSdk(spec, values.class ? { className: values.class } : {});
  const report = await verifyReplay(spec, api, source);

  await mkdir(values.output, { recursive: true });
  await writeFile(join(values.output, "openapi.yaml"), toYaml(doc, { aliasDuplicateObjects: false }));
  await writeFile(join(values.output, "client.ts"), source);
  await writeFile(join(values.output, "verify-report.json"), JSON.stringify(report, null, 2) + "\n");

  process.stderr.write(
    `${all} requests → ${api.length} API calls → ${countOperations(doc)} operations\n` + formatReport(report),
  );
  process.stderr.write(`Wrote ${join(values.output, "openapi.yaml")}, client.ts, verify-report.json\n`);
  return verifyExitCode(report, values.strict);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "-h" || command === "--help") {
    process.stdout.write(USAGE);
    return command === undefined ? 2 : 0;
  }
  const commands: Record<string, (files: string[], values: Values) => Promise<number>> = {
    generate: runGenerate,
    openapi: runOpenApi,
    sdk: runSdk,
    verify: runVerify,
  };
  const run = commands[command];
  if (!run) throw new UsageError(`Unknown command: ${command}`);

  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: OPTIONS });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  return run(positionals, values);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`reversio: ${message}\n${err instanceof UsageError ? `\n${USAGE}` : ""}`);
    process.exitCode = err instanceof UsageError ? 2 : 1;
  },
);

#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { stringify as toYaml } from "yaml";
import { filterExchanges } from "./filter.js";
import { parseHar, type Exchange } from "./har.js";
import { buildOpenApi } from "./openapi.js";

const USAGE = `reversio — turn captured API traffic into an OpenAPI spec

Usage:
  reversio openapi <capture.har>... [options]

Options:
  -o, --output <file>   Write the spec to a file (.yaml/.yml → YAML, otherwise JSON).
                        Default: JSON on stdout.
      --yaml            Print YAML instead of JSON on stdout.
      --host <host>     Only include this host (repeatable), e.g. api.example.com.
      --title <title>   API title in the spec.
      --examples        Include observed example values. Off by default because
                        captures can contain personal data and secrets.
  -h, --help            Show this help.

Capture a HAR from your browser: DevTools → Network → right click → "Save all as HAR".
`;

async function runOpenApi(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o" },
      yaml: { type: "boolean", default: false },
      host: { type: "string", multiple: true },
      title: { type: "string" },
      examples: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || positionals.length === 0) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 2;
  }

  const exchanges: Exchange[] = [];
  for (const file of positionals) {
    exchanges.push(...parseHar(await readFile(file, "utf8")));
  }
  const api = filterExchanges(exchanges, values.host ? { hosts: values.host } : {});
  if (api.length === 0) {
    process.stderr.write(
      `No API calls found among ${exchanges.length} requests. ` +
        `Make sure the HAR includes response bodies ("Save all as HAR with content").\n`,
    );
    return 1;
  }

  const doc = buildOpenApi(api, {
    examples: values.examples,
    ...(values.title !== undefined && { title: values.title }),
  });
  const asYaml = values.output ? /\.ya?ml$/i.test(values.output) : values.yaml;
  const text = asYaml ? toYaml(doc, { aliasDuplicateObjects: false }) : JSON.stringify(doc, null, 2) + "\n";

  const operations = Object.values(doc.paths as Record<string, object>).reduce(
    (n, item) => n + Object.keys(item).filter((k) => k !== "servers").length,
    0,
  );
  const summary = `${exchanges.length} requests → ${api.length} API calls → ${operations} operations`;
  if (values.output) {
    await writeFile(values.output, text);
    process.stderr.write(`${summary}\nWrote ${values.output}\n`);
  } else {
    process.stdout.write(text);
    process.stderr.write(`${summary}\n`);
  }
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "openapi":
      return runOpenApi(rest);
    case undefined:
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(USAGE);
      return command === undefined ? 2 : 0;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`reversio: ${message}\n`);
    process.exitCode = 1;
  },
);

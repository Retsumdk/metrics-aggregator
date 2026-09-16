/**
 * Dependency-free command line interface.
 *
 * Built on `node:util`'s `parseArgs` rather than a CLI framework: the parsing
 * this tool needs (repeated flags, `--flag=value`, `--no-*` booleans, positional
 * files) is covered by the standard library, and a metrics tool that pulls in a
 * dependency tree just to print `--help` is hard to run on a locked-down host.
 *
 * Exit codes: `0` success, `1` runtime failure, `2` usage error.
 */

import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { aggregate, AGGREGATOR_NAMES } from "./aggregate.ts";
import type { AggregatorName } from "./types.ts";
import { encodeExposition } from "./encoder.ts";
import { ParseError, parseExposition } from "./parser.ts";
import { scrapeAll } from "./scrape.ts";
import { startServer } from "./server.ts";
import { VERSION } from "./version.ts";
import type {
  AggregateOptions,
  ConflictPolicy,
  Labels,
  MetadataMap,
  Series,
  TargetSpec,
} from "./types.ts";

/**
 * Diagnostics go straight to `process.stderr` rather than through
 * `console.error`: Bun's `console.error` writes to the real descriptor and
 * ignores a patched `process.stderr.write`, which would make the CLI's own
 * output untestable.
 */
function warnTo(message: string): void {
  process.stderr.write(`${message}\n`);
}

const USAGE = `metrics-aggregator ${VERSION} — Prometheus-compatible metrics aggregation

Usage: metrics-aggregator <command> [options]

Commands:
  aggregate [files...]   Parse exposition text and aggregate it
  parse [files...]       Parse exposition text and report what is inside
  serve                  Run the HTTP service (/metrics, /api/*, push endpoints)
  push                   Push exposition text to a running server
  fetch                  Fetch /metrics from a running server and print it
  help                   Show this message

Input:
  files…                 Read these files (omit or use "-" for stdin)
  --url <url>            Scrape this URL instead (repeatable)
  --header <k: v>        Header for --url requests (repeatable)
  --bearer <token>       Authorization: Bearer <token> for --url requests
  --basic <user:pass>    Authorization: Basic for --url requests
  --timeout <ms>         Per-request timeout (default 10000)
  --retries <n>          Retries per URL (default 2)

Aggregation:
  --agg <name>           Aggregator: ${AGGREGATOR_NAMES.join(", ")} (repeatable, default sum)
  --by <a,b>             Keep only these labels
  --without <a,b>        Drop these labels
  --drop-labels <a,b>    Drop these labels from the output but keep grouping on them
  --name <name>          Output metric name (default: input family name)
  --label <k=v>          Static label to add (repeatable)
  --conflict <policy>    keep | newest | error (default keep)
  --merge                push: merge into the group instead of replacing it
  --keep-quantiles       Keep summary quantiles (approximated) instead of dropping
  --openmetrics          Emit OpenMetrics framing (# UNIT, # EOF)

Server (serve):
  --port <n>             Port (default 9137, 0 picks a free port)
  --host <addr>          Bind address (default 127.0.0.1)
  --token <token>        Bearer token required by every write endpoint
  --target <url>         Scrape target (repeatable)
  --target-name <name>   Name for the preceding --target
  --interval <ms>        Scrape interval (default 15000 when targets are set)
  --push-ttl <ms>        Expire push groups idle for longer than this

Output:
  --out <file>           Write output to a file instead of stdout
  --json                 Emit JSON (parse, aggregate stats, serve status)
  --strict               Treat any parse warning as a failure
  --quiet                Suppress progress logging
  -h, --help             Show this message
  -v, --version          Show the version

Examples:
  cat metrics.txt | metrics-aggregator aggregate --by service,region --agg sum
  metrics-aggregator serve --port 9137 --target http://127.0.0.1:9100/metrics
  metrics-aggregator parse examples/cluster-metrics.txt --json
`;

interface Flags {
  url: string[];
  header: string[];
  bearer?: string;
  basic?: string;
  timeout?: string;
  retries?: string;
  agg: string[];
  by?: string;
  without?: string;
  "drop-labels"?: string;
  name?: string;
  label: string[];
  conflict?: string;
  merge?: boolean;
  "keep-quantiles"?: boolean;
  openmetrics?: boolean;
  port?: string;
  host?: string;
  token?: string;
  target: string[];
  "target-name"?: string;
  interval?: string;
  "push-ttl"?: string;
  out?: string;
  json?: boolean;
  strict?: boolean;
  quiet?: boolean;
  help?: boolean;
  version?: boolean;
}

class UsageError extends Error {}

function parse(argv: string[]): { command: string; positionals: string[]; flags: Flags } {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        url: { type: "string", multiple: true, default: [] },
        header: { type: "string", multiple: true, default: [] },
        bearer: { type: "string" },
        basic: { type: "string" },
        timeout: { type: "string" },
        retries: { type: "string" },
        agg: { type: "string", multiple: true, default: [] },
        by: { type: "string" },
        without: { type: "string" },
        "drop-labels": { type: "string" },
        name: { type: "string" },
        label: { type: "string", multiple: true, default: [] },
        conflict: { type: "string" },
        merge: { type: "boolean" },
        "keep-quantiles": { type: "boolean" },
        openmetrics: { type: "boolean" },
        port: { type: "string" },
        host: { type: "string" },
        token: { type: "string" },
        target: { type: "string", multiple: true, default: [] },
        "target-name": { type: "string" },
        interval: { type: "string" },
        "push-ttl": { type: "string" },
        out: { type: "string" },
        json: { type: "boolean" },
        strict: { type: "boolean" },
        quiet: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const positionals = parsed.positionals;
  const command = positionals[0] ?? "help";
  return {
    command,
    positionals: positionals.slice(1),
    flags: parsed.values as unknown as Flags,
  };
}

function integerFlag(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new UsageError(`--${name} must be a non-negative integer`);
  return value;
}

function labelList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const names = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  return names.length === 0 ? undefined : names;
}

function parseKeyValues(pairs: readonly string[]): Labels {
  const labels: Labels = {};
  for (const pair of pairs) {
    const index = pair.indexOf("=");
    if (index <= 0) throw new UsageError(`--label expects NAME=VALUE, got "${pair}"`);
    const name = pair.slice(0, index).trim();
    labels[name] = pair.slice(index + 1);
  }
  return labels;
}

function parseConflict(raw: string | undefined): ConflictPolicy | undefined {
  if (raw === undefined) return undefined;
  if (raw !== "keep" && raw !== "newest" && raw !== "error") {
    throw new UsageError(`--conflict must be keep, newest or error (got "${raw}")`);
  }
  return raw;
}

function parseHeaders(entries: readonly string[]): Record<string, string> | undefined {
  if (entries.length === 0) return undefined;
  const headers: Record<string, string> = {};
  for (const entry of entries) {
    const index = entry.indexOf(":");
    if (index <= 0) throw new UsageError(`--header expects "Name: value", got "${entry}"`);
    headers[entry.slice(0, index).trim()] = entry.slice(index + 1).trim();
  }
  return headers;
}

function aggregateOptionsFrom(flags: Flags): AggregateOptions {
  const aggregators = flags.agg
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "") as AggregatorName[];
  for (const name of aggregators) {
    if (!(AGGREGATOR_NAMES as readonly string[]).includes(name)) {
      throw new UsageError(`unknown aggregator "${name}"; valid: ${AGGREGATOR_NAMES.join(", ")}`);
    }
  }
  const by = labelList(flags.by);
  const without = labelList(flags.without);
  if (by !== undefined && without !== undefined) {
    throw new UsageError("--by and --without are mutually exclusive");
  }
  const options: AggregateOptions = {};
  if (aggregators.length > 0) options.aggregators = aggregators;
  if (by !== undefined) options.by = by;
  if (without !== undefined) options.without = without;
  const dropLabels = labelList(flags["drop-labels"]);
  if (dropLabels !== undefined) options.dropLabels = dropLabels;
  if (flags.name !== undefined) options.name = flags.name;
  const label = parseKeyValues(flags.label);
  if (Object.keys(label).length > 0) options.label = label;
  const conflict = parseConflict(flags.conflict);
  if (conflict !== undefined) options.conflictPolicy = conflict;
  // `--keep-quantiles` opt-in: quantiles are dropped by default because they
  // cannot be combined across populations.
  if (flags["keep-quantiles"] === true) options.dropQuantiles = false;
  return options;
}

/** Read every input source in order; `-` (the default) means stdin. */
/**
 * Read every input as its own document.
 *
 * Each source is a complete exposition document, so they are parsed separately
 * and their metadata merged. Concatenating them into one buffer would make the
 * second file's `# HELP` / `# TYPE` lines look like duplicates of the first
 * file's, which is not what happened on disk.
 */
function readInputs(files: readonly string[]): { source: string; text: string }[] {
  const sources = files.length === 0 ? ["-"] : files;
  const documents: { source: string; text: string }[] = [];
  for (const source of sources) {
    if (source === "-") {
      documents.push({ source: "<stdin>", text: readFileSync(0, "utf-8") });
    } else {
      documents.push({ source, text: readFileSync(resolve(source), "utf-8") });
    }
  }
  return documents;
}

async function collectInputs(
  files: readonly string[],
  flags: Flags,
): Promise<{ series: Series[]; metadata: MetadataMap; sources: string[]; warnings: string[] }> {
  const warnings: string[] = [];
  let series: Series[] = [];
  let metadata: MetadataMap = new Map();
  const sources: string[] = [];

  const fromUrls = flags.url.length > 0;
  if (!fromUrls || files.length > 0) {
    for (const document of readInputs(files)) {
      const parsed = parseExposition(document.text, { strict: flags.strict ?? false });
      series.push(...parsed.series);
      for (const [name, entry] of parsed.metadata) {
        if (!metadata.has(name)) metadata.set(name, entry);
      }
      sources.push(document.source);
      for (const warning of parsed.warnings) {
        warnings.push(`${document.source}:${warning.line}:${warning.column} ${warning.message}`);
      }
    }
  }

  if (fromUrls) {
    const specs: TargetSpec[] = flags.url.map((url) => {
      const spec: TargetSpec = { url };
      const headers = parseHeaders(flags.header);
      if (headers !== undefined) spec.headers = headers;
      if (flags.bearer !== undefined) spec.bearer = flags.bearer;
      if (flags.basic !== undefined) {
        const index = flags.basic.indexOf(":");
        if (index <= 0) throw new UsageError('--basic expects "user:password"');
        spec.basic = { username: flags.basic.slice(0, index), password: flags.basic.slice(index + 1) };
      }
      spec.timeoutMs = integerFlag(flags.timeout, 10_000, "timeout");
      spec.retries = integerFlag(flags.retries, 2, "retries");
      return spec;
    });
    const results = await scrapeAll(specs);
    for (const result of results) {
      sources.push(result.target.url);
      if (!result.ok) {
        warnings.push(`${result.target.url}: ${result.error ?? "scrape failed"}`);
        continue;
      }
      series.push(...result.series);
      for (const [name, entry] of result.metadata) {
        if (!metadata.has(name)) metadata.set(name, entry);
      }
      warnings.push(...result.warnings.map((warning) => `${warning.line}:${warning.column} ${warning.message}`));
    }
  }

  return { series, metadata, sources, warnings };
}

function writeOut(text: string, out: string | undefined): void {
  if (out === undefined) {
    process.stdout.write(text);
    return;
  }
  writeFileSync(resolve(out), text);
}

function requireToken(flags: Flags): string {
  const token = flags.token ?? process.env.METRICS_AGGREGATOR_TOKEN;
  if (token === undefined || token === "") {
    throw new UsageError("this command needs --token (or $METRICS_AGGREGATOR_TOKEN)");
  }
  return token;
}

async function commandAggregate(files: string[], flags: Flags): Promise<number> {
  const options = aggregateOptionsFrom(flags);
  const { series, metadata, sources, warnings } = await collectInputs(files, flags);
  const result = aggregate(series, metadata, options);
  const body = encodeExposition(result.series, result.metadata, {
    openMetrics: flags.openmetrics ?? false,
  });
  if (flags.json === true) {
    writeOut(
      `${JSON.stringify(
        {
          sources,
          inputSeries: series.length,
          outputSeries: result.series.length,
          stats: result.stats,
          warnings: [...warnings, ...result.stats.warnings],
          series: result.series,
        },
        null,
        2,
      )}\n`,
      flags.out,
    );
  } else {
    writeOut(body, flags.out);
  }
  if (flags.quiet !== true) {
    const breakdown = Object.entries(result.stats.perAggregator)
      .map(([name, count]) => `${name}=${count}`)
      .join(" ");
    const summary = `${sources.join(", ")}: ${series.length} in → ${result.series.length} out (${breakdown})`;
    warnTo(summary);
    for (const warning of [...warnings, ...result.stats.warnings]) warnTo(`warning: ${warning}`);
  }
  return 0;
}

async function commandParse(files: string[], flags: Flags): Promise<number> {
  const { series, metadata, sources, warnings } = await collectInputs(files, flags);
  const families = [...metadata.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (flags.json === true) {
    writeOut(
      `${JSON.stringify(
        {
          sources,
          series: series.length,
          warnings,
          families: families.map(([name, entry]) => ({ name, ...entry })),
          samples: series,
        },
        null,
        2,
      )}\n`,
      flags.out,
    );
  } else {
    const lines = [
      `sources: ${sources.join(", ")}`,
      `series: ${series.length}`,
      `families: ${families.length}`,
      ...families.map(([name, entry]) => `  ${name} (${entry.type ?? "untyped"})${entry.help ? ` — ${entry.help}` : ""}`),
      ...warnings.map((warning) => `warning: ${warning}`),
    ];
    writeOut(`${lines.join("\n")}\n`, flags.out);
  }
  if (flags.strict === true && warnings.length > 0) {
    warnTo(`strict mode: ${warnings.length} warning(s)`);
    return 1;
  }
  return 0;
}

async function commandServe(flags: Flags): Promise<number> {
  const port = integerFlag(flags.port, 9137, "port");
  const targets: TargetSpec[] = flags.target.map((url) => {
    const spec: TargetSpec = { url };
    if (flags["target-name"] !== undefined) spec.name = flags["target-name"];
    const headers = parseHeaders(flags.header);
    if (headers !== undefined) spec.headers = headers;
    if (flags.bearer !== undefined) spec.bearer = flags.bearer;
    return spec;
  });
  const options: Parameters<typeof startServer>[0] = {
    port,
    host: flags.host ?? "127.0.0.1",
    aggregate: aggregateOptionsFrom(flags),
    quiet: flags.quiet ?? false,
  };
  if (flags.token !== undefined) options.token = flags.token;
  if (targets.length > 0) options.targets = targets;
  if (flags.interval !== undefined) options.scrapeIntervalMs = integerFlag(flags.interval, 15_000, "interval");
  if (flags["push-ttl"] !== undefined) options.pushTtlMs = integerFlag(flags["push-ttl"], 0, "push-ttl");
  if (flags.openmetrics === true) options.openMetrics = true;

  const running = await startServer(options);
  if (flags.quiet !== true) {
    warnTo(`metrics-aggregator ${VERSION} listening on ${running.url}`);
    warnTo(`  scrape endpoint : ${running.url}/metrics`);
    warnTo(`  health          : ${running.url}/-/healthy`);
    warnTo(`  push            : PUT ${running.url}/metrics/job/<job>`);
    if (flags.token === undefined) {
      warnTo("  warning: no --token set, so push and aggregate endpoints are unauthenticated");
    }
  }

  const shutdown = (): void => {
    void running.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise<void>(() => undefined);
  return 0;
}

async function commandPush(files: string[], flags: Flags): Promise<number> {
  const base = flags.url[0];
  if (base === undefined) throw new UsageError("push needs --url with the target server, e.g. --url http://127.0.0.1:9137");
  const job = flags.target[0];
  if (job === undefined) throw new UsageError("push needs --target with the job name, e.g. --target db-backup");
  const token = requireToken(flags);
  const text = readInputs(files)
    .map((document) => document.text)
    .join("\n");
  const mode = flags.merge === true ? "POST" : "PUT";
  const url = new URL(`/metrics/job/${encodeURIComponent(job)}`, base);
  const response = await fetch(url, {
    method: mode,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "text/plain; charset=utf-8",
    },
    body: text,
  });
  const body = await response.text();
  if (!response.ok) {
    warnTo(`push failed (${response.status}): ${body}`);
    return 1;
  }
  if (flags.quiet !== true) process.stdout.write(`${body.trim()}\n`);
  return 0;
}

async function commandFetch(flags: Flags): Promise<number> {
  const base = flags.url[0];
  if (base === undefined) throw new UsageError("fetch needs --url with the target server");
  const url = new URL("/metrics", base);
  const response = await fetch(url, {
    headers: { accept: flags.openmetrics === true ? "application/openmetrics-text" : "text/plain" },
  });
  const body = await response.text();
  if (!response.ok) {
    warnTo(`fetch failed (${response.status}): ${body}`);
    return 1;
  }
  if (flags.json === true) {
    const parsed = parseExposition(body, { strict: false });
    writeOut(`${JSON.stringify({ series: parsed.series.length, samples: parsed.series }, null, 2)}\n`, flags.out);
    return 0;
  }
  writeOut(body, flags.out);
  return 0;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let parsed: { command: string; positionals: string[]; flags: Flags };
  try {
    parsed = parse([...argv]);
  } catch (error) {
    warnTo(error instanceof Error ? error.message : String(error));
    warnTo(USAGE);
    return 2;
  }

  const { command, positionals, flags } = parsed;
  // `--version` wins over the implicit help command, so `tool --version` prints
  // the version rather than the whole usage banner.
  if (flags.version === true) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (flags.help === true || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  try {
    switch (command) {
      case "aggregate":
        return await commandAggregate(positionals, flags);
      case "parse":
      case "check":
        return await commandParse(positionals, flags);
      case "serve":
        return await commandServe(flags);
      case "push":
        return await commandPush(positionals, flags);
      case "fetch":
      case "export":
        return await commandFetch(flags);
      default:
        warnTo(`unknown command "${command}"`);
        warnTo(USAGE);
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      warnTo(error.message);
      return 2;
    }
    if (error instanceof ParseError) {
      warnTo(`parse error — ${error.message}`);
      return 1;
    }
    warnTo(error instanceof Error ? error.stack ?? error.message : String(error));
    return 1;
  }
}

/**
 * Run when this file is the program entry point, and stay silent when it is
 * imported (the tests import `main` directly). Bun exposes `import.meta.main`;
 * Node does not, so fall back to comparing `argv[1]` with this module's URL.
 */
function invokedDirectly(): boolean {
  const main = (import.meta as { main?: unknown }).main;
  if (typeof main === "boolean") return main;
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = await main();
}

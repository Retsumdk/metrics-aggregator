/**
 * CLI behaviour, driven through `main(argv)` rather than a shell so the tests
 * can assert exact exit codes and read the files the tool writes.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { startServer, type RunningServer } from "../src/index.ts";
import { VERSION } from "../src/version.ts";

const TOKEN = "cli-test-token";

/**
 * Capture one of the process streams for the duration of a test. `main()` writes
 * its output straight to `process.stdout`, so this is the only way to assert on
 * it without spawning a child process.
 */
function capture(stream: "stdout" | "stderr"): { text(): string; restore(): void } {
  const target = process[stream];
  const original = target.write.bind(target);
  let buffer = "";
  target.write = ((chunk: string | Uint8Array): boolean => {
    buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof target.write;
  return {
    text: () => buffer,
    restore: () => {
      target.write = original;
    },
  };
}

const captureStdout = (): ReturnType<typeof capture> => capture("stdout");
const captureStderr = (): ReturnType<typeof capture> => capture("stderr");
const directory = mkdtempSync(join(tmpdir(), "metrics-aggregator-cli-"));

const DOCUMENT = [
  "# HELP api_requests_total Requests served.",
  "# TYPE api_requests_total counter",
  'api_requests_total{service="api",region="us-east",pod="a"} 10',
  'api_requests_total{service="api",region="us-east",pod="b"} 15',
  'api_requests_total{service="api",region="eu-west",pod="c"} 5',
  "# TYPE queue_depth gauge",
  'queue_depth{service="api",region="us-east",pod="a"} 4',
  'queue_depth{service="api",region="us-east",pod="b"} 6',
  "",
].join("\n");

let input = "";
const outPath = join(directory, "out.txt");

beforeAll(() => {
  input = join(directory, "input.txt");
  writeFileSync(input, DOCUMENT);
});

describe("CLI — aggregate", () => {
  test("aggregates a file, keeps the family name and reports the breakdown", async () => {
    const code = await main(["aggregate", input, "--by", "service,region", "--out", outPath, "--quiet"]);
    expect(code).toBe(0);
    const out = readFileSync(outPath, "utf8");
    expect(out).toContain('api_requests_total{region="eu-west",service="api"} 5');
    expect(out).toContain('api_requests_total{region="us-east",service="api"} 25');
    expect(out).toContain('queue_depth{region="us-east",service="api"} 10');
  });

  test("--agg selects the aggregator and --name renames the family", async () => {
    const code = await main([
      "aggregate",
      input,
      "--by",
      "region",
      "--agg",
      "max",
      "--name",
      "cluster_requests_max",
      "--out",
      outPath,
      "--quiet",
    ]);
    expect(code).toBe(0);
    const out = readFileSync(outPath, "utf8");
    expect(out).toContain('cluster_requests_max{region="eu-west"} 5');
    expect(out).toContain('cluster_requests_max{region="us-east"} 15');
  });

  test("--label adds a static label without splitting the group", async () => {
    const code = await main([
      "aggregate",
      input,
      "--by",
      "region",
      "--label",
      "cluster=prod",
      "--out",
      outPath,
      "--quiet",
    ]);
    expect(code).toBe(0);
    expect(readFileSync(outPath, "utf8")).toContain('api_requests_total{cluster="prod",region="us-east"} 25');
  });

  test("--json emits a machine-readable envelope", async () => {
    const code = await main(["aggregate", input, "--by", "region", "--json", "--out", outPath, "--quiet"]);
    expect(code).toBe(0);
    const payload = JSON.parse(readFileSync(outPath, "utf8")) as {
      sources: string[];
      inputSeries: number;
      outputSeries: number;
      stats: { groups: number };
      series: { name: string; value: number }[];
    };
    expect(payload.sources).toEqual([input]);
    expect(payload.inputSeries).toBe(5);
    // Two families by two regions, minus the (family, region) pair that has no
    // samples: `queue_depth` was never reported for eu-west.
    expect(payload.outputSeries).toBe(3);
    expect(payload.stats.groups).toBe(3);
  });

  test("summary quantiles are dropped, and the run says so", async () => {
    const summary = join(directory, "summary.txt");
    writeFileSync(
      summary,
      [
        "# TYPE payload_bytes summary",
        'payload_bytes{instance="a",quantile="0.5"} 1024',
        'payload_bytes{instance="a",quantile="0.99"} 65536',
        'payload_bytes_sum{instance="a"} 6.1e6',
        'payload_bytes_count{instance="a"} 120',
        "",
      ].join("\n"),
    );
    const code = await main(["aggregate", summary, "--without", "instance", "--out", outPath, "--quiet"]);
    expect(code).toBe(0);
    const out = readFileSync(outPath, "utf8");
    expect(out).not.toContain("quantile=");
    expect(out).toContain("payload_bytes_sum 6100000");
    expect(out).toContain("payload_bytes_count 120");
  });

  test("--conflict error turns a conflicting duplicate into a failure", async () => {
    const duplicated = join(directory, "duplicated.txt");
    writeFileSync(duplicated, 'm{instance="a"} 1\nm{instance="a"} 2\n');
    expect(await main(["aggregate", duplicated, "--without", "instance", "--out", outPath, "--quiet"])).toBe(0);
    expect(
      await main(["aggregate", duplicated, "--without", "instance", "--conflict", "error", "--out", outPath, "--quiet"]),
    ).toBe(1);
  });

  test("a missing file fails instead of silently producing an empty document", async () => {
    expect(await main(["aggregate", join(directory, "nope.txt"), "--out", outPath, "--quiet"])).toBe(1);
  });
});

describe("CLI — parse", () => {
  test("reports families and exits 0", async () => {
    expect(await main(["parse", input, "--out", outPath, "--quiet"])).toBe(0);
    const report = readFileSync(outPath, "utf8");
    expect(report).toContain("families: 2");
    expect(report).toContain("api_requests_total (counter)");
  });

  test("--strict turns a malformed line into exit 1", async () => {
    const broken = join(directory, "broken.txt");
    writeFileSync(broken, 'm{a="1"} 1\nm{broken} 2\n');
    expect(await main(["parse", broken, "--out", outPath, "--quiet"])).toBe(0);
    expect(await main(["parse", broken, "--strict", "--out", outPath, "--quiet"])).toBe(1);
  });
});

describe("CLI — usage", () => {
  test("help and --version succeed", async () => {
    expect(await main(["help"])).toBe(0);
    expect(await main(["--version"])).toBe(0);
  });

  test("an unknown command and a bad flag value exit 2", async () => {
    expect(await main(["frobnicate"])).toBe(2);
    expect(await main(["aggregate", input, "--agg", "median", "--quiet"])).toBe(2);
    expect(await main(["aggregate", input, "--by", "region", "--without", "pod", "--quiet"])).toBe(2);
  });

  test("write commands refuse to run without a token", async () => {
    expect(await main(["push", input, "--url", "http://127.0.0.1:1", "--target", "job", "--quiet"])).toBe(2);
  });
});

describe("CLI — push and fetch against a live server", () => {
  let server: RunningServer;

  beforeAll(async () => {
    server = await startServer({ port: 0, host: "127.0.0.1", token: TOKEN, quiet: true });
  });

  afterAll(async () => {
    await server.stop();
  });

  test("push stores a group and fetch reads /metrics back", async () => {
    const code = await main([
      "push",
      input,
      "--url",
      server.url,
      "--target",
      "nightly",
      "--token",
      TOKEN,
      "--quiet",
    ]);
    expect(code).toBe(0);

    const listing = (await (await fetch(`${server.url}/api/series`)).json()) as { count: number };
    expect(listing.count).toBe(5);

    const fetched = join(directory, "fetched.txt");
    expect(await main(["fetch", "--url", server.url, "--out", fetched, "--quiet"])).toBe(0);
    expect(readFileSync(fetched, "utf8")).toContain("api_requests_total");
  });

  test("push --merge appends instead of replacing", async () => {
    const extra = join(directory, "extra.txt");
    writeFileSync(extra, 'api_requests_total{service="api",region="us-east",pod="d"} 1\n');
    expect(
      await main(["push", extra, "--url", server.url, "--target", "nightly", "--merge", "--token", TOKEN, "--quiet"]),
    ).toBe(0);
    const listing = (await (await fetch(`${server.url}/api/series`)).json()) as { count: number };
    expect(listing.count).toBe(6);
  });

  test("a rejected push reports a failure exit code", async () => {
    expect(await main(["push", input, "--url", server.url, "--target", "x", "--token", "wrong", "--quiet"])).toBe(1);
  });
});

describe("CLI — version string", () => {
  test("the usage banner carries the version", async () => {
    await main(["help"]);
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("--version prints the bare version, not the usage banner", async () => {
    const captured = captureStdout();
    try {
      expect(await main(["--version"])).toBe(0);
      expect(captured.text()).toBe(`${VERSION}\n`);
    } finally {
      captured.restore();
    }
  });

  test("-v is the same as --version", async () => {
    const captured = captureStdout();
    try {
      expect(await main(["-v"])).toBe(0);
      expect(captured.text()).toBe(`${VERSION}\n`);
    } finally {
      captured.restore();
    }
  });

  test("an unknown command exits 2 with the usage banner", async () => {
    const errors = captureStderr();
    try {
      expect(await main(["frobnicate"])).toBe(2);
      expect(errors.text()).toContain("unknown command");
    } finally {
      errors.restore();
    }
  });
});

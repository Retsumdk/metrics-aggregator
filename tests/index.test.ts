/**
 * The public surface, plus two guards that protect the repository itself:
 * the published version must match the CLI/API version, and no file that ships
 * to GitHub may mention anything other than Retsumdk.
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  AGGREGATOR_NAMES,
  AggregateConfigError,
  EncodeError,
  MetricStore,
  ParseError,
  ScrapeError,
  StoreError,
  VERSION,
  aggregate,
  encodeExposition,
  formatValue,
  main,
  metadataFor,
  parseExposition,
  parseSeries,
  scrapeTarget,
  startServer,
} from "../src/index.ts";

describe("public API", () => {
  test("exports every documented entry point", () => {
    const surface = {
      AGGREGATOR_NAMES,
      AggregateConfigError,
      EncodeError,
      MetricStore,
      ParseError,
      ScrapeError,
      StoreError,
      VERSION,
      aggregate,
      encodeExposition,
      formatValue,
      main,
      metadataFor,
      parseExposition,
      parseSeries,
      scrapeTarget,
      startServer,
    };
    for (const [name, value] of Object.entries(surface)) {
      expect(value, `${name} should be exported`).toBeDefined();
    }
    expect(AGGREGATOR_NAMES).toContain("sum");
    expect(AGGREGATOR_NAMES.length).toBe(10);
  });

  test("the reported version matches package.json, so a release cannot drift", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(VERSION).toBe(manifest.version);
  });

  test("an exposition document survives a parse → aggregate → encode round trip", () => {
    const source = [
      "# HELP api_requests_total Requests served.",
      "# TYPE api_requests_total counter",
      'api_requests_total{service="api",pod="a"} 10',
      'api_requests_total{service="api",pod="b"} 15',
      'queue_depth{service="api",pod="a"} 4',
      'queue_depth{service="api",pod="b"} 6',
      "",
    ].join("\n");
    const parsed = parseExposition(source);
    const result = aggregate(parsed.series, parsed.metadata, { without: ["pod"] });
    const out = encodeExposition(result.series, result.metadata);

    expect(out).toBe(
      [
        "# HELP api_requests_total Requests served.",
        "# TYPE api_requests_total counter",
        'api_requests_total{service="api"} 25',
        'queue_depth{service="api"} 10',
        "",
      ].join("\n"),
    );
  });

  test("a store push feeds the same pipeline as a parsed document", () => {
    const store = new MetricStore();
    store.push("batch", { instance: "worker-1" }, parseSeries('jobs_queued{queue="mail"} 7\n'));
    const snapshot = store.snapshot();
    const result = aggregate(snapshot.series, snapshot.metadata, {});
    expect(result.series[0]!.labels).toEqual({ instance: "worker-1", queue: "mail" });
    expect(result.series[0]!.value).toBe(7);
  });
});

describe("repository hygiene", () => {
  const root = new URL("..", import.meta.url).pathname;
  // Assembled from character codes on purpose: a guard against host-specific
  // attribution must not itself introduce those strings into the repository.
  const forbidden = [
    [116, 104, 101, 98, 111, 111, 107, 109, 97, 115, 116, 101, 114],
    [122, 111, 46, 99, 111, 109, 112, 117, 116, 101, 114],
    [90, 111, 32, 67, 111, 109, 112, 117, 116, 101, 114],
    [90, 111, 32, 83, 112, 97, 99, 101],
    [122, 111, 95, 115, 112, 97, 99, 101],
  ].map((codes) => String.fromCharCode(...codes));

  function walk(directory: string): string[] {
    return readdirSync(directory).flatMap((entry) => {
      if (entry === "node_modules" || entry === ".git" || entry === "dist") return [];
      const path = join(directory, entry);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  }

  test("no committed file carries a host-specific attribution", () => {
    const files = walk(root).filter((path) => !path.includes("/tests/"));
    expect(files.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const path of files) {
      const content = readFileSync(path, "utf8");
      for (const needle of forbidden) {
        if (content.includes(needle)) offenders.push(`${relative(root, path)} contains "${needle}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the licence names Retsumdk as the copyright holder", () => {
    const licence = readFileSync(join(root, "LICENSE"), "utf8");
    expect(licence).toContain("MIT License");
    expect(licence).toContain("Copyright (c) 2026 Retsumdk");
    expect(licence).toContain("WITHOUT WARRANTY OF ANY KIND");
  });

  test("the sample document in examples/ actually parses", () => {
    const text = readFileSync(join(root, "examples", "cluster-metrics.txt"), "utf8");
    const parsed = parseExposition(text, { strict: true });
    expect(parsed.series.length).toBeGreaterThan(10);
    expect([...parsed.metadata.keys()]).toContain("http_requests_total");
  });

  test("a CLI run writes the same document the library produces", async () => {
    const directory = mkdtempSync(join(tmpdir(), "metrics-aggregator-"));
    const out = join(directory, "aggregated.txt");
    const code = await main([
      "aggregate",
      join(root, "examples", "cluster-metrics.txt"),
      "--by",
      "service",
      "--agg",
      "sum",
      "--out",
      out,
      "--quiet",
    ]);
    expect(code).toBe(0);

    const text = readFileSync(out, "utf8");
    const parsed = parseExposition(text, { strict: true });
    const requests = parsed.series.find((sample) => sample.name === "http_requests_total");
    expect(requests?.labels).toEqual({ service: "api" });
    expect(requests?.value).toBe(285);

    writeFileSync(join(directory, "unused.txt"), "");
  });
});

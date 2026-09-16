/**
 * Aggregation tests.
 *
 * These are the tests that matter most: the engine's job is to turn N samples
 * into one number without lying about what it measured. Plain series, merged
 * histograms and un-aggregatable summary quantiles are all covered here.
 */

import { describe, expect, test } from "bun:test";
import { AGGREGATOR_NAMES, AggregateConfigError, AggregateConflictError, aggregate } from "../src/aggregate.ts";
import { parseExposition } from "../src/parser.ts";
import type { MetadataMap, Series } from "../src/types.ts";

function sample(name: string, labels: Record<string, string>, value: number, timestamp?: number): Series {
  return timestamp === undefined ? { name, labels, value } : { name, labels, value, timestamp };
}

function values(result: { series: Series[] }, name?: string): number[] {
  const target = name === undefined ? result.series : result.series.filter((entry) => entry.name === name);
  return target.map((entry) => entry.value);
}

function labelsOf(result: { series: Series[] }, value: number): Record<string, string> {
  const found = result.series.find((entry) => entry.value === value);
  if (!found) throw new Error(`no series with value ${value}`);
  return found.labels;
}

test("labelsOf finds a series by value, so label assertions stay readable", () => {
  expect(labelsOf({ series: [{ name: "m", labels: { a: "1" }, value: 7 }] }, 7)).toEqual({ a: "1" });
});

const counters: Series[] = [
  sample("http_requests_total", { service: "api", instance: "10.0.0.1" }, 120),
  sample("http_requests_total", { service: "api", instance: "10.0.0.2" }, 80),
  sample("http_requests_total", { service: "api", instance: "10.0.1.2" }, 20),
];

describe("aggregate — configuration validation", () => {
  test("rejects by and without together", () => {
    expect(() => aggregate(counters, new Map(), { by: ["service"], without: ["instance"] })).toThrow(
      AggregateConfigError,
    );
  });

  test("names the valid aggregators when given an unknown one", () => {
    try {
      aggregate(counters, new Map(), { aggregators: ["median" as never] });
      throw new Error("expected a config error");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateConfigError);
      expect((error as Error).message).toContain("median");
      for (const name of AGGREGATOR_NAMES) expect((error as Error).message).toContain(name);
    }
  });

  test("rejects an empty aggregator list", () => {
    expect(() => aggregate(counters, new Map(), { aggregators: [] })).toThrow(AggregateConfigError);
  });

  test("rejects a label list containing an invalid label name", () => {
    expect(() => aggregate(counters, new Map(), { by: ["not a label"] })).toThrow(AggregateConfigError);
    expect(() => aggregate(counters, new Map(), { without: ["has-a-dash"] })).toThrow(AggregateConfigError);
  });

  test("rejects an invalid static label", () => {
    expect(() => aggregate(counters, new Map(), { label: { "bad name": "x" } })).toThrow(AggregateConfigError);
  });
});

describe("aggregate — plain series", () => {
  test("sums every series in a group and drops the grouping label", () => {
    const result = aggregate(counters, new Map(), { without: ["instance"] });
    expect(result.series).toHaveLength(1);
    expect(result.series[0]!.value).toBe(220);
    expect(result.series[0]!.name).toBe("http_requests_total");
    expect(result.series[0]!.labels).toEqual({ service: "api" });
  });

  test("keeps only the labels named by `by`, so groups stay separate", () => {
    const input = [
      sample("m", { service: "api", region: "us-east" }, 1),
      sample("m", { service: "api", region: "eu-west" }, 2),
      sample("m", { service: "web", region: "us-east" }, 3),
    ];
    const result = aggregate(input, new Map(), { by: ["region"] });
    expect(result.stats.groups).toBe(2);
    // us-east sums api(1) + web(3); eu-west has only api(2).
    expect(values(result).sort((a, b) => a - b)).toEqual([2, 4]);
  });

  test("applies each supported aggregator", () => {
    const input = [sample("m", {}, 1), sample("m", {}, 2), sample("m", {}, 6)];
    const expectations: Record<string, number> = {
      sum: 9,
      min: 1,
      max: 6,
      avg: 3,
      count: 3,
      stdvar: 14 / 3,
      group: 1,
    };
    for (const [aggregator, expected] of Object.entries(expectations)) {
      const result = aggregate(input, new Map(), { aggregators: [aggregator as never] });
      expect(result.series[0]!.value).toBeCloseTo(expected, 10);
    }
    const stddev = aggregate(input, new Map(), { aggregators: ["stddev"] });
    expect(stddev.series[0]!.value).toBeCloseTo(Math.sqrt(14 / 3), 10);
  });

  test("uses population variance, not sample variance", () => {
    const result = aggregate([sample("m", {}, 2), sample("m", {}, 4)], new Map(), { aggregators: ["stdvar"] });
    expect(result.series[0]!.value).toBeCloseTo(1, 10);
  });

  test("last and first use timestamps when they are present", () => {
    const input = [
      sample("m", {}, 30, 3000),
      sample("m", {}, 10, 1000),
      sample("m", {}, 20, 2000),
    ];
    expect(aggregate(input, new Map(), { aggregators: ["last"] }).series[0]!.value).toBe(30);
    expect(aggregate(input, new Map(), { aggregators: ["first"] }).series[0]!.value).toBe(10);
  });

  test("last and first fall back to input order without timestamps", () => {
    const input = [sample("m", {}, 30), sample("m", {}, 10)];
    expect(aggregate(input, new Map(), { aggregators: ["last"] }).series[0]!.value).toBe(10);
    expect(aggregate(input, new Map(), { aggregators: ["first"] }).series[0]!.value).toBe(30);
  });

  test("propagates NaN instead of silently ignoring it", () => {
    const input = [sample("m", {}, 1), sample("m", {}, Number.NaN)];
    expect(Number.isNaN(aggregate(input, new Map(), { aggregators: ["sum"] }).series[0]!.value)).toBe(true);
    expect(Number.isNaN(aggregate(input, new Map(), { aggregators: ["avg"] }).series[0]!.value)).toBe(true);
    expect(aggregate(input, new Map(), { aggregators: ["count"] }).series[0]!.value).toBe(2);
  });

  test("carries infinities through a sum", () => {
    const input = [sample("m", {}, 1), sample("m", {}, Number.POSITIVE_INFINITY)];
    expect(aggregate(input, new Map(), { aggregators: ["sum"] }).series[0]!.value).toBe(Number.POSITIVE_INFINITY);
  });

  test("adds static labels after grouping so they cannot split a group", () => {
    const result = aggregate(counters, new Map(), { by: ["service"], label: { aggregated: "true" } });
    expect(result.series).toHaveLength(1);
    expect(result.series[0]!.labels).toEqual({ service: "api", aggregated: "true" });
  });

  test("renames the output family when asked", () => {
    const result = aggregate(counters, new Map(), { without: ["instance"], name: "cluster_requests" });
    expect(result.series[0]!.name).toBe("cluster_requests");
  });

  test("namespaces the output when several aggregators are requested at once", () => {
    const result = aggregate(counters, new Map(), { without: ["instance"], aggregators: ["sum", "max"] });
    const names = result.series.map((entry) => entry.name).sort();
    expect(names).toEqual(["http_requests_total_max", "http_requests_total_sum"]);
    expect(values(result, "http_requests_total_sum")[0]).toBe(220);
    expect(values(result, "http_requests_total_max")[0]).toBe(120);
  });

  test("dropLabels removes a label without narrowing the group to `by`", () => {
    const result = aggregate(counters, new Map(), { dropLabels: ["instance"] });
    expect(result.series).toHaveLength(1);
    expect(result.series[0]!.value).toBe(220);
  });

  test("reports input, group and output counts", () => {
    const result = aggregate(counters, new Map(), { without: ["instance"] });
    expect(result.stats.inputSeries).toBe(3);
    expect(result.stats.groups).toBe(1);
    expect(result.stats.outputSeries).toBe(1);
    expect(result.stats.perAggregator.sum).toBe(1);
  });

  test("returns nothing for empty input instead of inventing a zero", () => {
    const result = aggregate([], new Map(), { aggregators: ["sum"] });
    expect(result.series).toEqual([]);
    expect(result.stats.inputSeries).toBe(0);
  });
});

describe("aggregate — duplicates", () => {
  test("collapses exact duplicates so a double-scraped target is not counted twice", () => {
    const input = [sample("m", { instance: "a" }, 5), sample("m", { instance: "a" }, 5)];
    const result = aggregate(input, new Map(), { without: ["instance"] });
    expect(result.series[0]!.value).toBe(5);
    expect(result.stats.dedupedSamples).toBe(1);
  });

  test("keeps conflicting samples as group members by default", () => {
    const input = [sample("m", { instance: "a" }, 5), sample("m", { instance: "a" }, 7)];
    const result = aggregate(input, new Map(), { without: ["instance"] });
    expect(result.series[0]!.value).toBe(12);
  });

  test("conflictPolicy newest keeps only the freshest sample", () => {
    const input = [
      sample("m", { instance: "a" }, 5, 1000),
      sample("m", { instance: "a" }, 7, 2000),
    ];
    const result = aggregate(input, new Map(), { without: ["instance"], conflictPolicy: "newest" });
    expect(result.series[0]!.value).toBe(7);
    expect(result.stats.conflictsResolved).toBe(1);
  });

  test("conflictPolicy error surfaces the duplicate", () => {
    const input = [sample("m", { instance: "a" }, 5), sample("m", { instance: "a" }, 7)];
    expect(() => aggregate(input, new Map(), { conflictPolicy: "error" })).toThrow(AggregateConflictError);
  });

  test("dedupeIdentical false keeps even byte-identical samples", () => {
    const input = [sample("m", {}, 5), sample("m", {}, 5)];
    const result = aggregate(input, new Map(), { dedupeIdentical: false });
    expect(result.series[0]!.value).toBe(10);
  });
});

describe("aggregate — histograms", () => {
  const metadata: MetadataMap = new Map([["latency_seconds", { type: "histogram" }]]);
  const targetA: Series[] = [
    sample("latency_seconds_bucket", { instance: "a", le: "0.1" }, 10),
    sample("latency_seconds_bucket", { instance: "a", le: "0.5" }, 40),
    sample("latency_seconds_bucket", { instance: "a", le: "+Inf" }, 55),
    sample("latency_seconds_sum", { instance: "a" }, 12.5),
    sample("latency_seconds_count", { instance: "a" }, 55),
  ];
  const targetB: Series[] = [
    sample("latency_seconds_bucket", { instance: "b", le: "0.1" }, 5),
    sample("latency_seconds_bucket", { instance: "b", le: "0.5" }, 20),
    sample("latency_seconds_bucket", { instance: "b", le: "+Inf" }, 30),
    sample("latency_seconds_sum", { instance: "b" }, 7.5),
    sample("latency_seconds_count", { instance: "b" }, 30),
  ];

  test("adds bucket counts per le and preserves cumulative ordering", () => {
    const result = aggregate([...targetA, ...targetB], metadata, { without: ["instance"] });
    const buckets = result.series
      .filter((entry) => entry.name.endsWith("_bucket"))
      .map((entry) => [entry.labels.le, entry.value] as const);
    expect(buckets).toEqual([
      ["0.1", 15],
      ["0.5", 60],
      ["+Inf", 85],
    ]);
    const cumulative = buckets.map(([, value]) => value);
    expect(cumulative[0]! <= cumulative[1]! && cumulative[1]! <= cumulative[2]!).toBe(true);
  });

  test("adds _sum and _count", () => {
    const result = aggregate([...targetA, ...targetB], metadata, { without: ["instance"] });
    expect(result.series.find((entry) => entry.name.endsWith("_sum"))!.value).toBe(20);
    expect(result.series.find((entry) => entry.name.endsWith("_count"))!.value).toBe(85);
  });

  test("drops the grouping label from every part of the histogram", () => {
    const result = aggregate([...targetA, ...targetB], metadata, { without: ["instance"] });
    for (const entry of result.series) expect(entry.labels.instance).toBeUndefined();
  });

  test("the requested aggregator does not corrupt buckets", () => {
    const result = aggregate([...targetA, ...targetB], metadata, {
      without: ["instance"],
      aggregators: ["max"],
    });
    const infinite = result.series.find((entry) => entry.labels.le === "+Inf")!;
    expect(infinite.value).toBe(85);
  });

  test("keeps the histogram type, declared at the family level only", () => {
    const result = aggregate([...targetA, ...targetB], metadata, { without: ["instance"] });
    expect(result.metadata.get("latency_seconds")!.type).toBe("histogram");
    expect(result.metadata.has("latency_seconds_bucket")).toBe(false);
  });

  test("merges a histogram that arrives without a # TYPE declaration", () => {
    const result = aggregate([...targetA, ...targetB], new Map(), { without: ["instance"] });
    expect(result.stats.histogramGroups).toBe(1);
    expect(result.series.find((entry) => entry.name.endsWith("_count"))!.value).toBe(85);
  });

  test("warns when merged buckets are non-monotonic", () => {
    const broken = [
      sample("latency_seconds_bucket", { le: "0.1" }, 10),
      sample("latency_seconds_bucket", { le: "0.5" }, 5),
      sample("latency_seconds_count", {}, 10),
    ];
    const result = aggregate(broken, metadata, {});
    expect(result.stats.warnings.some((warning) => warning.includes("non-monotonic"))).toBe(true);
  });

  test("warns when the +Inf bucket disagrees with _count", () => {
    const broken = [
      sample("latency_seconds_bucket", { le: "+Inf" }, 4),
      sample("latency_seconds_count", {}, 9),
    ];
    const result = aggregate(broken, metadata, {});
    expect(result.stats.warnings.some((warning) => warning.includes("_count"))).toBe(true);
  });

  test("keeps separate groups separate", () => {
    const result = aggregate([...targetA, ...targetB], metadata, { by: ["instance"] });
    expect(result.series.filter((entry) => entry.name.endsWith("_count"))).toHaveLength(2);
  });
});

describe("aggregate — summaries", () => {
  const metadata: MetadataMap = new Map([["rpc_duration_seconds", { type: "summary" }]]);
  const input: Series[] = [
    sample("rpc_duration_seconds", { instance: "a", quantile: "0.5" }, 0.2),
    sample("rpc_duration_seconds", { instance: "a", quantile: "0.99" }, 0.9),
    sample("rpc_duration_seconds_sum", { instance: "a" }, 12),
    sample("rpc_duration_seconds_count", { instance: "a" }, 100),
    sample("rpc_duration_seconds", { instance: "b", quantile: "0.5" }, 0.3),
    sample("rpc_duration_seconds_sum", { instance: "b" }, 8),
    sample("rpc_duration_seconds_count", { instance: "b" }, 60),
  ];

  test("drops quantiles by default because they cannot be added", () => {
    const result = aggregate(input, metadata, { without: ["instance"] });
    expect(result.series.some((entry) => entry.labels.quantile !== undefined)).toBe(false);
    expect(result.stats.droppedQuantileSeries).toBe(3);
    expect(result.stats.warnings.some((warning) => warning.includes("quantile"))).toBe(true);
  });

  test("still adds _sum and _count so rate() stays possible", () => {
    const result = aggregate(input, metadata, { without: ["instance"] });
    expect(result.series.find((entry) => entry.name.endsWith("_sum"))!.value).toBe(20);
    expect(result.series.find((entry) => entry.name.endsWith("_count"))!.value).toBe(160);
  });

  test("dropQuantiles false keeps the first member's quantiles and says they are approximate", () => {
    const result = aggregate(input, metadata, { without: ["instance"], dropQuantiles: false });
    const quantiles = result.series.filter((entry) => entry.labels.quantile !== undefined);
    expect(quantiles).toHaveLength(2);
    expect(result.stats.warnings.some((warning) => warning.includes("not a true aggregate"))).toBe(true);
  });
});

describe("aggregate — end to end from parsed text", () => {
  test("aggregates two scraped documents into one cluster view", () => {
    const a = parseExposition(
      [
        "# HELP http_requests_total Total HTTP requests.",
        "# TYPE http_requests_total counter",
        'http_requests_total{service="api",region="us-east",instance="a"} 120',
        'http_requests_total{service="api",region="eu-west",instance="a"} 50',
        "",
      ].join("\n"),
      { strict: true },
    );
    const b = parseExposition(
      [
        "# HELP http_requests_total Total HTTP requests.",
        "# TYPE http_requests_total counter",
        'http_requests_total{service="api",region="us-east",instance="b"} 80',
        'http_requests_total{service="api",region="eu-west",instance="b"} 10',
        "",
      ].join("\n"),
      { strict: true },
    );
    const merged = [...a.series, ...b.series];
    const result = aggregate(merged, a.metadata, { by: ["service", "region"] });
    expect(result.stats.inputSeries).toBe(4);
    expect(result.stats.groups).toBe(2);
    expect(result.series.find((entry) => entry.labels.region === "us-east")!.value).toBe(200);
    expect(result.series.find((entry) => entry.labels.region === "eu-west")!.value).toBe(60);
  });
});

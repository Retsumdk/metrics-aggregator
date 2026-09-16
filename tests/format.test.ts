import { describe, expect, test } from "bun:test";
import {
  LEADING_METRIC_NAME_RE,
  METRIC_TYPES,
  canonicalLabels,
  compareSeries,
  escapeHelpText,
  escapeLabelValue,
  familyCandidates,
  formatValue,
  isMetricType,
  isValidLabelName,
  isValidMetricName,
  labelsEqual,
  labelsKey,
  labelsToString,
  mergeLabels,
  metadataFor,
  metricTypeOf,
  omitLabels,
  parseTimestamp,
  parseValue,
  pickLabels,
  seriesSuffix,
  sortSeries,
  sortedLabelNames,
  unescapeLabelValue,
} from "../src/format.ts";
import type { MetadataMap, Series } from "../src/types.ts";

describe("name validation", () => {
  test("accepts the characters the format allows", () => {
    for (const name of ["a", "A", "_", ":http_requests", "up", "node_cpu_seconds_total", "a1:b2_c"]) {
      expect(isValidMetricName(name)).toBe(true);
    }
  });

  test("rejects names that start with a digit or contain punctuation", () => {
    for (const name of ["", "1a", "a-b", "a.b", "a b", "a,b", "metric{}"]) {
      expect(isValidMetricName(name)).toBe(false);
    }
  });

  test("label names may not contain colons", () => {
    expect(isValidLabelName("service")).toBe(true);
    expect(isValidLabelName("_service")).toBe(true);
    expect(isValidLabelName(":service")).toBe(false);
    expect(isValidLabelName("1service")).toBe(false);
    expect(isValidLabelName("")).toBe(false);
  });

  test("the leading-name regex stops at the label set", () => {
    expect(LEADING_METRIC_NAME_RE.exec('http_requests_total{code="200"} 5')?.[0]).toBe("http_requests_total");
  });

  test("type guard accepts exactly the five declared types", () => {
    expect(METRIC_TYPES).toEqual(["counter", "gauge", "histogram", "summary", "untyped"]);
    for (const type of METRIC_TYPES) expect(isMetricType(type)).toBe(true);
    expect(isMetricType("Counter")).toBe(false);
    expect(isMetricType("")).toBe(false);
  });
});

describe("metricTypeOf", () => {
  test("prefers an explicit declaration", () => {
    expect(metricTypeOf("anything")).toBe("untyped");
    expect(metricTypeOf("up", "gauge")).toBe("gauge");
  });

  test("infers a counter from the _total convention", () => {
    expect(metricTypeOf("http_requests_total")).toBe("counter");
    expect(metricTypeOf("http_requests_total", "untyped")).toBe("counter");
  });

  test("does not guess a type from a suffix it has no convention for", () => {
    // `_bucket` alone is not proof of a histogram — only `_total` has a
    // convention strong enough to normalise without a declaration.
    expect(metricTypeOf("request_duration_seconds_bucket")).toBe("untyped");
    expect(metricTypeOf("request_duration_seconds_sum")).toBe("untyped");
  });
});

describe("label escaping", () => {
  test("round-trips backslash, quote and newline", () => {
    const value = 'a\\b"c\nd';
    const escaped = escapeLabelValue(value);
    expect(escaped).toBe('a\\\\b\\"c\\nd');
    expect(unescapeLabelValue(escaped)).toBe(value);
  });

  test("leaves ordinary text alone", () => {
    expect(escapeLabelValue("us-east-1")).toBe("us-east-1");
    expect(unescapeLabelValue("us-east-1")).toBe("us-east-1");
  });

  test("rejects undefined escape sequences instead of guessing", () => {
    expect(unescapeLabelValue("\\t")).toBeNull();
    expect(unescapeLabelValue("\\")).toBeNull();
    expect(unescapeLabelValue("ok\\t")).toBeNull();
    expect(unescapeLabelValue("\\n")).toBe("\n");
    expect(unescapeLabelValue("\\\"")).toBe('"');
    expect(unescapeLabelValue("\\\\")).toBe("\\");
  });

  test("HELP text escapes backslash and newline only", () => {
    expect(escapeHelpText('line1\nline2\\x"quoted"')).toBe('line1\\nline2\\\\x"quoted"');
  });
});

describe("formatValue / parseValue", () => {
  test("renders special values the way the format spells them", () => {
    expect(formatValue(Number.NaN)).toBe("NaN");
    expect(formatValue(Number.POSITIVE_INFINITY)).toBe("+Inf");
    expect(formatValue(Number.NEGATIVE_INFINITY)).toBe("-Inf");
  });

  test("renders integers without a trailing decimal point", () => {
    expect(formatValue(0)).toBe("0");
    expect(formatValue(85)).toBe("85");
    expect(formatValue(-12)).toBe("-12");
    expect(formatValue(1e9)).toBe("1000000000");
    expect(formatValue(2 ** 40)).toBe(String(2 ** 40));
  });

  test("keeps the sign of negative zero and normalises exponents", () => {
    expect(formatValue(-0)).toBe("-0");
    expect(formatValue(1e-7)).toBe("1e-07");
  });

  test("renders fractional values with their shortest round trip", () => {
    expect(formatValue(0.5)).toBe("0.5");
    expect(formatValue(12.5)).toBe("12.5");
    expect(formatValue(1 / 3)).toBe("0.3333333333333333");
  });

  test("parses the values the format defines", () => {
    expect(parseValue("5")).toBe(5);
    expect(parseValue("5.5")).toBe(5.5);
    expect(parseValue("-5.5")).toBe(-5.5);
    expect(parseValue("+5")).toBe(5);
    expect(parseValue("1e3")).toBe(1000);
    expect(parseValue("1E-3")).toBe(0.001);
    expect(parseValue("NaN")).toBeNaN();
    expect(parseValue("+Inf")).toBe(Number.POSITIVE_INFINITY);
    expect(parseValue("-Inf")).toBe(Number.NEGATIVE_INFINITY);
  });

  test("returns null for values it cannot represent", () => {
    for (const value of ["", "abc", "1,5", "0x10", "1.2.3", "5 "]) {
      expect(parseValue(value)).toBeNull();
    }
  });

  test("every rendered value parses back to the same number", () => {
    for (const value of [0, -0, 1, -1, 0.1, 1 / 3, 1e-7, 1e21, 2 ** 53, Number.MAX_VALUE, 12.5]) {
      const rendered = formatValue(value);
      const parsed = parseValue(rendered);
      expect(parsed).not.toBeNull();
      expect(Object.is(parsed, value) || Math.abs(parsed! - value) < Number.EPSILON * Math.abs(value)).toBe(true);
    }
  });
});

describe("parseTimestamp", () => {
  test("accepts integer milliseconds", () => {
    expect(parseTimestamp("1710000000000")).toBe(1_710_000_000_000);
    expect(parseTimestamp("-1")).toBe(-1);
    expect(parseTimestamp("0")).toBe(0);
  });

  test("rejects anything else", () => {
    for (const value of ["1.5", "1e3", "abc", "", "1710000000000.0"]) {
      expect(parseTimestamp(value)).toBeNull();
    }
  });
});

describe("label set helpers", () => {
  const labels = { service: "api", region: "us-east" };

  test("sortedLabelNames sorts without mutating", () => {
    expect(sortedLabelNames(labels)).toEqual(["region", "service"]);
    expect(Object.keys(labels)).toEqual(["service", "region"]);
  });

  test("labelsKey is order independent and collision resistant", () => {
    expect(labelsKey({ a: "1", b: "2" })).toBe(labelsKey({ b: "2", a: "1" }));
    expect(labelsKey({ a: "1" })).not.toBe(labelsKey({ a: "1", b: "" }));
    expect(labelsKey({ ab: "c" })).not.toBe(labelsKey({ a: "bc" }));
  });

  test("labelsToString always renders a brace pair, sorted", () => {
    expect(labelsToString({})).toBe("{}");
    expect(labelsToString({ b: "2", a: "1" })).toBe('{a="1",b="2"}');
  });

  test("canonicalLabels returns a sorted copy", () => {
    const canonical = canonicalLabels({ b: "2", a: "1" });
    expect(Object.keys(canonical)).toEqual(["a", "b"]);
  });

  test("mergeLabels lets later sets win", () => {
    expect(mergeLabels({ a: "1", b: "1" }, { b: "2" }, { c: "3" })).toEqual({ a: "1", b: "2", c: "3" });
  });

  test("omitLabels and pickLabels are complementary", () => {
    expect(omitLabels(labels, ["region"])).toEqual({ service: "api" });
    expect(pickLabels(labels, ["region"])).toEqual({ region: "us-east" });
    expect(pickLabels(labels, ["missing"])).toEqual({});
  });

  test("labelsEqual ignores ordering", () => {
    expect(labelsEqual({ a: "1", b: "2" }, { b: "2", a: "1" })).toBe(true);
    expect(labelsEqual({ a: "1" }, { a: "1", b: "" })).toBe(false);
  });
});

describe("family resolution", () => {
  const metadata: MetadataMap = new Map([
    ["request_duration_seconds", { type: "histogram", help: "Latency." }],
    ["http_requests", { type: "counter" }],
  ]);

  test("familyCandidates lists the name and its base", () => {
    expect(familyCandidates("http_requests_total")).toEqual(["http_requests_total", "http_requests"]);
    expect(familyCandidates("request_duration_seconds_bucket")).toEqual([
      "request_duration_seconds_bucket",
      "request_duration_seconds",
    ]);
    expect(familyCandidates("up")).toEqual(["up"]);
  });

  test("metadataFor prefers an exact declaration", () => {
    expect(metadataFor("http_requests", metadata).family).toBe("http_requests");
    expect(metadataFor("http_requests", metadata).meta.type).toBe("counter");
  });

  test("metadataFor resolves histogram parts to their family", () => {
    for (const name of [
      "request_duration_seconds_bucket",
      "request_duration_seconds_sum",
      "request_duration_seconds_count",
    ]) {
      const resolved = metadataFor(name, metadata);
      expect(resolved.family).toBe("request_duration_seconds");
      expect(resolved.meta.type).toBe("histogram");
    }
  });

  test("metadataFor resolves a _total counter to its declared base", () => {
    expect(metadataFor("http_requests_total", metadata).family).toBe("http_requests");
  });

  test("metadataFor falls back to the sample itself when nothing is declared", () => {
    const resolved = metadataFor("unrelated_metric", metadata);
    expect(resolved.family).toBe("unrelated_metric");
    expect(resolved.meta).toEqual({});
  });

  test("seriesSuffix reports which part of a family a sample is", () => {
    expect(seriesSuffix("request_duration_seconds", "request_duration_seconds")).toBe("");
    expect(seriesSuffix("request_duration_seconds_bucket", "request_duration_seconds")).toBe("_bucket");
    expect(seriesSuffix("request_duration_seconds_sum", "request_duration_seconds")).toBe("_sum");
    expect(seriesSuffix("request_duration_seconds_count", "request_duration_seconds")).toBe("_count");
    expect(seriesSuffix("other", "request_duration_seconds")).toBe("");
  });
});

describe("sorting", () => {
  const metadata: MetadataMap = new Map([["latency", { type: "histogram" }]]);
  const series: Series[] = [
    { name: "latency_count", labels: {}, value: 2 },
    { name: "latency_sum", labels: {}, value: 1 },
    { name: "latency_bucket", labels: { le: "+Inf" }, value: 3 },
    { name: "latency_bucket", labels: { le: "0.5" }, value: 2 },
    { name: "latency_bucket", labels: { le: "0.1" }, value: 1 },
  ];

  test("orders buckets numerically, then _sum, then _count", () => {
    expect(sortSeries(series, metadata).map((sample) => `${sample.name}${labelsToString(sample.labels)}`)).toEqual([
      'latency_bucket{le="0.1"}',
      'latency_bucket{le="0.5"}',
      'latency_bucket{le="+Inf"}',
      "latency_sum{}",
      "latency_count{}",
    ]);
  });

  test("sorting is stable for the same input", () => {
    const first = sortSeries(series, metadata);
    const second = sortSeries([...series].reverse(), metadata);
    expect(first.map(compareIdentity)).toEqual(second.map(compareIdentity));
  });

  test("compareSeries orders by family, then labels, then value", () => {
    const a: Series = { name: "m", labels: { a: "1" }, value: 1 };
    const b: Series = { name: "m", labels: { a: "2" }, value: 1 };
    const c: Series = { name: "m", labels: { a: "2" }, value: 2 };
    expect(compareSeries(a, b)).toBeLessThan(0);
    expect(compareSeries(b, c)).toBeLessThan(0);
    expect(compareSeries(a, a)).toBe(0);
  });
});

function compareIdentity(sample: Series): string {
  return `${sample.name}|${labelsKey(sample.labels)}|${sample.value}`;
}

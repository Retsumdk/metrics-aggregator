/**
 * Encoder tests — the output of this module is scraped by Prometheus, so every
 * assertion here is about wire compatibility, not just "it printed something".
 */

import { describe, expect, test } from "bun:test";
import { EncodeError, encodeExemplar, encodeExposition, encodeSample } from "../src/encoder.ts";
import type { MetadataMap, Series } from "../src/types.ts";

const histogramMetadata: MetadataMap = new Map([
  ["request_duration_seconds", { type: "histogram", help: "Request latency." }],
]);

describe("encodeSample", () => {
  test("renders a bare name when there are no labels", () => {
    expect(encodeSample({ name: "up", labels: {}, value: 1 })).toBe("up 1");
  });

  test("sorts label names and escapes their values", () => {
    const series: Series = {
      name: "m",
      labels: { z: 'quote"here', a: "back\\slash", m: "two\nlines" },
      value: 2.5,
    };
    expect(encodeSample(series)).toBe('m{a="back\\\\slash",m="two\\nlines",z="quote\\"here"} 2.5');
  });

  test("appends the timestamp when present", () => {
    expect(encodeSample({ name: "m", labels: {}, value: 1, timestamp: 1710000000000 })).toBe("m 1 1710000000000");
  });

  test("renders special float values the way the format spells them", () => {
    expect(encodeSample({ name: "m", labels: {}, value: Number.NaN })).toBe("m NaN");
    expect(encodeSample({ name: "m", labels: {}, value: Number.POSITIVE_INFINITY })).toBe("m +Inf");
    expect(encodeSample({ name: "m", labels: {}, value: Number.NEGATIVE_INFINITY })).toBe("m -Inf");
  });

  test("refuses to emit a line Prometheus would reject", () => {
    expect(() => encodeSample({ name: "1bad", labels: {}, value: 1 })).toThrow(EncodeError);
  });
});

describe("encodeExemplar", () => {
  test("renders the OpenMetrics exemplar comment", () => {
    const line = encodeExemplar({
      name: "m",
      labels: {},
      value: 1,
      exemplar: { labels: { trace_id: "abc" }, value: 0.4, timestamp: 1710000000000 },
    });
    expect(line).toBe('# {trace_id="abc"} 0.4 1710000000000');
  });

  test("returns undefined when the sample carries no exemplar", () => {
    expect(encodeExemplar({ name: "m", labels: {}, value: 1 })).toBeUndefined();
  });
});

describe("encodeExposition", () => {
  test("returns an empty document for no samples", () => {
    expect(encodeExposition([], new Map())).toBe("");
  });

  test("emits HELP and TYPE once per family, in sorted family order", () => {
    const metadata: MetadataMap = new Map([
      ["b_metric", { type: "gauge", help: "Second." }],
      ["a_metric", { type: "counter", help: "First.\nWith a newline." }],
    ]);
    const output = encodeExposition(
      [
        { name: "b_metric", labels: {}, value: 2 },
        { name: "a_metric", labels: {}, value: 1 },
      ],
      metadata,
    );
    expect(output).toBe(
      [
        "# HELP a_metric First.\\nWith a newline.",
        "# TYPE a_metric counter",
        "a_metric 1",
        "# HELP b_metric Second.",
        "# TYPE b_metric gauge",
        "b_metric 2",
        "",
      ].join("\n"),
    );
  });

  test("groups histogram parts under their family and orders buckets, sum, count", () => {
    const output = encodeExposition(
      [
        { name: "request_duration_seconds_count", labels: {}, value: 3 },
        { name: "request_duration_seconds_sum", labels: {}, value: 1.5 },
        { name: "request_duration_seconds_bucket", labels: { le: "+Inf" }, value: 3 },
        { name: "request_duration_seconds_bucket", labels: { le: "0.1" }, value: 1 },
        { name: "request_duration_seconds_bucket", labels: { le: "0.5" }, value: 2 },
      ],
      histogramMetadata,
    );
    expect(output).toBe(
      [
        "# HELP request_duration_seconds Request latency.",
        "# TYPE request_duration_seconds histogram",
        'request_duration_seconds_bucket{le="0.1"} 1',
        'request_duration_seconds_bucket{le="0.5"} 2',
        'request_duration_seconds_bucket{le="+Inf"} 3',
        "request_duration_seconds_sum 1.5",
        "request_duration_seconds_count 3",
        "",
      ].join("\n"),
    );
  });

  test("orders summary quantiles numerically before sum and count", () => {
    const metadata: MetadataMap = new Map([["rpc_duration_seconds", { type: "summary" }]]);
    const output = encodeExposition(
      [
        { name: "rpc_duration_seconds", labels: { quantile: "0.99" }, value: 9 },
        { name: "rpc_duration_seconds", labels: { quantile: "0.5" }, value: 5 },
        { name: "rpc_duration_seconds_sum", labels: {}, value: 14 },
        { name: "rpc_duration_seconds_count", labels: {}, value: 4 },
      ],
      metadata,
    );
    expect(output.split("\n").filter((line) => line !== "" && !line.startsWith("#"))).toEqual([
      'rpc_duration_seconds{quantile="0.5"} 5',
      'rpc_duration_seconds{quantile="0.99"} 9',
      "rpc_duration_seconds_sum 14",
      "rpc_duration_seconds_count 4",
    ]);
  });

  test("is byte-for-byte deterministic regardless of input order", () => {
    const series: Series[] = [
      { name: "m", labels: { b: "2", a: "1" }, value: 2 },
      { name: "m", labels: { a: "1" }, value: 1 },
      { name: "n", labels: {}, value: 3 },
    ];
    const first = encodeExposition(series, new Map());
    const second = encodeExposition([...series].reverse(), new Map());
    expect(first).toBe(second);
  });

  test("can omit HELP and TYPE lines", () => {
    const metadata: MetadataMap = new Map([["m", { type: "gauge", help: "h" }]]);
    const output = encodeExposition([{ name: "m", labels: {}, value: 1 }], metadata, {
      includeHelp: false,
      includeType: false,
    });
    expect(output).toBe("m 1\n");
  });

  test("preserves input order when sorting is disabled", () => {
    const output = encodeExposition(
      [
        { name: "b", labels: {}, value: 1 },
        { name: "a", labels: {}, value: 2 },
      ],
      new Map(),
      { sort: false },
    );
    expect(output).toBe("b 1\na 2\n");
  });

  test("adds UNIT and EOF framing for OpenMetrics", () => {
    const metadata: MetadataMap = new Map([["latency_seconds", { type: "gauge", unit: "seconds" }]]);
    const output = encodeExposition([{ name: "latency_seconds", labels: {}, value: 3 }], metadata, {
      openMetrics: true,
    });
    expect(output).toBe("# TYPE latency_seconds gauge\n# UNIT latency_seconds seconds\nlatency_seconds 3\n# EOF\n");
  });

  test("writes exemplars only in OpenMetrics mode", () => {
    const sample: Series = {
      name: "m",
      labels: {},
      value: 1,
      exemplar: { labels: { trace_id: "abc" }, value: 0.5 },
    };
    expect(encodeExposition([sample], new Map(), { includeType: false })).toBe("m 1\n");
    expect(encodeExposition([sample], new Map(), { openMetrics: true, includeType: false })).toBe(
      'm 1\n# {trace_id="abc"} 0.5\n# EOF\n',
    );
  });

  test("omits the type line for a family with no declaration", () => {
    // `untyped` is the format default; restating it adds no information.
    expect(encodeExposition([{ name: "mystery", labels: {}, value: 1 }], new Map())).toBe("mystery 1\n");
  });

  test("still emits an explicitly declared untyped family", () => {
    const metadata: MetadataMap = new Map([["mystery", { type: "untyped" }]]);
    expect(encodeExposition([{ name: "mystery", labels: {}, value: 1 }], metadata)).toBe(
      "# TYPE mystery untyped\nmystery 1\n",
    );
  });

  test("round-trips through the parser", async () => {
    const { parseExposition } = await import("../src/parser.ts");
    const source = [
      "# HELP http_requests_total Total HTTP requests.",
      "# TYPE http_requests_total counter",
      'http_requests_total{code="200"} 12',
      "# TYPE latency_seconds histogram",
      'latency_seconds_bucket{le="0.1"} 1',
      'latency_seconds_bucket{le="+Inf"} 4',
      "latency_seconds_sum 0.9",
      "latency_seconds_count 4",
      "",
    ].join("\n");
    const parsed = parseExposition(source, { strict: true });
    expect(encodeExposition(parsed.series, parsed.metadata)).toBe(source);
  });
});

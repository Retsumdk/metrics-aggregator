import { describe, expect, test } from "bun:test";
import { ParseError, parseExposition, parseSeries } from "../src/parser.ts";

describe("parseExposition — basic samples", () => {
  test("parses a bare sample", () => {
    const result = parseExposition("plain 3.5\n");
    expect(result.series).toEqual([{ name: "plain", labels: {}, value: 3.5 }]);
    expect(result.warnings).toEqual([]);
    expect(result.openMetrics).toBe(false);
  });

  test("parses labels, sorting nothing but preserving every pair", () => {
    const result = parseExposition('m{b="2",a="1"} 1\n');
    expect(result.series[0]!.labels).toEqual({ b: "2", a: "1" });
  });

  test("accepts a trailing comma and whitespace inside the label set", () => {
    const result = parseExposition('m{ a = "1" , b = "2" , } 1\n');
    expect(result.series[0]!.labels).toEqual({ a: "1", b: "2" });
  });

  test("accepts an empty label set", () => {
    expect(parseSeries("m{} 1\n")[0]!.labels).toEqual({});
  });

  test("parses timestamps as integers", () => {
    expect(parseSeries("m 1 1710000000000\n")[0]!.timestamp).toBe(1710000000000);
  });

  test("tolerates CRLF line endings", () => {
    expect(parseSeries('m{a="1"} 1\r\nn 2\r\n')).toHaveLength(2);
  });

  test("tolerates a trailing blank line and whitespace-only lines", () => {
    expect(parseSeries("m 1\n\n   \n")).toHaveLength(1);
  });

  test("tolerates tabs as separators", () => {
    expect(parseSeries("m\t1\n")[0]!.value).toBe(1);
  });

  test("tolerates leading whitespace on a sample line", () => {
    expect(parseSeries("   m 1\n")[0]!.name).toBe("m");
  });

  test("parses special float values", () => {
    const [nan, positive, negative, inf] = parseSeries("n NaN\np +Inf\nng -Inf\ni Inf\n");
    expect(Number.isNaN(nan!.value)).toBe(true);
    expect(positive!.value).toBe(Number.POSITIVE_INFINITY);
    expect(negative!.value).toBe(Number.NEGATIVE_INFINITY);
    expect(inf!.value).toBe(Number.POSITIVE_INFINITY);
  });

  test("parses exponent notation", () => {
    expect(parseSeries("m 1.5e3\n")[0]!.value).toBe(1500);
    expect(parseSeries("m -2E-2\n")[0]!.value).toBe(-0.02);
  });

  test("keeps -0 as negative zero", () => {
    expect(Object.is(parseSeries("m -0\n")[0]!.value, -0)).toBe(true);
  });

  test("parses names containing colons (recording-rule style)", () => {
    expect(parseSeries("job:http_rate:sum 1\n")[0]!.name).toBe("job:http_rate:sum");
  });

  test("unescapes \\\\, \\\" and \\n inside label values", () => {
    const series = parseSeries('m{a="back\\\\slash",b="quo\\"te",c="new\\nline"} 1\n');
    expect(series[0]!.labels).toEqual({ a: "back\\slash", b: 'quo"te', c: "new\nline" });
  });

  test("keeps UTF-8 label values intact", () => {
    expect(parseSeries('m{service="café"} 1\n')[0]!.labels["service"]).toBe("café");
  });
});

describe("parseExposition — metadata", () => {
  test("reads HELP and TYPE", () => {
    const result = parseExposition("# HELP m A metric.\n# TYPE m counter\nm_total 1\n");
    expect(result.metadata.get("m")).toEqual({ type: "counter", help: "A metric." });
  });

  test("reads UNIT when OpenMetrics is enabled", () => {
    const result = parseExposition("# UNIT ms milliseconds\nms 1\n");
    expect(result.metadata.get("ms")!.unit).toBe("milliseconds");
  });

  test("rejects UNIT when OpenMetrics is disabled", () => {
    const result = parseExposition("# UNIT ms milliseconds\nms 1\n", { allowOpenMetrics: false });
    expect(result.metadata.get("ms")).toBeUndefined();
    expect(result.warnings.map((warning) => warning.code)).toContain("openmetrics-disabled");
  });

  test("keeps an empty HELP string", () => {
    expect(parseExposition("# HELP m \nm 1\n").metadata.get("m")!.help).toBe("");
  });

  test("warns about a duplicate HELP and keeps the first", () => {
    const result = parseExposition("# HELP m first\n# HELP m second\nm 1\n");
    expect(result.metadata.get("m")!.help).toBe("first");
    expect(result.warnings.map((warning) => warning.code)).toContain("duplicate-help");
  });

  test("ignores ordinary comments", () => {
    const result = parseExposition("# just a note\nm 1\n");
    expect(result.series).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  test("detects the OpenMetrics EOF marker", () => {
    const result = parseExposition("# TYPE m gauge\nm 1\n# EOF\n");
    expect(result.openMetrics).toBe(true);
  });

  test("warns when content follows # EOF", () => {
    const result = parseExposition("# EOF\nm 1\n");
    expect(result.warnings.map((warning) => warning.code)).toContain("content-after-eof");
  });
});

describe("parseExposition — families and suffix normalisation", () => {
  test("normalises a counter with a _total suffix", () => {
    const result = parseExposition("# TYPE requests counter\nrequests_total 5\n");
    expect(result.series[0]!.name).toBe("requests_total");
    expect(result.metadata.get("requests")!.type).toBe("counter");
  });

  test("keeps a histogram family declared under its base name", () => {
    const text = [
      "# TYPE latency histogram",
      'latency_bucket{le="0.5"} 3',
      'latency_bucket{le="+Inf"} 4',
      "latency_sum 1.5",
      "latency_count 4",
    ].join("\n");
    const result = parseExposition(`${text}\n`);
    expect(result.series.map((sample) => sample.name)).toEqual([
      "latency_bucket",
      "latency_bucket",
      "latency_sum",
      "latency_count",
    ]);
    expect(result.metadata.get("latency")!.type).toBe("histogram");
  });

  test("warns when a counter is declared without a _total suffix", () => {
    const result = parseExposition("# TYPE c counter\nc 1\n");
    expect(result.warnings.map((warning) => warning.code)).toContain("counter-without-total");
  });
});

describe("parseExposition — failures", () => {
  test("strict mode throws a ParseError with position and text", () => {
    try {
      parseExposition("m{a=1} 2\n", { strict: true });
      throw new Error("expected a ParseError");
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      const parseError = error as ParseError;
      expect(parseError.line).toBe(1);
      expect(parseError.column).toBeGreaterThan(0);
      expect(parseError.text).toBe("m{a=1} 2");
      expect(parseError.message).toContain("1:");
    }
  });

  test("non-strict mode collects the same problem as a warning", () => {
    const result = parseExposition("m{a=1} 2\n");
    expect(result.series).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.line).toBe(1);
  });

  test("rejects a duplicate label", () => {
    const result = parseExposition('m{a="1",a="2"} 1\n');
    expect(result.warnings.map((warning) => warning.code)).toContain("duplicate-label");
  });

  test("rejects an unterminated label set", () => {
    const result = parseExposition('m{a="1" 1\n');
    expect(result.warnings.map((warning) => warning.code)).toContain("unterminated-label-set");
  });

  test("rejects an invalid escape sequence", () => {
    const result = parseExposition('m{a="bad\\qescape"} 1\n');
    expect(result.warnings.map((warning) => warning.code)).toContain("invalid-escape");
  });

  test("rejects a missing value", () => {
    const result = parseExposition("m\n");
    expect(result.warnings.map((warning) => warning.code)).toContain("missing-value");
  });

  test("rejects a non-numeric value", () => {
    const result = parseExposition("m abc\n");
    expect(result.warnings.map((warning) => warning.code)).toContain("invalid-value");
  });

  test("rejects a non-integer timestamp", () => {
    const result = parseExposition("m 1 1.5\n");
    expect(result.warnings.map((warning) => warning.code)).toContain("invalid-timestamp");
  });

  test("rejects trailing content", () => {
    const result = parseExposition("m 1 2 3\n");
    expect(result.warnings.map((warning) => warning.code)).toContain("trailing-content");
  });

  test("rejects a label name starting with a digit", () => {
    const result = parseExposition('m{1a="b"} 1\n');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test("enforces maxSeries", () => {
    expect(() => parseExposition("a 1\nb 2\nc 3\n", { maxSeries: 2 })).toThrow(ParseError);
  });

  test("enforces maxLineLength", () => {
    expect(() => parseExposition(`m{a="${"x".repeat(50)}"} 1\n`, { maxLineLength: 20 })).toThrow(ParseError);
  });

  test("keeps parsing after a bad line in non-strict mode", () => {
    const result = parseExposition("bad line here\nm 1\n");
    expect(result.series.map((sample) => sample.name)).toEqual(["m"]);
  });
});

describe("parseExposition — OpenMetrics exemplars", () => {
  test("attaches an exemplar to the preceding sample", () => {
    const text = ['m 1', '# {trace_id="abc"} 1 1710000000000', ""].join("\n");
    const result = parseExposition(text);
    expect(result.series).toHaveLength(1);
    expect(result.series[0]!.exemplar).toEqual({
      labels: { trace_id: "abc" },
      value: 1,
      timestamp: 1710000000000,
    });
  });

  test("warns about an exemplar with no preceding sample", () => {
    const result = parseExposition('# {trace_id="abc"} 1\n');
    expect(result.warnings.map((warning) => warning.code)).toContain("orphan-exemplar");
  });

  test("warns about a second exemplar on the same sample", () => {
    const result = parseExposition('m 1\n# {a="1"} 1\n# {a="2"} 1\n');
    expect(result.warnings.map((warning) => warning.code)).toContain("duplicate-exemplar");
  });

  test("rejects exemplars when OpenMetrics is disabled", () => {
    const result = parseExposition('m 1\n# {a="1"} 1\n', { allowOpenMetrics: false });
    expect(result.warnings.map((warning) => warning.code)).toContain("openmetrics-disabled");
  });
});

describe("parseSeries", () => {
  test("returns only the samples", () => {
    const series = parseSeries("# TYPE m gauge\nm 1\nn 2\n");
    expect(series.map((sample) => sample.name)).toEqual(["m", "n"]);
  });
});

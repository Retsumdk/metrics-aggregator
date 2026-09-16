/**
 * Parser for the Prometheus text exposition format (0.0.4) and the OpenMetrics
 * extensions that real exporters emit in practice: `# UNIT`, `# EOF`, `_created`
 * samples and exemplars.
 *
 * Two modes:
 * - lenient (default) collects a `ParseWarning` per problem and keeps going, so
 *   one bad line from one exporter cannot take down an aggregation of forty.
 * - strict throws a `ParseError` carrying line/column and the offending line.
 *
 * The parser never guesses. An undeclared sample is `untyped`, a `x_total`
 * sample only joins a bare `x` family when that family was declared a counter,
 * and a sample whose declared type contradicts its name is reported rather than
 * silently reclassified.
 */

import {
  LABEL_NAME_RE,
  LEADING_METRIC_NAME_RE,
  METRIC_NAME_RE,
  isMetricType,
  metadataFor,
  parseTimestamp,
  parseValue,
  unescapeLabelValue,
} from "./format.ts";
import type {
  Exemplar,
  Labels,
  Metadata,
  MetadataMap,
  MetricType,
  ParseOptions,
  ParseResult,
  ParseWarning,
  Series,
} from "./types.ts";

export class ParseError extends Error {
  readonly line: number;
  readonly column: number;
  readonly text: string;

  constructor(message: string, line: number, column: number, text: string) {
    super(`line ${line}:${column}: ${message}`);
    this.name = "ParseError";
    this.line = line;
    this.column = column;
    this.text = text;
  }
}

interface LabelBlock {
  labels: Labels;
  consumed: number;
}

const DEFAULT_MAX_SERIES = 1_000_000;
const DEFAULT_MAX_LINE_LENGTH = 1024 * 1024;

function unescapeHelpText(raw: string): { text: string; invalid: boolean } {
  let out = "";
  let invalid = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!;
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = raw[i + 1];
    if (next === "\\") out += "\\";
    else if (next === "n") out += "\n";
    else {
      invalid = true;
      out += char;
      continue;
    }
    i++;
  }
  return { text: out, invalid };
}

function isSpace(char: string | undefined): boolean {
  return char === " " || char === "\t";
}

/**
 * Parse exposition text and return only the samples — the common case when the
 * caller does not care about `# HELP` / `# TYPE` declarations.
 */
export function parseSeries(input: string, options: ParseOptions = {}): Series[] {
  return parseExposition(input, options).series;
}

/**
 * Parse the body of an exposition document.
 *
 * @param input  the document text
 * @param options parsing behaviour; see `ParseOptions`
 */

export function parseExposition(input: string, options: ParseOptions = {}): ParseResult {
  const strict = options.strict ?? false;
  const allowOpenMetrics = options.allowOpenMetrics ?? true;
  const maxSeries = options.maxSeries ?? DEFAULT_MAX_SERIES;
  const maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;

  const series: Series[] = [];
  const metadata: MetadataMap = new Map();
  const warnings: ParseWarning[] = [];
  let openMetrics = false;
  let sawEof = false;

  const fail = (code: string, message: string, line: number, column: number, text: string): void => {
    if (strict) throw new ParseError(message, line, column, text);
    warnings.push({ code, message, line, column });
  };

  const writeMetadata = (
    name: string,
    set: (meta: Metadata) => void,
    has: (meta: Metadata) => boolean,
    codeDuplicate: string,
    line: number,
  ): void => {
    const existing = metadata.get(name);
    if (existing) {
      if (has(existing)) {
        warnings.push({
          code: codeDuplicate,
          message: `duplicate ${codeDuplicate.replace("duplicate-", "")} for "${name}"; keeping the first declaration`,
          line,
          column: 1,
        });
        return;
      }
      set(existing);
      return;
    }
    const meta: Metadata = {};
    set(meta);
    metadata.set(name, meta);
  };

  const commitSeries = (entry: Series): void => {
    // Resource guards are never downgraded to warnings: a caller that asked for
    // a bound must not silently receive an unbounded amount of data.
    if (series.length >= maxSeries) {
      throw new ParseError(`document exceeds the ${maxSeries} series limit`, 1, 1, "");
    }
    const { family, meta: declared } = metadataFor(entry.name, metadata);
    const expected: MetricType | undefined = declared.type ?? options.defaultType;
    if (expected && expected !== "untyped" && expected !== "histogram" && expected !== "summary") {
      if (expected === "counter" && !entry.name.endsWith("_total")) {
        fail(
          "counter-without-total",
          `sample "${entry.name}" is declared a counter but does not end in "_total"`,
          1,
          1,
          entry.name,
        );
      } else if (expected === "gauge" && entry.name.endsWith("_total")) {
        fail(
          "sample-type-mismatch",
          `sample "${entry.name}" ends in "_total" but family "${family}" is declared a gauge`,
          1,
          1,
          entry.name,
        );
      }
    }
    series.push(entry);
  };

  /**
   * Parse `{a="1",b="2"}` starting at `text[0] === "{"`.
   * Returns the label set and how many characters the block occupied.
   */
  const parseLabelBlock = (text: string, lineNo: number, rawLine: string, startColumn: number): LabelBlock | null => {
    const labels: Labels = {};
    // A label set that never closes is a structural problem, not a typo inside
    // one pair, so it gets its own code: if there is no `}` at all in the
    // remainder of the line, every failure below is an unterminated set.
    const unterminated = !text.includes("}");
    let cursor = 1;
    while (true) {
      while (isSpace(text[cursor])) cursor++;
      if (cursor >= text.length) {
        fail("unterminated-label-set", "unterminated label set", lineNo, startColumn + cursor, rawLine);
        return null;
      }
      if (text[cursor] === "}") {
        cursor++;
        break;
      }
      const nameMatch = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(text.slice(cursor));
      if (!nameMatch) {
        fail(
          unterminated ? "unterminated-label-set" : "invalid-label-name",
          unterminated ? "unterminated label set" : `invalid label name at column ${startColumn + cursor}`,
          lineNo,
          startColumn + cursor,
          rawLine,
        );
        return null;
      }
      const name = nameMatch[0];
      if (!LABEL_NAME_RE.test(name)) {
        fail("invalid-label-name", `invalid label name "${name}"`, lineNo, startColumn + cursor, rawLine);
        return null;
      }
      cursor += name.length;
      while (isSpace(text[cursor])) cursor++;
      if (text[cursor] !== "=") {
        fail("expected-equals", `expected "=" after label "${name}"`, lineNo, startColumn + cursor, rawLine);
        return null;
      }
      cursor++;
      while (isSpace(text[cursor])) cursor++;
      if (text[cursor] !== '"') {
        fail("expected-quote", `expected '"' to open the value of label "${name}"`, lineNo, startColumn + cursor, rawLine);
        return null;
      }
      const valueStart = cursor + 1;
      let scan = valueStart;
      let raw = "";
      while (true) {
        const char = text[scan];
        if (char === undefined) {
          fail("unterminated-label-value", `unterminated value for label "${name}"`, lineNo, startColumn + scan, rawLine);
          return null;
        }
        if (char === "\\") {
          raw += char + (text[scan + 1] ?? "");
          scan += 2;
          continue;
        }
        if (char === '"') break;
        raw += char;
        scan++;
      }
      const value = unescapeLabelValue(raw);
      if (value === null) {
        fail("invalid-escape", `invalid escape sequence in the value of label "${name}"`, lineNo, startColumn + valueStart, rawLine);
        return null;
      }
      if (labels[name] !== undefined) {
        fail("duplicate-label", `duplicate label "${name}"`, lineNo, startColumn + cursor, rawLine);
        return null;
      }
      labels[name] = value;
      cursor = scan + 1;
      while (isSpace(text[cursor])) cursor++;
      if (text[cursor] === ",") {
        cursor++;
        continue;
      }
      if (text[cursor] === "}") {
        cursor++;
        break;
      }
      fail(
        unterminated ? "unterminated-label-set" : "expected-comma-or-brace",
        unterminated
          ? "unterminated label set"
          : `expected "," or "}" after label "${name}"`,
        lineNo,
        startColumn + cursor,
        rawLine,
      );
      return null;
    }
    return { labels, consumed: cursor };
  };

  let lastSeries: Series | undefined;

  const handleExemplar = (body: string, lineNo: number, rawLine: string): void => {
    if (!allowOpenMetrics) {
      fail("openmetrics-disabled", "exemplars are an OpenMetrics feature and are disabled", lineNo, 1, rawLine);
      return;
    }
    const block = parseLabelBlock(body, lineNo, rawLine, 1);
    if (!block) return;
    const rest = body.slice(block.consumed);
    if (rest.length > 0 && !isSpace(rest[0])) {
      fail("malformed-exemplar", "expected whitespace after the exemplar label set", lineNo, block.consumed + 1, rawLine);
      return;
    }
    const tokens = rest.trim().split(/\s+/).filter((token) => token.length > 0);
    if (tokens.length === 0) {
      fail("malformed-exemplar", "exemplar is missing its value", lineNo, 1, rawLine);
      return;
    }
    if (tokens.length > 2) {
      fail("malformed-exemplar", "exemplar has trailing content after its value", lineNo, 1, rawLine);
      return;
    }
    const value = parseValue(tokens[0]!);
    if (value === null) {
      fail("invalid-value", `invalid exemplar value "${tokens[0]}"`, lineNo, 1, rawLine);
      return;
    }
    let timestamp: number | undefined;
    if (tokens.length === 2) {
      const parsed = parseTimestamp(tokens[1]!);
      if (parsed === null) {
        fail("invalid-timestamp", `invalid exemplar timestamp "${tokens[1]}"`, lineNo, 1, rawLine);
        return;
      }
      timestamp = parsed;
    }
    if (!lastSeries) {
      fail("orphan-exemplar", "exemplar does not follow a sample", lineNo, 1, rawLine);
      return;
    }
    if (lastSeries.exemplar) {
      fail("duplicate-exemplar", `sample "${lastSeries.name}" already has an exemplar`, lineNo, 1, rawLine);
      return;
    }
    const exemplar: Exemplar = { labels: block.labels, value };
    if (timestamp !== undefined) exemplar.timestamp = timestamp;
    lastSeries.exemplar = exemplar;
  };

  const handleComment = (body: string, lineNo: number, rawLine: string): void => {
    if (body.startsWith("{")) {
      handleExemplar(body, lineNo, rawLine);
      return;
    }
    const keywordMatch = /^(\S+)\s*(.*)$/.exec(body);
    if (!keywordMatch) return;
    const keyword = keywordMatch[1]!;
    const rest = keywordMatch[2]!;

    if (keyword === "HELP") {
      const split = /^(\S+)(?:\s(.*))?$/.exec(rest);
      if (!split) {
        fail("malformed-help", "malformed HELP line", lineNo, 1, rawLine);
        return;
      }
      const name = split[1]!;
      if (!METRIC_NAME_RE.test(name)) {
        fail("invalid-metric-name", `invalid metric name "${name}" in HELP`, lineNo, 1, rawLine);
        return;
      }
      const unescaped = unescapeHelpText(split[2] ?? "");
      if (unescaped.invalid) {
        warnings.push({
          code: "invalid-escape",
          message: `HELP for "${name}" contains an undefined escape sequence; kept verbatim`,
          line: lineNo,
          column: 1,
        });
      }
      writeMetadata(
        name,
        (meta) => {
          meta.help = unescaped.text;
        },
        (meta) => meta.help !== undefined,
        "duplicate-help",
        lineNo,
      );
      return;
    }

    if (keyword === "TYPE") {
      const parts = rest.trim().split(/\s+/);
      if (parts.length !== 2) {
        fail("malformed-type", "malformed TYPE line; expected `# TYPE <name> <type>`", lineNo, 1, rawLine);
        return;
      }
      const name = parts[0]!;
      const type = parts[1]!;
      if (!METRIC_NAME_RE.test(name)) {
        fail("invalid-metric-name", `invalid metric name "${name}" in TYPE`, lineNo, 1, rawLine);
        return;
      }
      if (!isMetricType(type)) {
        fail("invalid-metric-type", `unknown metric type "${type}"`, lineNo, 1, rawLine);
        return;
      }
      const existing = metadata.get(name);
      if (existing?.type !== undefined && existing.type !== type) {
        fail("conflicting-type", `family "${name}" was already declared ${existing.type}`, lineNo, 1, rawLine);
        return;
      }
      writeMetadata(
        name,
        (meta) => {
          meta.type = type;
        },
        (meta) => meta.type !== undefined,
        "duplicate-type",
        lineNo,
      );
      return;
    }

    if (keyword === "UNIT") {
      if (!allowOpenMetrics) {
        fail("openmetrics-disabled", "# UNIT is an OpenMetrics feature and is disabled", lineNo, 1, rawLine);
        return;
      }
      const parts = rest.trim().split(/\s+/);
      if (parts.length < 1 || parts.length > 2) {
        fail("malformed-unit", "malformed UNIT line; expected `# UNIT <name> <unit>`", lineNo, 1, rawLine);
        return;
      }
      const name = parts[0]!;
      if (!METRIC_NAME_RE.test(name)) {
        fail("invalid-metric-name", `invalid metric name "${name}" in UNIT`, lineNo, 1, rawLine);
        return;
      }
      const unit = parts[1] ?? "";
      writeMetadata(
        name,
        (meta) => {
          meta.unit = unit;
        },
        (meta) => meta.unit !== undefined,
        "duplicate-unit",
        lineNo,
      );
      return;
    }

    if (keyword === "EOF") {
      if (!allowOpenMetrics) {
        fail("openmetrics-disabled", "# EOF is an OpenMetrics feature and is disabled", lineNo, 1, rawLine);
        return;
      }
      openMetrics = true;
      sawEof = true;
      return;
    }

    // Any other `#` line is a comment, which the format explicitly allows.
  };

  const handleSample = (line: string, lineNo: number, rawLine: string): void => {
    const nameMatch = LEADING_METRIC_NAME_RE.exec(line);
    if (!nameMatch) {
      fail("invalid-metric-name", "line does not start with a metric name", lineNo, 1, rawLine);
      return;
    }
    const name = nameMatch[0];
    let cursor = name.length;
    let labels: Labels = {};

    // No whitespace is permitted between the metric name and its label set —
    // `metric {a="b"} 1` is not valid exposition text.
    if (line[cursor] === "{") {
      const block = parseLabelBlock(line.slice(cursor), lineNo, rawLine, cursor + 1);
      if (!block) return;
      labels = block.labels;
      cursor += block.consumed;
    }

    if (!isSpace(line[cursor])) {
      fail("missing-value", `sample "${name}" is missing its value`, lineNo, cursor + 1, rawLine);
      return;
    }
    const tokens = line.slice(cursor).trim().split(/\s+/).filter((token) => token.length > 0);
    if (tokens.length === 0) {
      fail("missing-value", `sample "${name}" is missing its value`, lineNo, cursor + 1, rawLine);
      return;
    }
    if (tokens.length > 2) {
      fail("trailing-content", `sample "${name}" has trailing content after its timestamp`, lineNo, cursor + 1, rawLine);
      return;
    }
    const value = parseValue(tokens[0]!);
    if (value === null) {
      fail("invalid-value", `invalid value "${tokens[0]}" for sample "${name}"`, lineNo, cursor + 1, rawLine);
      return;
    }
    let timestamp: number | undefined;
    if (tokens.length === 2) {
      const parsed = parseTimestamp(tokens[1]!);
      if (parsed === null) {
        fail("invalid-timestamp", `invalid timestamp "${tokens[1]}" for sample "${name}"`, lineNo, cursor + 1, rawLine);
        return;
      }
      timestamp = parsed;
    }

    let metricName = name;
    if (labels["__name__"] !== undefined) {
      if (strict) {
        fail("reserved-label-name", "__name__ may not appear as a label in the exposition format", lineNo, 1, rawLine);
        return;
      }
      metricName = labels["__name__"]!;
      delete labels["__name__"];
      warnings.push({
        code: "reserved-label-name",
        message: `"__name__" label found on "${name}"; using "${metricName}" as the metric name`,
        line: lineNo,
        column: 1,
      });
      if (!METRIC_NAME_RE.test(metricName)) {
        fail("invalid-metric-name", `"${metricName}" from the __name__ label is not a valid metric name`, lineNo, 1, rawLine);
        return;
      }
    }

    const entry: Series = { name: metricName, labels, value };
    if (timestamp !== undefined) entry.timestamp = timestamp;
    commitSeries(entry);
    lastSeries = entry;
  };

  const lines = input.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const lineNo = index + 1;
    let line = lines[index]!;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.length > maxLineLength) {
      throw new ParseError(
        `line exceeds the ${maxLineLength} character limit`,
        lineNo,
        1,
        line.slice(0, 256),
      );
    }
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    if (sawEof) {
      fail("content-after-eof", "content found after the OpenMetrics # EOF marker", lineNo, 1, line);
      sawEof = false;
      continue;
    }

    if (trimmed.startsWith("#")) {
      handleComment(trimmed.slice(1).trimStart(), lineNo, line);
      continue;
    }

    handleSample(line.trimStart(), lineNo, line);
  }

  return { series, metadata, warnings, openMetrics };
}

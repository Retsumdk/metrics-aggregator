/**
 * Shared primitives for the Prometheus exposition format: name validation,
 * label escaping, value parsing/formatting, family resolution and the sort
 * order used everywhere in this codebase.
 *
 * Keeping these in one module matters because the parser, the aggregator and
 * the encoder must agree on all of them. A formatter that disagrees with the
 * parser about, say, `1e-7` vs `1e-07` produces an aggregator whose output
 * cannot be re-ingested by the thing that fed it.
 */

import type { Labels, Metadata, MetadataMap, MetricType, Series } from "./types.ts";

/** Prometheus metric name grammar. */
export const METRIC_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
/** Prometheus label name grammar. */
export const LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export const LEADING_METRIC_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*/;

export const METRIC_TYPES: readonly MetricType[] = ["counter", "gauge", "histogram", "summary", "untyped"];

const MAX_EXACT_INTEGER = 1e15;

export function isValidMetricName(name: string): boolean {
  return METRIC_NAME_RE.test(name);
}

export function isValidLabelName(name: string): boolean {
  return LABEL_NAME_RE.test(name);
}

export function isMetricType(value: string): value is MetricType {
  return (METRIC_TYPES as readonly string[]).includes(value);
}

/**
 * Infer a type from a metric name when the input declared none. Only the
 * unambiguous cases are inferred — a bare `_total` suffix on a counter, and the
 * `le`/`quantile` label conventions are handled by callers that can see labels.
 */
export function metricTypeOf(name: string, declared?: MetricType): MetricType {
  // An explicitly `untyped` family is "we do not know", not "not a counter", so
  // the `_total` convention still applies — that is what Prometheus itself does.
  if (declared !== undefined && declared !== "untyped") return declared;
  if (name.endsWith("_total") || name.endsWith("_count_total")) return "counter";
  return "untyped";
}

/** Escape a label value for the wire format. */
export function escapeLabelValue(value: string): string {
  let out = "";
  for (const char of value) {
    if (char === "\\") out += "\\\\";
    else if (char === '"') out += '\\"';
    else if (char === "\n") out += "\\n";
    else out += char;
  }
  return out;
}

/**
 * Unescape a label value. Returns `null` for a backslash escape that the format
 * does not define, so the caller can report it as a parse error instead of
 * silently passing the backslash through.
 */
export function unescapeLabelValue(raw: string): string | null {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!;
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) return null;
    if (next === "\\") out += "\\";
    else if (next === '"') out += '"';
    else if (next === "n") out += "\n";
    else return null;
    i++;
  }
  return out;
}

/** Escape HELP text: the format only defines backslash and newline escapes. */
export function escapeHelpText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

/**
 * Render a float the way the reference implementation does: shortest
 * round-trip form, `NaN`/`+Inf`/`-Inf` for the special values, no trailing
 * `.0` on integers, and an exponent padded to at least two digits
 * (`1e-07`, not `1e-7`).
 */
export function formatValue(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  if (Object.is(value, -0)) return "-0";
  if (Number.isInteger(value) && Math.abs(value) < MAX_EXACT_INTEGER) return String(value);
  const text = String(value);
  return text.replace(/e([+-])(\d)$/, "e$10$2").replace(/e([+-])(\d{2,})$/, "e$1$2");
}

/**
 * Parse a sample value. Accepts everything the reference parser accepts,
 * including the `Inf`/`Infinity` spellings Go's `ParseFloat` allows, but
 * rejects partial parses such as `1.2.3` or `12abc`.
 */
export function parseValue(text: string): number | null {
  if (text.length === 0) return null;
  const lower = text.toLowerCase();
  if (lower === "nan") return Number.NaN;
  if (lower === "inf" || lower === "+inf" || lower === "infinity" || lower === "+infinity") {
    return Number.POSITIVE_INFINITY;
  }
  if (lower === "-inf" || lower === "-infinity") return Number.NEGATIVE_INFINITY;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return null;
  const value = Number(text);
  return Number.isNaN(value) ? null : value;
}

/**
 * Parse a millisecond timestamp. Prometheus accepts integer milliseconds,
 * optionally signed, and nothing else.
 */
export function parseTimestamp(text: string): number | null {
  if (!/^[+-]?\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/** Label names in sorted order — the order the encoder always writes them. */
export function sortedLabelNames(labels: Labels): string[] {
  return Object.keys(labels).sort();
}

export function labelsEqual(a: Labels, b: Labels): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const key of aKeys) if (a[key] !== b[key]) return false;
  return true;
}

/**
 * Canonical string form of a label set, suitable as a map key. Sorted by label
 * name so `{a="1",b="2"}` and `{b="2",a="1"}` collapse to the same key.
 */
export function labelsKey(labels: Labels): string {
  const names = Object.keys(labels).sort();
  if (names.length === 0) return "";
  return names.map((name) => `${name}\u001f${labels[name]}`).join("\u001e");
}

/** Human-readable form of a label set, for logs and warnings. */
export function labelsToString(labels: Labels): string {
  const names = Object.keys(labels).sort();
  if (names.length === 0) return "{}";
  return `{${names.map((name) => `${name}="${labels[name]}"`).join(",")}}`;
}

/** Return a shallow copy with keys inserted in sorted order. */
export function canonicalLabels(labels: Labels): Labels {
  const out: Labels = {};
  for (const name of Object.keys(labels).sort()) out[name] = labels[name]!;
  return out;
}

/** Merge label sets; later arguments win. */
export function mergeLabels(...sets: Labels[]): Labels {
  const out: Labels = {};
  for (const set of sets) {
    for (const name of Object.keys(set)) out[name] = set[name]!;
  }
  return canonicalLabels(out);
}

/** Copy of `labels` with the named labels removed. */
export function omitLabels(labels: Labels, names: readonly string[]): Labels {
  const drop = new Set(names);
  const out: Labels = {};
  for (const name of Object.keys(labels)) if (!drop.has(name)) out[name] = labels[name]!;
  return canonicalLabels(out);
}

/** Copy of `labels` keeping only the named labels that are actually present. */
export function pickLabels(labels: Labels, names: readonly string[]): Labels {
  const out: Labels = {};
  for (const name of [...names].sort()) {
    const value = labels[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

const SERIES_SUFFIXES = ["_bucket", "_sum", "_count", "_created"] as const;
export type SeriesSuffix = "" | (typeof SERIES_SUFFIXES)[number];

/**
 * Candidate family names for a sample, most specific first:
 * the sample name itself, then the sample name minus a known suffix, then —
 * for `x_total` — the OpenMetrics counter base `x`, which is only a valid
 * family if that base is actually declared a counter.
 */
export function familyCandidates(name: string): string[] {
  const candidates = [name];
  for (const suffix of SERIES_SUFFIXES) {
    if (name.endsWith(suffix) && name.length > suffix.length) {
      candidates.push(name.slice(0, -suffix.length));
      break;
    }
  }
  if (name.endsWith("_total") && name.length > "_total".length) {
    candidates.push(name.slice(0, -"_total".length));
  }
  return candidates;
}

/**
 * Resolve which declared family a sample belongs to, plus its metadata.
 * When nothing is declared, the family is the sample name and the metadata is
 * empty (the caller decides on a default type).
 */
export function metadataFor(name: string, metadata: MetadataMap): { family: string; meta: Metadata } {
  const exact = metadata.get(name);
  if (exact) return { family: name, meta: exact };

  for (const suffix of SERIES_SUFFIXES) {
    if (!name.endsWith(suffix) || name.length <= suffix.length) continue;
    const base = name.slice(0, -suffix.length);
    const meta = metadata.get(base);
    if (meta) return { family: base, meta };
  }

  if (name.endsWith("_total") && name.length > "_total".length) {
    const base = name.slice(0, -"_total".length);
    const meta = metadata.get(base);
    if (meta && meta.type === "counter") return { family: base, meta };
  }

  return { family: name, meta: {} };
}

/** The suffix that separates `name` from its `family`, or `""` when equal. */
export function seriesSuffix(name: string, family: string): SeriesSuffix {
  if (name === family) return "";
  for (const suffix of SERIES_SUFFIXES) {
    if (name === `${family}${suffix}`) return suffix;
  }
  return "";
}

function suffixRank(name: string, family: string): number {
  switch (seriesSuffix(name, family)) {
    case "":
      return 0;
    case "_bucket":
      return 1;
    case "_sum":
      return 2;
    case "_count":
      return 3;
    case "_created":
      return 4;
    default:
      return 0;
  }
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function numericLabel(labels: Labels, name: string): number | null {
  const raw = labels[name];
  if (raw === undefined) return null;
  if (raw === "+Inf" || raw === "Inf") return Number.POSITIVE_INFINITY;
  if (raw === "-Inf") return Number.NEGATIVE_INFINITY;
  const value = Number(raw);
  return Number.isNaN(value) ? null : value;
}

/**
 * Total order over samples, used by the encoder and by every comparison in the
 * test-suite so output is byte-stable. Families sort by name; within a family
 * the "primary" sample (`x`) comes before `x_bucket`, `x_sum`, `x_count` and
 * `x_created`; buckets and quantiles sort numerically, so `le="+Inf"` is last
 * rather than sorting next to the strings.
 */
export function compareSeries(a: Series, b: Series, metadata: MetadataMap = new Map()): number {
  const familyA = metadataFor(a.name, metadata).family;
  const familyB = metadataFor(b.name, metadata).family;
  const byFamily = compareStrings(familyA, familyB);
  if (byFamily !== 0) return byFamily;

  const byRank = suffixRank(a.name, familyA) - suffixRank(b.name, familyB);
  if (byRank !== 0) return byRank;

  const leA = numericLabel(a.labels, "le");
  const leB = numericLabel(b.labels, "le");
  if (leA !== null && leB !== null && leA !== leB) return leA < leB ? -1 : 1;

  const quantileA = numericLabel(a.labels, "quantile");
  const quantileB = numericLabel(b.labels, "quantile");
  if (quantileA !== null && quantileB !== null && quantileA !== quantileB) return quantileA < quantileB ? -1 : 1;

  const byLabels = compareStrings(labelsKey(a.labels), labelsKey(b.labels));
  if (byLabels !== 0) return byLabels;

  const byName = compareStrings(a.name, b.name);
  if (byName !== 0) return byName;

  const timestampA = a.timestamp ?? Number.NEGATIVE_INFINITY;
  const timestampB = b.timestamp ?? Number.NEGATIVE_INFINITY;
  if (timestampA !== timestampB) return timestampA < timestampB ? -1 : 1;

  if (a.value !== b.value && !(Number.isNaN(a.value) && Number.isNaN(b.value))) {
    return a.value < b.value ? -1 : 1;
  }
  return 0;
}

/** Stable, locale-independent sort used in place of `Array#sort` defaults. */
export function sortSeries(series: readonly Series[], metadata: MetadataMap = new Map()): Series[] {
  return [...series].sort((a, b) => compareSeries(a, b, metadata));
}

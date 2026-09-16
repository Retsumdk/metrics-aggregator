/**
 * metrics-aggregator — the public API.
 *
 * A Prometheus-compatible aggregation service: parse the text exposition format,
 * merge samples from many sources onto a reduced label set, and re-emit valid
 * exposition text. Zero runtime dependencies; Node's standard library only.
 *
 * ```ts
 * import { parseExposition, aggregate, encodeExposition } from "metrics-aggregator";
 *
 * const a = parseExposition(await Bun.file("node-a.txt").text());
 * const b = parseExposition(await Bun.file("node-b.txt").text());
 * const merged = aggregate([...a.series, ...b.series], b.metadata, { without: ["instance"] });
 * process.stdout.write(encodeExposition(merged.series, merged.metadata));
 * ```
 */

export { VERSION } from "./version.ts";

/**
 * The CLI entry point, re-exported so an embedder (or a test harness) can drive
 * the command line in-process instead of spawning a child Bun process.
 */
export { main } from "./cli.ts";

export * from "./types.ts";

export {
  ParseError,
  parseExposition,
  parseSeries,
} from "./parser.ts";

export {
  EncodeError,
  encodeExposition,
  encodeSample,
  encodeExemplar,
} from "./encoder.ts";

export {
  AGGREGATOR_NAMES,
  AggregateConfigError,
  AggregateConflictError,
  aggregate,
} from "./aggregate.ts";

export {
  ScrapeError,
  resolveRetryDelayMs,
  scrapeAll,
  scrapeTarget,
} from "./scrape.ts";

export {
  MetricStore,
  StoreError,
  dedupeSeries,
  mergeMetadataMaps,
} from "./store.ts";

export {
  createHandler,
  parseAggregateOptions,
  requireAuth,
  startServer,
} from "./server.ts";

export {
  METRIC_NAME_RE,
  LABEL_NAME_RE,
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
  sortedLabelNames,
  sortSeries,
  unescapeLabelValue,
} from "./format.ts";

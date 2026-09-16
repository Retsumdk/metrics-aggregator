/**
 * Public type surface for metrics-aggregator.
 *
 * Everything here is intentionally serialisable: a `Series` is the unit that
 * crosses every boundary in this codebase (parse → scrape → store → aggregate
 * → encode), so it holds only strings and numbers.
 */

/** Prometheus metric types. `untyped` is what you get when nothing was declared. */
export type MetricType = "counter" | "gauge" | "histogram" | "summary" | "untyped";

/** Label name → label value. `__name__` is never stored here. */
export type Labels = Record<string, string>;

/** A `# {…} value [timestamp]` exemplar line (OpenMetrics). */
export interface Exemplar {
  labels: Labels;
  value: number;
  timestamp?: number;
}

/** One sample: a metric name, its labels, a value and an optional timestamp (ms). */
export interface Series {
  name: string;
  labels: Labels;
  value: number;
  timestamp?: number;
  exemplar?: Exemplar;
}

/** Family-level metadata declared with `# HELP` / `# TYPE` / `# UNIT`. */
export interface Metadata {
  type?: MetricType;
  help?: string;
  unit?: string;
}

export type MetadataMap = Map<string, Metadata>;

/** A non-fatal problem found while parsing. */
export interface ParseWarning {
  code: string;
  message: string;
  line: number;
  column: number;
}

/** Hard parse failure. Carries the offending position and line text. */
export interface ParseFailure {
  message: string;
  line: number;
  column: number;
  text: string;
}

export interface ParseOptions {
  /** Throw on the first problem instead of collecting it as a warning. */
  strict?: boolean;
  /** Accept OpenMetrics extras: `# UNIT`, `# EOF`, exemplars. Default `true`. */
  allowOpenMetrics?: boolean;
  /** Type assumed for samples whose family declared none. Default `untyped`. */
  defaultType?: MetricType;
  /** Reject documents longer than this many samples (default 1,000,000). */
  maxSeries?: number;
  /** Reject lines longer than this many characters (default 1 MiB). */
  maxLineLength?: number;
}

export interface ParseResult {
  series: Series[];
  metadata: MetadataMap;
  warnings: ParseWarning[];
  /** True when the document ended with the OpenMetrics `# EOF` marker. */
  openMetrics: boolean;
}

export type AggregatorName =
  | "sum"
  | "min"
  | "max"
  | "avg"
  | "count"
  | "stddev"
  | "stdvar"
  | "last"
  | "first"
  | "group";

/**
 * How to treat two samples that share a metric name and label set:
 * - `keep`   — both are group members (default; correct for N scraped targets)
 * - `newest` — keep only the sample with the greatest timestamp
 * - `error`  — fail with a duplicate-sample error
 */
export type ConflictPolicy = "keep" | "newest" | "error";

export interface AggregateOptions {
  /** Keep only these labels when grouping (exclusive with `without`). */
  by?: string[];
  /** Drop these labels before grouping (exclusive with `by`). */
  without?: string[];
  /** Static labels added to every output series. */
  label?: Labels;
  /** Rename the output family. */
  name?: string;
  /** Aggregation functions to apply. Default `["sum"]`. */
  aggregators?: AggregatorName[];
  /** Extra labels removed before grouping, in addition to `without`. */
  dropLabels?: string[];
  /** Drop summary quantile series (default `true`) instead of approximating them. */
  dropQuantiles?: boolean;
  /** Collapse exact duplicate samples. Default `true`. */
  dedupeIdentical?: boolean;
  /** Behaviour for conflicting duplicates. Default `keep`. */
  conflictPolicy?: ConflictPolicy;
}

export interface AggregateStats {
  inputSeries: number;
  /** Exact duplicate samples collapsed before grouping. */
  dedupedSamples: number;
  /** Samples discarded because `conflictPolicy: "newest"` superseded them. */
  conflictsResolved: number;
  groups: number;
  outputSeries: number;
  /** Summary quantile series removed because they cannot be aggregated. */
  droppedQuantileSeries: number;
  histogramGroups: number;
  summaryGroups: number;
  /** Output series produced per aggregator function. */
  perAggregator: Record<string, number>;
  /** Human-readable notes about anything lossy or surprising. */
  warnings: string[];
}

export interface AggregateResult {
  series: Series[];
  metadata: MetadataMap;
  stats: AggregateStats;
}

export interface EncodeOptions {
  openMetrics?: boolean;
  includeHelp?: boolean;
  includeType?: boolean;
  sort?: boolean;
}

/** A scrape target: a URL serving the Prometheus text format. */
export interface TargetSpec {
  url: string;
  /** Display name; defaults to the URL. */
  name?: string;
  headers?: Record<string, string>;
  bearer?: string;
  basic?: { username: string; password: string };
  timeoutMs?: number;
  retries?: number;
  /** Grouping labels applied to every sample from this target. */
  labels?: Labels;
}

export interface ScrapeOptions {
  timeoutMs?: number;
  /** Fail the scrape on a format error instead of collecting warnings. */
  strict?: boolean;
  retries?: number;
  retryDelayMs?: number;
  concurrency?: number;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export type ScrapeErrorKind = "timeout" | "network" | "http" | "parse" | "aborted";

export interface ScrapeResult {
  target: TargetSpec;
  ok: boolean;
  series: Series[];
  metadata: MetadataMap;
  warnings: ParseWarning[];
  durationMs: number;
  attempts: number;
  status?: number;
  error?: string;
  errorKind?: ScrapeErrorKind;
}

/** Rolling state of a configured target inside the server. */
export interface TargetState {
  spec: TargetSpec;
  ok: boolean;
  lastScrapeAt?: number;
  lastDurationMs?: number;
  lastSeriesCount?: number;
  lastError?: string;
  consecutiveFailures: number;
}

/** A push group: everything pushed under one job and grouping label set. */
export interface PushGroup {
  job: string;
  grouping: Labels;
  series: Series[];
  metadata: MetadataMap;
  pushedAt: number;
}

export interface PushGroupInfo {
  job: string;
  grouping: Labels;
  seriesCount: number;
  pushedAt: number;
}

export interface StoreStats {
  groups: number;
  series: number;
  families: number;
}

export interface ServerOptions {
  port?: number;
  host?: string;
  /** Bearer token required for every write endpoint. */
  token?: string;
  aggregate?: AggregateOptions;
  targets?: TargetSpec[];
  scrapeIntervalMs?: number;
  scrapeTimeoutMs?: number;
  scrapeRetries?: number;
  /** Scrape-level defaults (timeouts, retries, concurrency, extra headers). */
  scrape?: ScrapeOptions;
  /** Drop push groups that have not been refreshed for this long. `0` disables TTL. */
  pushTtlMs?: number;
  /** Serve OpenMetrics framing (`# UNIT`, `# EOF`) when a client asks for it. */
  openMetrics?: boolean;
  fetchImpl?: typeof fetch;
  /** Silence the built-in request logger. */
  quiet?: boolean;
}

export interface RunningServer {
  url: string;
  port: number;
  stop(): Promise<void>;
  /** Convenience wrapper used by the CLI and the tests. */
  request(path: string, init?: RequestInit): Promise<Response>;
}

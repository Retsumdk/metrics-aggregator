/**
 * Target scraper.
 *
 * Pulls exposition text over HTTP from one or more targets and turns it into
 * samples. The interesting parts, which a naive `await fetch(url).text()` gets
 * wrong:
 *
 * - a timeout that actually fires (an unresponsive target must not pin a slot),
 * - retries that distinguish transient failures (429/408/5xx, network) from
 *   permanent ones (404/403) and honour `Retry-After`,
 * - exponential backoff with jitter, capped,
 * - a bounded worker pool so 50 targets do not open 50 sockets at once,
 * - per-target labels applied as *defaults*: a sample that already carries the
 *   label keeps its own value instead of being silently relabelled.
 */

import { ParseError, parseExposition } from "./parser.ts";
import type {
  Labels,
  ParseWarning,
  ScrapeErrorKind,
  ScrapeOptions,
  ScrapeResult,
  Series,
  TargetSpec,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_CONCURRENCY = 4;
const MAX_RETRY_DELAY_MS = 30_000;

export class ScrapeError extends Error {
  constructor(
    message: string,
    readonly kind: ScrapeErrorKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ScrapeError";
  }
}

/** HTTP status codes worth another attempt. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Delay before attempt `attempt + 1`, in milliseconds.
 *
 * `Retry-After` wins when the server sends a sane value; otherwise this is
 * `base * 2 ** attempt` with full jitter, capped so a flapping target cannot
 * stall a scrape loop for minutes.
 */
export function resolveRetryDelayMs(
  attempt: number,
  baseDelayMs: number = DEFAULT_RETRY_DELAY_MS,
  retryAfterSeconds?: number | null,
  random: () => number = Math.random,
): number {
  if (retryAfterSeconds !== undefined && retryAfterSeconds !== null) {
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
      return Math.min(retryAfterSeconds * 1000, MAX_RETRY_DELAY_MS);
    }
  }
  const exponential = baseDelayMs * 2 ** attempt;
  const jittered = exponential / 2 + random() * (exponential / 2);
  return Math.min(Math.round(jittered), MAX_RETRY_DELAY_MS);
}

/** Parse a `Retry-After` header (delta-seconds form) into seconds. */
export function parseRetryAfter(value: string | null, nowMs: number = Date.now()): number | null {
  if (value === null || value.trim() === "") return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, (date - nowMs) / 1000);
}

function targetHeaders(spec: TargetSpec, shared?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { accept: "text/plain, application/openmetrics-text;q=0.9, */*;q=0.1" };
  for (const [name, value] of Object.entries(shared ?? {})) headers[name.toLowerCase()] = value;
  for (const [name, value] of Object.entries(spec.headers ?? {})) headers[name.toLowerCase()] = value;
  if (spec.bearer !== undefined && spec.bearer !== "") {
    headers.authorization = `Bearer ${spec.bearer}`;
  } else if (spec.basic !== undefined) {
    const raw = `${spec.basic.username}:${spec.basic.password}`;
    headers.authorization = `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
  }
  return headers;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Apply target labels as defaults. Sample labels always win: a target that
 * declares `{job="api"}` must not rewrite a metric that already says
 * `job="billing"`, because that would silently merge two different series.
 */
export function applyDefaultLabels(series: readonly Series[], defaults: Labels | undefined): Series[] {
  if (defaults === undefined || Object.keys(defaults).length === 0) {
    return [...series];
  }
  return series.map((sample) => {
    let changed = false;
    const labels: Labels = { ...sample.labels };
    for (const [name, value] of Object.entries(defaults)) {
      if (labels[name] === undefined) {
        labels[name] = value;
        changed = true;
      }
    }
    return changed ? { ...sample, labels } : sample;
  });
}

export interface ScrapeTargetDeps {
  fetchImpl?: typeof fetch;
  random?: () => number;
  sleepImpl?: (ms: number) => Promise<void>;
}

/** Scrape one target, retrying transient failures. Never throws; failures land in the result. */
export async function scrapeTarget(
  spec: TargetSpec,
  options: ScrapeOptions = {},
  deps: ScrapeTargetDeps = {},
): Promise<ScrapeResult> {
  const fetchImpl = deps.fetchImpl ?? options.fetchImpl ?? globalThis.fetch;
  const random = deps.random ?? Math.random;
  const sleepImpl = deps.sleepImpl ?? sleep;
  const timeoutMs = spec.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = Math.max(0, spec.retries ?? options.retries ?? DEFAULT_RETRIES);
  const headers = targetHeaders(spec, options.headers);
  const started = Date.now();
  let attempts = 0;
  let lastError = "";
  let lastKind: ScrapeErrorKind = "network";
  let lastStatus: number | undefined;

  if (typeof fetchImpl !== "function") {
    return {
      target: spec,
      ok: false,
      series: [],
      metadata: new Map(),
      warnings: [],
      durationMs: 0,
      attempts: 0,
      error: "no fetch implementation available (Node 18+ or Bun required)",
      errorKind: "network",
    };
  }

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    attempts += 1;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetchImpl(spec.url, {
        method: "GET",
        headers,
        signal: controller.signal,
        redirect: "follow",
      });
      lastStatus = response.status;

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        lastStatus = response.status;
        lastKind = "http";
        lastError = `HTTP ${response.status} ${response.statusText}${body === "" ? "" : `: ${body.slice(0, 200).trim()}`}`;
        if (isRetryableStatus(response.status) && attempt < maxRetries) {
          const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
          await sleepImpl(resolveRetryDelayMs(attempt, options.retryDelayMs, retryAfter, random));
          continue;
        }
        break;
      }

      const text = await response.text();
      const parsed = parseExposition(text, { strict: options.strict ?? false });
      const series = applyDefaultLabels(parsed.series, spec.labels);
      return {
        target: spec,
        ok: true,
        series,
        metadata: parsed.metadata,
        warnings: parsed.warnings,
        durationMs: Date.now() - started,
        attempts,
        status: response.status,
      };
    } catch (error) {
      if (error instanceof ParseError) {
        // A malformed document will not become well-formed on a retry.
        lastKind = "parse";
        lastError = error.message;
        break;
      }
      if (timedOut) {
        lastKind = "timeout";
        lastError = `timed out after ${timeoutMs}ms`;
      } else if (error instanceof Error && error.name === "AbortError") {
        lastKind = "aborted";
        lastError = "request aborted";
      } else {
        lastKind = "network";
        lastError = errorMessage(error);
      }
      if (attempt < maxRetries) {
        await sleepImpl(resolveRetryDelayMs(attempt, options.retryDelayMs, null, random));
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    target: spec,
    ok: false,
    series: [],
    metadata: new Map(),
    warnings: [] as ParseWarning[],
    durationMs: Date.now() - started,
    attempts,
    ...(lastStatus === undefined ? {} : { status: lastStatus }),
    error: lastError,
    errorKind: lastKind,
  };
}

/**
 * Scrape many targets through a bounded pool. Results keep the input order, so
 * callers can zip them against their target list.
 */
export async function scrapeAll(
  specs: readonly TargetSpec[],
  options: ScrapeOptions = {},
  deps: ScrapeTargetDeps = {},
): Promise<ScrapeResult[]> {
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const results: ScrapeResult[] = new Array<ScrapeResult>(specs.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= specs.length) return;
      const spec = specs[index]!;
      results[index] = await scrapeTarget(spec, options, deps);
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, specs.length)) }, worker);
  await Promise.all(workers);
  return results;
}

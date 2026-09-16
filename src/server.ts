/**
 * HTTP control plane.
 *
 * Written against the WHATWG `Request`/`Response` types so the same handler runs
 * on Bun's native server and on `node:http` through a small adapter. Routes:
 *
 *   GET  /metrics                    aggregated exposition text (scrape target)
 *   GET  /-/healthy, /health         liveness
 *   GET  /-/ready                    readiness
 *   GET  /api/status                 JSON status + last aggregation stats
 *   GET  /api/targets                JSON per-target scrape state
 *   GET  /api/series                 JSON sample list from the store
 *   POST /api/aggregate              body = exposition text → aggregated text
 *   PUT  /api/push/:job              replace a push group (also /metrics/job/:job)
 *   POST /api/push/:job              merge into a push group
 *   DELETE /api/push/:job            delete a push group
 *
 * Read routes are open, matching Prometheus itself: `/metrics` has to be
 * scrapeable without credentials. Write routes (`POST /api/aggregate`, pushes)
 * require `Authorization: Bearer <token>` whenever a token is configured, and
 * the comparison is constant-time.
 */

import { timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { aggregate } from "./aggregate.ts";
import { encodeExposition } from "./encoder.ts";
import { LABEL_NAME_RE } from "./format.ts";
import { parseExposition } from "./parser.ts";
import { scrapeAll } from "./scrape.ts";
import { MetricStore } from "./store.ts";
import { VERSION } from "./version.ts";
import type {
  AggregateOptions,
  AggregateStats,
  AggregatorName,
  Labels,
  ScrapeOptions,
  ServerOptions,
  Series,
  TargetSpec,
  TargetState,
} from "./types.ts";

const KNOWN_PATHS = new Map<string, string[]>([
  ["/metrics", ["GET"]],
  ["/health", ["GET"]],
  ["/healthz", ["GET"]],
  ["/-/healthy", ["GET"]],
  ["/-/ready", ["GET"]],
  ["/api/status", ["GET"]],
  ["/api/targets", ["GET"]],
  ["/api/series", ["GET"]],
  ["/api/aggregate", ["POST"]],
]);

const AGGREGATOR_LOOKUP = new Set<string>([
  "sum",
  "min",
  "max",
  "avg",
  "count",
  "stddev",
  "stdvar",
  "last",
  "first",
  "group",
]);

export interface HandlerState {
  store: MetricStore;
  options: ServerOptions;
  targets: TargetState[];
  startedAt: number;
  counters: {
    scrapes: number;
    scrapeFailures: number;
    pushes: number;
    aggregateRequests: number;
  };
  lastAggregate?: AggregateStats;
}

export interface Handler {
  (request: Request): Promise<Response>;
}

function json(body: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function text(body: string, status = 200, contentType = "text/plain; charset=utf-8"): Response {
  return new Response(body, { status, headers: { "content-type": contentType, "cache-control": "no-store" } });
}

/** A 405 that carries the `Allow` header, so a client can recover without guessing. */
function methodNotAllowed(allow: string[]): Response {
  const response = json({ error: `method not allowed; allowed: ${allow.join(", ")}` }, 405);
  response.headers.set("allow", allow.join(", "));
  return response;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * `true` when the request may perform a write.
 *
 * With no token configured the server is open — that is the documented default
 * for a service bound to localhost, and `startServer` warns loudly about it.
 */
export function requireAuth(request: Request, token: string | undefined): boolean {
  if (token === undefined || token === "") return true;
  const header = request.headers.get("authorization");
  if (header === null) return false;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  if (match === null) return false;
  return constantTimeEquals(match[1]!.trim(), token);
}

/** Translate `?agg=sum&by=job,method` (and friends) into aggregation options. */
export function parseAggregateOptions(params: URLSearchParams): AggregateOptions {
  const options: AggregateOptions = {};
  const aggregators: AggregatorName[] = [];
  for (const raw of params.getAll("agg")) {
    for (const piece of raw.split(",")) {
      const name = piece.trim();
      if (name === "") continue;
      if (!AGGREGATOR_LOOKUP.has(name)) {
        throw new Error(`unknown aggregator "${name}"`);
      }
      aggregators.push(name as AggregatorName);
    }
  }
  if (aggregators.length > 0) options.aggregators = aggregators;

  const by = params.get("by");
  const without = params.get("without");
  if (by !== null && without !== null) {
    throw new Error("provide either `by` or `without`, not both");
  }
  if (by !== null) {
    options.by = by.split(",").map((name) => name.trim()).filter((name) => name !== "");
  }
  if (without !== null) {
    options.without = without.split(",").map((name) => name.trim()).filter((name) => name !== "");
  }

  const name = params.get("name");
  if (name !== null && name.trim() !== "") options.name = name.trim();

  const labels: Labels = {};
  for (const raw of params.getAll("label")) {
    const separator = raw.indexOf("=");
    if (separator <= 0) throw new Error(`invalid label "${raw}"; expected key=value`);
    labels[raw.slice(0, separator)] = raw.slice(separator + 1);
  }
  if (Object.keys(labels).length > 0) options.label = labels;

  // `dropQuantiles` is the native form; `keepQuantiles` is accepted as its inverse so
  // existing dashboards that used the opt-in spelling keep working.
  const dropQuantiles = params.get("dropQuantiles");
  if (dropQuantiles !== null) {
    options.dropQuantiles = parseBoolean(dropQuantiles, "dropQuantiles");
  } else {
    const keepQuantiles = params.get("keepQuantiles");
    if (keepQuantiles !== null) {
      options.dropQuantiles = !parseBoolean(keepQuantiles, "keepQuantiles");
    }
  }

  const dedupeIdentical = params.get("dedupe");
  if (dedupeIdentical !== null) options.dedupeIdentical = parseBoolean(dedupeIdentical, "dedupe");

  const conflict = params.get("conflict");
  if (conflict !== null) {
    if (conflict !== "keep" && conflict !== "newest" && conflict !== "error") {
      throw new Error(`invalid conflict policy "${conflict}"; expected keep, newest or error`);
    }
    options.conflictPolicy = conflict;
  }
  return options;
}

function parseBoolean(value: string, field: string): boolean {
  const normalised = value.trim().toLowerCase();
  if (normalised === "true" || normalised === "1" || normalised === "yes") return true;
  if (normalised === "false" || normalised === "0" || normalised === "no") return false;
  throw new Error(`invalid boolean for ${field}: "${value}"`);
}

function wantsOpenMetrics(request: Request): boolean {
  const accept = request.headers.get("accept");
  if (accept === null) return false;
  return accept.includes("application/openmetrics-text");
}

function seriesToJson(sample: Series): Record<string, unknown> {
  return {
    name: sample.name,
    labels: sample.labels,
    value: sample.value,
    ...(sample.timestamp === undefined ? {} : { timestamp: sample.timestamp }),
    ...(sample.exemplar === undefined ? {} : { exemplar: sample.exemplar }),
  };
}

/**
 * Pushgateway-style push target: `/metrics/job/db-backup/instance/primary`.
 *
 * Everything after the job name must come in `label/value` pairs — that is the
 * shape the real Pushgateway accepts, and it means a producer cannot smuggle a
 * label name that the server would have to guess at.
 */
function parsePushPath(pathname: string): { job: string; grouping: Labels } | { error: string } {
  const segments = pathname.split("/").filter((segment) => segment !== "");
  const prefix = segments[0] === "metrics" || segments[0] === "api" ? segments[1] : undefined;
  if (prefix !== "job" && prefix !== "push") {
    return { error: "push paths must look like /metrics/job/<job>[/<label>/<value>...]" };
  }
  const job = segments[2];
  if (job === undefined || job === "") return { error: "job name is required" };
  const rest = segments.slice(3);
  if (rest.length % 2 !== 0) return { error: "grouping labels must come in label/value pairs" };
  const grouping: Labels = {};
  for (let index = 0; index < rest.length; index += 2) {
    const name = decodeURIComponent(rest[index]!);
    const value = decodeURIComponent(rest[index + 1]!);
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) return { error: `invalid grouping label name "${name}"` };
    if (name === "__name__") return { error: "__name__ cannot be used as a grouping label" };
    grouping[name] = value;
  }
  return { job: decodeURIComponent(job), grouping };
}

/**
 * Grouping labels supplied as query parameters (`?instance=worker-1`). The path
 * form (`/metrics/job/x/instance/worker-1`) is the Pushgateway convention; the
 * query form carries the same information for clients that would rather not
 * build a deep path.
 */
function groupingFromQuery(params: URLSearchParams): Labels {
  const grouping: Labels = {};
  for (const [name, value] of params) {
    if (!LABEL_NAME_RE.test(name)) {
      throw new Error(`invalid grouping label name "${name}"`);
    }
    if (name === "__name__") {
      throw new Error("__name__ cannot be used as a grouping label");
    }
    grouping[name] = value;
  }
  return grouping;
}

function isPushPath(pathname: string): boolean {
  return (
    pathname === "/api/push" ||
    pathname.startsWith("/api/push/") ||
    pathname === "/metrics/job" ||
    pathname.startsWith("/metrics/job/")
  );
}

/** Build the request handler. Exported so tests can drive the API without a socket. */
export function createHandler(state: HandlerState): Handler {
  const { store, options } = state;

  const handleAggregateRequest = async (request: Request, url: URL): Promise<Response> => {
    let aggregateOptions: AggregateOptions;
    try {
      aggregateOptions = parseAggregateOptions(url.searchParams);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
    const raw = await request.text();
    const parsed = parseExposition(raw, { strict: false });
    const result = aggregate(parsed.series, parsed.metadata, aggregateOptions);
    state.counters.aggregateRequests += 1;
    state.lastAggregate = result.stats;
    const body = encodeExposition(result.series, result.metadata, {
      openMetrics: wantsOpenMetrics(request) || url.searchParams.get("openmetrics") === "true",
    });
    return text(body, 200, "text/plain; charset=utf-8; version=0.0.4");
  };

  const handlePush = async (request: Request, url: URL, mode: "replace" | "merge" | "delete"): Promise<Response> => {
    const target = parsePushPath(url.pathname);
    if ("error" in target) return json({ error: target.error }, 400);
    let grouping: Labels;
    try {
      grouping = { ...target.grouping, ...groupingFromQuery(url.searchParams) };
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }

    if (mode === "delete") {
      const removed = store.delete(target.job, grouping);
      state.counters.pushes += 1;
      return json({ deleted: removed, job: target.job, grouping });
    }

    const raw = await request.text();
    if (raw.trim() === "") return json({ error: "request body must contain exposition text" }, 400);
    const parsed = parseExposition(raw, { strict: false });
    store.push(target.job, grouping, parsed.series, parsed.metadata, mode);
    state.counters.pushes += 1;
    return json({
      stored: parsed.series.length,
      job: target.job,
      grouping,
      mode,
      warnings: parsed.warnings.slice(0, 20),
    });
  };

  return async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    let pathname = url.pathname;
    if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);

    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { allow: "GET, POST, PUT, DELETE, OPTIONS", "cache-control": "no-store" },
      });
    }

    if (isPushPath(pathname)) {
      if (method !== "POST" && method !== "PUT" && method !== "DELETE") {
        return methodNotAllowed(["POST", "PUT", "DELETE"]);
      }
      if (!requireAuth(request, options.token)) {
        return json({ error: "unauthorized" }, 401);
      }
      return handlePush(request, url, method === "DELETE" ? "delete" : method === "POST" ? "merge" : "replace");
    }

    if (pathname === "/metrics") {
      if (method !== "GET" && method !== "HEAD") {
        return methodNotAllowed(["GET"]);
      }
      const snapshot = store.snapshot();
      const result = aggregate(snapshot.series, snapshot.metadata, options.aggregate ?? {});
      const body = encodeExposition(result.series, result.metadata, {
        openMetrics: wantsOpenMetrics(request),
      });
      return text(body, 200, "text/plain; charset=utf-8; version=0.0.4");
    }

    if (pathname === "/-/healthy" || pathname === "/health" || pathname === "/healthz") {
      if (method !== "GET" && method !== "HEAD") {
        return methodNotAllowed(["GET"]);
      }
      return text("OK\n");
    }

    if (pathname === "/-/ready") {
      if (method !== "GET" && method !== "HEAD") {
        return methodNotAllowed(["GET"]);
      }
      return text("OK\n");
    }

    if (pathname === "/api/status") {
      if (method !== "GET") return methodNotAllowed(["GET"]);
      const storeStats = store.stats();
      return json({
        version: VERSION,
        uptimeSeconds: Math.round((Date.now() - state.startedAt) / 1000),
        openMetrics: options.openMetrics ?? false,
        authRequired: options.token !== undefined && options.token !== "",
        intervals: { scrapeIntervalMs: options.scrapeIntervalMs ?? 0, pushTtlMs: options.pushTtlMs ?? 0 },
        aggregateOptions: options.aggregate ?? {},
        store: storeStats,
        push: {
          groups: storeStats.groups,
          series: storeStats.series,
          families: storeStats.families,
          ttlMs: options.pushTtlMs ?? 0,
          seriesIdentities: store.seriesIdentityCount(),
        },
        duplicateSeriesInStore: store.seriesIdentityCount(),
        targets: {
          total: state.targets.length,
          failing: state.targets.filter((target) => !target.ok && target.lastScrapeAt !== undefined).length,
        },
        counters: state.counters,
        lastAggregate: state.lastAggregate ?? null,
      });
    }

    if (pathname === "/api/targets") {
      if (method !== "GET") return methodNotAllowed(["GET"]);
      return json({
        targets: state.targets.map((target) => ({
          url: target.spec.url,
          name: target.spec.name ?? null,
          labels: target.spec.labels ?? {},
          ok: target.ok,
          lastScrapeAt: target.lastScrapeAt ?? null,
          lastDurationMs: target.lastDurationMs ?? null,
          lastSeriesCount: target.lastSeriesCount ?? null,
          lastError: target.lastError ?? null,
          consecutiveFailures: target.consecutiveFailures,
        })),
      });
    }

    if (pathname === "/api/series") {
      if (method !== "GET") return methodNotAllowed(["GET"]);
      const nameFilter = url.searchParams.get("name");
      const limit = Number(url.searchParams.get("limit") ?? "1000");
      if (!Number.isFinite(limit) || limit <= 0) return json({ error: "limit must be a positive number" }, 400);
      const snapshot = store.snapshot();
      const filtered =
        nameFilter === null ? snapshot.series : snapshot.series.filter((sample) => sample.name === nameFilter);
      return json({
        count: filtered.length,
        truncated: filtered.length > limit,
        store: store.stats(),
        groups: store.list(),
        series: filtered.slice(0, limit).map(seriesToJson),
      });
    }

    if (pathname === "/api/aggregate") {
      if (method !== "POST") return methodNotAllowed(["POST"]);
      if (!requireAuth(request, options.token)) return json({ error: "unauthorized" }, 401);
      return handleAggregateRequest(request, url);
    }

    const known = KNOWN_PATHS.get(pathname);
    if (known !== undefined) {
      return methodNotAllowed(known);
    }
    return json({ error: `no route for ${pathname}` }, 404);
  };
}

interface ScrapeLoop {
  stop(): void;
}

async function refreshTargets(state: HandlerState): Promise<void> {
  const specs: TargetSpec[] = state.targets.map((target) => target.spec);
  if (specs.length === 0) return;
  const scrapeOptions: ScrapeOptions = state.options.scrape ?? {};
  const results = await scrapeAll(specs, scrapeOptions);
  state.counters.scrapes += 1;
  for (const [index, result] of results.entries()) {
    const targetState = state.targets[index]!;
    targetState.consecutiveFailures = result.ok ? 0 : targetState.consecutiveFailures + 1;
    targetState.ok = result.ok;
    targetState.lastScrapeAt = Date.now();
    targetState.lastDurationMs = result.durationMs;
    targetState.lastSeriesCount = result.series.length;
    if (result.ok) {
      delete targetState.lastError;
      const grouping: Labels = { target: result.target.name ?? result.target.url };
      if (result.target.labels !== undefined) Object.assign(grouping, result.target.labels);
      state.store.push("scrape", grouping, result.series, result.metadata, "replace");
    } else {
      targetState.lastError = result.error ?? "unknown error";
      state.counters.scrapeFailures += 1;
    }
  }
}

function startScrapeLoop(state: HandlerState): ScrapeLoop {
  const intervalMs = state.options.scrapeIntervalMs ?? 0;
  if (state.targets.length === 0 || intervalMs <= 0) {
    return { stop: () => undefined };
  }
  const tick = (): void => {
    void refreshTargets(state).catch((error: unknown) => {
      if (!state.options.quiet) {
        console.error(`scrape loop error: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  if (typeof timer === "object" && "unref" in timer) timer.unref();
  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}

function pruneLoop(state: HandlerState): ScrapeLoop {
  const ttlMs = state.options.pushTtlMs ?? 0;
  if (ttlMs <= 0) return { stop: () => undefined };
  const intervalMs = Math.max(1000, Math.round(ttlMs / 4));
  const timer = setInterval(() => {
    const removed = state.store.prune(ttlMs);
    if (removed > 0 && !state.options.quiet) {
      console.log(`pruned ${removed} expired push group(s)`);
    }
  }, intervalMs);
  if (typeof timer === "object" && "unref" in timer) timer.unref();
  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}

/** `node:http`'s `close` takes a callback; Bun's takes a boolean. */
type NodeServer = Server & { close(callback: (error?: Error) => void): void };

async function nodeRequestToFetch(request: IncomingMessage, host: string, port: number): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const body = chunks.length === 0 ? undefined : Buffer.concat(chunks);
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else {
      headers.set(name, value);
    }
  }
  const init: RequestInit = { method: request.method ?? "GET", headers };
  if (body !== undefined && (request.method ?? "GET").toUpperCase() !== "GET") {
    init.body = body;
  }
  return new Request(url.toString(), init);
}

async function writeFetchResponseToNode(response: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  res.writeHead(response.status, headers);
  const body = response.body === null ? Buffer.alloc(0) : Buffer.from(await response.arrayBuffer());
  res.end(body);
}

/** Start the HTTP server. Prefers Bun's native server, falls back to `node:http`. */
export async function startServer(options: ServerOptions = {}): Promise<{
  url: string;
  port: number;
  state: HandlerState;
  stop(): Promise<void>;
  request(path: string, init?: RequestInit): Promise<Response>;
}> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 9464;
  const store = new MetricStore();
  const state: HandlerState = {
    store,
    options: { ...options, host, port },
    targets: (options.targets ?? []).map((spec) => ({ spec, ok: true, consecutiveFailures: 0 })),
    startedAt: Date.now(),
    counters: { scrapes: 0, scrapeFailures: 0, pushes: 0, aggregateRequests: 0 },
  };
  const handler = createHandler(state);
  const loops: ScrapeLoop[] = [startScrapeLoop(state), pruneLoop(state)];

  if (!options.quiet) {
    if (options.token === undefined || options.token === "") {
      console.warn(`metrics-aggregator: no --token set; push and aggregate endpoints are unauthenticated`);
    }
    console.log(`metrics-aggregator ${VERSION} listening on http://${host}:${port}`);
  }

  const bunGlobal = (
    globalThis as unknown as {
      Bun?: { serve(options: Record<string, unknown>): { port: number; stop(close?: boolean): void } };
    }
  ).Bun;

  let actualPort = port;
  let close: () => Promise<void>;

  if (bunGlobal !== undefined) {
    const server = bunGlobal.serve({
      hostname: host,
      port,
      fetch: async (request: Request): Promise<Response> => {
        const started = Date.now();
        const response = await handler(request);
        if (!options.quiet) {
          console.log(`${request.method} ${new URL(request.url).pathname} ${response.status} ${Date.now() - started}ms`);
        }
        return response;
      },
    });
    actualPort = server.port;
    close = async () => {
      server.stop(true);
    };
  } else {
    const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const started = Date.now();
        const request = await nodeRequestToFetch(req, host, port);
        const response = await handler(request);
        await writeFetchResponseToNode(response, res);
        if (!options.quiet) {
          console.log(`${request.method} ${new URL(request.url).pathname} ${response.status} ${Date.now() - started}ms`);
        }
      })().catch((error: unknown) => {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        resolve();
      });
    });
    const address = server.address();
    if (address !== null && typeof address === "object") actualPort = address.port;
    close = () =>
      new Promise<void>((resolve) => {
        (server as NodeServer).close(() => {
          resolve();
        });
      });
  }

  const url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${actualPort}`;
  return {
    url,
    port: actualPort,
    state,
    async stop(): Promise<void> {
      for (const loop of loops) loop.stop();
      await close();
    },
    request(path: string, init?: RequestInit): Promise<Response> {
      return fetch(new URL(path, url), init);
    },
  };
}

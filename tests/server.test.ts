/**
 * HTTP service tests.
 *
 * These drive the real handler over a real socket: the routes, the auth gate,
 * the push-gateway semantics and the scrape loop are all exercised the way an
 * operator would hit them, not through the library API.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHandler, parseAggregateOptions, requireAuth, startServer, type HandlerState } from "../src/server.ts";
import { MetricStore } from "../src/store.ts";
import { VERSION } from "../src/version.ts";
import type { ServerOptions, Series, TargetSpec } from "../src/types.ts";

const TOKEN = "s3cr3t-token";

/** Response bodies are asserted on directly; this keeps the casts in one place. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

function sample(name: string, labels: Record<string, string>, value: number, timestamp?: number): Series {
  return timestamp === undefined
    ? { name, labels, value }
    : { name, labels, value, timestamp };
}

/** Minimal exposition document used as push/aggregate payload. */
const PUSH_BODY = [
  "# HELP jobs_queued Queued jobs.",
  "# TYPE jobs_queued gauge",
  'jobs_queued{queue="mail"} 4',
  'jobs_queued{queue="sms"} 6',
  "",
].join("\n");

interface Harness {
  url: string;
  port: number;
  state: HandlerState;
  stop(): Promise<void>;
}

const running: Harness[] = [];

async function start(overrides: ServerOptions = {}): Promise<Harness> {
  const server = await startServer({
    port: 0,
    host: "127.0.0.1",
    token: TOKEN,
    quiet: true,
    ...overrides,
  });
  const harness: Harness = { url: server.url, port: server.port, state: server.state, stop: () => server.stop() };
  running.push(harness);
  return harness;
}

afterEach(async () => {
  while (running.length > 0) {
    const harness = running.pop()!;
    await harness.stop();
  }
});

function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, ...extra };
}

describe("requireAuth", () => {
  test("accepts the configured bearer token", () => {
    const request = new Request("http://localhost/", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(requireAuth(request, TOKEN)).toBe(true);
  });

  test("rejects a wrong, missing, or differently-cased header", () => {
    expect(requireAuth(new Request("http://localhost/"), TOKEN)).toBe(false);
    expect(requireAuth(new Request("http://localhost/", { headers: { authorization: "Bearer nope" } }), TOKEN)).toBe(false);
    expect(requireAuth(new Request("http://localhost/", { headers: { authorization: `Basic ${TOKEN}` } }), TOKEN)).toBe(false);
  });

  test("an unset token leaves the server open, which startServer warns about", () => {
    expect(requireAuth(new Request("http://localhost/"), undefined)).toBe(true);
    expect(requireAuth(new Request("http://localhost/"), "")).toBe(true);
  });
});

describe("parseAggregateOptions", () => {
  test("reads repeatable and comma separated aggregation parameters", () => {
    const params = new URLSearchParams([
      ["agg", "sum"],
      ["agg", "max"],
      ["by", "service,region"],
      ["label", "env=prod"],
      ["label", "team=core"],
      ["name", "cluster_jobs"],
      ["conflict", "newest"],
      ["dropQuantiles", "false"],
      ["dedupe", "false"],
    ]);
    const options = parseAggregateOptions(params);
    expect(options.aggregators).toEqual(["sum", "max"]);
    expect(options.by).toEqual(["service", "region"]);
    expect(options.label).toEqual({ env: "prod", team: "core" });
    expect(options.name).toBe("cluster_jobs");
    expect(options.conflictPolicy).toBe("newest");
    expect(options.dropQuantiles).toBe(false);
    expect(options.dedupeIdentical).toBe(false);
  });

  test("accepts keepQuantiles as the inverse spelling of dropQuantiles", () => {
    const options = parseAggregateOptions(new URLSearchParams([["keepQuantiles", "true"]]));
    expect(options.dropQuantiles).toBe(false);
  });

  test("rejects an unknown aggregator, conflict policy or label", () => {
    expect(() => parseAggregateOptions(new URLSearchParams([["agg", "median"]]))).toThrow();
    expect(() => parseAggregateOptions(new URLSearchParams([["conflict", "coin-flip"]]))).toThrow();
    expect(() => parseAggregateOptions(new URLSearchParams([["label", "novalue"]]))).toThrow();
    expect(() => parseAggregateOptions(new URLSearchParams([["by", ""]]))).not.toThrow();
  });
});

describe("GET /metrics", () => {
  test("serves aggregated exposition text and validates as exposition text", async () => {
    const harness = await start({ aggregate: { by: ["service"], aggregators: ["sum"] } });
    await fetch(`${harness.url}/metrics/job/edge`, {
      method: "PUT",
      headers: auth({ "content-type": "text/plain" }),
      body: [
        'http_requests_total{service="api",instance="a"} 10',
        'http_requests_total{service="api",instance="b"} 32',
        'http_requests_total{service="web",instance="c"} 7',
        "",
      ].join("\n"),
    });

    const response = await fetch(`${harness.url}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const body = await response.text();
    expect(body).toContain('http_requests_total{service="api"} 42');
    expect(body).toContain('http_requests_total{service="web"} 7');
    expect(body).not.toContain("instance=");
  });

  test("speaks OpenMetrics when the client asks for it", async () => {
    const harness = await start({ openMetrics: true });
    await fetch(`${harness.url}/metrics/job/edge`, {
      method: "PUT",
      headers: auth({ "content-type": "text/plain" }),
      body: "# UNIT temp_celsius celsius\ntemp_celsius 21\n",
    });

    const openMetrics = await fetch(`${harness.url}/metrics`, {
      headers: { accept: "application/openmetrics-text" },
    });
    const body = await openMetrics.text();
    expect(body).toContain("# UNIT temp_celsius celsius");
    expect(body.trimEnd().endsWith("# EOF")).toBe(true);

    const classic = await fetch(`${harness.url}/metrics`);
    expect(await classic.text()).not.toContain("# EOF");
  });

  test("an empty store produces an empty document rather than an error", async () => {
    const harness = await start();
    const response = await fetch(`${harness.url}/metrics`);
    expect(response.status).toBe(200);
    expect((await response.text()).trim()).toBe("");
  });
});

describe("health and introspection", () => {
  test("health endpoints answer without a token", async () => {
    const harness = await start();
    for (const path of ["/-/healthy", "/health", "/-/ready"]) {
      const response = await fetch(`${harness.url}${path}`);
      expect(response.status).toBe(200);
      expect((await response.text()).trim()).toBe("OK");
    }
  });

  test("status reports the version, uptime and push groups", async () => {
    const harness = await start();
    await fetch(`${harness.url}/metrics/job/edge`, {
      method: "PUT",
      headers: auth(),
      body: PUSH_BODY,
    });
    const status = (await (await fetch(`${harness.url}/api/status`)).json()) as Json;
    expect(status.version).toBe(VERSION);
    expect(status.push.groups).toBe(1);
    expect(status.push.series).toBe(2);
    expect(typeof status.uptimeSeconds).toBe("number");
    expect(status.push.ttlMs).toBe(0);
  });

  test("series can be listed as JSON", async () => {
    const harness = await start();
    await fetch(`${harness.url}/metrics/job/edge`, { method: "PUT", headers: auth(), body: PUSH_BODY });
    const listing = (await (await fetch(`${harness.url}/api/series`)).json()) as Json;
    expect(listing.count).toBe(2);
    expect(listing.series.map((entry: Series) => entry.value).sort((a: number, b: number) => a - b)).toEqual([4, 6]);
  });
});

describe("push gateway", () => {
  test("PUT replaces a group, POST merges into it, DELETE clears it", async () => {
    const harness = await start();
    const url = `${harness.url}/metrics/job/reporting/instance/primary`;

    const put = await fetch(url, { method: "PUT", headers: auth(), body: PUSH_BODY });
    expect(put.status).toBe(200);
    expect(((await put.json()) as Json).stored).toBe(2);

    await fetch(url, { method: "PUT", headers: auth(), body: "jobs_queued{queue=\"mail\"} 1\n" });
    expect(((await (await fetch(`${harness.url}/api/series`)).json()) as Json).count).toBe(1);

    await fetch(url, { method: "POST", headers: auth(), body: 'jobs_queued{queue="sms"} 3\n' });
    const merged = (await (await fetch(`${harness.url}/api/series`)).json()) as Json;
    expect(merged.count).toBe(2);
    expect(merged.series[0].labels.instance).toBe("primary");

    const deleted = await fetch(url, { method: "DELETE", headers: auth() });
    expect(((await deleted.json()) as Json).deleted).toBe(1);
    expect(((await (await fetch(`${harness.url}/api/series`)).json()) as Json).count).toBe(0);
  });

  test("the /api/push alias accepts the same payload", async () => {
    const harness = await start();
    const response = await fetch(`${harness.url}/api/push/batch?instance=worker-1`, {
      method: "PUT",
      headers: auth(),
      body: PUSH_BODY,
    });
    expect(response.status).toBe(200);
    const listing = (await (await fetch(`${harness.url}/api/series`)).json()) as Json;
    expect(listing.count).toBe(2);
    expect(listing.series[0].labels.instance).toBe("worker-1");
  });

  test("writes need a token", async () => {
    const harness = await start();
    const response = await fetch(`${harness.url}/metrics/job/edge`, { method: "PUT", body: PUSH_BODY });
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toBe("unauthorized");
  });

  test("rejects a malformed push path, an empty body and bad label pairs", async () => {
    const harness = await start();
    expect((await fetch(`${harness.url}/metrics/job`, { method: "PUT", headers: auth(), body: PUSH_BODY })).status).toBe(400);
    expect((await fetch(`${harness.url}/metrics/job/x/odd`, { method: "PUT", headers: auth(), body: PUSH_BODY })).status).toBe(400);
    expect((await fetch(`${harness.url}/metrics/job/x`, { method: "PUT", headers: auth(), body: "   " })).status).toBe(400);
    const badLabel = await fetch(`${harness.url}/metrics/job/x/1bad/value`, {
      method: "PUT",
      headers: auth(),
      body: PUSH_BODY,
    });
    expect(badLabel.status).toBe(400);
    expect(((await badLabel.json()) as { error: string }).error).toContain("invalid grouping label name");
  });
});

describe("POST /api/aggregate", () => {
  test("aggregates the posted document with the query parameters", async () => {
    const harness = await start();
    const response = await fetch(`${harness.url}/api/aggregate?by=service&agg=sum`, {
      method: "POST",
      headers: auth({ "content-type": "text/plain" }),
      body: [
        'rpc_calls_total{service="api",pod="a"} 3',
        'rpc_calls_total{service="api",pod="b"} 4',
        "",
      ].join("\n"),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('rpc_calls_total{service="api"} 7');
    expect(body).not.toContain("pod=");
  });

  test("requires a token and validates the query", async () => {
    const harness = await start();
    expect((await fetch(`${harness.url}/api/aggregate`, { method: "POST", body: "m 1\n" })).status).toBe(401);
    const bad = await fetch(`${harness.url}/api/aggregate?agg=median`, {
      method: "POST",
      headers: auth(),
      body: "m 1\n",
    });
    expect(bad.status).toBe(400);
  });
});

describe("routing", () => {
  test("unknown paths are 404 and known paths reject the wrong method", async () => {
    const harness = await start();
    expect((await fetch(`${harness.url}/nope`)).status).toBe(404);
    const wrongMethod = await fetch(`${harness.url}/api/series`, { method: "POST", headers: auth() });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toContain("GET");
  });

  test("the handler can be driven without a socket, which keeps tests fast", async () => {
    const state: HandlerState = {
      store: new MetricStore(),
      options: { token: TOKEN },
      targets: [],
      startedAt: Date.now(),
      counters: { scrapes: 0, scrapeFailures: 0, pushes: 0, aggregateRequests: 0 },
    };
    const handler = createHandler(state);
    const response = await handler(
      new Request("http://localhost:9137/metrics/job/direct", {
        method: "PUT",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: "direct_pushes_total 1\n",
      }),
    );
    expect(response.status).toBe(200);
    expect(state.counters.pushes).toBe(1);
    expect(state.store.snapshot().series.length).toBe(1);
  });
});

describe("scrape loop", () => {
  test("scrapes configured targets on an interval and serves the result", async () => {
    const payload = `# TYPE target_up gauge\ntarget_up{job="probe"} 1\n`;
    const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(payload) });
    const spec: TargetSpec = { url: `http://127.0.0.1:${upstream.port}/metrics`, name: "upstream" };
    try {
      const harness = await start({ targets: [spec], scrapeIntervalMs: 60_000, aggregate: { without: ["instance"] } });
      // The first scrape fires immediately; poll briefly instead of sleeping a fixed interval.
      let body = "";
      for (let attempt = 0; attempt < 50; attempt += 1) {
        body = await (await fetch(`${harness.url}/metrics`)).text();
        if (body.includes("target_up")) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // Scraped series keep the `job` the upstream document declared, and the
      // `target` grouping label records which scrape produced the sample.
      expect(body).toContain('target_up{job="probe",target="upstream"} 1');

      const targets = (await (await fetch(`${harness.url}/api/targets`)).json()) as {
        targets: { ok: boolean; lastSeriesCount: number }[];
      };
      expect(targets.targets[0]!.ok).toBe(true);
      expect(targets.targets[0]!.lastSeriesCount).toBe(1);
      expect(harness.state.counters.scrapes).toBe(1);
    } finally {
      upstream.stop(true);
    }
  });

  test("a failing target is reported but does not break /metrics", async () => {
    const spec: TargetSpec = { url: "http://127.0.0.1:1/metrics", name: "dead", retries: 0, timeoutMs: 200 };
    const harness = await start({ targets: [spec], scrapeIntervalMs: 60_000 });
    type TargetListing = { targets: { ok: boolean; consecutiveFailures: number; lastError?: string }[] };
    let targets: TargetListing = { targets: [] };
    for (let attempt = 0; attempt < 50; attempt += 1) {
      targets = (await (await fetch(`${harness.url}/api/targets`)).json()) as TargetListing;
      if (targets.targets[0]?.ok === false) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(targets.targets[0]!.ok).toBe(false);
    expect(targets.targets[0]!.consecutiveFailures).toBe(1);
    expect(typeof targets.targets[0]!.lastError).toBe("string");
    expect((await fetch(`${harness.url}/metrics`)).status).toBe(200);
  });

  test("push TTL expires stale groups", async () => {
    const harness = await start({ pushTtlMs: 1 });
    await fetch(`${harness.url}/metrics/job/short-lived`, { method: "PUT", headers: auth(), body: PUSH_BODY });
    expect(harness.state.store.size).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(harness.state.store.size).toBe(0);
  });
});

describe("deterministic output", () => {
  test("two identical requests produce byte-identical documents", async () => {
    const harness = await start({ aggregate: { aggregators: ["sum", "max"] } });
    await fetch(`${harness.url}/metrics/job/a`, { method: "PUT", headers: auth(), body: PUSH_BODY });
    await fetch(`${harness.url}/metrics/job/b`, { method: "PUT", headers: auth(), body: "jobs_queued{queue=\"mail\"} 2\n" });
    const first = await (await fetch(`${harness.url}/metrics`)).text();
    const second = await (await fetch(`${harness.url}/metrics`)).text();
    expect(first).toBe(second);
    expect(sample("jobs_queued", { queue: "mail" }, 0).name).toBe("jobs_queued");
  });
});

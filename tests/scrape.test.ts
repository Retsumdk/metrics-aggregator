import { describe, test, expect } from "bun:test";
import {
  ScrapeError,
  applyDefaultLabels,
  isRetryableStatus,
  parseRetryAfter,
  resolveRetryDelayMs,
  scrapeAll,
  scrapeTarget,
} from "../src/scrape.ts";
import type { Series, TargetSpec } from "../src/types.ts";

const EXPOSITION = [
  "# HELP queue_depth Jobs waiting.",
  "# TYPE queue_depth gauge",
  'queue_depth{queue="default"} 12',
  'queue_depth{queue="slow"} 3',
  "",
].join("\n");

interface Harness {
  url: string;
  requests: { path: string; headers: Record<string, string> }[];
  stop(): void;
}

function startHarness(
  handler: (request: Request, attempt: number) => Response | Promise<Response>,
): Harness {
  const requests: { path: string; headers: Record<string, string> }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const headers: Record<string, string> = {};
      request.headers.forEach((value, name) => {
        headers[name] = value;
      });
      requests.push({ path: new URL(request.url).pathname, headers });
      return handler(request, requests.length);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/metrics`,
    requests,
    stop: () => server.stop(true),
  };
}

const instantSleep = async (): Promise<void> => undefined;

describe("scrapeTarget — success paths", () => {
  test("scrapes a healthy target and keeps the parsed metadata", async () => {
    const harness = startHarness(() => new Response(EXPOSITION));
    try {
      const result = await scrapeTarget({ url: harness.url }, {}, { sleepImpl: instantSleep });
      expect(result.ok).toBe(true);
      expect(result.attempts).toBe(1);
      expect(result.series.length).toBe(2);
      expect(result.series.map((sample) => sample.value).sort((a, b) => a - b)).toEqual([3, 12]);
      expect(result.metadata.get("queue_depth")?.type).toBe("gauge");
      expect(result.metadata.get("queue_depth")?.help).toBe("Jobs waiting.");
      expect(result.status).toBe(200);
      expect(result.error).toBeUndefined();
      expect(typeof result.durationMs).toBe("number");
    } finally {
      harness.stop();
    }
  });

  test("names the target after its URL unless a name is given", async () => {
    const harness = startHarness(() => new Response(EXPOSITION));
    try {
      const anonymous = await scrapeTarget({ url: harness.url }, {}, { sleepImpl: instantSleep });
      expect(anonymous.target.name).toBeUndefined();
      const named = await scrapeTarget(
        { url: harness.url, name: "queue-primary" },
        {},
        { sleepImpl: instantSleep },
      );
      expect(named.target.name).toBe("queue-primary");
    } finally {
      harness.stop();
    }
  });

  test("sends bearer, basic and extra headers", async () => {
    const harness = startHarness(() => new Response(EXPOSITION));
    try {
      await scrapeTarget(
        { url: harness.url, bearer: "s3cret", headers: { "x-scope": "prod" } },
        {},
        { sleepImpl: instantSleep },
      );
      expect(harness.requests[0]!.headers["authorization"]).toBe("Bearer s3cret");
      expect(harness.requests[0]!.headers["x-scope"]).toBe("prod");

      await scrapeTarget(
        { url: harness.url, basic: { username: "u", password: "p" } },
        {},
        { sleepImpl: instantSleep },
      );
      const basic = harness.requests[1]!.headers["authorization"]!;
      expect(basic.startsWith("Basic ")).toBe(true);
      expect(Buffer.from(basic.slice(6), "base64").toString("utf8")).toBe("u:p");
    } finally {
      harness.stop();
    }
  });

  test("sends an Accept header that asks for the exposition format", async () => {
    const harness = startHarness(() => new Response(EXPOSITION));
    try {
      await scrapeTarget({ url: harness.url }, {}, { sleepImpl: instantSleep });
      expect(harness.requests[0]!.headers["accept"]).toContain("text/plain");
    } finally {
      harness.stop();
    }
  });

  test("a body that is not exposition text is reported as warnings, not a failure", async () => {
    const harness = startHarness(() => new Response("<html>not metrics</html>\n"));
    try {
      const result = await scrapeTarget({ url: harness.url }, {}, { sleepImpl: instantSleep });
      expect(result.ok).toBe(true);
      expect(result.series).toEqual([]);
      expect(result.warnings.length).toBeGreaterThan(0);
    } finally {
      harness.stop();
    }
  });

  test("optional strict parsing turns a format error into a failed scrape", async () => {
    const harness = startHarness(() => new Response("m{a=1} 2\n"));
    try {
      const lenient = await scrapeTarget({ url: harness.url }, {}, { sleepImpl: instantSleep });
      expect(lenient.ok).toBe(true);
      expect(lenient.warnings.length).toBeGreaterThan(0);

      const strict = await scrapeTarget(
        { url: harness.url, retries: 3 },
        { strict: true },
        { sleepImpl: instantSleep },
      );
      expect(strict.ok).toBe(false);
      expect(strict.errorKind).toBe("parse");
      // A malformed document is not retried: it cannot fix itself.
      expect(strict.attempts).toBe(1);
    } finally {
      harness.stop();
    }
  });
});

describe("scrapeTarget — retries and failures", () => {
  test("retries a 503 and succeeds", async () => {
    const harness = startHarness((_request, attempt) =>
      attempt < 3 ? new Response("unavailable", { status: 503 }) : new Response(EXPOSITION),
    );
    try {
      const result = await scrapeTarget(
        { url: harness.url },
        { retries: 3 },
        { sleepImpl: instantSleep },
      );
      expect(result.ok).toBe(true);
      expect(result.attempts).toBe(3);
      expect(harness.requests.length).toBe(3);
    } finally {
      harness.stop();
    }
  });

  test("gives up after the retry budget and reports the status", async () => {
    const harness = startHarness(() => new Response("nope", { status: 500 }));
    try {
      const result = await scrapeTarget(
        { url: harness.url },
        { retries: 1 },
        { sleepImpl: instantSleep },
      );
      expect(result.ok).toBe(false);
      expect(result.attempts).toBe(2);
      expect(result.status).toBe(500);
      expect(result.errorKind).toBe("http");
    } finally {
      harness.stop();
    }
  });

  test("does not retry a 404, because it will not become a 200", async () => {
    const harness = startHarness(() => new Response("gone", { status: 404 }));
    try {
      const result = await scrapeTarget(
        { url: harness.url },
        { retries: 5 },
        { sleepImpl: instantSleep },
      );
      expect(result.ok).toBe(false);
      expect(result.attempts).toBe(1);
      expect(result.status).toBe(404);
    } finally {
      harness.stop();
    }
  });

  test("honours Retry-After on a 429", async () => {
    const sleeps: number[] = [];
    const harness = startHarness((_request, attempt) =>
      attempt === 1
        ? new Response("slow down", { status: 429, headers: { "retry-after": "2" } })
        : new Response(EXPOSITION),
    );
    try {
      const result = await scrapeTarget(
        { url: harness.url },
        { retries: 1 },
        {
          sleepImpl: async (ms) => {
            sleeps.push(ms);
          },
        },
      );
      expect(result.ok).toBe(true);
      expect(sleeps).toEqual([2000]);
    } finally {
      harness.stop();
    }
  });

  test("times out rather than hanging on a stalled server", async () => {
    const harness = startHarness(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return new Response(EXPOSITION);
    });
    try {
      const result = await scrapeTarget(
        { url: harness.url, timeoutMs: 30, retries: 0 },
        {},
        { sleepImpl: instantSleep },
      );
      expect(result.ok).toBe(false);
      expect(result.errorKind).toBe("timeout");
      expect(result.error).toContain("30ms");
    } finally {
      harness.stop();
    }
  });

  test("reports a network error for a closed port", async () => {
    const result = await scrapeTarget(
      { url: "http://127.0.0.1:1/metrics", timeoutMs: 500, retries: 0 },
      {},
      { sleepImpl: instantSleep },
    );
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe("network");
    expect(result.series).toEqual([]);
  });

  test("never throws — every failure lands in the result", async () => {
    const result = await scrapeTarget(
      { url: "not-a-url", retries: 0 },
      {},
      { sleepImpl: instantSleep },
    );
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe("network");
  });
});

describe("scrapeAll", () => {
  test("keeps input order and scrapes everything", async () => {
    const first = startHarness(() => new Response(EXPOSITION));
    const second = startHarness(() => new Response("# TYPE up gauge\nup 1\n"));
    try {
      const results = await scrapeAll(
        [{ url: first.url, name: "first" }, { url: second.url, name: "second" }],
        {},
        { sleepImpl: instantSleep },
      );
      expect(results.map((result) => result.target.name)).toEqual(["first", "second"]);
      expect(results.every((result) => result.ok)).toBe(true);
    } finally {
      first.stop();
      second.stop();
    }
  });

  test("never runs more scrapes at once than the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const harness = startHarness(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return new Response(EXPOSITION);
    });
    try {
      const specs: TargetSpec[] = Array.from({ length: 8 }, (_unused, index) => ({
        url: `${harness.url}?target=${index}`,
      }));
      const results = await scrapeAll(specs, { concurrency: 2 }, { sleepImpl: instantSleep });
      expect(results.length).toBe(8);
      expect(results.every((result) => result.ok)).toBe(true);
      expect(peak).toBeLessThanOrEqual(2);
    } finally {
      harness.stop();
    }
  });

  test("one broken target does not stop the others", async () => {
    const harness = startHarness(() => new Response(EXPOSITION));
    try {
      const results = await scrapeAll(
        [
          { url: harness.url, name: "healthy" },
          { url: "http://127.0.0.1:1/metrics", name: "broken", retries: 0, timeoutMs: 500 },
        ],
        { concurrency: 2 },
        { sleepImpl: instantSleep },
      );
      expect(results[0]!.ok).toBe(true);
      expect(results[1]!.ok).toBe(false);
    } finally {
      harness.stop();
    }
  });
});

describe("retry policy helpers", () => {
  test("retries only statuses that can plausibly recover", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(200)).toBe(false);
  });

  test("backs off exponentially, inside the cap, with jitter", () => {
    const alwaysZero = (): number => 0;
    const alwaysOne = (): number => 1;
    expect(resolveRetryDelayMs(0, 100, null, alwaysZero)).toBe(50);
    expect(resolveRetryDelayMs(0, 100, null, alwaysOne)).toBe(100);
    expect(resolveRetryDelayMs(3, 100, null, alwaysOne)).toBe(800);
    expect(resolveRetryDelayMs(30, 100, null, alwaysOne)).toBe(30_000);
  });

  test("Retry-After wins over the exponential schedule and is capped", () => {
    expect(resolveRetryDelayMs(0, 100, 2)).toBe(2000);
    expect(resolveRetryDelayMs(0, 100, 600)).toBe(30_000);
  });

  test("parses Retry-After in both the seconds and the HTTP-date form", () => {
    expect(parseRetryAfter("5")).toBe(5);
    expect(parseRetryAfter(" 0 ")).toBe(0);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("not-a-date")).toBeNull();
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:30 GMT", now)).toBe(30);
    expect(parseRetryAfter("Thu, 01 Jan 2025 00:00:00 GMT", now)).toBe(0);
  });
});

describe("applyDefaultLabels", () => {
  const series: Series[] = [{ name: "m", labels: { job: "metric" }, value: 1 }];

  test("fills in missing labels without touching the rest", () => {
    const [tagged] = applyDefaultLabels(series, { cluster: "eu", job: "scraped" });
    expect(tagged!.labels).toEqual({ job: "metric", cluster: "eu" });
  });

  test("returns the same samples when there is nothing to add", () => {
    expect(applyDefaultLabels(series, undefined)[0]).toBe(series[0]!);
    expect(applyDefaultLabels(series, {})[0]).toBe(series[0]!);
  });

  test("does not mutate the input", () => {
    applyDefaultLabels(series, { cluster: "eu" });
    expect(series[0]!.labels).toEqual({ job: "metric" });
  });
});

describe("ScrapeError", () => {
  test("carries a kind so callers can branch on the failure mode", () => {
    const error = new ScrapeError("boom", "timeout");
    expect(error.name).toBe("ScrapeError");
    expect(error.kind).toBe("timeout");
    expect(error instanceof Error).toBe(true);
  });
});

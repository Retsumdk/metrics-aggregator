# metrics-aggregator

[![CI](https://github.com/Retsumdk/metrics-aggregator/actions/workflows/ci.yml/badge.svg)](https://github.com/Retsumdk/metrics-aggregator/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/typescript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/node.js-18%2B-green?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Zero dependencies](https://img.shields.io/badge/runtime%20dependencies-0-blue?style=flat-square)](package.json)
[![MIT License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)

Prometheus-compatible metrics aggregation: parse exposition text, merge samples
from many sources onto a reduced label set, and re-emit valid exposition output
over HTTP or the command line.

## The problem

Every service you run exposes metrics, and every one of them describes the same
thing slightly differently:

```
http_requests_total{service="api",instance="10.0.0.1:8080"} 120
http_requests_total{service="api",instance="10.0.0.2:8080"} 80
http_requests_total{service="web",instance="10.0.1.1:8080"} 90
```

You want one line per service. The usual answers all have a catch:

- **Scrape every target into Prometheus.** Then you need a Prometheus server
  (with its own storage, retention and operational surface) to answer a
  question that is really just "add these numbers up".
- **Use a query language at read time.** `sum by (service) (…)` is the right
  idea, but it lives inside a query engine, so a one-off script or a CI job has
  to bring that engine along.
- **Write a shell script with `awk`.** It breaks the first time a label value
  contains a comma, an escaped quote, a newline, an `le` bucket boundary, or a
  series whose family was declared `histogram` one line earlier.

Aggregating histogram buckets by hand is worse than it looks. Buckets are
cumulative and addressed by a *label*, so "sum the buckets" means "sum the
values of the samples that share every other label and each distinct `le`" — and
adding `_count` as if it were a gauge silently corrupts every rate and quantile
computed later. Summary quantiles cannot be combined at all.

## The solution

`metrics-aggregator` is a single tool that does exactly that job and nothing
else. It is a parser, an aggregation engine, an encoder, a scraper and a small
HTTP service, with **no runtime dependencies** — everything is the Node standard
library. Eleven small modules behind one public API, so it can be embedded as a
library, driven from a shell, or left running as a service on port 9137.

What it does that a naive implementation does not:

| Concern | How it is handled |
| --- | --- |
| Histogram buckets | Added per `le`, never averaged; `_sum` and `_count` added separately; `+Inf` bucket is cross-checked against `_count` |
| Summary quantiles | Dropped by default, because quantiles from different populations cannot be added — with a warning instead of a plausible-looking lie |
| Unbalanced labels | A series that does not carry a grouping label forms its own group, exactly like PromQL `by` |
| Duplicate scrapes | Byte-identical samples collapse, so `count` is not inflated by scraping the same target twice |
| Conflicting duplicates | `keep` (default), `newest`, or `error` — your choice, never a silent pick |
| Escaping | `\\`, `\"` and `\n` round-trip; an undefined escape sequence is reported, not guessed |
| Determinism | Families, samples and label names are sorted, so the same input produces byte-identical output |
| Type awareness | A family declared `histogram` is merged as a histogram even if the `# TYPE` line is missing |

## How it works

```
                 ┌──────────────┐
 files ─────────▶│              │
 HTTP targets ──▶│  parser      │  exposition text ─▶ Series[] + MetadataMap
 push payloads ─▶│              │
                 └──────┬───────┘
                        ▼
                 ┌──────────────┐   by / without / dropLabels
                 │  aggregate   │   sum|min|max|avg|count|stddev|stdvar|last|first|group
                 │              │   histogram buckets merged per `le`
                 └──────┬───────┘
                        ▼
                 ┌──────────────┐
                 │   encoder    │──▶ exposition text (optionally OpenMetrics)
                 └──────────────┘
```

A `Series` is the unit that crosses every boundary: a name, a label set, a
value, an optional millisecond timestamp and an optional exemplar. The parser
never guesses. An undeclared sample is `untyped`, a `x_total` sample only joins
a bare `x` family when that family was declared a counter, and a sample whose
declared type contradicts its name is reported rather than silently normalised.

The aggregation pass works in three stages:

1. **Shape** — every family is inspected once so histograms, summaries and plain
   gauges/counters are separated before any arithmetic happens. A histogram that
   arrives without a `# TYPE` line is still a histogram (buckets plus `le`), but
   the tool records that it was inferred so the output can be audited.
2. **Grouping** — each sample is reduced to its group labels (`by`, `without`
   and `dropLabels` applied) and placed in a group keyed by family + labels.
   `le` and `quantile` are never grouping labels: they are dimensions *inside* a
   group.
3. **Emission** — plain groups get the requested aggregator; histogram groups
   get per-`le` bucket sums plus added `_sum`/`_count`; summary groups get added
   `_sum`/`_count`. Output is sorted and de-duplicated by label set.

### HTTP service

```bash
metrics-aggregator serve --port 9137 --token "$TOKEN"
```

| Route | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/metrics` | GET | no | The aggregated view; scrape it with anything |
| `/-/healthy`, `/health`, `/healthz` | GET | no | Liveness |
| `/-/ready` | GET | no | Readiness |
| `/api/status` | GET | no | Version, uptime, counters, store and target state |
| `/api/targets` | GET | no | Per-target scrape state, including consecutive failures |
| `/api/series` | GET | no | Current samples as JSON (`?name=`, `?limit=`) |
| `/api/aggregate` | POST | **yes** | Aggregate a posted document (`?by=`, `?without=`, `?agg=`, `?name=`, `?label=`, `?conflict=`, `?dedupe=`) |
| `/metrics/job/<job>[/<label>/<value>…]` | PUT / POST / DELETE | **yes** | Pushgateway-compatible push, merge and delete |
| `/api/push/<job>` | PUT / POST / DELETE | **yes** | Same semantics, plus grouping labels as query parameters |

`PUT` replaces a job's group, `POST` merges into it, `DELETE` removes it. The
push endpoints are the only write surface, so they are the only ones behind the
bearer token; `/metrics` stays open so probes and scrapers do not need a secret.

### Safety and operational behaviour

- The server binds `127.0.0.1` by default. `--host 0.0.0.0` is an explicit choice.
- With no `--token`, push and aggregate endpoints are open and the server says so
  loudly on startup.
- Comparisons of secrets are constant-time and length-checked.
- Scrapes fail closed: an unreachable or slow target is reported as a failed
  scrape with its error kind (`timeout`, `http`, `network`, `parse`), and is
  retried with exponential backoff plus jitter. Only `408`, `429` and `5xx` are
  retried; a `404` is not going to become a `200`.
- Push groups can expire: `--push-ttl 300000` drops groups that no producer has
  refreshed in five minutes.
- The process only exits when it is told to; both `SIGINT` and `SIGTERM` shut the
  listener down cleanly.

## Getting started

Node 18.17+ or Bun. No dependencies to install for the library or the CLI.

```bash
git clone https://github.com/Retsumdk/metrics-aggregator.git
cd metrics-aggregator
bun install --frozen-lockfile   # dev dependencies only: TypeScript and type definitions
```

Run the tests, the typechecker and a build:

```bash
bun test          # 238 tests
bun run typecheck # tsc --noEmit, strict
bun run build     # emits dist/ with declarations
```

Use it without installing anything globally:

```bash
bun src/cli.ts aggregate examples/cluster-metrics.txt --without instance
node dist/cli.js aggregate examples/cluster-metrics.txt --without instance  # after a build
```

## Examples

### 1. Merge two scrapes and drop a label

Two targets report the same fleet; the `instance` label is the only thing that
makes them distinct series. Add them up with `--without instance`:

```bash
bun src/cli.ts aggregate examples/cluster-metrics.txt examples/other-cluster.txt --without instance
```

```
# HELP build_info Build metadata; the value is always 1.
# TYPE build_info gauge
build_info{revision="9f3c1ab",service="api",version="2.4.1"} 1
# HELP http_request_duration_seconds Request latency.
# TYPE http_request_duration_seconds histogram
http_request_duration_seconds_bucket{le="0.1",service="api"} 135
http_request_duration_seconds_bucket{le="0.5",service="api"} 210
http_request_duration_seconds_bucket{le="1",service="api"} 400
http_request_duration_seconds_bucket{le="+Inf",service="api"} 400
http_request_duration_seconds_sum{service="api"} 37.099999999999994
http_request_duration_seconds_count{service="api"} 400
# HELP http_requests_total Total HTTP requests served, by service and instance.
# TYPE http_requests_total counter
http_requests_total{region="eu-west",service="api"} 10
http_requests_total{region="us-east",service="api"} 285
http_requests_total{region="us-east",service="web"} 130
http_requests_total{service="api"} 285
http_requests_total{service="web"} 130
# HELP payload_bytes Request and response payload size in bytes.
# TYPE payload_bytes summary
payload_bytes_sum{service="api"} 6100000
payload_bytes_count{service="api"} 120
# HELP process_resident_memory_bytes Resident memory of the exporter process.
# TYPE process_resident_memory_bytes gauge
process_resident_memory_bytes{service="api"} 149942272
# HELP queue_depth Items waiting in the worker queue.
# TYPE queue_depth gauge
queue_depth{queue="mail",service="api"} 16
queue_depth{queue="mail",service="web"} 3
queue_depth{queue="sms",service="api"} 0
```

Progress goes to stderr, the document goes to stdout, so the command composes:

```
examples/cluster-metrics.txt, examples/other-cluster.txt: 42 in → 18 out (sum=10)
warning: summary quantiles were dropped: quantiles from different populations cannot be added, so only _sum and _count are aggregated
```

Three things worth noticing in that output:

- the histogram's buckets were **added per `le`** (90+40=130 for `0.1`, …) and
  `_sum`/`_count` were added independently — the `+Inf` bucket equals `_count`,
  which is exactly what a healthy histogram does;
- `payload_bytes_sum`/`_count` were added but the `quantile="0.5"` and
  `quantile="0.99"` samples were dropped, with a warning, because percentiles
  from different populations cannot be merged;
- samples that carried a `region` label grouped by region, and samples that never
  had a `region` label formed a group of their own rather than being folded into
  a labelled bucket. That is the same rule PromQL's `sum by (…)` uses, and it is
  deliberate: folding them in would double count.

### 2. Group by a label, and read the numbers as JSON

```bash
bun src/cli.ts aggregate examples/cluster-metrics.txt examples/other-cluster.txt \
  --by service,region --json --quiet
```

```json
{
  "sources": [
    "examples/cluster-metrics.txt",
    "examples/other-cluster.txt"
  ],
  "inputSeries": 42,
  "outputSeries": 17,
  "stats": {
    "inputSeries": 42,
    "dedupedSamples": 1,
    "conflictsResolved": 0,
    "groups": 11,
    "outputSeries": 17,
    "droppedQuantileSeries": 2,
    "histogramGroups": 1,
    "summaryGroups": 1,
    "perAggregator": {
      "sum": 9
    },
    "warnings": [
      "summary quantiles were dropped: quantiles from different populations cannot be added, so only _sum and _count are aggregated"
    ]
  },
  "warnings": [
    "summary quantiles were dropped: quantiles from different populations cannot be added, so only _sum and _count are aggregated"
  ]
}
```

### 3. Ask what is inside a document

```bash
bun src/cli.ts parse examples/cluster-metrics.txt
```

```
sources: examples/cluster-metrics.txt
series: 28
families: 6
  build_info (gauge) — Build metadata; the value is always 1.
  http_request_duration_seconds (histogram) — Request latency.
  http_requests_total (counter) — Total HTTP requests served, by service and instance.
  payload_bytes (summary) — Request and response payload size in bytes.
  process_resident_memory_bytes (gauge) — Resident memory of the exporter process.
  queue_depth (gauge) — Items waiting in the worker queue.
```

`--strict` turns any warning into a failure, which is what you want in CI:

```bash
bun src/cli.ts parse examples/cluster-metrics.txt --strict; echo $?   # 0
printf 'm{a=1} 1\n' | bun src/cli.ts parse - --strict; echo $?         # 1
```

### 4. Run it as a service and scrape the aggregate

```bash
bun src/cli.ts serve --port 9137 --token s3cr3t \
  --target http://127.0.0.1:9100/metrics \
  --target http://127.0.0.1:9101/metrics \
  --interval 15000 --without instance
```

```console
$ curl -s http://127.0.0.1:9137/metrics
http_requests_total{service="api"} 285
http_requests_total{service="web"} 130

$ curl -s http://127.0.0.1:9137/-/healthy
OK

$ curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:9137/api/aggregate
401

$ curl -s -X POST -H 'Authorization: Bearer s3cr3t' \
    --data-binary $'q{a="1"} 2\nq{a="2"} 3\n' \
    'http://127.0.0.1:9137/api/aggregate?by=a'
q{a="1"} 2
q{a="2"} 3
```

Push a batch result into it — the surrounding job and instance become labels on
every sample you send:

```console
$ curl -s -X PUT -H 'Authorization: Bearer s3cr3t' \
    --data-binary 'nightly_jobs_queued{queue="mail"} 4' \
    http://127.0.0.1:9137/metrics/job/backup/instance/primary
{
  "stored": 1,
  "job": "backup",
  "grouping": { "instance": "primary" },
  "mode": "replace",
  "warnings": []
}

$ curl -s http://127.0.0.1:9137/api/series | head -20
```

### 5. Use it as a library

```ts
import { parseExposition, aggregate, encodeExposition } from "metrics-aggregator";

const scrape = `
# HELP http_requests_total Requests served.
# TYPE http_requests_total counter
http_requests_total{service="api",instance="a"} 10
http_requests_total{service="api",instance="b"} 15
http_requests_total{service="web",instance="c"} 7
`;

const parsed = parseExposition(scrape, { strict: true });
const merged = aggregate(parsed.series, parsed.metadata, { without: ["instance"] });
process.stdout.write(encodeExposition(merged.series, merged.metadata));
```

```
# HELP http_requests_total Requests served.
# TYPE http_requests_total counter
http_requests_total{service="api"} 25
http_requests_total{service="web"} 7
```

`aggregate()` also returns `stats` (inputs, groups, outputs, deduplicated
samples, histogram groups, warnings) which the CLI prints with `--json`.

## CLI reference

```
metrics-aggregator <command> [options]

Commands
  aggregate [files...]   Parse exposition text and aggregate it
  parse [files...]       Parse exposition text and report what is inside (alias: check)
  serve                  Run the HTTP service
  push                   Push exposition text to a running server
  fetch                  Fetch /metrics from a running server and print it
  help                   Show the usage banner
```

| Flag | Meaning |
| --- | --- |
| `files…` | Read these files; omit or use `-` for stdin |
| `--url <url>` | Scrape a URL instead of a file (repeatable) |
| `--header <k: v>`, `--bearer <token>`, `--basic user:pass` | Request credentials for `--url` |
| `--timeout <ms>`, `--retries <n>` | Per-request timeout (default 10000) and retry budget (default 2) |
| `--agg <name>` | `sum` (default), `min`, `max`, `avg`, `count`, `stddev`, `stdvar`, `last`, `first`, `group` — repeatable |
| `--by <a,b>` | Keep only these labels |
| `--without <a,b>` | Drop these labels |
| `--drop-labels <a,b>` | Drop these labels without narrowing the group to `by` |
| `--name <name>` | Rename the output family |
| `--label <k=v>` | Add a static label to every output sample (repeatable) |
| `--conflict <policy>` | `keep` (default), `newest` or `error` |
| `--keep-quantiles` | Keep summary quantiles from the first group member instead of dropping them |
| `--openmetrics` | Emit OpenMetrics framing (`# UNIT`, `# EOF`) |
| `--port <n>` `--host <addr>` `--token <t>` `--target <url>` `--target-name <n>` `--interval <ms>` `--push-ttl <ms>` | Server options |
| `--out <file>` `--json` `--strict` `--quiet` | Output options |

Exit codes: `0` success, `1` runtime or parse failure, `2` usage error.

## API reference

```ts
// Parsing and encoding
parseExposition(text, { strict, allowOpenMetrics, maxSeries, maxLineLength })
parseSeries(text, options)
encodeExposition(series, metadata, { openMetrics, includeHelp, includeType, sort })

// Aggregation
aggregate(series, metadata, {
  by, without, dropLabels, label, name, aggregators,
  dropQuantiles, dedupeIdentical, conflictPolicy,
})
AGGREGATOR_NAMES

// Scraping
scrapeTarget(spec, options, deps)
scrapeAll(specs, options, deps)
applyDefaultLabels(series, defaults)

// Storage and service
new MetricStore()            // push / delete / prune / snapshot / list / stats
startServer(options)         // { url, port, state, stop, request }
createHandler(state)         // drive the routes without a socket
```

Errors are typed, so a caller can branch on the failure mode rather than
matching strings: `ParseError` (with line and column), `AggregateConfigError`,
`AggregateConflictError`, `ScrapeError` (with `kind`), `StoreError`, `EncodeError`.

## Design notes and limitations

- **Histogram buckets are always added**, whatever `--agg` says. Averaging or
  taking the minimum of cumulative bucket counts produces a histogram that is
  not a histogram.
- **Summary quantiles are dropped by default.** `_sum` and `_count` are still
  added, so `rate()` and average-size calculations remain correct.
- **An aggregated histogram keeps its `histogram` type**, so downstream tooling
  knows the `_bucket` samples are cumulative.
- **`--agg` with several values namespaces the output** (`avg_http_requests_total`,
  `max_http_requests_total`), because two aggregators cannot share one family
  name. A single aggregator keeps the original family name, as PromQL does.
- **Staleness is not modelled.** A sample with no timestamp is always treated as
  fresh; this tool merges what it is given rather than deciding what has expired.
  Push groups have their own TTL.
- **No storage, no retention, no query language.** Point it at a Prometheus
  server (or a TSDB) if you need history.
- The in-memory store holds whatever you push. It is sized for aggregation
  windows and batch reports, not for a million series.

## Testing

```bash
bun test
```

238 tests, 604 assertions, no outbound network access and no fixture files on
disk: the parser
tests cover the format's edge cases (escapes, `CRLF`, tabs, `NaN`, `±Inf`,
negative zero, trailing commas, duplicate labels, OpenMetrics exemplars and
`# EOF`), the encoder tests assert exact bytes, the aggregation tests assert the
arithmetic for every aggregator and the histogram/summary merge rules, the
scraper tests run against real local HTTP servers (including a `503` that
recovers, a `429` with `Retry-After`, a stalled socket and a closed port), and
the service tests drive the real handler over a real socket.

## Related repositories

- [rate-limiter-middleware](https://github.com/Retsumdk/rate-limiter-middleware) — token bucket rate limiting
- [request-id-middleware](https://github.com/Retsumdk/request-id-middleware) — distributed tracing
- [health-check-monitor](https://github.com/Retsumdk/health-check-monitor) — service health monitoring

## License

MIT — see [LICENSE](LICENSE).

---

Built by [Retsumdk](https://github.com/Retsumdk).

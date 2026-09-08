# metrics-aggregator

Prometheus-compatible metrics aggregation service

## Features

- Production-ready code
- TypeScript with full type safety
- Comprehensive error handling
- Built by Retsumdk

## Installation

```bash
git clone https://github.com/Retsumdk/metrics-aggregator.git
cd metrics-aggregator
bun install
```

## Usage

```bash
bun run src/index.ts --help
```

## Configuration

Create `config.json` for custom settings.

```json
{
  "baseUrl": "https://metrics-api.internal:9090",
  "timeout": 30000,
  "retries": 3
}
```

## Architecture

Single-module TypeScript CLI:
- `src/index.ts` — entry point, Commander-based CLI, loads configuration, then aggregates metric series and reports progress
- `tests/index.test.ts` — smoke test confirming the module loads and runs

The service reads an optional `config.json` (falling back to sensible defaults), connects to the configured Prometheus-compatible endpoint, and emits one summary line per aggregation run.

## Real-World Use Case

A multi-service platform exposes Prometheus scrape endpoints on each backend. Instead of querying every instance separately in dashboards and alerts, operators point `metrics-aggregator` at the central gateway and get a single, deduplicated view of aggregate metrics — reducing dashboard cardinality and making cross-service trends readable in one place.

```bash
bun run src/index.ts --config ./config.json --verbose
```

## Testing

```bash
bun test
```

## License

MIT License

---

Built by Retsumdk

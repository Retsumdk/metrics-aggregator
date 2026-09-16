import { describe, test, expect } from "bun:test";
import { MetricStore, StoreError, dedupeSeries, mergeMetadataMaps } from "../src/store.ts";
import type { MetadataMap, Series } from "../src/types.ts";

function sample(name: string, labels: Record<string, string>, value: number, timestamp?: number): Series {
  return timestamp === undefined ? { name, labels, value } : { name, labels, value, timestamp };
}

function metadata(entries: Record<string, { type?: "counter" | "gauge" | "histogram"; help?: string }>): MetadataMap {
  return new Map(Object.entries(entries));
}

describe("dedupeSeries", () => {
  test("collapses byte-identical samples and counts them", () => {
    const input = [sample("a", { instance: "1" }, 1, 100), sample("a", { instance: "1" }, 1, 100)];
    const result = dedupeSeries(input);
    expect(result.series.length).toBe(1);
    expect(result.removed).toBe(1);
  });

  test("keeps samples that differ only by timestamp", () => {
    const input = [sample("a", {}, 1, 100), sample("a", {}, 1, 200)];
    expect(dedupeSeries(input).series.length).toBe(2);
  });

  test("keeps samples that differ only by value", () => {
    const input = [sample("a", {}, 1), sample("a", {}, 2)];
    expect(dedupeSeries(input).series.length).toBe(2);
  });

  test("is order independent for the kept sample", () => {
    const input = [sample("a", {}, 1), sample("a", {}, 1), sample("b", {}, 2)];
    expect(dedupeSeries(input).series.map((entry) => entry.name)).toEqual(["a", "b"]);
  });

  test("preserves an exemplar on the kept sample", () => {
    const withExemplar: Series = { name: "a", labels: {}, value: 1, exemplar: { labels: { trace_id: "t" }, value: 1 } };
    const result = dedupeSeries([sample("a", {}, 1), withExemplar]);
    expect(result.series.length).toBe(1);
    expect(result.removed).toBe(1);
    // The copy that carries the exemplar survives: dropping the trace id would
    // lose information the caller cannot reconstruct.
    expect(result.series[0]!.exemplar?.labels.trace_id).toBe("t");
    // Order is preserved and the exemplar-less duplicate that arrives *after*
    // the exemplar one never displaces it.
    const reversed = dedupeSeries([withExemplar, sample("a", {}, 1)]);
    expect(reversed.series[0]!.exemplar?.labels.trace_id).toBe("t");
  });
});

describe("mergeMetadataMaps", () => {
  test("merges disjoint families", () => {
    const merged = mergeMetadataMaps([metadata({ a: { type: "counter" } }), metadata({ b: { type: "gauge" } })]);
    expect([...merged.metadata.keys()].sort()).toEqual(["a", "b"]);
    expect(merged.conflicts).toEqual([]);
  });

  test("reports a family declared twice with different types", () => {
    const merged = mergeMetadataMaps([metadata({ a: { type: "counter" } }), metadata({ a: { type: "gauge" } })]);
    expect(merged.conflicts.length).toBe(1);
    expect(merged.conflicts[0]).toContain("a");
  });

  test("merges help text from a later map when the first has none", () => {
    const merged = mergeMetadataMaps([metadata({ a: { type: "counter" } }), metadata({ a: { help: "total requests" } })]);
    expect(merged.metadata.get("a")).toEqual({ type: "counter", help: "total requests" });
  });
});

describe("MetricStore", () => {
  test("push replaces the contents of a job + grouping", () => {
    const store = new MetricStore();
    store.push("batch", {}, [sample("queue_depth", {}, 5)]);
    store.push("batch", {}, [sample("queue_depth", {}, 9), sample("workers", {}, 2)]);
    const snapshot = store.snapshot();
    expect(snapshot.series.length).toBe(2);
    expect(snapshot.series.find((entry) => entry.name === "queue_depth")!.value).toBe(9);
  });

  test("push merge appends and collapses exact duplicates", () => {
    const store = new MetricStore();
    store.push("batch", {}, [sample("m", {}, 1)], new Map(), "merge");
    store.push("batch", {}, [sample("m", {}, 1), sample("m", {}, 2)], new Map(), "merge");
    const snapshot = store.snapshot();
    expect(snapshot.series.length).toBe(2);
    expect(snapshot.series.map((entry) => entry.value).sort()).toEqual([1, 2]);
    // The duplicate was already collapsed at merge time, so the snapshot has
    // nothing left to remove.
    expect(snapshot.duplicatesRemoved).toBe(0);
  });

  test("grouping labels are part of the identity", () => {
    const store = new MetricStore();
    store.push("batch", { instance: "a" }, [sample("m", {}, 1)]);
    store.push("batch", { instance: "b" }, [sample("m", {}, 2)]);
    expect(store.size).toBe(2);
    expect(store.snapshot().series.length).toBe(2);
  });

  test("grouping label order does not create a second group", () => {
    const store = new MetricStore();
    store.push("batch", { a: "1", b: "2" }, [sample("m", {}, 1)]);
    store.push("batch", { b: "2", a: "1" }, [sample("m", {}, 2)]);
    expect(store.size).toBe(1);
  });

  test("delete removes one grouping and reports the count", () => {
    const store = new MetricStore();
    store.push("batch", { instance: "a" }, [sample("m", {}, 1)]);
    store.push("batch", { instance: "b" }, [sample("m", {}, 2)]);
    expect(store.delete("batch", { instance: "a" })).toBe(1);
    expect(store.size).toBe(1);
    expect(store.snapshot().series[0]!.value).toBe(2);
  });

  test("delete without a grouping removes every group of that job", () => {
    const store = new MetricStore();
    store.push("batch", { instance: "a" }, [sample("m", {}, 1)]);
    store.push("batch", { instance: "b" }, [sample("m", {}, 2)]);
    store.push("other", {}, [sample("m", {}, 3)]);
    expect(store.delete("batch")).toBe(2);
    expect(store.size).toBe(1);
  });

  test("delete of an unknown job is a no-op", () => {
    const store = new MetricStore();
    expect(store.delete("nope")).toBe(0);
  });

  test("prune drops groups that have not been refreshed inside the TTL", () => {
    const store = new MetricStore();
    store.push("batch", { instance: "old" }, [sample("m", {}, 1)]);
    const pushedAt = store.list()[0]!.pushedAt;
    store.push("batch", { instance: "new" }, [sample("m", {}, 2)]);
    // Both groups were pushed within the same millisecond, so a TTL that has
    // not expired yet removes nothing...
    expect(store.prune(60_000, pushedAt + 59_000)).toBe(0);
    // ...and once it has, every stale group goes at once.
    expect(store.prune(60_000, pushedAt + 60_001)).toBe(2);
    expect(store.size).toBe(0);

    // Re-pushing a group refreshes its clock, so an active producer is never
    // pruned by a TTL meant for abandoned ones.
    const refreshed = new MetricStore();
    refreshed.push("batch", { instance: "live" }, [sample("m", {}, 1)]);
    refreshed.push("batch", { instance: "live" }, [sample("m", {}, 2)]);
    const lastSeen = refreshed.list()[0]!.pushedAt;
    expect(refreshed.prune(60_000, lastSeen + 59_999)).toBe(0);
  });

  test("snapshot merges metadata across groups and reports conflicts", () => {
    const store = new MetricStore();
    store.push("a", {}, [sample("m", {}, 1)], metadata({ m: { type: "counter" } }));
    store.push("b", {}, [sample("n", {}, 1)], metadata({ m: { type: "gauge" }, n: { type: "gauge" } }));
    const snapshot = store.snapshot();
    expect(snapshot.conflicts.length).toBe(1);
    expect(snapshot.metadata.get("n")).toEqual({ type: "gauge" });
  });

  test("seriesIdentityCount counts distinct name + label sets, not samples", () => {
    const store = new MetricStore();
    store.push("a", {}, [sample("m", { instance: "1" }, 1), sample("m", { instance: "1" }, 2)]);
    store.push("b", {}, [sample("m", { instance: "2" }, 3)]);
    expect(store.seriesIdentityCount()).toBe(2);
  });

  test("stats summarises groups and samples", () => {
    const store = new MetricStore();
    store.push("a", {}, [sample("m", {}, 1), sample("n", {}, 2)]);
    store.push("b", {}, [sample("m", {}, 3)]);
    const stats = store.stats();
    expect(stats.groups).toBe(2);
    expect(stats.series).toBe(3);
    expect(stats.families).toBe(2);
    expect(store.seriesIdentityCount()).toBe(2);
  });

  test("list returns one row per group with its series count", () => {
    const store = new MetricStore();
    store.push("a", { instance: "1" }, [sample("m", {}, 1), sample("n", {}, 2)]);
    const rows = store.list();
    expect(rows.length).toBe(1);
    expect(rows[0]!.job).toBe("a");
    expect(rows[0]!.grouping).toEqual({ instance: "1" });
    expect(rows[0]!.seriesCount).toBe(2);
  });

  test("clear empties the store", () => {
    const store = new MetricStore();
    store.push("a", {}, [sample("m", {}, 1)]);
    store.clear();
    expect(store.size).toBe(0);
    expect(store.snapshot().series).toEqual([]);
  });

  test("rejects an empty job name", () => {
    const store = new MetricStore();
    expect(() => store.push("", {}, [sample("m", {}, 1)])).toThrow(StoreError);
  });

  test("rejects an invalid grouping label name", () => {
    const store = new MetricStore();
    expect(() => store.push("a", { "bad name": "1" }, [sample("m", {}, 1)])).toThrow(StoreError);
  });

  test("__name__ is not allowed as a grouping label", () => {
    const store = new MetricStore();
    expect(() => store.push("a", { __name__: "m" }, [sample("m", {}, 1)])).toThrow(StoreError);
  });

  test("an empty push still creates the group, so a producer can assert liveness", () => {
    const store = new MetricStore();
    store.push("heartbeat", {}, []);
    expect(store.size).toBe(1);
    expect(store.list()[0]!.seriesCount).toBe(0);
  });
});

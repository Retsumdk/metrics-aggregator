/**
 * In-memory sample store with Pushgateway-compatible grouping.
 *
 * Samples arrive either from scraped targets or from HTTP pushes. Both paths
 * need the same thing: a way to hold several *groups* of samples that are
 * replaced wholesale when the same producer pushes again, then flattened into a
 * single list for aggregation.
 *
 * Groups are keyed by `job` + grouping labels, matching the Prometheus
 * Pushgateway URL shape (`/metrics/job/<job>/<label>/<value>`). `push` replaces
 * a group; `merge` adds to it. That distinction is the difference between a
 * batch job reporting "3 items in the queue" and accumulating junk forever.
 */

import { LABEL_NAME_RE, labelsKey, labelsToString, mergeLabels } from "./format.ts";
import type {
  Labels,
  MetadataMap,
  PushGroup,
  PushGroupInfo,
  Series,
  StoreStats,
} from "./types.ts";

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}

function sampleKey(sample: Series): string {
  const timestamp = sample.timestamp === undefined ? "" : String(sample.timestamp);
  return `${sample.name}\u001f${labelsKey(sample.labels)}\u001f${String(sample.value)}\u001f${timestamp}`;
}

/**
 * Drop samples that are byte-for-byte identical (same name, labels, value and
 * timestamp). Two scrapes of the same target produce these, and counting them
 * twice inflates `count` aggregations. Order is preserved.
 */
export function dedupeSeries(series: readonly Series[]): { series: Series[]; removed: number } {
  const index = new Map<string, number>();
  const out: Series[] = [];
  for (const sample of series) {
    const key = sampleKey(sample);
    const existing = index.get(key);
    if (existing === undefined) {
      index.set(key, out.length);
      out.push(sample);
      continue;
    }
    // The samples are identical, so one of them is dropped — but an exemplar is
    // extra information rather than a different sample, so keep the copy that
    // carries one instead of throwing the trace id away.
    const kept = out[existing]!;
    if (kept.exemplar === undefined && sample.exemplar !== undefined) out[existing] = sample;
  }
  return { series: out, removed: series.length - out.length };
}

/**
 * Merge metadata maps. First declaration wins for a family (a `# TYPE` seen
 * twice is a producer bug, not an instruction to change our minds), and a
 * family declared with two *different* types is reported so the caller can tell
 * the operator rather than guessing.
 */
export function mergeMetadataMaps(
  maps: readonly MetadataMap[],
): { metadata: MetadataMap; conflicts: string[] } {
  const metadata: MetadataMap = new Map();
  const conflicts: string[] = [];
  for (const map of maps) {
    for (const [name, entry] of map) {
      const existing = metadata.get(name);
      if (existing === undefined) {
        metadata.set(name, { ...entry });
        continue;
      }
      if (existing.type !== undefined && entry.type !== undefined && existing.type !== entry.type) {
        conflicts.push(`${name} declared as ${existing.type} and ${entry.type}`);
        continue;
      }
      metadata.set(name, {
        ...existing,
        ...entry,
        ...(existing.type === undefined && entry.type !== undefined ? { type: entry.type } : {}),
      });
    }
  }
  return { metadata, conflicts };
}

export class MetricStore {
  private readonly groups = new Map<string, PushGroup>();

  private static groupKey(job: string, grouping: Labels): string {
    return `${job}\u001e${labelsKey(grouping)}`;
  }

  /** Total groups currently held. */
  get size(): number {
    return this.groups.size;
  }

  /**
   * Store samples under `job` + `grouping`.
   *
   * `replace` (default) overwrites the group: an hourly batch job that reports a
   * queue depth should not leave yesterday's number behind. `merge` appends,
   * collapsing exact duplicates.
   */
  push(
    job: string,
    grouping: Labels,
    series: readonly Series[],
    metadata: MetadataMap = new Map(),
    mode: "replace" | "merge" = "replace",
  ): void {
    if (typeof job !== "string" || job.trim() === "") {
      throw new StoreError("job name must be a non-empty string");
    }
    for (const name of Object.keys(grouping)) {
      if (!LABEL_NAME_RE.test(name)) {
        throw new StoreError(`grouping label "${name}" is not a valid label name`);
      }
      if (name === "__name__") {
        throw new StoreError("__name__ cannot be used as a grouping label");
      }
    }
    const key = MetricStore.groupKey(job, grouping);
    if (mode === "merge") {
      const existing = this.groups.get(key);
      if (existing !== undefined) {
        const combined = dedupeSeries([...existing.series, ...series]);
        const merged = mergeMetadataMaps([existing.metadata, metadata]);
        this.groups.set(key, {
          job,
          grouping: { ...grouping },
          series: combined.series,
          metadata: merged.metadata,
          pushedAt: Date.now(),
        });
        return;
      }
    }
    this.groups.set(key, {
      job,
      grouping: { ...grouping },
      series: [...series],
      metadata: new Map(metadata),
      pushedAt: Date.now(),
    });
  }

  /** Delete one group, or every group belonging to `job`. Returns groups removed. */
  delete(job: string, grouping?: Labels): number {
    if (grouping !== undefined) {
      const key = MetricStore.groupKey(job, grouping);
      return this.groups.delete(key) ? 1 : 0;
    }
    let removed = 0;
    for (const key of [...this.groups.keys()]) {
      const group = this.groups.get(key)!;
      if (group.job === job) {
        this.groups.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Drop groups untouched for longer than `ttlMs`. Returns groups removed. */
  prune(ttlMs: number, now: number = Date.now()): number {
    let removed = 0;
    for (const [key, group] of [...this.groups.entries()]) {
      if (now - group.pushedAt > ttlMs) {
        this.groups.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.groups.clear();
  }

  list(): PushGroupInfo[] {
    return [...this.groups.values()].map((group) => ({
      job: group.job,
      grouping: { ...group.grouping },
      seriesCount: group.series.length,
      pushedAt: group.pushedAt,
    }));
  }

  stats(): StoreStats {
    let seriesCount = 0;
    const families = new Set<string>();
    for (const group of this.groups.values()) {
      seriesCount += group.series.length;
      for (const sample of group.series) families.add(sample.name);
    }
    return { groups: this.groups.size, series: seriesCount, families: families.size };
  }

  /**
   * Flatten every group into one sample list plus merged metadata.
   *
   * Exact duplicates are collapsed, because the same series can legitimately be
   * present in two groups (a scoped push and a scrape) and aggregating it twice
   * would double-count.
   */
  snapshot(): { series: Series[]; metadata: MetadataMap; duplicatesRemoved: number; conflicts: string[] } {
    const all: Series[] = [];
    const maps: MetadataMap[] = [];
    for (const group of this.groups.values()) {
      // Grouping labels are part of a pushed sample's identity, so they travel
      // with it: two jobs pushing `queue_depth` for different instances must not
      // collapse into one series. A label the producer already set wins.
      const names = Object.keys(group.grouping);
      for (const sample of group.series) {
        all.push(names.length === 0 ? sample : { ...sample, labels: mergeLabels(group.grouping, sample.labels) });
      }
      maps.push(group.metadata);
    }
    const deduped = dedupeSeries(all);
    const merged = mergeMetadataMaps(maps);
    return {
      series: deduped.series,
      metadata: merged.metadata,
      duplicatesRemoved: deduped.removed,
      conflicts: merged.conflicts,
    };
  }

  /** Distinct (name, labels) pairs currently stored — the cardinality estimate. */
  seriesIdentityCount(): number {
    const seen = new Set<string>();
    for (const group of this.groups.values()) {
      for (const sample of group.series) {
        seen.add(`${sample.name}\u001f${labelsKey(mergeLabels(group.grouping, sample.labels))}`);
      }
    }
    return seen.size;
  }

  /** Human-readable one-line summary of every group, used by the CLI. */
  describe(): string {
    const infos = this.list();
    if (infos.length === 0) return "no groups";
    return infos
      .map((info) => {
        const labels = labelsToString(info.grouping);
        return `${info.job}${labels} (${info.seriesCount} series)`;
      })
      .join(", ");
  }

  /** Apply static labels to a snapshot, used when a job pushes scoped metrics. */
  static scope(series: readonly Series[], labels: Labels): Series[] {
    return series.map((sample) => ({ ...sample, labels: mergeLabels(labels, sample.labels) }));
  }
}

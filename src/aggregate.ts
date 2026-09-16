/**
 * Aggregation engine.
 *
 * Collapses samples from one or more sources (scraped targets, pushed payloads,
 * files) onto a reduced label set, applying PromQL-style aggregator functions
 * per group.
 *
 * Three kinds of series need genuinely different treatment, and this module
 * treats them differently rather than pretending everything is a gauge:
 *
 * - **plain** series → the requested aggregator is applied to the group's values.
 * - **histograms** → bucket counts are *added* per `le` (the only merge that
 *   preserves the meaning of a cumulative histogram) and `_sum`/`_count` are
 *   added. The requested aggregator is deliberately not applied to buckets.
 * - **summaries** → `_sum`/`_count` are added, but quantiles from different
 *   populations cannot be combined. They are dropped by default instead of
 *   producing a plausible-looking lie.
 *
 * Family shape is decided in a first pass over the input, so a histogram that
 * arrives without a `# TYPE` declaration is still merged as a histogram instead
 * of being silently summed as a set of unrelated gauges.
 */

import { LABEL_NAME_RE, METRIC_NAME_RE, labelsKey, metadataFor, sortedLabelNames } from "./format.ts";
import type {
  AggregateOptions,
  AggregateResult,
  AggregateStats,
  AggregatorName,
  Labels,
  MetadataMap,
  MetricType,
  Series,
} from "./types.ts";

export const AGGREGATOR_NAMES: readonly AggregatorName[] = [
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
];

export class AggregateConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AggregateConfigError";
  }
}

export class AggregateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AggregateConflictError";
  }
}

const MAX_REPORTED_CONFLICTS = 5;
const MAX_REPORTED_WARNINGS = 20;

function isAggregatorName(value: string): value is AggregatorName {
  return (AGGREGATOR_NAMES as readonly string[]).includes(value);
}

/** Population variance, which is what PromQL's `stdvar` computes. */
function variance(samples: Series[]): number {
  const n = samples.length;
  if (n === 0) return Number.NaN;
  let total = 0;
  for (const sample of samples) {
    if (Number.isNaN(sample.value)) return Number.NaN;
    total += sample.value;
  }
  const mean = total / n;
  let acc = 0;
  for (const sample of samples) acc += (sample.value - mean) ** 2;
  return acc / n;
}

function pickByTimestamp(samples: Series[], mode: "last" | "first"): Series {
  const fallback = mode === "last" ? -Infinity : Infinity;
  let best = samples[0]!;
  let bestAt = best.timestamp ?? fallback;
  for (let index = 1; index < samples.length; index++) {
    const candidate = samples[index]!;
    const at = candidate.timestamp ?? fallback;
    const better = mode === "last" ? at >= bestAt : at < bestAt;
    if (better) {
      best = candidate;
      bestAt = at;
    }
  }
  return best;
}

const AGGREGATOR_FNS: Record<AggregatorName, (samples: Series[]) => number> = {
  sum: (samples) => {
    let total = 0;
    for (const sample of samples) {
      if (Number.isNaN(sample.value)) return Number.NaN;
      total += sample.value;
    }
    return total;
  },
  min: (samples) => {
    let result = Infinity;
    for (const sample of samples) {
      if (Number.isNaN(sample.value)) return Number.NaN;
      if (sample.value < result) result = sample.value;
    }
    return result;
  },
  max: (samples) => {
    let result = -Infinity;
    for (const sample of samples) {
      if (Number.isNaN(sample.value)) return Number.NaN;
      if (sample.value > result) result = sample.value;
    }
    return result;
  },
  avg: (samples) => AGGREGATOR_FNS.sum(samples) / samples.length,
  count: (samples) => samples.length,
  stddev: (samples) => Math.sqrt(variance(samples)),
  stdvar: (samples) => variance(samples),
  last: (samples) => pickByTimestamp(samples, "last").value,
  first: (samples) => pickByTimestamp(samples, "first").value,
  group: () => 1,
};

interface FamilyShape {
  declared: MetricType | undefined;
  hasLe: boolean;
}

interface Group {
  family: string;
  type: MetricType;
  labels: Labels;
  plain: Series[];
  buckets: Map<string, number[]>;
  sums: Series[];
  counts: Series[];
  quantiles: Map<string, Series[]>;
}

function leSortValue(le: string): number {
  if (le === "+Inf" || le === "Inf") return Infinity;
  if (le === "-Inf") return -Infinity;
  const parsed = Number(le);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

function compareLe(a: string, b: string): number {
  const left = leSortValue(a);
  const right = leSortValue(b);
  const leftNaN = Number.isNaN(left);
  const rightNaN = Number.isNaN(right);
  if (!leftNaN && !rightNaN && left !== right) return left < right ? -1 : 1;
  if (leftNaN && !rightNaN) return 1;
  if (!leftNaN && rightNaN) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareQuantile(a: string, b: string): number {
  const left = Number(a);
  const right = Number(b);
  if (!Number.isNaN(left) && !Number.isNaN(right) && left !== right) return left < right ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareSamples(a: Series, b: Series): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  const aLe = a.labels["le"];
  const bLe = b.labels["le"];
  if (aLe !== undefined && bLe !== undefined) {
    const order = compareLe(aLe, bLe);
    if (order !== 0) return order;
  }
  const aQuantile = a.labels["quantile"];
  const bQuantile = b.labels["quantile"];
  if (aQuantile !== undefined && bQuantile !== undefined) {
    const order = compareQuantile(aQuantile, bQuantile);
    if (order !== 0) return order;
  }
  const aKey = labelsKey(a.labels);
  const bKey = labelsKey(b.labels);
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

function validateLabelList(kind: string, value: string[] | undefined): void {
  if (value === undefined) return;
  for (const name of value) {
    if (!LABEL_NAME_RE.test(name)) {
      throw new AggregateConfigError(`${kind} contains "${name}", which is not a valid label name`);
    }
  }
}

function dedupeSamples(
  input: Series[],
  options: AggregateOptions,
  warnings: string[],
): { samples: Series[]; deduped: number; conflictsResolved: number } {
  const dedupeIdentical = options.dedupeIdentical ?? true;
  const policy = options.conflictPolicy ?? "keep";
  const seen = new Set<string>();
  const unique: Series[] = [];
  let deduped = 0;
  let conflictsResolved = 0;

  for (const sample of input) {
    if (dedupeIdentical) {
      const key = `${sample.name}\u0000${labelsKey(sample.labels)}\u0000${sample.value}\u0000${sample.timestamp ?? ""}`;
      if (seen.has(key)) {
        deduped++;
        continue;
      }
      seen.add(key);
    }
    unique.push(sample);
  }

  if (policy === "keep") return { samples: unique, deduped, conflictsResolved };

  const byKey = new Map<string, Series[]>();
  const order: string[] = [];
  for (const sample of unique) {
    const key = `${sample.name}\u0000${labelsKey(sample.labels)}`;
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = [];
      byKey.set(key, bucket);
      order.push(key);
    }
    bucket.push(sample);
  }

  const kept: Series[] = [];
  const conflicts: string[] = [];
  for (const key of order) {
    const bucket = byKey.get(key)!;
    if (bucket.length === 1) {
      kept.push(bucket[0]!);
      continue;
    }
    if (policy === "error") {
      const distinct = new Set(bucket.map((sample) => sample.value));
      if (distinct.size > 1 && conflicts.length < MAX_REPORTED_CONFLICTS) {
        conflicts.push(`${bucket[0]!.name}{${labelsKey(bucket[0]!.labels)}} has ${distinct.size} distinct values`);
      }
      kept.push(...bucket);
      continue;
    }
    const distinct = new Set(bucket.map((sample) => sample.value));
    kept.push(pickByTimestamp(bucket, "last"));
    if (distinct.size > 1) {
      deduped += bucket.length - 1;
      conflictsResolved += bucket.length - 1;
    }
  }

  if (conflicts.length > 0) {
    throw new AggregateConflictError(
      `conflicting samples for identical series (use conflictPolicy "newest" or "keep" to resolve): ${conflicts.join("; ")}`,
    );
  }
  if (policy === "newest" && deduped > 0) {
    warnings.push(`conflictPolicy "newest" discarded ${deduped} superseded sample(s)`);
  }
  return { samples: kept, deduped, conflictsResolved };
}

/** Reduce `input` onto a smaller label set. */
export function aggregate(input: Series[], metadata: MetadataMap, options: AggregateOptions = {}): AggregateResult {
  if (options.by !== undefined && options.without !== undefined) {
    throw new AggregateConfigError("`by` and `without` are mutually exclusive");
  }
  validateLabelList("by", options.by);
  validateLabelList("without", options.without);
  validateLabelList("dropLabels", options.dropLabels);
  for (const name of Object.keys(options.label ?? {})) {
    if (!LABEL_NAME_RE.test(name)) {
      throw new AggregateConfigError(`static label "${name}" is not a valid label name`);
    }
  }

  const aggregators = options.aggregators ?? ["sum"];
  if (aggregators.length === 0) {
    throw new AggregateConfigError("at least one aggregator is required");
  }
  for (const name of aggregators) {
    if (!isAggregatorName(name)) {
      throw new AggregateConfigError(`unknown aggregator "${name}"; valid aggregators are: ${AGGREGATOR_NAMES.join(", ")}`);
    }
  }
  if (aggregators.length > 1 && options.name !== undefined) {
    throw new AggregateConfigError("`name` cannot be combined with multiple aggregators; aggregate once per output family");
  }
  if (options.name !== undefined && !METRIC_NAME_RE.test(options.name)) {
    throw new AggregateConfigError(`"${options.name}" is not a valid metric name`);
  }

  const warnings: string[] = [];
  const warn = (message: string): void => {
    if (warnings.length < MAX_REPORTED_WARNINGS && !warnings.includes(message)) warnings.push(message);
  };

  const { samples, deduped, conflictsResolved } = dedupeSamples(input, options, warnings);

  // Pass 1 — family shape. A histogram is recognised structurally as well as by
  // declaration, because plenty of real exporters omit `# TYPE`.
  const shapes = new Map<string, FamilyShape>();
  for (const sample of samples) {
    const resolved = metadataFor(sample.name, metadata);
    let shape = shapes.get(resolved.family);
    if (!shape) {
      shape = { declared: resolved.meta?.type, hasLe: false };
      shapes.set(resolved.family, shape);
    }
    if (sample.labels["le"] !== undefined && sample.name.endsWith("_bucket")) shape.hasLe = true;
  }

  const drop = new Set([...(options.without ?? []), ...(options.dropLabels ?? [])]);
  const keep = options.by === undefined ? undefined : new Set(options.by);

  // Pass 2 — grouping.
  const groups = new Map<string, Group>();
  const groupOrder: string[] = [];
  const structuralHistograms = new Set<string>();
  let droppedQuantileSeries = 0;

  for (const sample of samples) {
    const resolved = metadataFor(sample.name, metadata);
    const family = resolved.family;
    const shape = shapes.get(family)!;
    const isHistogram = shape.declared === "histogram" || shape.hasLe;
    const isSummary = shape.declared === "summary";
    const type: MetricType = isHistogram ? "histogram" : isSummary ? "summary" : (shape.declared ?? "untyped");
    if (shape.hasLe && shape.declared !== "histogram") structuralHistograms.add(family);

    const groupLabels: Labels = {};
    for (const labelName of sortedLabelNames(sample.labels)) {
      if (labelName === "le" || labelName === "quantile") continue;
      if (drop.has(labelName)) continue;
      if (keep !== undefined && !keep.has(labelName)) continue;
      groupLabels[labelName] = sample.labels[labelName]!;
    }

    const key = `${family}\u0000${labelsKey(groupLabels)}`;
    let group = groups.get(key);
    if (!group) {
      group = { family, type, labels: groupLabels, plain: [], buckets: new Map(), sums: [], counts: [], quantiles: new Map() };
      groups.set(key, group);
      groupOrder.push(key);
    }

    const label = sample.labels["le"] !== undefined && sample.name.endsWith("_bucket");
    if (label && isHistogram) {
      const le = sample.labels["le"]!;
      let bucket = group.buckets.get(le);
      if (!bucket) {
        bucket = [];
        group.buckets.set(le, bucket);
      }
      bucket.push(sample.value);
      continue;
    }

    if (sample.labels["quantile"] !== undefined && isSummary) {
      const quantile = sample.labels["quantile"]!;
      let bucket = group.quantiles.get(quantile);
      if (!bucket) {
        bucket = [];
        group.quantiles.set(quantile, bucket);
      }
      bucket.push(sample);
      droppedQuantileSeries++;
      continue;
    }

    if (isHistogram && sample.name.endsWith("_sum")) {
      group.sums.push(sample);
      continue;
    }
    if (isHistogram && sample.name.endsWith("_count")) {
      group.counts.push(sample);
      continue;
    }
    if (isSummary && sample.name.endsWith("_sum")) {
      group.sums.push(sample);
      continue;
    }
    if (isSummary && sample.name.endsWith("_count")) {
      group.counts.push(sample);
      continue;
    }

    // Everything else is a plain sample; a non-summary `quantile` label is just
    // another label dimension, so restore it.
    const plainLabels = sample.labels["quantile"] === undefined ? groupLabels : { ...groupLabels, quantile: sample.labels["quantile"]! };
    const plain: Series = { name: sample.name, labels: plainLabels, value: sample.value };
    if (sample.timestamp !== undefined) plain.timestamp = sample.timestamp;
    if (sample.exemplar !== undefined) plain.exemplar = sample.exemplar;
    group.plain.push(plain);
  }

  const output: Series[] = [];
  const outputMetadata: MetadataMap = new Map();
  const perAggregator: Record<string, number> = {};
  for (const name of aggregators) perAggregator[name] = 0;

  const staticLabels = options.label ?? {};
  const withStatic = (labels: Labels): Labels => ({ ...labels, ...staticLabels });

  const propagateMetadata = (target: string, sourceFamily: string, type: MetricType): void => {
    if (outputMetadata.has(target)) return;
    const source = metadata.get(sourceFamily);
    const meta: { type?: MetricType; help?: string; unit?: string } = {};
    if (type !== "untyped") meta.type = type;
    if (source?.help !== undefined) meta.help = source.help;
    if (source?.unit !== undefined) meta.unit = source.unit;
    outputMetadata.set(target, meta);
  };

  let histogramGroups = 0;
  let summaryGroups = 0;
  let nonMonotonicReports = 0;
  let mismatchReports = 0;

  for (const key of groupOrder) {
    const group = groups.get(key)!;
    const baseName = options.name ?? group.family;
    const hasBuckets = group.buckets.size > 0;
    const hasQuantiles = group.quantiles.size > 0;

    if (hasBuckets) {
      histogramGroups++;
      const buckets = [...group.buckets.entries()]
        .map(([le, values]) => ({ le, values }))
        .sort((a, b) => compareLe(a.le, b.le));
      const merged = buckets.map((bucket) => {
        let total = 0;
        for (const value of bucket.values) {
          if (Number.isNaN(value)) {
            total = Number.NaN;
            break;
          }
          total += value;
        }
        return { le: bucket.le, value: total };
      });

      let previous = -Infinity;
      for (const entry of merged) {
        if (entry.le === "+Inf" || entry.le === "Inf") continue;
        if (!Number.isNaN(entry.value) && entry.value < previous && nonMonotonicReports < 3) {
          nonMonotonicReports++;
          warn(
            `histogram "${baseName}" has non-monotonic buckets after merging (le="${entry.le}" is smaller than the preceding bucket); the source histograms are probably being mutated in place`,
          );
        }
        previous = entry.value;
      }

      for (const entry of merged) {
        output.push({ name: `${baseName}_bucket`, value: entry.value, labels: withStatic({ ...group.labels, le: entry.le }) });
      }
      if (group.sums.length > 0) {
        output.push({ name: `${baseName}_sum`, value: AGGREGATOR_FNS.sum(group.sums), labels: withStatic({ ...group.labels }) });
      }
      if (group.counts.length > 0) {
        const countTotal = AGGREGATOR_FNS.sum(group.counts);
        output.push({ name: `${baseName}_count`, value: countTotal, labels: withStatic({ ...group.labels }) });
        const infinite = merged.find((entry) => entry.le === "+Inf" || entry.le === "Inf");
        if (infinite && !Number.isNaN(infinite.value) && infinite.value !== countTotal && mismatchReports < 3) {
          mismatchReports++;
          warn(
            `histogram "${baseName}" has a +Inf bucket of ${infinite.value} but a _count of ${countTotal}; one of them is wrong in the source data`,
          );
        }
      }
      // Declare the *family* once. `_bucket` / `_sum` / `_count` samples resolve
      // back to it, so emitting declarations for the suffixed names too would
      // produce three bogus families in the output document.
      propagateMetadata(baseName, group.family, "histogram");
      continue;
    }

    if (hasQuantiles) {
      summaryGroups++;
      const dropQuantiles = options.dropQuantiles ?? true;
      if (dropQuantiles) {
        warn(
          "summary quantiles were dropped: quantiles from different populations cannot be added, so only _sum and _count are aggregated",
        );
      } else {
        warn("summary quantiles were taken from the first member of each group; they are not a true aggregate");
        for (const quantile of [...group.quantiles.keys()].sort(compareQuantile)) {
          const representative = group.quantiles.get(quantile)![0]!;
          output.push({ name: baseName, value: representative.value, labels: withStatic({ ...group.labels, quantile }) });
        }
      }
      if (group.sums.length > 0) {
        output.push({ name: `${baseName}_sum`, value: AGGREGATOR_FNS.sum(group.sums), labels: withStatic({ ...group.labels }) });
      }
      if (group.counts.length > 0) {
        output.push({ name: `${baseName}_count`, value: AGGREGATOR_FNS.sum(group.counts), labels: withStatic({ ...group.labels }) });
      }
      propagateMetadata(baseName, group.family, "summary");
    }

    if (group.plain.length > 0) {
      const synthesized = aggregators.length > 1;
      if (synthesized) {
        warn(
          "more than one aggregator was requested, so every output family is named \"<family>_<aggregator>\" and declared a gauge: a counter family name must end in \"_total\", which a synthesized name cannot guarantee",
        );
      }
      for (const aggregator of aggregators) {
        const name = options.name ?? (synthesized ? `${group.family}_${aggregator}` : group.family);
        output.push({ name, value: AGGREGATOR_FNS[aggregator](group.plain), labels: withStatic({ ...group.labels }) });
        perAggregator[aggregator] = (perAggregator[aggregator] ?? 0) + 1;
        propagateMetadata(name, group.family, synthesized ? "gauge" : group.type);
      }
    }

    if (!hasBuckets && !hasQuantiles) {
      if (group.sums.length > 0) {
        output.push({ name: `${baseName}_sum`, value: AGGREGATOR_FNS.sum(group.sums), labels: withStatic({ ...group.labels }) });
        propagateMetadata(baseName, group.family, group.type);
      }
      if (group.counts.length > 0) {
        output.push({ name: `${baseName}_count`, value: AGGREGATOR_FNS.sum(group.counts), labels: withStatic({ ...group.labels }) });
        propagateMetadata(baseName, group.family, group.type);
      }
    }
  }

  if (structuralHistograms.size > 0) {
    warn(
      `merged ${structuralHistograms.size} family/families as histograms based on the "_bucket" suffix and "le" label without a "# TYPE histogram" declaration: ${[...structuralHistograms].slice(0, 3).join(", ")}`,
    );
  }

  output.sort(compareSamples);

  const stats: AggregateStats = {
    inputSeries: input.length,
    dedupedSamples: deduped,
    conflictsResolved,
    groups: groupOrder.length,
    outputSeries: output.length,
    droppedQuantileSeries,
    histogramGroups,
    summaryGroups,
    perAggregator,
    warnings,
  };

  return { series: output, metadata: outputMetadata, stats };
}

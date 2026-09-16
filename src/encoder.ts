/**
 * Encoder for the Prometheus text exposition format, with optional OpenMetrics
 * framing (`# UNIT`, exemplars, `# EOF`).
 *
 * Output is byte-for-byte deterministic: families, samples inside a family, and
 * label names are all sorted, so two runs over the same input produce the same
 * document. That matters because this module's output is meant to be scraped,
 * diffed and committed.
 */

import {
  METRIC_NAME_RE,
  compareSeries,
  escapeHelpText,
  escapeLabelValue,
  formatValue,
  metadataFor,
  sortedLabelNames,
} from "./format.ts";
import type { EncodeOptions, MetadataMap, Series } from "./types.ts";

export class EncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncodeError";
  }
}

/** Render one sample line, without the trailing newline. */
export function encodeSample(series: Series): string {
  if (!METRIC_NAME_RE.test(series.name)) {
    throw new EncodeError(`"${series.name}" is not a valid metric name`);
  }
  const names = sortedLabelNames(series.labels);
  let line = series.name;
  if (names.length > 0) {
    const pairs = names.map((name) => `${name}="${escapeLabelValue(series.labels[name]!)}"`);
    line += `{${pairs.join(",")}}`;
  }
  line += ` ${formatValue(series.value)}`;
  if (series.timestamp !== undefined) line += ` ${series.timestamp}`;
  return line;
}

export function encodeExemplar(series: Series): string | undefined {
  const exemplar = series.exemplar;
  if (!exemplar) return undefined;
  const names = sortedLabelNames(exemplar.labels);
  const pairs = names.map((name) => `${name}="${escapeLabelValue(exemplar.labels[name]!)}"`);
  let line = `# {${pairs.join(",")}} ${formatValue(exemplar.value)}`;
  if (exemplar.timestamp !== undefined) line += ` ${exemplar.timestamp}`;
  return line;
}

/**
 * Encode samples + metadata as an exposition document.
 *
 * @param series   samples to write
 * @param metadata family metadata collected by the parser
 * @param options  `openMetrics` adds `# UNIT`, exemplars and `# EOF`
 */
export function encodeExposition(series: Series[], metadata: MetadataMap, options: EncodeOptions = {}): string {
  const openMetrics = options.openMetrics ?? false;
  const includeHelp = options.includeHelp ?? true;
  const includeType = options.includeType ?? true;
  const sort = options.sort ?? true;

  const families = new Map<string, Series[]>();
  const familyOrder: string[] = [];
  for (const sample of series) {
    const family = metadataFor(sample.name, metadata).family;
    let bucket = families.get(family);
    if (!bucket) {
      bucket = [];
      families.set(family, bucket);
      familyOrder.push(family);
    }
    bucket.push(sample);
  }

  const names = sort ? [...familyOrder].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) : familyOrder;
  const lines: string[] = [];

  for (const family of names) {
    const samples = families.get(family)!;
    if (sort) samples.sort((a, b) => compareSeries(a, b, metadata));
    const meta = metadata.get(family);
    const type = meta?.type ?? "untyped";
    if (includeHelp && meta?.help !== undefined) {
      lines.push(`# HELP ${family} ${escapeHelpText(meta.help)}`);
    }
    // `untyped` is the format's default, so a line that would only restate it
    // is noise — and it is the one thing every official client library omits.
    if (includeType && meta?.type !== undefined) {
      lines.push(`# TYPE ${family} ${type}`);
    }
    if (openMetrics && meta?.unit) {
      lines.push(`# UNIT ${family} ${meta.unit}`);
    }
    for (const sample of samples) {
      lines.push(encodeSample(sample));
      if (openMetrics) {
        const exemplar = encodeExemplar(sample);
        if (exemplar !== undefined) lines.push(exemplar);
      }
    }
  }

  if (openMetrics) lines.push("# EOF");
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

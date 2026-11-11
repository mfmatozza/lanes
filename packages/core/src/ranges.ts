// Line ranges for the multiplayer heads-up (S6.1): line numbers only, never file text (ADR-0010).
import type { LineRange } from "./types.ts";

/** Ranges kept per file. */
export const MAX_RANGES = 50;
/** Changes this close count as one overlap: adjacent changes conflict in a line merge too (multiplayer/benchmark/method.md). */
export const NEAR_LINES = 3;

/** Sorted, with touching or overlapping ranges merged; past `max`, the tail collapses into one range, so nothing is dropped. */
export function mergeRanges(list: LineRange[], max = MAX_RANGES): LineRange[] {
  const out: LineRange[] = [];
  for (const [a, b] of [...list].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  if (out.length > max) out.splice(max - 1, out.length, [out[max - 1][0], out[out.length - 1][1]]);
  return out;
}

/** True when the two ranges are within NEAR_LINES lines of each other. */
export function nearRange(a: LineRange, b: LineRange): boolean {
  return a[0] <= b[1] + NEAR_LINES && b[0] <= a[1] + NEAR_LINES;
}

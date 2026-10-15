import type { TimingPoint } from '../types';

const DEFAULT_BEAT_LENGTH = 500;

export interface TimingState { beatLength: number; sv: number }

/**
 * Timing lookup over points that are already stable-sorted by time (file order kept for ties).
 * - red line: last uninherited point with time <= t, or the first red line if t precedes all of them;
 * - SV: taken from the last point with time <= t if it is a green line (clamped 0.1–10), otherwise 1.
 */
export class TimingLookup {
  private readonly points: TimingPoint[];
  private readonly reds: TimingPoint[];

  constructor(points: TimingPoint[]) {
    this.points = points;
    this.reds = points.filter((p) => p.uninherited);
  }

  private static lastAtOrBefore(list: TimingPoint[], t: number): number {
    let lo = 0;
    let hi = list.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].time <= t) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  beatLengthAt(t: number): number {
    if (this.reds.length === 0) return DEFAULT_BEAT_LENGTH;
    const idx = TimingLookup.lastAtOrBefore(this.reds, t);
    return this.reds[Math.max(0, idx)].beatLength;
  }

  svAt(t: number): number {
    const idx = TimingLookup.lastAtOrBefore(this.points, t);
    if (idx < 0) return 1;
    const p = this.points[idx];
    if (p.uninherited) return 1;
    if (!(p.beatLength < 0)) return 1;
    return Math.min(10, Math.max(0.1, -100 / p.beatLength));
  }

  at(t: number): TimingState {
    return { beatLength: this.beatLengthAt(t), sv: this.svAt(t) };
  }
}

/** Duration of one slider span: length / (SliderMultiplier × 100 × SV) × beatLength. */
export function spanDurationFor(length: number, sliderMultiplier: number, state: TimingState): number {
  return (length / (sliderMultiplier * 100 * state.sv)) * state.beatLength;
}

/** Inverse of spanDurationFor; used when exporting synthetic sliders. */
export function lengthForSpanDuration(spanDuration: number, sliderMultiplier: number, state: TimingState): number {
  return (spanDuration / state.beatLength) * sliderMultiplier * 100 * state.sv;
}

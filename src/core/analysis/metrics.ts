import type { Frame, Judgment, KeyPress, ReplayAnalysis, Scope } from '../types';
import { countAlternation } from '../replay/keyPresses';

export const TAP_INTERVAL_LIMIT_MS = 400;

/** Minimal replay shape the metrics need (keeps this module independent of app state). */
export interface AnalyzedReplay { id: string; frames: Frame[]; analysis: ReplayAnalysis }

type Range = [number, number];

function lowerBound<T>(arr: T[], t: number, key: (v: T) => number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound<T>(arr: T[], t: number, key: (v: T) => number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index range of a time-sorted array that satisfies inScope (same half-open rule). */
export function scopeRange<T>(arr: T[], key: (v: T) => number, scope: Pick<Scope, 'startMs' | 'endMs'>, durationMs: number): Range {
  const lo = lowerBound(arr, scope.startMs, key);
  const hi = scope.endMs >= durationMs ? upperBound(arr, scope.endMs, key) : lowerBound(arr, scope.endMs, key);
  return [lo, Math.max(lo, hi)];
}

const byNoteTime = (j: Judgment) => j.noteTime;
const byTime = (v: { time: number }) => v.time;

export function scopedJudgments(a: ReplayAnalysis, scope: Pick<Scope, 'startMs' | 'endMs'>, d: number): Judgment[] {
  const [lo, hi] = scopeRange(a.judgments, byNoteTime, scope, d);
  return a.judgments.slice(lo, hi);
}

export function scopedPresses(a: ReplayAnalysis, scope: Pick<Scope, 'startMs' | 'endMs'>, d: number): KeyPress[] {
  const [lo, hi] = scopeRange(a.keyPresses, byTime, scope, d);
  return a.keyPresses.slice(lo, hi);
}

export const isEffective = (j: Judgment) => j.judgment !== 'SKIP';
/** A timed hit on the circle / slider head (an early-missed slider head does not count even if the body scored). */
export const isHit = (j: Judgment) => j.pressed && j.judgment !== 'MISS' && j.judgment !== 'SKIP' && (j.slider === null || j.slider.headHit);
export const isSliderBreak = (j: Judgment) => j.slider !== null && j.slider.break !== null;

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

/** UR = population standard deviation of hit errors × 10; null with fewer than 2 hits. */
export function unstableRate(errors: number[]): number | null {
  if (errors.length < 2) return null;
  const m = mean(errors)!;
  let v = 0;
  for (const e of errors) v += (e - m) * (e - m);
  return Math.sqrt(v / errors.length) * 10;
}

export function altPercent(presses: KeyPress[]): number | null {
  const { alternate, single } = countAlternation(presses);
  return alternate + single > 0 ? (alternate / (alternate + single)) * 100 : null;
}

export interface ReplayRow { id: string; k1: number; k2: number; altPct: number | null; miss: number; sliderBreaks: number; meanDeviation: number | null }

export interface PrimaryMetrics {
  ur: number | null;
  altPct: number | null;
  meanHitError: number | null;
  holdK1: number | null;
  holdK2: number | null;
  peakVelocity: number | null;
  meanTapInterval: number | null;
  equivalentBpm: number | null;
}

export interface RadarPoint { replayId: string; lateral: number; longitudinal: number; miss: boolean }

export interface ScopeMetrics {
  k1: number;
  k2: number;
  k1Pct: number | null;
  k2Pct: number | null;
  kps: number | null;
  missCount: number;
  missReason: string;
  sliderBreakCount: number;
  /** Reason of the primary's first slider break, a fallback when only other replays broke, or ''. */
  sliderBreakReason: string;
  meanDeviation: number | null;
  overaimPct: number | null;
  underaimPct: number | null;
  effectiveCount: number;
  rows: ReplayRow[];
  primary: PrimaryMetrics | null;
  radar: RadarPoint[];
}

export const MISS_REASON_OTHERS = '其他回放有 Miss';
export const MISS_REASON_NONE = '无失误';
export const BREAK_REASON_OTHERS = '其他回放有断连';

export function computePrimaryMetrics(rep: AnalyzedReplay, scope: Pick<Scope, 'startMs' | 'endMs'>, d: number): PrimaryMetrics {
  const judg = scopedJudgments(rep.analysis, scope, d);
  const presses = scopedPresses(rep.analysis, scope, d);
  const hitErrors = judg.filter(isHit).map((j) => j.timeError as number);
  const holds = (key: 'K1' | 'K2') =>
    mean(presses.filter((p) => p.key === key && p.holdMs !== null).map((p) => p.holdMs as number));
  const [flo, fhi] = scopeRange(rep.frames, byTime, scope, d);
  let peak: number | null = null;
  for (let i = flo; i < fhi; i++) peak = peak === null ? rep.frames[i].velocity : Math.max(peak, rep.frames[i].velocity);
  const intervals = presses
    .map((p) => p.tapInterval)
    .filter((v): v is number => v !== null && v < TAP_INTERVAL_LIMIT_MS);
  const meanTapInterval = mean(intervals);
  return {
    ur: unstableRate(hitErrors),
    altPct: altPercent(presses),
    meanHitError: mean(hitErrors),
    holdK1: holds('K1'),
    holdK2: holds('K2'),
    peakVelocity: peak,
    meanTapInterval,
    equivalentBpm: meanTapInterval && meanTapInterval > 0 ? 15000 / meanTapInterval : null,
  };
}

export function computeScopeMetrics(
  selected: AnalyzedReplay[],
  primary: AnalyzedReplay | null,
  scope: Pick<Scope, 'startMs' | 'endMs'>,
  durationMs: number,
): ScopeMetrics {
  let k1 = 0;
  let k2 = 0;
  let missCount = 0;
  let devSum = 0;
  let effectiveCount = 0;
  let over = 0;
  let under = 0;
  let breakCount = 0;
  let primaryFirstMiss: Judgment | null = null;
  let primaryFirstBreak: Judgment | null = null;
  const rows: ReplayRow[] = [];
  const radar: RadarPoint[] = [];

  for (const rep of selected) {
    const judg = scopedJudgments(rep.analysis, scope, durationMs);
    const presses = scopedPresses(rep.analysis, scope, durationMs);
    let rk1 = 0;
    let rk2 = 0;
    for (const p of presses) p.key === 'K1' ? rk1++ : rk2++;
    let rMiss = 0;
    let rBreaks = 0;
    let rDev = 0;
    let rEff = 0;
    const isPrimary = !!primary && rep.id === primary.id;
    for (const j of judg) {
      if (!isEffective(j)) continue;
      rEff++;
      rDev += j.radialOffset;
      if (j.isOveraim) over++;
      if (j.isUnderaim) under++;
      if (j.judgment === 'MISS') {
        rMiss++;
        if (isPrimary && !primaryFirstMiss) primaryFirstMiss = j;
      }
      if (isSliderBreak(j)) {
        rBreaks++;
        if (isPrimary && !primaryFirstBreak) primaryFirstBreak = j;
      }
      if (j.lateralOffset !== null && j.longitudinalOffset !== null) {
        radar.push({ replayId: rep.id, lateral: j.lateralOffset, longitudinal: j.longitudinalOffset, miss: j.judgment === 'MISS' });
      }
    }
    k1 += rk1;
    k2 += rk2;
    missCount += rMiss;
    breakCount += rBreaks;
    devSum += rDev;
    effectiveCount += rEff;
    rows.push({ id: rep.id, k1: rk1, k2: rk2, altPct: altPercent(presses), miss: rMiss, sliderBreaks: rBreaks, meanDeviation: rEff ? rDev / rEff : null });
  }

  const total = k1 + k2;
  const seconds = (scope.endMs - scope.startMs) / 1000;
  let missReason: string = MISS_REASON_NONE;
  if (primaryFirstMiss) missReason = (primaryFirstMiss as Judgment).missReason;
  else if (missCount > 0) missReason = MISS_REASON_OTHERS;
  let sliderBreakReason = '';
  if (primaryFirstBreak) sliderBreakReason = (primaryFirstBreak as Judgment).slider!.break!.reason;
  else if (breakCount > 0) sliderBreakReason = BREAK_REASON_OTHERS;

  return {
    k1,
    k2,
    k1Pct: total ? (k1 / total) * 100 : null,
    k2Pct: total ? (k2 / total) * 100 : null,
    kps: selected.length && seconds > 0 ? total / selected.length / seconds : null,
    missCount,
    missReason,
    sliderBreakCount: breakCount,
    sliderBreakReason,
    meanDeviation: effectiveCount ? devSum / effectiveCount : null,
    overaimPct: effectiveCount ? (over / effectiveCount) * 100 : null,
    underaimPct: effectiveCount ? (under / effectiveCount) * 100 : null,
    effectiveCount,
    rows,
    primary: primary ? computePrimaryMetrics(primary, scope, durationMs) : null,
    radar,
  };
}

/** Bucket edges (ms) for the hit-error histogram; labels are generated from the same array. */
export const HIT_ERROR_EDGES = [-25, -15, -5, 5, 15, 25] as const;

export function histogramLabels(edges: readonly number[] = HIT_ERROR_EDGES): string[] {
  const fmt = (v: number) => (v > 0 ? `+${v}` : String(v));
  const labels = [`< ${fmt(edges[0])}`];
  for (let i = 1; i < edges.length; i++) labels.push(`${fmt(edges[i - 1])} ~ ${fmt(edges[i])}`);
  labels.push(`≥ ${fmt(edges[edges.length - 1])}`);
  return labels;
}

/** Bucket i covers [edges[i-1], edges[i]); bucket 0 is below edges[0], the last is >= the last edge. */
export function histogramBucket(value: number, edges: readonly number[] = HIT_ERROR_EDGES): number {
  let i = 0;
  while (i < edges.length && value >= edges[i]) i++;
  return i;
}

export interface HistogramSeries { id: string; counts: number[] }

export function hitErrorHistogram(selected: AnalyzedReplay[], scope: Pick<Scope, 'startMs' | 'endMs'>, d: number): HistogramSeries[] {
  return selected.map((rep) => {
    const counts = new Array(HIT_ERROR_EDGES.length + 1).fill(0);
    for (const j of scopedJudgments(rep.analysis, scope, d)) {
      if (isHit(j)) counts[histogramBucket(j.timeError as number)]++;
    }
    return { id: rep.id, counts };
  });
}

export interface TapIntervalPoint { time: number; interval: number }

export function tapIntervalSeries(rep: AnalyzedReplay, scope: Pick<Scope, 'startMs' | 'endMs'>, d: number): TapIntervalPoint[] {
  return scopedPresses(rep.analysis, scope, d)
    .filter((p) => p.tapInterval !== null && p.tapInterval < TAP_INTERVAL_LIMIT_MS)
    .map((p) => ({ time: p.time, interval: p.tapInterval as number }));
}

import type { Beatmap } from '../types';
import type { AnalyzedReplay } from './metrics';
import { isEffective } from './metrics';
import { sliceCount, sliceIndexOf } from './scope';

export interface SliceStat {
  index: number;
  startMs: number;
  endMs: number;
  noteCount: number;
  misses: number;
  c100: number;
  c50: number;
  meanDeviation: number | null;
  k1: number;
  k2: number;
}

/** Per-slice aggregates over the selected replays; bucketing uses the same rule as inScope. */
export function computeSlices(beatmap: Beatmap, selected: AnalyzedReplay[], sliceLen: number): SliceStat[] {
  const d = beatmap.durationMs;
  const n = sliceCount(d, sliceLen);
  const stats: SliceStat[] = [];
  const devSum = new Array(n).fill(0);
  const devCount = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    stats.push({
      index: i, startMs: i * sliceLen, endMs: Math.min((i + 1) * sliceLen, d),
      noteCount: 0, misses: 0, c100: 0, c50: 0, meanDeviation: null, k1: 0, k2: 0,
    });
  }
  for (const o of beatmap.hitObjects) {
    const i = sliceIndexOf(o.time, sliceLen, d);
    if (i >= 0) stats[i].noteCount++;
  }
  for (const rep of selected) {
    for (const j of rep.analysis.judgments) {
      const i = sliceIndexOf(j.noteTime, sliceLen, d);
      if (i < 0 || !isEffective(j)) continue;
      if (j.judgment === 'MISS') stats[i].misses++;
      else if (j.judgment === '100') stats[i].c100++;
      else if (j.judgment === '50') stats[i].c50++;
      devSum[i] += j.radialOffset;
      devCount[i]++;
    }
    for (const p of rep.analysis.keyPresses) {
      const i = sliceIndexOf(p.time, sliceLen, d);
      if (i < 0) continue;
      if (p.key === 'K1') stats[i].k1++;
      else stats[i].k2++;
    }
  }
  for (let i = 0; i < n; i++) stats[i].meanDeviation = devCount[i] ? devSum[i] / devCount[i] : null;
  return stats;
}

/** Slice with the most misses; ties go to the earliest. */
export function worstSlice(stats: SliceStat[]): SliceStat | null {
  let worst: SliceStat | null = null;
  for (const s of stats) if (!worst || s.misses > worst.misses) worst = s;
  return worst;
}

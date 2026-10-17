import type { Judgment } from '../types';

/** miss = MISS; break = slider break; meh = 100 / 50 without a break. */
export type MarkKind = 'miss' | 'break' | 'meh';

export interface JudgmentMark { time: number; kind: MarkKind; text: string }

/**
 * Judgement points for a timeline inside [from, to]: misses at the note, slider breaks where the combo
 * broke, and other 100/50s at the note. Sorted by time.
 */
export function judgmentMarks(judgments: Judgment[], from: number, to: number): JudgmentMark[] {
  const out: JudgmentMark[] = [];
  const push = (time: number, kind: MarkKind, text: string) => {
    if (time >= from && time <= to) out.push({ time, kind, text });
  };
  for (const j of judgments) {
    if (j.judgment === 'MISS') push(j.noteTime, 'miss', `MISS · ${j.missReason}`);
    else if (j.slider?.break) push(j.slider.break.time, 'break', `断连 · ${j.slider.break.reason}`);
    else if (j.judgment === '100' || j.judgment === '50') {
      const dropped = j.slider?.checks.find((c) => !c.hit);
      const detail = j.slider && dropped
        ? `滑条 ${j.slider.hitParts}/${j.slider.totalParts}（${dropped.reason}）`
        : `${j.timeError !== null && j.timeError >= 0 ? '+' : ''}${Math.round(j.timeError ?? 0)} ms`;
      push(j.noteTime, 'meh', `${j.judgment} · ${detail}`);
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

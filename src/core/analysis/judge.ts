import type {
  Beatmap, EffectiveDifficulty, Frame, HitObject, Judgment, JudgmentKind, KeyPress, ReplayAnalysis, SimulatedCounts, SliderBreak,
} from '../types';
import { effectiveDifficulty } from '../beatmap/difficulty';
import { cursorPositionAt } from '../replay/frames';
import { extractKeyPresses } from '../replay/keyPresses';
import { decomposeAim, movementOrigin } from './aim';
import { judgeSliderChecks, sliderJudgmentKind } from './slider';

export const MISS_REASON = {
  early: '过早按键',
  aimOut: (px: number) => `Aim 偏出圆圈（最近一次偏了 ${px.toFixed(1)} px）`,
  cursorOnButNoTap: '光标到位但漏按',
  cursorOffAndNoTap: '未拉到位且漏按',
  sliderHead: (reason: string) => `滑条头：${reason}`,
} as const;

interface Pending {
  obj: HitObject;
  lastOutsideDistance: number | null;
}

function judgmentFor(absErr: number, eff: EffectiveDifficulty): JudgmentKind | null {
  if (absErr <= eff.hw300) return '300';
  if (absErr <= eff.hw100) return '100';
  if (absErr <= eff.hw50) return '50';
  return null;
}

/**
 * Approximate judgement (§5.4). Heads: notelock on the earliest unjudged object, presses outside the
 * circle are ignored (the player may re-tap), early-press miss window of 400 ms, timeout at time + hw50.
 * Sliders follow stable: any head hit inside hw50 counts, the body is judged by follow tracking on
 * ticks / repeats / the tail check, and the result is the share of parts hit. A missed head, tick or
 * repeat is a slider break unless the whole slider is a miss. Spinners produce SKIP.
 * O(presses + objects + frames inside sliders).
 */
export function judgeReplay(beatmap: Beatmap, frames: Frame[], presses: KeyPress[], eff: EffectiveDifficulty): Judgment[] {
  const objects = beatmap.hitObjects;
  const results: (Judgment | undefined)[] = new Array(objects.length);
  const queue: Pending[] = [];

  const base = (obj: HitObject) => {
    const origin = movementOrigin(objects, obj.index);
    return { origin, target: { x: obj.x, y: obj.y } };
  };

  /** Circles pass through; sliders get their body judged and the overall stable result. */
  const settle = (obj: HitObject, j: Judgment, headHit: boolean): Judgment => {
    if (obj.type !== 'slider' || !obj.slider) return j;
    const checks = judgeSliderChecks(obj, frames, eff.radius);
    let hitParts = headHit ? 1 : 0;
    for (const c of checks) if (c.hit) hitParts++;
    const totalParts = checks.length + 1;
    const judgment = sliderJudgmentKind(hitParts, totalParts);
    let brk: SliderBreak | null = null;
    if (judgment !== 'MISS') {
      if (!headHit) brk = { time: obj.time, x: obj.x, y: obj.y, reason: MISS_REASON.sliderHead(j.missReason) };
      else {
        const c = checks.find((x) => !x.hit && x.kind !== 'tail');
        if (c) brk = { time: c.time, x: c.x, y: c.y, reason: c.reason };
      }
    }
    return {
      ...j,
      judgment,
      missReason: judgment === 'MISS' ? j.missReason : '',
      slider: { headHit, checks, hitParts, totalParts, break: brk },
    };
  };

  for (const obj of objects) {
    if (obj.type === 'spinner') {
      const cur = cursorPositionAt(frames, obj.time) ?? { x: obj.x, y: obj.y };
      results[obj.index] = {
        noteIndex: obj.index, noteTime: obj.time, noteX: obj.x, noteY: obj.y, objectType: obj.type,
        judgment: 'SKIP', pressed: false, hitTime: null, hitX: cur.x, hitY: cur.y, timeError: null,
        radialOffset: 0, longitudinalOffset: null, lateralOffset: null, isOveraim: false, isUnderaim: false,
        keyUsed: null, missReason: '', slider: null,
      };
    } else queue.push({ obj, lastOutsideDistance: null });
  }

  const finishHit = (p: Pending, press: KeyPress, kind: JudgmentKind, reason: string) => {
    const { origin, target } = base(p.obj);
    const aim = decomposeAim(origin, target, { x: press.x, y: press.y });
    results[p.obj.index] = settle(p.obj, {
      noteIndex: p.obj.index, noteTime: p.obj.time, noteX: p.obj.x, noteY: p.obj.y, objectType: p.obj.type,
      judgment: kind, pressed: true, hitTime: press.time, hitX: press.x, hitY: press.y,
      timeError: press.time - p.obj.time, ...aim, keyUsed: press.key, missReason: reason, slider: null,
    }, kind !== 'MISS');
  };

  const finishTimeout = (p: Pending) => {
    const { origin, target } = base(p.obj);
    const cur = cursorPositionAt(frames, p.obj.time) ?? target;
    const dist = Math.hypot(cur.x - target.x, cur.y - target.y);
    let reason: string;
    if (p.lastOutsideDistance !== null) reason = MISS_REASON.aimOut(p.lastOutsideDistance);
    else reason = dist <= eff.radius ? MISS_REASON.cursorOnButNoTap : MISS_REASON.cursorOffAndNoTap;
    results[p.obj.index] = settle(p.obj, {
      noteIndex: p.obj.index, noteTime: p.obj.time, noteX: p.obj.x, noteY: p.obj.y, objectType: p.obj.type,
      judgment: 'MISS', pressed: false, hitTime: null, hitX: cur.x, hitY: cur.y, timeError: null,
      ...decomposeAim(origin, target, cur), keyUsed: null, missReason: reason, slider: null,
    }, false);
  };

  let head = 0;
  for (const press of presses) {
    while (head < queue.length && press.time > queue[head].obj.time + eff.hw50) finishTimeout(queue[head++]);
    if (head >= queue.length) break;
    const p = queue[head];
    const err = press.time - p.obj.time;
    if (err < -eff.earlyMissWindow) continue;
    const dist = Math.hypot(press.x - p.obj.x, press.y - p.obj.y);
    if (dist > eff.radius) {
      if (Math.abs(err) <= eff.hw50) p.lastOutsideDistance = dist;
      continue;
    }
    const kind = judgmentFor(Math.abs(err), eff);
    if (kind) finishHit(p, press, kind, '');
    else finishHit(p, press, 'MISS', MISS_REASON.early);
    head++;
  }
  while (head < queue.length) finishTimeout(queue[head++]);

  return results as Judgment[];
}

export function countSimulated(judgments: Judgment[]): SimulatedCounts {
  const c: SimulatedCounts = { c300: 0, c100: 0, c50: 0, cMiss: 0, sliderBreaks: 0 };
  for (const j of judgments) {
    if (j.judgment === '300') c.c300++;
    else if (j.judgment === '100') c.c100++;
    else if (j.judgment === '50') c.c50++;
    else if (j.judgment === 'MISS') c.cMiss++;
    if (j.slider?.break) c.sliderBreaks++;
  }
  return c;
}

export function analyzeReplay(beatmap: Beatmap, frames: Frame[], mods: number): ReplayAnalysis {
  const effective = effectiveDifficulty(beatmap, mods);
  const keyPresses = extractKeyPresses(frames);
  const judgments = judgeReplay(beatmap, frames, keyPresses, effective);
  return { effective, keyPresses, judgments, simulated: countSimulated(judgments) };
}

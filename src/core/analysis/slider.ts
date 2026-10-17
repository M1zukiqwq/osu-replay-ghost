import { objectPositionAt } from '../formats/osu';
import { lowerBoundFrames, sampleCursor } from '../replay/frames';
import type { Frame, HitObject, JudgmentKind, SliderCheck, SliderCheckKind, SliderDropCause, Vec2 } from '../types';

/** Follow circle radius while tracking, as a multiple of the circle radius (picking the ball up needs 1×). */
export const FOLLOW_RADIUS_SCALE = 2.4;
/** stable checks the slider end this long before the visual end (but never before the slider's midpoint). */
export const LEGACY_TAIL_OFFSET_MS = 36;
/** osu! stops generating ticks on absurdly long paths. */
const MAX_TICK_PATH_LENGTH = 100000;
/** Guards pathological tick rates; real maps stay far below this. */
const MAX_CHECKS_PER_SLIDER = 2048;

export interface SliderCheckpoint { kind: SliderCheckKind; ordinal: number; time: number; pos: Vec2 }

/**
 * Ticks, repeats and the legacy tail check of a slider, sorted by time. Mirrors osu!'s SliderEventGenerator:
 * ticks are placed from the path start every `tickDistance`, none closer than 10 ms of travel to a span end,
 * and the same path positions are reused on reversed spans.
 */
export function sliderCheckpoints(obj: HitObject): SliderCheckpoint[] {
  const s = obj.slider;
  if (!s) return [];
  const total = s.cumulative[s.cumulative.length - 1];
  const length = Math.min(MAX_TICK_PATH_LENGTH, s.length > 0 ? s.length : total);
  const span = s.spanDuration;
  const out: SliderCheckpoint[] = [];
  const at = (time: number) => objectPositionAt(obj, time);
  const tickDistance = Math.min(Math.max(s.tickDistance, 0), length);

  if (tickDistance > 0 && span > 0) {
    const minDistanceFromEnd = (length / span) * 10;
    let ticks = 0;
    let repeats = 0;
    for (let i = 0; i < s.slides && out.length < MAX_CHECKS_PER_SLIDER; i++) {
      const spanStart = obj.time + i * span;
      const reversed = i % 2 === 1;
      const spanTicks: number[] = [];
      for (let d = tickDistance; d <= length && spanTicks.length < MAX_CHECKS_PER_SLIDER; d += tickDistance) {
        if (d >= length - minDistanceFromEnd) break;
        const p = d / length;
        spanTicks.push(spanStart + (reversed ? 1 - p : p) * span);
      }
      if (reversed) spanTicks.reverse();
      for (const time of spanTicks) out.push({ kind: 'tick', ordinal: ++ticks, time, pos: at(time) });
      if (i < s.slides - 1) {
        const time = spanStart + span;
        out.push({ kind: 'repeat', ordinal: ++repeats, time, pos: at(time) });
      }
    }
  }

  const duration = s.slides * span;
  const tailTime = Math.max(obj.time + duration / 2, obj.time + duration - LEGACY_TAIL_OFFSET_MS);
  out.push({ kind: 'tail', ordinal: 1, time: tailTime, pos: at(tailTime) });
  // The early tail check can precede a last tick that sits within 36 ms of the end.
  return out.sort((a, b) => a.time - b.time);
}

export function checkLabel(kind: SliderCheckKind, ordinal: number): string {
  if (kind === 'tick') return `第 ${ordinal} 个 tick`;
  if (kind === 'repeat') return `第 ${ordinal} 次折返`;
  return '滑条尾';
}

const px = (v: number) => `${v.toFixed(1)} px`;

/**
 * Simulates the follow circle over the slider body and judges every checkpoint (stable rules):
 * tracking can start from the slider's start time when a key is held and the cursor is within the circle
 * radius, and continues while a key stays held and the cursor stays within 2.4 × radius of the ball.
 * The state is updated at every replay frame and at each checkpoint (position interpolated, keys from
 * the last frame, as in sampleCursor). O(frames in the slider + checkpoints).
 */
export function judgeSliderChecks(obj: HitObject, frames: Frame[], radius: number): SliderCheck[] {
  const points = sliderCheckpoints(obj);
  const follow = radius * FOLLOW_RADIUS_SCALE;
  let tracking = false;

  const step = (t: number) => {
    const cur = sampleCursor(frames, t);
    const ball = objectPositionAt(obj, t);
    const held = !!cur && (cur.k1 || cur.k2);
    const dist = cur ? Math.hypot(cur.x - ball.x, cur.y - ball.y) : Infinity;
    const wasTracking = tracking;
    tracking = held && dist <= (wasTracking ? follow : radius);
    return { cur, held, dist, wasTracking };
  };

  step(obj.time);
  let fi = lowerBoundFrames(frames, obj.time);
  const checks: SliderCheck[] = [];
  for (const p of points) {
    while (fi < frames.length && frames[fi].time < p.time) step(frames[fi++].time);
    const s = step(p.time);
    let cause: SliderDropCause | null = null;
    let reason = '';
    if (!tracking) {
      const label = checkLabel(p.kind, p.ordinal);
      if (!s.cur) {
        cause = 'noCursor';
        reason = `${label}：没有光标数据`;
      } else if (!s.held) {
        cause = 'released';
        reason = `${label}：没有按住按键（松键过早）`;
      } else if (s.dist > follow) {
        cause = 'outside';
        reason = `${label}：光标脱离跟随圈（距滑条球 ${px(s.dist)}，跟随圈半径 ${px(follow)}）`;
      } else {
        cause = 'lost';
        reason = `${label}：光标没有重新跟上滑条球（距 ${px(s.dist)}，需回到 ${px(radius)} 以内）`;
      }
    }
    checks.push({
      kind: p.kind, ordinal: p.ordinal, time: p.time, x: p.pos.x, y: p.pos.y,
      cursorX: s.cur?.x ?? p.pos.x, cursorY: s.cur?.y ?? p.pos.y, hit: tracking, cause, reason,
    });
  }
  return checks;
}

/** stable's slider result: every part hit = 300, at least half = 100, any = 50, none = miss. */
export function sliderJudgmentKind(hitParts: number, totalParts: number): JudgmentKind {
  if (hitParts >= totalParts) return '300';
  if (hitParts === 0) return 'MISS';
  return hitParts / totalParts >= 0.5 ? '100' : '50';
}

import type { Frame, RawFrame, Vec2 } from '../types';
import { MOD } from './mods';

export const PLAYFIELD_W = 512;
export const PLAYFIELD_H = 384;
export const K1_MASK = 5;
export const K2_MASK = 10;

/**
 * Converts raw .osr frames into timed frames in beatmap coordinates:
 * accumulates w, drops stable's two (256,-500) placeholder frames and negative-delta frames,
 * keeps time monotonic, flips y for HR, and computes velocity (px/ms).
 */
export function buildFrames(raw: RawFrame[], mods: number): Frame[] {
  const flip = (mods & MOD.HR) !== 0;
  const frames: Frame[] = [];
  let time = 0;
  let lastTime = -Infinity;
  let velocity = 0;
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    time += r.w;
    if (i < 2 && r.x === 256 && r.y === -500) continue;
    if (r.w < 0 || time < 0 || time < lastTime) continue;
    const y = flip ? PLAYFIELD_H - r.y : r.y;
    const prev = frames[frames.length - 1];
    if (prev) {
      const dt = time - prev.time;
      if (dt > 0) velocity = Math.hypot(r.x - prev.x, y - prev.y) / dt;
    }
    frames.push({ time, x: r.x, y, keys: r.z, k1: (r.z & K1_MASK) !== 0, k2: (r.z & K2_MASK) !== 0, velocity });
    lastTime = time;
  }
  return frames;
}

/** Inverse of buildFrames (used for export): frames → raw w|x|y|z in screen coordinates. */
export function framesToRaw(frames: Frame[], mods: number, withPlaceholders = true): RawFrame[] {
  const flip = (mods & MOD.HR) !== 0;
  const out: RawFrame[] = [];
  let prevTime = 0;
  if (withPlaceholders) {
    out.push({ w: 0, x: 256, y: -500, z: 0 }, { w: -1, x: 256, y: -500, z: 0 });
    prevTime = -1;
  }
  for (const f of frames) {
    out.push({ w: f.time - prevTime, x: f.x, y: flip ? PLAYFIELD_H - f.y : f.y, z: f.keys });
    prevTime = f.time;
  }
  return out;
}

/** Index of the last frame with time <= t, or -1. */
export function frameIndexAt(frames: Frame[], t: number): number {
  let lo = 0;
  let hi = frames.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].time <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** First index with frames[i].time >= t. */
export function lowerBoundFrames(frames: Frame[], t: number): number {
  let lo = 0;
  let hi = frames.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].time < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface CursorSample extends Vec2 { k1: boolean; k2: boolean; velocity: number; frameIndex: number }

/**
 * Cursor state at time t: position is interpolated linearly between f0 and f1,
 * keys are a step function taken from f0, frameIndex is f0's index.
 */
export function sampleCursor(frames: Frame[], t: number): CursorSample | null {
  if (frames.length === 0) return null;
  const i0 = frameIndexAt(frames, t);
  if (i0 < 0) {
    const f = frames[0];
    return { x: f.x, y: f.y, k1: false, k2: false, velocity: 0, frameIndex: 0 };
  }
  const f0 = frames[i0];
  const f1 = frames[i0 + 1];
  if (!f1 || f0.time === t) return { x: f0.x, y: f0.y, k1: f0.k1, k2: f0.k2, velocity: f0.velocity, frameIndex: i0 };
  const span = f1.time - f0.time;
  const w = span > 0 ? (t - f0.time) / span : 0;
  return {
    x: f0.x + (f1.x - f0.x) * w,
    y: f0.y + (f1.y - f0.y) * w,
    k1: f0.k1,
    k2: f0.k2,
    velocity: f1.velocity,
    frameIndex: i0,
  };
}

export function cursorPositionAt(frames: Frame[], t: number): Vec2 | null {
  const s = sampleCursor(frames, t);
  return s ? { x: s.x, y: s.y } : null;
}

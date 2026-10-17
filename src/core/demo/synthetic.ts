import type { Beatmap, HitObject, KeyName, RawFrame, Vec2 } from '../types';
import { effectiveDifficulty } from '../beatmap/difficulty';
import { objectPositionAt } from '../formats/osu';
import { movementOrigin } from '../analysis/aim';
import { MOD } from '../replay/mods';
import { K1_MASK, K2_MASK, PLAYFIELD_H } from '../replay/frames';
import { mulberry32 } from './prng';

export interface SynthConfig {
  seed: number;
  mods: number;
  missWindows: [number, number][];
  chokeMissProb: number;
  /** Sliders starting inside these windows (and not missed) are released a third of the way in → slider break. */
  sliderBreakWindows: [number, number][];
  aimBiasLong: number;
  aimSpread: number;
  timingBias: number;
  timingSpread: number;
  baseHoldMs: number;
  altPreference: number;
  dominantKey: KeyName;
  snapExponent: number;
  arcAmplitude: number;
}

const FRAME_INTERVAL_MS = 1000 / 60;
const SPINNER_RADIUS = 50;
const SPINNER_RAD_PER_MS = 0.03;

interface Plan { obj: HitObject; tapTime: number; landing: Vec2; key: KeyName; releaseTime: number }

type Segment =
  | { kind: 'move'; t0: number; t1: number; p0: Vec2; p1: Vec2 }
  | { kind: 'hold'; t0: number; t1: number; p: Vec2 }
  | { kind: 'slider'; t0: number; t1: number; obj: HitObject; offset: Vec2 }
  | { kind: 'spinner'; t0: number; t1: number };

function spinnerPos(t: number): Vec2 {
  const a = t * SPINNER_RAD_PER_MS;
  return { x: 256 + Math.cos(a) * SPINNER_RADIUS, y: 192 + Math.sin(a) * SPINNER_RADIUS };
}

function segmentEnd(s: Segment): Vec2 {
  switch (s.kind) {
    case 'move': return s.p1;
    case 'hold': return s.p;
    case 'spinner': return spinnerPos(s.t1);
    case 'slider': {
      const p = objectPositionAt(s.obj, s.t1);
      return { x: p.x + s.offset.x, y: p.y + s.offset.y };
    }
  }
}

/**
 * Generates raw replay frames (screen coordinates, HR-flipped when HR is on, with stable's placeholder
 * frames) so synthetic data goes through exactly the same pipeline as a decoded .osr. O(frames + objects).
 */
export function generateSyntheticFrames(beatmap: Beatmap, cfg: SynthConfig): RawFrame[] {
  const objects = beatmap.hitObjects;
  if (objects.length === 0) return [];
  const eff = effectiveDifficulty(beatmap, cfg.mods);
  const rng = mulberry32(cfg.seed);
  const plans: Plan[] = [];
  let prevKey: KeyName = cfg.dominantKey === 'K1' ? 'K2' : 'K1';
  let prevTime = -Infinity;

  for (const obj of objects) {
    if (obj.type === 'spinner') {
      plans.push({ obj, tapTime: obj.time, landing: spinnerPos(obj.time), key: 'K1', releaseTime: obj.endTime });
      prevKey = 'K1';
      prevTime = obj.time;
      continue;
    }
    const rMiss = rng();
    const rLong = rng();
    const rLat = rng();
    const rTime = rng();
    const rHold = rng();
    const rKey = rng();

    const origin = movementOrigin(objects, obj.index);
    let dx = obj.x - origin.x;
    let dy = obj.y - origin.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) { dx = 1; dy = 0; } else { dx /= len; dy /= len; }

    const inChoke = cfg.missWindows.some(([a, b]) => obj.time >= a && obj.time <= b);
    const isMiss = inChoke && rMiss < cfg.chokeMissProb;
    let long = (rLong - 0.5 + cfg.aimBiasLong) * cfg.aimSpread;
    let lat = (rLat - 0.5) * cfg.aimSpread * 0.65;
    const maxHit = eff.radius * 0.85;
    const mag = Math.hypot(long, lat);
    if (mag > maxHit) { long *= maxHit / mag; lat *= maxHit / mag; }
    if (isMiss) long = (cfg.aimBiasLong >= 0 ? 1 : -1) * (eff.radius + 10 + rLong * 14);
    const landing = { x: obj.x + dx * long - dy * lat, y: obj.y + dy * long + dx * lat };

    const errLimit = eff.hw100 * 0.9;
    const err = Math.max(-errLimit, Math.min(errLimit, Math.round((rTime - 0.5) * cfg.timingSpread + cfg.timingBias)));
    const tapTime = Math.round(obj.time + err);
    const hold = Math.max(12, Math.round(cfg.baseHoldMs + (rHold - 0.5) * 16));
    const alternate = obj.time - prevTime < 145 || rKey < cfg.altPreference;
    const key: KeyName = alternate ? (prevKey === 'K1' ? 'K2' : 'K1') : cfg.dominantKey;
    let releaseTime = obj.type === 'slider' ? Math.max(tapTime + hold, Math.round(obj.endTime)) : tapTime + hold;
    const breaks = cfg.sliderBreakWindows.some(([a, b]) => obj.time >= a && obj.time <= b);
    if (obj.type === 'slider' && breaks && !isMiss) {
      releaseTime = Math.max(tapTime + hold, Math.round(obj.time + (obj.endTime - obj.time) / 3));
    }
    plans.push({ obj, tapTime, landing, key, releaseTime });
    prevKey = key;
    prevTime = obj.time;
  }

  // Same key pressed again before release: release 1 ms before the next press.
  const lastByKey: Record<KeyName, Plan | null> = { K1: null, K2: null };
  for (const p of plans) {
    const prev = lastByKey[p.key];
    if (prev && prev.releaseTime >= p.tapTime) prev.releaseTime = Math.max(prev.tapTime + 1, p.tapTime - 1);
    lastByKey[p.key] = p;
  }

  // Cursor segments.
  const segments: Segment[] = [];
  let cursor: Vec2 = { x: 256, y: 192 };
  let cursorTime = 0;
  for (const p of plans) {
    const arrive = Math.max(cursorTime, p.tapTime);
    segments.push({ kind: 'move', t0: cursorTime, t1: arrive, p0: cursor, p1: p.landing });
    if (p.obj.type === 'spinner') {
      segments.push({ kind: 'spinner', t0: arrive, t1: p.obj.endTime });
    } else if (p.obj.type === 'slider') {
      const offset = { x: (p.landing.x - p.obj.x) * 0.4, y: (p.landing.y - p.obj.y) * 0.4 };
      const start = Math.max(arrive, p.obj.time);
      segments.push({ kind: 'hold', t0: arrive, t1: start, p: p.landing });
      segments.push({ kind: 'slider', t0: start, t1: Math.max(start, p.obj.endTime), obj: p.obj, offset });
    } else {
      segments.push({ kind: 'hold', t0: arrive, t1: arrive, p: p.landing });
    }
    const last = segments[segments.length - 1];
    cursor = segmentEnd(last);
    cursorTime = last.t1;
  }

  const positionIn = (s: Segment, t: number): Vec2 => {
    switch (s.kind) {
      case 'hold': return s.p;
      case 'spinner': return spinnerPos(t);
      case 'slider': {
        const p = objectPositionAt(s.obj, t);
        return { x: p.x + s.offset.x, y: p.y + s.offset.y };
      }
      case 'move': {
        const span = s.t1 - s.t0;
        const u = span > 0 ? Math.min(1, Math.max(0, (t - s.t0) / span)) : 1;
        const ddx = s.p1.x - s.p0.x;
        const ddy = s.p1.y - s.p0.y;
        const l = Math.hypot(ddx, ddy) || 1;
        const snap = Math.pow(u, cfg.snapExponent);
        const arc = Math.sin(u * Math.PI) * cfg.arcAmplitude;
        return { x: s.p0.x + ddx * snap - (ddy / l) * arc, y: s.p0.y + ddy * snap + (ddx / l) * arc };
      }
    }
  };

  // Frame times: a ~60 fps grid merged with exact press/release times.
  const events: { time: number; key: KeyName; down: boolean }[] = [];
  for (const p of plans) {
    events.push({ time: p.tapTime, key: p.key, down: true });
    events.push({ time: p.releaseTime, key: p.key, down: false });
  }
  events.sort((a, b) => a.time - b.time || Number(a.down) - Number(b.down));
  const times: number[] = [];
  let e = 0;
  const end = beatmap.durationMs;
  for (let k = 0; ; k++) {
    const g = Math.round(k * FRAME_INTERVAL_MS);
    while (e < events.length && events[e].time <= g) {
      if (events[e].time >= 0 && (times.length === 0 || times[times.length - 1] !== events[e].time)) times.push(events[e].time);
      e++;
    }
    if (g > end) break;
    if (times.length === 0 || times[times.length - 1] !== g) times.push(g);
  }

  const flip = (cfg.mods & MOD.HR) !== 0;
  const raw: RawFrame[] = [
    { w: 0, x: 256, y: -500, z: 0 },
    { w: -1, x: 256, y: -500, z: 0 },
  ];
  const down: Record<KeyName, boolean> = { K1: false, K2: false };
  let seg = 0;
  let ev = 0;
  let prevT = -1;
  for (const t of times) {
    while (ev < events.length && events[ev].time <= t) {
      down[events[ev].key] = events[ev].down;
      ev++;
    }
    while (seg < segments.length - 1 && segments[seg].t1 < t) seg++;
    const pos = segments[seg].t1 < t ? segmentEnd(segments[seg]) : positionIn(segments[seg], t);
    const z = (down.K1 ? K1_MASK : 0) | (down.K2 ? K2_MASK : 0);
    raw.push({ w: t - prevT, x: round2(pos.x), y: round2(flip ? PLAYFIELD_H - pos.y : pos.y), z });
    prevT = t;
  }
  return raw;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

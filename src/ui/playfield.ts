import { COMBO_COLORS, getActiveGroup, getPrimaryReplay, getSelectedReplays, replayColor, state } from '../app/state';
import { FOLLOW_RADIUS_SCALE } from '../core/analysis/slider';
import { effectiveDifficulty } from '../core/beatmap/difficulty';
import { objectPositionAt } from '../core/formats/osu';
import { lowerBoundFrames, sampleCursor } from '../core/replay/frames';
import type { Beatmap, HitObject, Judgment, KeyPress } from '../core/types';
import { $ } from './dom';

export const CANVAS_W = 768;
export const CANVAS_H = 576;
const PAD_X = 76;
const PAD_Y = 58;
const SCALE = (CANVAS_W - PAD_X * 2) / 512;
const FADE_IN_MS = 400;
const FADE_OUT_MS = 260;
const MIN_ALPHA = 0.08;
const APPROACH_SCALE = 2.6;
export const TRAIL_PAST_MS = 480;
export const TRAIL_FUTURE_MS = 140;
const VECTOR_BEFORE_MS = 80;
const VECTOR_AFTER_MS = 550;
const K1_COLOR = '#22d3ee';
const K2_COLOR = '#f472b6';
const MISS_COLOR = '#f43f5e';
const BREAK_COLOR = '#fb923c';
const CHECK_LABEL = { tick: 'tick', repeat: '折返', tail: '滑条尾' } as const;
const CAUSE_LABEL = { released: '松键', outside: '出跟随圈', lost: '没跟上', noCursor: '' } as const;

const sx = (x: number) => PAD_X + x * SCALE;
const sy = (y: number) => PAD_Y + y * SCALE;

let ctx: CanvasRenderingContext2D | null = null;
let dpr = 1;

export function setupCanvas(): void {
  const canvas = $<HTMLCanvasElement>('osuPlayfieldCanvas');
  dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  canvas.width = Math.round(CANVAS_W * dpr);
  canvas.height = Math.round(CANVAS_H * dpr);
  ctx = canvas.getContext('2d');
}

interface MapCache { map: Beatmap; maxDuration: number }
let mapCache: MapCache | null = null;

function cacheFor(map: Beatmap): MapCache {
  if (mapCache?.map !== map) {
    let maxDuration = 0;
    for (const o of map.hitObjects) maxDuration = Math.max(maxDuration, o.endTime - o.time);
    mapCache = { map, maxDuration };
  }
  return mapCache;
}

function lowerBy<T>(arr: T[], t: number, key: (v: T) => number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function visibleObjects(map: Beatmap, t: number, preempt: number): HitObject[] {
  const objs = map.hitObjects;
  const { maxDuration } = cacheFor(map);
  const out: HitObject[] = [];
  const from = lowerBy(objs, t - FADE_OUT_MS - maxDuration, (o) => o.time);
  for (let i = from; i < objs.length && objs[i].time <= t + preempt; i++) {
    if (t <= objs[i].endTime + FADE_OUT_MS) out.push(objs[i]);
  }
  return out;
}

function drawBackground(c: CanvasRenderingContext2D): void {
  c.fillStyle = '#070a12';
  c.fillRect(0, 0, CANVAS_W, CANVAS_H);
  c.strokeStyle = '#1e293b';
  c.lineWidth = 1.5;
  c.strokeRect(PAD_X, PAD_Y, 512 * SCALE, 384 * SCALE);
  c.strokeStyle = 'rgba(51, 65, 85, 0.35)';
  c.setLineDash([4, 4]);
  c.beginPath();
  c.moveTo(sx(256), PAD_Y);
  c.lineTo(sx(256), CANVAS_H - PAD_Y);
  c.moveTo(PAD_X, sy(192));
  c.lineTo(CANVAS_W - PAD_X, sy(192));
  c.stroke();
  c.setLineDash([]);
}

function tracePath(c: CanvasRenderingContext2D, o: HitObject): void {
  const path = o.slider!.path;
  c.beginPath();
  c.moveTo(sx(path[0].x), sy(path[0].y));
  for (let i = 1; i < path.length; i++) c.lineTo(sx(path[i].x), sy(path[i].y));
}

function drawObjects(c: CanvasRenderingContext2D, visible: HitObject[], t: number, radius: number, preempt: number): void {
  for (let i = 1; i < visible.length; i++) {
    const prev = visible[i - 1];
    const cur = visible[i];
    if (cur.newCombo || cur.type === 'spinner' || prev.type === 'spinner' || cur.comboNumber === 1) continue;
    const from = prev.slider ? { x: prev.slider.endX, y: prev.slider.endY } : prev;
    c.strokeStyle = 'rgba(148, 163, 184, 0.28)';
    c.lineWidth = 2;
    c.setLineDash([5, 5]);
    c.beginPath();
    c.moveTo(sx(from.x), sy(from.y));
    c.lineTo(sx(cur.x), sy(cur.y));
    c.stroke();
    c.setLineDash([]);
  }

  const r = radius * SCALE;
  for (let i = visible.length - 1; i >= 0; i--) {
    const o = visible[i];
    const color = COMBO_COLORS[o.comboColorIdx % COMBO_COLORS.length];
    let alpha = 1;
    if (t < o.time) alpha = Math.min(1, (t - (o.time - preempt)) / FADE_IN_MS);
    else if (t > o.endTime) alpha = 1 - (t - o.endTime) / FADE_OUT_MS;
    c.save();
    c.globalAlpha = Math.max(MIN_ALPHA, alpha);

    if (o.type === 'spinner') {
      c.strokeStyle = color;
      c.lineWidth = 3;
      c.beginPath();
      c.arc(sx(256), sy(192), 150 * SCALE, 0, Math.PI * 2);
      c.stroke();
      if (t >= o.time && t <= o.endTime) {
        const remain = 1 - (t - o.time) / Math.max(1, o.endTime - o.time);
        c.strokeStyle = '#f8fafc';
        c.lineWidth = 2;
        c.beginPath();
        c.arc(sx(256), sy(192), 150 * SCALE * remain, 0, Math.PI * 2);
        c.stroke();
      }
      c.fillStyle = '#ffffff';
      c.font = 'bold 13px "JetBrains Mono", monospace';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText('SPINNER', sx(256), sy(192));
      c.restore();
      continue;
    }

    if (o.slider) {
      c.lineCap = 'round';
      c.lineJoin = 'round';
      tracePath(c, o);
      c.strokeStyle = color;
      c.lineWidth = r * 1.92;
      c.stroke();
      c.strokeStyle = '#0f172a';
      c.lineWidth = r * 1.68;
      c.stroke();
      const tail = o.slider.path[o.slider.path.length - 1];
      c.beginPath();
      c.arc(sx(tail.x), sy(tail.y), r * 0.85, 0, Math.PI * 2);
      c.strokeStyle = color;
      c.lineWidth = 2;
      c.stroke();
      if (t >= o.time && t <= o.endTime) {
        const ball = objectPositionAt(o, t);
        c.beginPath();
        c.arc(sx(ball.x), sy(ball.y), r * 0.9, 0, Math.PI * 2);
        c.strokeStyle = '#f8fafc';
        c.lineWidth = 3;
        c.stroke();
      }
    }

    const cx = sx(o.x);
    const cy = sy(o.y);
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.fillStyle = color + '44';
    c.fill();
    c.lineWidth = 3.5;
    c.strokeStyle = '#f8fafc';
    c.stroke();
    c.fillStyle = '#ffffff';
    c.font = 'bold 16px "JetBrains Mono", monospace';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(String(o.comboNumber), cx, cy);
    if (t <= o.time) {
      const remain = Math.max(0, (o.time - t) / preempt);
      c.beginPath();
      c.arc(cx, cy, r * (1 + remain * APPROACH_SCALE), 0, Math.PI * 2);
      c.strokeStyle = color;
      c.lineWidth = 2.2;
      c.stroke();
    }
    c.restore();
  }
}

function drawVectors(c: CanvasRenderingContext2D, judgments: Judgment[], t: number): void {
  const from = lowerBy(judgments, t - VECTOR_AFTER_MS, (j) => j.noteTime);
  c.textBaseline = 'alphabetic';
  for (let i = from; i < judgments.length && judgments[i].noteTime <= t + VECTOR_BEFORE_MS; i++) {
    const j = judgments[i];
    if (j.judgment === 'SKIP') continue;
    const miss = j.judgment === 'MISS';
    const headBreak = !miss && j.slider !== null && !j.slider.headHit;
    const color = miss ? MISS_COLOR : headBreak ? BREAK_COLOR : '#fbbf24';
    const nx = sx(j.noteX);
    const ny = sy(j.noteY);
    const hx = sx(j.hitX);
    const hy = sy(j.hitY);
    c.strokeStyle = color;
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(nx, ny);
    c.lineTo(hx, hy);
    c.stroke();
    c.fillStyle = color;
    c.beginPath();
    c.arc(hx, hy, 4.5, 0, Math.PI * 2);
    c.fill();
    c.font = 'bold 12px "JetBrains Mono", monospace';
    c.textAlign = 'center';
    if (miss) {
      c.fillStyle = MISS_COLOR;
      c.fillText('✕ MISS', hx, hy - 12);
    } else if (headBreak) {
      c.fillText('✕ 断连 · 滑条头', hx, hy - 12);
    } else {
      c.fillStyle = j.judgment === '300' ? K1_COLOR : '#fbbf24';
      const err = j.timeError ?? 0;
      const parts = j.slider && j.slider.hitParts < j.slider.totalParts ? ` ${j.slider.hitParts}/${j.slider.totalParts}` : '';
      c.fillText(`${j.judgment} (${err >= 0 ? '+' : ''}${Math.round(err)}ms)${parts}`, hx, hy - 12);
    }
  }
}

/**
 * Dropped slider checks around t, drawn above the cursors: ✕ at the ball, a dashed line to where the cursor
 * was, and at the combo break the follow circle plus a label with the cause.
 */
function drawSliderChecks(c: CanvasRenderingContext2D, judgments: Judgment[], t: number, maxDuration: number, radius: number): void {
  const from = lowerBy(judgments, t - VECTOR_AFTER_MS - maxDuration, (j) => j.noteTime);
  const follow = radius * FOLLOW_RADIUS_SCALE * SCALE;
  c.save();
  c.textBaseline = 'middle';
  c.textAlign = 'center';
  for (let i = from; i < judgments.length && judgments[i].noteTime <= t + VECTOR_BEFORE_MS; i++) {
    const s = judgments[i].slider;
    if (!s || judgments[i].judgment === 'MISS') continue;
    for (const k of s.checks) {
      if (k.hit || k.time < t - VECTOR_AFTER_MS || k.time > t + VECTOR_BEFORE_MS) continue;
      const isBreak = s.break !== null && s.break.time === k.time;
      const bx = sx(k.x);
      const by = sy(k.y);
      c.strokeStyle = BREAK_COLOR;
      if (isBreak) {
        c.globalAlpha = 0.55;
        c.lineWidth = 1.5;
        c.setLineDash([4, 4]);
        c.beginPath();
        c.arc(bx, by, follow, 0, Math.PI * 2);
        c.stroke();
        c.globalAlpha = 1;
      }
      c.lineWidth = 1.5;
      c.setLineDash([3, 3]);
      c.beginPath();
      c.moveTo(bx, by);
      c.lineTo(sx(k.cursorX), sy(k.cursorY));
      c.stroke();
      c.setLineDash([]);
      c.lineWidth = 2.5;
      c.beginPath();
      c.moveTo(bx - 5, by - 5);
      c.lineTo(bx + 5, by + 5);
      c.moveTo(bx + 5, by - 5);
      c.lineTo(bx - 5, by + 5);
      c.stroke();

      // Later drops on a broken slider usually follow from the break; only the break (or a lone tail) is labelled.
      if (!isBreak && s.break !== null) continue;
      const cause = k.cause ? CAUSE_LABEL[k.cause] : '';
      const text = `${isBreak ? '✕ 断连' : '漏'} · ${CHECK_LABEL[k.kind]}${cause ? `（${cause}）` : ''}`;
      c.font = `${isBreak ? 'bold ' : ''}11px "JetBrains Mono", monospace`;
      const w = c.measureText(text).width + 10;
      const ly = by - radius * SCALE - 14;
      c.fillStyle = 'rgba(7, 10, 18, 0.85)';
      c.fillRect(bx - w / 2, ly - 8, w, 16);
      c.fillStyle = BREAK_COLOR;
      c.fillText(text, bx, ly);
    }
  }
  c.restore();
}

function drawPresses(c: CanvasRenderingContext2D, presses: KeyPress[], t: number, isPri: boolean): void {
  const from = lowerBy(presses, t - TRAIL_PAST_MS, (p) => p.time);
  for (let i = from; i < presses.length && presses[i].time <= t + TRAIL_FUTURE_MS; i++) {
    const kp = presses[i];
    const color = kp.key === 'K1' ? K1_COLOR : K2_COLOR;
    const active = t >= kp.time && (kp.endTime === null || t < kp.endTime);
    c.save();
    c.globalAlpha = isPri ? 0.98 : 0.72;
    c.fillStyle = color;
    c.strokeStyle = '#090d16';
    c.lineWidth = 1.5;
    c.beginPath();
    c.arc(sx(kp.x), sy(kp.y), active ? 7.5 : 5, 0, Math.PI * 2);
    c.fill();
    c.stroke();
    if (isPri || active) {
      c.font = 'bold 10px "JetBrains Mono", monospace';
      c.textAlign = 'left';
      c.fillText(kp.key, sx(kp.x) + 8, sy(kp.y) - 4);
    }
    c.restore();
  }
}

export function renderPlayfield(): void {
  if (!ctx) return;
  const c = ctx;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawBackground(c);
  const g = getActiveGroup();
  if (!g) return;
  const map = g.beatmap;
  const selected = getSelectedReplays();
  const primary = getPrimaryReplay();
  const t = state.currentTimeMs;
  const eff = primary ? primary.analysis.effective : effectiveDifficulty(map, 0);

  drawObjects(c, visibleObjects(map, t, eff.preempt), t, eff.radius, eff.preempt);
  if (state.showAimVectors && primary) drawVectors(c, primary.analysis.judgments, t);

  for (const rep of selected) {
    const isPri = rep.id === primary?.id;
    const color = replayColor(rep);
    if (state.showGhostTrails || isPri) {
      const frames = rep.frames;
      const from = lowerBoundFrames(frames, t - TRAIL_PAST_MS);
      const to = lowerBoundFrames(frames, t + TRAIL_FUTURE_MS + 1e-6);
      if (to - from > 1) {
        c.save();
        c.lineWidth = isPri ? 3.2 : 2;
        c.strokeStyle = color;
        c.globalAlpha = isPri ? 0.92 : 0.58;
        if (!isPri) c.setLineDash([6, 4]);
        c.beginPath();
        c.moveTo(sx(frames[from].x), sy(frames[from].y));
        for (let i = from + 1; i < to; i++) c.lineTo(sx(frames[i].x), sy(frames[i].y));
        c.stroke();
        c.restore();
      }
    }
    if (state.showKeyMarkers) drawPresses(c, rep.analysis.keyPresses, t, isPri);

    const cur = sampleCursor(rep.frames, t);
    if (!cur) continue;
    const cx = sx(cur.x);
    const cy = sy(cur.y);
    c.save();
    if (cur.k1 || cur.k2) {
      c.beginPath();
      c.arc(cx, cy, isPri ? 18 : 14, 0, Math.PI * 2);
      c.strokeStyle = cur.k1 ? K1_COLOR : K2_COLOR;
      c.lineWidth = 2.5;
      c.stroke();
    }
    c.beginPath();
    c.arc(cx, cy, isPri ? 10 : 7.5, 0, Math.PI * 2);
    c.fillStyle = color;
    c.fill();
    c.lineWidth = 2.2;
    c.strokeStyle = '#ffffff';
    c.stroke();
    c.font = isPri ? 'bold 11px Inter, sans-serif' : '10px Inter, sans-serif';
    c.fillStyle = color;
    c.textAlign = 'left';
    c.textBaseline = 'alphabetic';
    c.fillText(rep.playerName.replace(/^LocalPlayer /, ''), cx + 13, cy + 4);
    c.restore();
  }
  if (state.showAimVectors && primary) drawSliderChecks(c, primary.analysis.judgments, t, cacheFor(map).maxDuration, eff.radius);
}

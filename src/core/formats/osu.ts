import { md5Bytes } from '../binary/md5';
import { computeSliderPath, positionAtDistance, sliderProgressAt } from '../beatmap/sliderPath';
import { TimingLookup, spanDurationFor } from '../beatmap/timing';
import type { Beatmap, CurveType, DataSource, HitObject, TimingPoint, Vec2 } from '../types';

export const COMBO_COLOR_COUNT = 4;
export const MIN_DURATION_MS = 10000;
export const TAIL_PADDING_MS = 1500;

export class OsuParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OsuParseError';
  }
}

const num = (s: string | undefined, fallback: number): number => {
  if (s === undefined) return fallback;
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : fallback;
};

const positiveId = (s: string | undefined): number | null => {
  if (!s) return null;
  const v = parseInt(s, 10);
  return Number.isFinite(v) && v > 0 ? v : null;
};

interface RawObject {
  x: number;
  y: number;
  time: number;
  typeBits: number;
  parts: string[];
}

export function durationFromObjects(objects: HitObject[]): number {
  let lastEnd = -Infinity;
  for (const o of objects) lastEnd = Math.max(lastEnd, o.endTime);
  return objects.length ? Math.max(lastEnd + TAIL_PADDING_MS, MIN_DURATION_MS) : MIN_DURATION_MS;
}

export function parseCurve(token: string, head: Vec2): { type: CurveType; points: Vec2[] } {
  const items = token.split('|');
  let type: CurveType = 'B';
  const points: Vec2[] = [head];
  for (const item of items) {
    const t = item.trim();
    if (!t) continue;
    if (/^[A-Za-z]$/.test(t)) {
      const c = t.toUpperCase();
      if (points.length === 1 && (c === 'L' || c === 'P' || c === 'B' || c === 'C')) type = c;
      continue;
    }
    const [xs, ys] = t.split(':');
    const x = parseFloat(xs);
    const y = parseFloat(ys);
    if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y });
  }
  return { type, points };
}

/** Builds fully-resolved hit objects (slider paths, end positions, combo numbers). */
export function buildHitObjects(
  raw: RawObject[],
  timing: TimingLookup,
  sliderMultiplier: number,
): HitObject[] {
  const objects: HitObject[] = [];
  let comboNumber = 1;
  let comboColorIdx = 0;
  let prevType: HitObject['type'] | null = null;

  for (const r of raw) {
    const isSlider = (r.typeBits & 2) !== 0;
    const isSpinner = (r.typeBits & 8) !== 0;
    const type: HitObject['type'] = isSpinner ? 'spinner' : isSlider ? 'slider' : 'circle';
    const comboSkip = (r.typeBits >> 4) & 7;
    const newCombo = (r.typeBits & 4) !== 0 || objects.length === 0 || prevType === 'spinner';

    if (newCombo && objects.length > 0) {
      comboNumber = 1;
      comboColorIdx = (comboColorIdx + 1 + comboSkip) % COMBO_COLOR_COUNT;
    }

    const obj: HitObject = {
      index: objects.length,
      type,
      x: r.x,
      y: r.y,
      time: r.time,
      endTime: r.time,
      newCombo: (r.typeBits & 4) !== 0,
      comboSkip,
      comboNumber: comboNumber++,
      comboColorIdx,
    };

    if (isSpinner) {
      obj.x = 256;
      obj.y = 192;
      obj.endTime = Math.max(r.time, num(r.parts[5], r.time));
    } else if (isSlider) {
      const curve = parseCurve(r.parts[5] ?? '', { x: r.x, y: r.y });
      const slides = Math.max(1, Math.round(num(r.parts[6], 1)));
      const length = Math.max(0, num(r.parts[7], 0));
      const { path, cumulative } = computeSliderPath(curve.type, curve.points, length);
      const spanDuration = spanDurationFor(length, sliderMultiplier, timing.at(r.time));
      const endProgress = sliderProgressAt(r.time + spanDuration * slides, r.time, spanDuration, slides);
      const total = cumulative[cumulative.length - 1];
      const end = positionAtDistance(path, cumulative, endProgress * total);
      obj.endTime = r.time + spanDuration * slides;
      obj.slider = {
        curveType: curve.type,
        controlPoints: curve.points,
        slides,
        length,
        spanDuration,
        path,
        cumulative,
        endX: end.x,
        endY: end.y,
      };
    }
    objects.push(obj);
    prevType = type;
  }
  return objects;
}

export interface ParseOsuOptions { fileName?: string; source?: DataSource; modifiedAt?: number | null }

export function parseOsu(bytes: Uint8Array, opts: ParseOsuOptions = {}): Beatmap {
  const md5 = md5Bytes(bytes);
  let text = new TextDecoder('utf-8').decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!/^\s*osu file format v\d+/.test(text)) {
    throw new OsuParseError('不是有效的 .osu 文件（缺少 “osu file format” 文件头）');
  }

  const general: Record<string, string> = {};
  const metadata: Record<string, string> = {};
  const difficulty: Record<string, string> = {};
  const timingPoints: TimingPoint[] = [];
  const rawObjects: RawObject[] = [];
  let section = '';

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1);
      continue;
    }
    if (section === 'General' || section === 'Metadata' || section === 'Difficulty') {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      (section === 'General' ? general : section === 'Metadata' ? metadata : difficulty)[key] = val;
    } else if (section === 'TimingPoints') {
      const p = line.split(',');
      if (p.length < 2) continue;
      const time = parseFloat(p[0]);
      const beatLength = parseFloat(p[1]);
      if (!Number.isFinite(time)) continue;
      const uninherited = p.length >= 7 && p[6].trim() !== '' ? p[6].trim() === '1' : beatLength > 0;
      timingPoints.push({ time, beatLength, uninherited });
    } else if (section === 'HitObjects') {
      const p = line.split(',');
      if (p.length < 4) continue;
      const x = parseFloat(p[0]);
      const y = parseFloat(p[1]);
      const time = parseFloat(p[2]);
      const typeBits = parseInt(p[3], 10);
      if (![x, y, time, typeBits].every(Number.isFinite)) continue;
      if (typeBits & 128) continue; // mania hold note
      rawObjects.push({ x, y, time, typeBits, parts: p });
    }
  }

  timingPoints.sort((a, b) => a.time - b.time); // Array#sort is stable: file order kept for ties
  rawObjects.sort((a, b) => a.time - b.time);

  const od = num(difficulty.OverallDifficulty, 5);
  const sliderMultiplier = num(difficulty.SliderMultiplier, 1.4) || 1.4;
  const timing = new TimingLookup(timingPoints);
  const hitObjects = buildHitObjects(rawObjects, timing, sliderMultiplier);
  const firstRed = timingPoints.find((t) => t.uninherited && t.beatLength > 0);

  const title = metadata.Title ?? '';
  const artist = metadata.Artist ?? '';
  return {
    md5,
    fileName: opts.fileName ?? '',
    beatmapId: positiveId(metadata.BeatmapID),
    beatmapSetId: positiveId(metadata.BeatmapSetID),
    title,
    titleUnicode: metadata.TitleUnicode ?? '',
    artist,
    artistUnicode: metadata.ArtistUnicode ?? '',
    creator: metadata.Creator ?? '',
    version: metadata.Version ?? '',
    mode: Math.round(num(general.Mode, 0)),
    hp: num(difficulty.HPDrainRate, 5),
    cs: num(difficulty.CircleSize, 5),
    od,
    ar: num(difficulty.ApproachRate, od),
    sliderMultiplier,
    sliderTickRate: num(difficulty.SliderTickRate, 1),
    stackLeniency: num(general.StackLeniency, 0.7),
    bpm: firstRed ? 60000 / firstRed.beatLength : null,
    timingPoints,
    hitObjects,
    durationMs: durationFromObjects(hitObjects),
    source: opts.source ?? 'file',
    modifiedAt: opts.modifiedAt ?? null,
  };
}

/** Position of a slider ball (or object head) at a time, in beatmap coordinates. */
export function objectPositionAt(obj: HitObject, time: number): Vec2 {
  const s = obj.slider;
  if (!s) return { x: obj.x, y: obj.y };
  const progress = sliderProgressAt(time, obj.time, s.spanDuration, s.slides);
  return positionAtDistance(s.path, s.cumulative, progress * s.cumulative[s.cumulative.length - 1]);
}

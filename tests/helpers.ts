import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseOsu } from '../src/core/formats/osu';
import { buildFrames } from '../src/core/replay/frames';
import type { Beatmap, Frame } from '../src/core/types';

export const fixture = (name: string) => new Uint8Array(readFileSync(join(__dirname, 'fixtures', name)));

export function fixtureFile(name: string): File {
  return new File([fixture(name) as BlobPart], name);
}

interface MapOpts {
  cs?: number;
  od?: number;
  ar?: number;
  sm?: number;
  timing?: string[];
  objects: string[];
  title?: string;
  beatmapId?: string;
}

/** Builds .osu text with sensible defaults; objects are raw [HitObjects] lines. */
export function osuText(o: MapOpts): string {
  return [
    'osu file format v14', '', '[General]', 'Mode: 0', '', '[Metadata]',
    `Title:${o.title ?? 'T'}`, 'Artist:A', 'Creator:C', 'Version:V', `BeatmapID:${o.beatmapId ?? '0'}`, '',
    '[Difficulty]', 'HPDrainRate:5', `CircleSize:${o.cs ?? 4}`, `OverallDifficulty:${o.od ?? 8}`, `ApproachRate:${o.ar ?? 9}`,
    `SliderMultiplier:${o.sm ?? 1.4}`, 'SliderTickRate:1', '',
    '[TimingPoints]', ...(o.timing ?? ['0,500,4,1,0,100,1,0']), '',
    '[HitObjects]', ...o.objects, '',
  ].join('\n');
}

export function map(o: MapOpts): Beatmap {
  return parseOsu(new TextEncoder().encode(osuText(o)));
}

/** Frames from (time, x, y, keys) tuples, in beatmap coordinates (no placeholders, NM). */
export function frames(list: [number, number, number, number][]): Frame[] {
  let prev = 0;
  return buildFrames(
    list.map(([t, x, y, z]) => {
      const w = t - prev;
      prev = t;
      return { w, x, y, z };
    }),
    0,
  );
}

import { describe, expect, it } from 'vitest';
import { parseOsu, objectPositionAt } from '../src/core/formats/osu';
import { computeSliderPath, positionAtDistance } from '../src/core/beatmap/sliderPath';
import { TimingLookup, lengthForSpanDuration, spanDurationFor } from '../src/core/beatmap/timing';
import { effectiveDifficulty } from '../src/core/beatmap/difficulty';
import { MOD } from '../src/core/replay/mods';
import type { HitObject } from '../src/core/types';
import { fixture, map } from './helpers';

const sliderEnd = (o: HitObject) => ({ x: o.slider!.endX, y: o.slider!.endY });
const near = (a: { x: number; y: number }, b: { x: number; y: number }, eps = 0.01) =>
  expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(eps);

describe('timing and slider duration [B7]', () => {
  it('uses the green line SV: length 140, SM 1.4, beatLength 300, SV 2.0 → 150 ms', () => {
    const m = map({ sm: 1.4, timing: ['0,300,4,1,0,100,1,0', '1000,-50,4,1,0,100,0,0'], objects: ['0,0,1000,2,0,L|200:0,1,140'] });
    expect(m.hitObjects[0].endTime - m.hitObjects[0].time).toBeCloseTo(150, 6);
    expect(m.hitObjects[0].slider!.spanDuration).toBeCloseTo(150, 6);
  });

  it('uses later red lines and resets SV to 1 on a red line', () => {
    const m = map({
      sm: 1,
      timing: ['0,500,4,1,0,100,1,0', '100,-50,4,1,0,100,0,0', '2000,250,4,1,0,100,1,0'],
      objects: ['0,0,2500,2,0,L|100:0,1,100'],
    });
    expect(m.hitObjects[0].endTime - 2500).toBeCloseTo(250, 6);
  });

  it('uses the first red line before any red line and supports the legacy timing format', () => {
    const t = new TimingLookup([
      { time: 1000, beatLength: 400, uninherited: true },
      { time: 2000, beatLength: -25, uninherited: false },
    ]);
    expect(t.beatLengthAt(0)).toBe(400);
    expect(t.svAt(2500)).toBe(4);
    const legacy = map({ timing: ['0,500', '500,-200'], objects: ['0,0,600,2,0,L|100:0,1,70'] });
    expect(legacy.timingPoints.map((p) => p.uninherited)).toEqual([true, false]);
    expect(legacy.hitObjects[0].endTime - 600).toBeCloseTo(spanDurationFor(70, 1.4, { beatLength: 500, sv: 0.5 }), 6);
  });

  it('length formula is the inverse of the duration formula', () => {
    const state = { beatLength: 270.27, sv: 0.63 };
    expect(spanDurationFor(lengthForSpanDuration(320, 1.4, state), 1.4, state)).toBeCloseTo(320, 9);
  });
});

describe('slider paths [B7]', () => {
  it('L: truncates and extends to the declared length', () => {
    near(sliderEnd(map({ objects: ['0,0,1000,2,0,L|200:0,1,150'] }).hitObjects[0]), { x: 150, y: 0 });
    near(sliderEnd(map({ objects: ['0,0,1000,2,0,L|200:0,1,250'] }).hitObjects[0]), { x: 250, y: 0 });
  });

  it('P: follows the circular arc through three points', () => {
    const half = Math.PI * 50;
    const o = map({ objects: [`0,0,1000,2,0,P|50:50|100:0,1,${half}`] }).hitObjects[0];
    // The chord approximation is slightly shorter than the true arc, so the end is extended a little.
    near(sliderEnd(o), { x: 100, y: 0 }, 0.2);
    const s = o.slider!;
    for (const p of s.path) expect(Math.abs(Math.hypot(p.x - 50, p.y) - 50)).toBeLessThan(0.11);
    near(positionAtDistance(s.path, s.cumulative, half / 2), { x: 50, y: 50 }, 0.1);
  });

  it('P: collinear points degrade to linear; more than three points use bezier', () => {
    const lin = map({ objects: ['0,0,1000,2,0,P|50:0|100:0,1,100'] }).hitObjects[0];
    expect(lin.slider!.path).toHaveLength(3);
    near(sliderEnd(lin), { x: 100, y: 0 });
    const bez = map({ objects: ['0,0,1000,2,0,P|50:50|100:0|150:50,1,50'] }).hitObjects[0];
    expect(bez.slider!.path.length).toBeGreaterThan(4);
  });

  it('B: a repeated point (red anchor) splits the curve into segments with a sharp corner', () => {
    const red = map({ objects: ['0,0,1000,2,0,B|100:0|100:0|100:100,1,200'] }).hitObjects[0];
    near(sliderEnd(red), { x: 100, y: 100 });
    near(positionAtDistance(red.slider!.path, red.slider!.cumulative, 100), { x: 100, y: 0 });
    const smooth = map({ objects: ['0,0,1000,2,0,B|100:0|100:100,1,150'] }).hitObjects[0];
    const mid = positionAtDistance(smooth.slider!.path, smooth.slider!.cumulative, 75);
    expect(Math.hypot(mid.x - 100, mid.y)).toBeGreaterThan(5);
  });

  it('C: catmull passes through its control points', () => {
    const { path } = computeSliderPath('C', [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 0 }], 0);
    expect(path.some((p) => Math.hypot(p.x - 100, p.y - 100) < 1e-6)).toBe(true);
    const straight = map({ objects: ['0,0,1000,2,0,C|100:0|200:0,1,200'] }).hitObjects[0];
    near(sliderEnd(straight), { x: 200, y: 0 }, 0.05);
  });

  it('repeats: an even number of slides ends at the head, odd at the tail', () => {
    const even = map({ objects: ['10,20,1000,2,0,L|110:20,2,100'] }).hitObjects[0];
    near(sliderEnd(even), { x: 10, y: 20 });
    const odd = map({ objects: ['10,20,1000,2,0,L|110:20,3,100'] }).hitObjects[0];
    near(sliderEnd(odd), { x: 110, y: 20 });
    const span = odd.slider!.spanDuration;
    near(objectPositionAt(odd, 1000 + span * 1.5), { x: 60, y: 20 });
  });
});

describe('.osu parsing', () => {
  it('treats BeatmapID 0 / missing as null and keeps romanised and unicode metadata apart [B9]', () => {
    const m = parseOsu(new TextEncoder().encode(
      'osu file format v14\n[Metadata]\nTitle:Roman\nTitleUnicode:ユニコード\nArtist:A\nArtistUnicode:エー\nBeatmapID:0\nBeatmapSetID:-1\n[HitObjects]\n1,1,1,1,0\n',
    ));
    expect(m.beatmapId).toBeNull();
    expect(m.beatmapSetId).toBeNull();
    expect(m.title).toBe('Roman');
    expect(m.titleUnicode).toBe('ユニコード');
    expect(m.artistUnicode).toBe('エー');
  });

  it('rejects files that are not .osu', () => {
    expect(() => parseOsu(new TextEncoder().encode('hello'))).toThrow(/osu file format/);
  });

  it('computes duration as max(last end + 1500, 10000)', () => {
    expect(map({ objects: ['0,0,1000,1,0'] }).durationMs).toBe(10000);
    expect(map({ objects: ['0,0,20000,1,0', '0,0,21000,12,0,25000'] }).durationMs).toBe(26500);
    expect(map({ objects: [] }).durationMs).toBe(10000);
  });

  it('assigns combo numbers and colours with new-combo and colour-skip bits', () => {
    const m = map({ objects: ['0,0,100,5,0', '0,0,200,1,0', '0,0,300,5,0', '0,0,400,53,0'] });
    expect(m.hitObjects.map((o) => [o.comboNumber, o.comboColorIdx])).toEqual([[1, 0], [2, 0], [1, 1], [1, (1 + 1 + 3) % 4]]);
  });

  for (const name of ['gen_v14_geometry.osu', 'gen_v14_red_anchors.osu', 'gen_v5_legacy.osu']) {
    it(`parses generated map ${name} with consistent slider geometry`, () => {
      const m = parseOsu(fixture(name));
      expect(m.hitObjects.length).toBeGreaterThan(50);
      expect(m.bpm).toBeGreaterThan(0);
      for (const o of m.hitObjects) {
        expect(o.endTime).toBeGreaterThanOrEqual(o.time);
        if (o.type === 'spinner') expect([o.x, o.y]).toEqual([256, 192]);
        if (!o.slider) continue;
        const s = o.slider;
        const total = s.cumulative[s.cumulative.length - 1];
        const lastTwoEqual = s.path.length >= 2 && s.path.at(-1)!.x === s.path.at(-2)!.x && s.path.at(-1)!.y === s.path.at(-2)!.y;
        if (!lastTwoEqual || total > s.length) expect(Math.abs(total - s.length)).toBeLessThan(1e-6);
        expect(Number.isFinite(s.endX) && Number.isFinite(s.endY)).toBe(true);
        expect(s.endX).toBeGreaterThan(-200);
        expect(s.endX).toBeLessThan(712);
        expect(s.spanDuration).toBeGreaterThan(0);
      }
      const ordered = m.hitObjects.every((o, i, a) => i === 0 || a[i - 1].time <= o.time);
      expect(ordered).toBe(true);
    });
  }
});

describe('difficulty with mods [B4]', () => {
  it('applies HR and EZ to CS/AR/OD and derives radius, windows and preempt', () => {
    const base = { cs: 4, od: 8, ar: 9, hp: 5 };
    const hr = effectiveDifficulty(base, MOD.HR);
    expect(hr.cs).toBeCloseTo(5.2);
    expect(hr.od).toBe(10);
    expect(hr.ar).toBe(10);
    expect(hr.radius).toBeCloseTo(54.4 - 4.48 * 5.2);
    expect(hr.hw50).toBe(100);
    expect(hr.preempt).toBe(450);
    const ez = effectiveDifficulty(base, MOD.EZ);
    expect(ez.cs).toBe(2);
    expect(ez.ar).toBe(4.5);
    expect(ez.preempt).toBe(1200 + 600 * 0.5 / 5);
    expect(effectiveDifficulty(base, 0).hw300).toBe(32);
  });
});

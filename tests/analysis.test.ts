import { describe, expect, it } from 'vitest';
import { analyzeReplay, MISS_REASON } from '../src/core/analysis/judge';
import {
  HIT_ERROR_EDGES, computeScopeMetrics, histogramBucket, histogramLabels, hitErrorHistogram, unstableRate,
} from '../src/core/analysis/metrics';
import { computeSlices, worstSlice } from '../src/core/analysis/slices';
import { inScope, sliceScope, clampScope } from '../src/core/analysis/scope';
import { resampleSpeed, timeGrid } from '../src/core/analysis/resample';
import { parseOsu } from '../src/core/formats/osu';
import { decodeReplayFile } from '../src/core/replay/decode';
import { extractKeyPresses } from '../src/core/replay/keyPresses';
import { sampleCursor } from '../src/core/replay/frames';
import { MOD } from '../src/core/replay/mods';
import type { Frame } from '../src/core/types';
import { fixture, frames, map } from './helpers';

// OD 8 → hw300 32, hw100 76, hw50 120; CS 4 → radius 36.48
const twoCircles = () => map({ objects: ['100,100,1000,1,0', '400,100,1500,1,0'] });
const analyzed = (m: ReturnType<typeof map>, f: Frame[], mods = 0) => ({ id: 'r', frames: f, analysis: analyzeReplay(m, f, mods) });

describe('judgement [B5 B6]', () => {
  it('a press outside the circle does not consume the note; a later accurate press hits it', () => {
    const f = frames([
      [900, 200, 200, 0],
      [990, 200, 200, 5], // outside
      [1000, 200, 200, 0],
      [1010, 101, 100, 10], // inside, +10 ms
      [1050, 101, 100, 0],
      [1500, 400, 100, 5],
      [1550, 400, 100, 0],
    ]);
    const j = analyzeReplay(twoCircles(), f, 0).judgments;
    expect(j[0]).toMatchObject({ judgment: '300', pressed: true, timeError: 10, keyUsed: 'K2' });
    expect(j[1].judgment).toBe('300');
  });

  it('notelock: a press on the next note while the earlier one is pending is ignored', () => {
    const f = frames([
      [900, 400, 100, 0],
      [1000, 400, 100, 5], // on note 2 while note 1 still pending
      [1040, 400, 100, 0],
      [1500, 400, 100, 10],
      [1540, 400, 100, 0],
    ]);
    const j = analyzeReplay(twoCircles(), f, 0).judgments;
    expect(j[0]).toMatchObject({ judgment: 'MISS', pressed: false, timeError: null });
    expect(j[0].missReason).toBe(MISS_REASON.aimOut(300));
    expect(j[1]).toMatchObject({ judgment: '300', timeError: 0 });
  });

  it('classifies misses: aim out, cursor on but no tap, too early', () => {
    const f = frames([
      [800, 100, 100, 0],
      [980, 150, 100, 5], // 50 px away → outside, inside ±hw50
      [1000, 150, 100, 0],
      [1100, 100, 100, 0],
      [1200, 400, 100, 0],
      [1300, 400, 100, 5], // −200 ms on note 2, inside circle → early miss
      [1340, 400, 100, 0],
    ]);
    const j = analyzeReplay(twoCircles(), f, 0).judgments;
    expect(j[0].missReason).toBe(MISS_REASON.aimOut(50));
    expect(j[1]).toMatchObject({ judgment: 'MISS', missReason: MISS_REASON.early, pressed: true, timeError: -200 });
    const idle = analyzeReplay(twoCircles(), frames([[0, 100, 100, 0], [2000, 100, 100, 0]]), 0).judgments;
    expect(idle[0].missReason).toBe(MISS_REASON.cursorOnButNoTap);
  });

  it('spinners are SKIP and never count as a miss [B6]', () => {
    const m = map({ objects: ['256,192,1000,12,0,3000'] });
    const j = analyzeReplay(m, frames([[0, 0, 0, 0], [1000, 0, 0, 5], [3000, 0, 0, 0]]), 0).judgments;
    expect(j).toHaveLength(1);
    expect(j[0]).toMatchObject({ judgment: 'SKIP', timeError: null });
    expect(computeScopeMetrics([analyzed(m, frames([[0, 0, 0, 0]]))], null, { startMs: 0, endMs: 10000 }, 10000).missCount).toBe(0);
  });

  it('HR replays: coordinates flip back and HR CS/OD are used — an accurate HR play has no misses [B4]', () => {
    const m = parseOsu(fixture('fixture_map.osu'));
    const hr = decodeReplayFile(fixture('replay_hr.osr'));
    expect(hr.header.mods & MOD.HR).toBeTruthy();
    const a = analyzeReplay(m, hr.frames!, hr.header.mods);
    expect(a.effective.cs).toBeCloseTo(5.2);
    expect(a.effective.hw50).toBe(200 - 10 * Math.min(10, 8 * 1.4));
    expect(a.simulated).toEqual({ c300: 5, c100: 0, c50: 0, cMiss: 0 });
    const nm = decodeReplayFile(fixture('replay_nm.osr'));
    expect(analyzeReplay(m, nm.frames!, 0).simulated.cMiss).toBe(0);
    // The same HR frames analysed without flipping would miss notes that are off the horizontal centre line.
    expect(analyzeReplay(m, nm.frames!.map((f) => ({ ...f, y: 384 - f.y })), 0).simulated.cMiss).toBeGreaterThan(0);
  });
});

describe('aim direction [B37]', () => {
  it('uses the previous slider end, not its head, as the movement origin', () => {
    // Slider from (100,100) to (300,100); next circle at (300,300) → movement points down (+y).
    const m = map({ objects: ['100,100,1000,2,0,L|300:100,1,200', '300,300,2000,1,0'] });
    const f = frames([[1000, 100, 100, 5], [1400, 300, 100, 0], [1990, 300, 310, 0], [2000, 300, 310, 10], [2040, 300, 310, 0]]);
    const j = analyzeReplay(m, f, 0).judgments[1];
    expect(j.longitudinalOffset).toBeCloseTo(10);
    expect(j.lateralOffset).toBeCloseTo(0);
    expect(j.isOveraim).toBe(true);
  });
});

describe('metrics [B13 B14 B15 B16]', () => {
  it('misses without a press are excluded from the histogram and the mean offset [B13]', () => {
    const m = twoCircles();
    const f = frames([[990, 100, 100, 5], [1030, 100, 100, 0], [1600, 0, 0, 0]]);
    const rep = analyzed(m, f);
    const scope = { startMs: 0, endMs: m.durationMs };
    expect(rep.analysis.judgments[1].judgment).toBe('MISS');
    expect(hitErrorHistogram([rep], scope, m.durationMs)[0].counts.reduce((a, b) => a + b)).toBe(1);
    expect(computeScopeMetrics([rep], rep, scope, m.durationMs).primary!.meanHitError).toBe(-10);
  });

  it('UR is null with a single hit, never a made-up number [B14]', () => {
    const m = twoCircles();
    const rep = analyzed(m, frames([[990, 100, 100, 5], [1030, 100, 100, 0]]));
    const mtr = computeScopeMetrics([rep], rep, { startMs: 0, endMs: m.durationMs }, m.durationMs);
    expect(mtr.primary!.ur).toBeNull();
    expect(mtr.primary!.holdK1).toBe(40);
    expect(mtr.primary!.meanTapInterval).toBeNull();
    expect(mtr.primary!.equivalentBpm).toBeNull();
    expect(unstableRate([10, -10])).toBe(100);
  });

  it('hold time is null when the key is still down at the end of the replay', () => {
    const p = extractKeyPresses(frames([[0, 0, 0, 5], [100, 0, 0, 5]]));
    expect(p[0]).toMatchObject({ key: 'K1', holdMs: null, endTime: null });
  });

  it('UR and Alt% follow the analysis scope [B15]', () => {
    const objects = ['100,100,1000,1,0', '100,100,1100,1,0', '100,100,1200,1,0', '100,100,3000,1,0', '100,100,3100,1,0', '100,100,3200,1,0'];
    const m = map({ objects });
    const taps: [number, number][] = [[1000, 5], [1100, 10], [1200, 5], [3020, 5], [3080, 5], [3220, 5]];
    const list: [number, number, number, number][] = [];
    for (const [t, k] of taps) list.push([t, 100, 100, k], [t + 30, 100, 100, 0]);
    const rep = analyzed(m, frames(list));
    const d = m.durationMs;
    const a = computeScopeMetrics([rep], rep, { startMs: 0, endMs: 2000 }, d).primary!;
    const b = computeScopeMetrics([rep], rep, { startMs: 2000, endMs: 4000 }, d).primary!;
    expect(a.ur).toBe(0);
    expect(b.ur).toBeGreaterThan(100);
    expect(a.altPct).toBe(100);
    expect(b.altPct).toBe(0);
  });

  it('notes on a slice boundary are counted exactly once, consistently with the panel [B16]', () => {
    const m = map({ objects: ['100,100,2000,1,0', '100,100,4000,1,0'] });
    const rep = analyzed(m, frames([[0, 0, 0, 0]]));
    const slices = computeSlices(m, [rep], 2000);
    expect(slices.map((s) => s.noteCount)).toEqual([0, 1, 1, 0, 0]);
    expect(slices.reduce((a, s) => a + s.misses, 0)).toBe(2);
    for (const s of slices) {
      const panel = computeScopeMetrics([rep], rep, sliceScope(s.index, 2000, m.durationMs), m.durationMs);
      expect(panel.missCount).toBe(s.misses);
    }
    expect(worstSlice(slices)!.index).toBe(1);
  });

  it('the last slice and full scope are closed on the right', () => {
    expect(inScope(10000, { startMs: 8000, endMs: 10000 }, 10000)).toBe(true);
    expect(inScope(8000, { startMs: 6000, endMs: 8000 }, 10000)).toBe(false);
    expect(sliceScope(9, 2000, 10000)).toMatchObject({ startMs: 8000, endMs: 10000, sliceIndex: 4 });
    expect(clampScope({ type: 'custom', startMs: 5000, endMs: 5050 }, 10000)).toMatchObject({ startMs: 5000, endMs: 5200 });
    expect(clampScope({ type: 'custom', startMs: 9990, endMs: 9999 }, 10000)).toMatchObject({ startMs: 9800, endMs: 10000 });
  });

  it('histogram labels are generated from the same edges used for bucketing [B26]', () => {
    const labels = histogramLabels();
    expect(labels).toHaveLength(HIT_ERROR_EDGES.length + 1);
    expect(labels[0]).toBe('< -25');
    expect(labels[3]).toBe('-5 ~ +5');
    expect(histogramBucket(-25.1)).toBe(0);
    expect(histogramBucket(-25)).toBe(1);
    expect(histogramBucket(4.9)).toBe(3);
    expect(histogramBucket(5)).toBe(4);
    expect(histogramBucket(25)).toBe(6);
  });

  it('miss reason falls back to other replays and then to “无失误”', () => {
    const m = twoCircles();
    const good = analyzed(m, frames([[1000, 100, 100, 5], [1030, 100, 100, 0], [1500, 400, 100, 10], [1530, 400, 100, 0]]));
    const bad = { ...analyzed(m, frames([[0, 0, 0, 0]])), id: 'bad' };
    const scope = { startMs: 0, endMs: m.durationMs };
    expect(computeScopeMetrics([good, bad], good, scope, m.durationMs).missReason).toBe('其他回放有 Miss');
    expect(computeScopeMetrics([good], good, scope, m.durationMs).missReason).toBe('无失误');
  });
});

describe('frames and playback helpers [B20 B21]', () => {
  it('interpolates position but takes keys and frame index from f0', () => {
    const f = frames([[0, 0, 0, 0], [16, 16, 0, 5]]);
    const s = sampleCursor(f, 8)!;
    expect(s.x).toBe(8);
    expect(s.k1).toBe(false);
    expect(s.frameIndex).toBe(0);
    expect(sampleCursor(f, 16)!.k1).toBe(true);
  });
});

describe('speed resampling [B19]', () => {
  it('aligns replays with different frame rates on a shared time grid', () => {
    const fast: [number, number, number, number][] = [];
    const slow: [number, number, number, number][] = [];
    for (let t = 0; t <= 2000; t += 8) fast.push([t, t * 0.5, 0, 0]);
    for (let t = 0; t <= 2000; t += 33) slow.push([t, t * 0.5, 0, 0]);
    const grid = timeGrid({ startMs: 500, endMs: 1500 }, 50);
    const a = resampleSpeed(frames(fast), grid);
    const b = resampleSpeed(frames(slow), grid);
    for (let i = 0; i < grid.length; i++) {
      expect(a[i]).toBeCloseTo(0.5, 6);
      expect(b[i]).toBeCloseTo(0.5, 6);
    }
    expect(resampleSpeed(frames(slow), timeGrid({ startMs: 2500, endMs: 3000 }, 5)).every((v) => v === null)).toBe(true);
  });
});

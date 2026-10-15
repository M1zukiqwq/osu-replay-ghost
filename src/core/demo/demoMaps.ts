import { lengthForSpanDuration } from '../beatmap/timing';
import type { KeyName } from '../types';
import type { SynthConfig } from './synthetic';
import { MOD } from '../replay/mods';

interface PatternNote { t: number; x: number; y: number; nc?: boolean; slider?: { ex: number; ey: number; dur: number } }

export interface DemoMapSpec {
  key: string;
  title: string;
  artist: string;
  creator: string;
  version: string;
  beatmapId: number;
  beatmapSetId: number;
  hp: number;
  cs: number;
  od: number;
  ar: number;
  bpm: number;
  sliderMultiplier: number;
  notes: PatternNote[];
}

export interface DemoReplaySpec {
  id: string;
  mapKey: string;
  playerName: string;
  /** Minutes before "now" at which the demo play is dated. */
  minutesAgo: number;
  totalScore: number;
  synth: SynthConfig;
}

const FD: PatternNote[] = [
  { t: 600, x: 120, y: 110, nc: true },
  { t: 950, x: 380, y: 130 },
  { t: 1300, x: 250, y: 290, slider: { ex: 350, ey: 260, dur: 320 } },
  { t: 1950, x: 140, y: 240, nc: true },
  { t: 2300, x: 390, y: 120 },
  { t: 2650, x: 160, y: 100 },
  { t: 3000, x: 340, y: 290, slider: { ex: 220, ey: 310, dur: 300 } },
  { t: 3600, x: 256, y: 192, nc: true },
  { t: 4100, x: 85, y: 78, nc: true },
  { t: 4320, x: 430, y: 310 },
  { t: 4540, x: 95, y: 315 },
  { t: 4760, x: 425, y: 82 },
  { t: 4980, x: 110, y: 195 },
  { t: 5200, x: 415, y: 195 },
  { t: 5420, x: 256, y: 68 },
  { t: 5640, x: 256, y: 325 },
  { t: 5860, x: 395, y: 140 },
  { t: 6250, x: 180, y: 160, nc: true, slider: { ex: 290, ey: 210, dur: 340 } },
  { t: 6900, x: 340, y: 120 },
  { t: 7250, x: 170, y: 270 },
  { t: 7600, x: 310, y: 250 },
  { t: 8100, x: 120, y: 180, nc: true },
  { t: 8235, x: 152, y: 162 },
  { t: 8370, x: 188, y: 152 },
  { t: 8505, x: 226, y: 154 },
  { t: 8640, x: 264, y: 168 },
  { t: 8775, x: 300, y: 190 },
  { t: 8910, x: 334, y: 218 },
  { t: 9045, x: 362, y: 252 },
  { t: 9180, x: 380, y: 290 },
  { t: 9315, x: 356, y: 320 },
  { t: 9450, x: 315, y: 330 },
  { t: 9585, x: 270, y: 318 },
  { t: 9720, x: 225, y: 294 },
  { t: 9855, x: 185, y: 262 },
  { t: 10200, x: 135, y: 130, nc: true },
  { t: 10500, x: 375, y: 135 },
  { t: 10800, x: 256, y: 295 },
  { t: 11100, x: 145, y: 240, slider: { ex: 260, ey: 180, dur: 350 } },
  { t: 11700, x: 360, y: 192, nc: true },
];

const BZ: PatternNote[] = [
  { t: 500, x: 100, y: 120, nc: true },
  { t: 850, x: 260, y: 90 },
  { t: 1200, x: 400, y: 150, slider: { ex: 340, ey: 260, dur: 350 } },
  { t: 1850, x: 180, y: 290, nc: true },
  { t: 2150, x: 120, y: 180 },
  { t: 2450, x: 380, y: 200 },
  { t: 2750, x: 256, y: 80 },
  { t: 3100, x: 256, y: 310 },
  { t: 3450, x: 110, y: 260, nc: true },
  { t: 3750, x: 410, y: 110 },
  { t: 4200, x: 160, y: 150, nc: true, slider: { ex: 280, ey: 150, dur: 400 } },
  { t: 4950, x: 350, y: 240 },
  { t: 5350, x: 180, y: 260 },
  { t: 5750, x: 260, y: 140 },
  { t: 6150, x: 90, y: 95, nc: true },
  { t: 6300, x: 145, y: 125 },
  { t: 6450, x: 205, y: 160 },
  { t: 6600, x: 268, y: 198 },
  { t: 6750, x: 332, y: 235 },
  { t: 6900, x: 395, y: 275 },
  { t: 7050, x: 435, y: 190 },
  { t: 7200, x: 370, y: 115 },
  { t: 7350, x: 290, y: 85 },
  { t: 7500, x: 205, y: 110 },
  { t: 7650, x: 135, y: 175 },
  { t: 7800, x: 190, y: 265 },
  { t: 8250, x: 330, y: 290, nc: true, slider: { ex: 220, ey: 200, dur: 400 } },
  { t: 9000, x: 256, y: 192 },
  { t: 9450, x: 390, y: 120 },
];

export const DEMO_MAPS: DemoMapSpec[] = [
  {
    key: 'fd', title: 'FREEDOM DiVE', artist: 'xi', creator: 'Nakagawa-Kanon', version: 'FOUR DIMENSIONS',
    beatmapId: 7562909, beatmapSetId: 39804, hp: 6.5, cs: 4.0, od: 9.0, ar: 9.3, bpm: 222, sliderMultiplier: 1.4, notes: FD,
  },
  {
    key: 'bz', title: 'Blue Zenith', artist: 'xi', creator: 'Asphyxia', version: 'Four Dimensions',
    beatmapId: 1842043, beatmapSetId: 292301, hp: 6.0, cs: 4.2, od: 9.2, ar: 9.4, bpm: 200, sliderMultiplier: 1.4, notes: BZ,
  },
];

/** Builds .osu text for a demo map; slider lengths are derived from the designed durations. */
export function demoOsuText(spec: DemoMapSpec): string {
  const beatLength = 60000 / spec.bpm;
  const timing = [`0,${beatLength},4,1,0,100,1,0`];
  const objects: string[] = [];
  for (const n of spec.notes) {
    const nc = n.nc ? 4 : 0;
    if (!n.slider) {
      objects.push(`${n.x},${n.y},${n.t},${1 | nc},0,0:0:0:0:`);
      continue;
    }
    const dist = Math.hypot(n.slider.ex - n.x, n.slider.ey - n.y);
    const sv = Math.min(10, Math.max(0.1, (dist * beatLength) / (spec.sliderMultiplier * 100 * n.slider.dur)));
    timing.push(`${n.t},${-100 / sv},4,1,0,100,0,0`);
    const length = lengthForSpanDuration(n.slider.dur, spec.sliderMultiplier, { beatLength, sv });
    objects.push(`${n.x},${n.y},${n.t},${2 | nc},0,L|${n.slider.ex}:${n.slider.ey},1,${length}`);
  }
  return [
    'osu file format v14', '',
    '[General]', 'Mode: 0', 'StackLeniency: 0.7', '',
    '[Metadata]',
    `Title:${spec.title}`, `TitleUnicode:${spec.title}`, `Artist:${spec.artist}`, `ArtistUnicode:${spec.artist}`,
    `Creator:${spec.creator}`, `Version:${spec.version}`, `BeatmapID:${spec.beatmapId}`, `BeatmapSetID:${spec.beatmapSetId}`, '',
    '[Difficulty]',
    `HPDrainRate:${spec.hp}`, `CircleSize:${spec.cs}`, `OverallDifficulty:${spec.od}`, `ApproachRate:${spec.ar}`,
    `SliderMultiplier:${spec.sliderMultiplier}`, 'SliderTickRate:1', '',
    '[TimingPoints]', ...timing, '',
    '[HitObjects]', ...objects, '',
  ].join('\r\n');
}

const base = (o: Partial<SynthConfig> & { seed: number }): SynthConfig => ({
  mods: 0,
  missWindows: [],
  chokeMissProb: 0,
  aimBiasLong: 0,
  aimSpread: 12,
  timingBias: 0,
  timingSpread: 14,
  baseHoldMs: 46,
  altPreference: 0.9,
  dominantKey: 'K1' as KeyName,
  snapExponent: 1.15,
  arcAmplitude: 10,
  ...o,
});

export const DEMO_REPLAYS: DemoReplaySpec[] = [
  {
    id: 'rep_fd_1', mapKey: 'fd', playerName: 'LocalPlayer (最新 #1 · Overaim 失误)', minutesAgo: 10, totalScore: 942180,
    synth: base({ seed: 11, missWindows: [[4000, 5950], [8800, 9900]], chokeMissProb: 0.45, aimBiasLong: 0.34, aimSpread: 18,
      timingBias: -4.5, timingSpread: 18, baseHoldMs: 44, altPreference: 0.92, snapExponent: 1.35, arcAmplitude: 14 }),
  },
  {
    id: 'rep_fd_2', mapKey: 'fd', playerName: 'LocalPlayer (个人最佳 FC 影子车)', minutesAgo: 33, totalScore: 1284900,
    synth: base({ seed: 29, mods: MOD.HD | MOD.HR, aimBiasLong: 0.04, aimSpread: 9.5, timingBias: 1.2, timingSpread: 11,
      baseHoldMs: 48, altPreference: 0.96, snapExponent: 1.12, arcAmplitude: -8 }),
  },
  {
    id: 'rep_fd_3', mapKey: 'fd', playerName: 'LocalPlayer (练习 #3 · Underaim + 单指偏多)', minutesAgo: 61, totalScore: 881400,
    synth: base({ seed: 73, missWindows: [[4100, 5800], [8200, 9800]], chokeMissProb: 0.38, aimBiasLong: -0.36, aimSpread: 19,
      timingBias: 6.8, timingSpread: 22, baseHoldMs: 58, altPreference: 0.42, snapExponent: 0.92, arcAmplitude: 19 }),
  },
  {
    id: 'rep_bz_1', mapKey: 'bz', playerName: 'LocalPlayer (6s-8s 大间距流断连)', minutesAgo: 86, totalScore: 812500,
    synth: base({ seed: 44, mods: MOD.HR, missWindows: [[6100, 7900]], chokeMissProb: 0.42, aimBiasLong: -0.32, aimSpread: 17,
      timingBias: 5.4, timingSpread: 19, baseHoldMs: 52, altPreference: 0.88, dominantKey: 'K2', snapExponent: 1.05, arcAmplitude: 12 }),
  },
  {
    id: 'rep_bz_2', mapKey: 'bz', playerName: 'LocalPlayer (稳定全连 Ghost)', minutesAgo: 111, totalScore: 1120400,
    synth: base({ seed: 88, mods: MOD.HD, aimBiasLong: 0.02, aimSpread: 8.5, timingBias: -1.1, timingSpread: 10,
      baseHoldMs: 45, altPreference: 0.95, snapExponent: 1.18, arcAmplitude: -6 }),
  },
];

/**
 * Config for the "simulate a new play" demo button; alternates overaim/underaim runs.
 * Choke windows sit at roughly 1/3 and 2/3 of the map so they also land inside long imported maps.
 */
export function liveRunConfig(runNumber: number, seed: number, durationMs: number): SynthConfig {
  const over = runNumber % 2 === 0;
  const w = (f: number): [number, number] => [Math.round(durationMs * f), Math.round(durationMs * f) + 2000];
  return base({
    seed, missWindows: [w(0.33), w(0.67)], chokeMissProb: 0.35, aimBiasLong: over ? 0.38 : -0.35, aimSpread: 17.5,
    timingBias: over ? -5.2 : 6.1, timingSpread: 19, baseHoldMs: 47, altPreference: 0.86, snapExponent: 1.25, arcAmplitude: over ? 15 : -13,
  });
}

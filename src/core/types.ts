export type DataSource = 'demo' | 'file' | 'library';

export interface Vec2 { x: number; y: number }

export interface TimingPoint { time: number; beatLength: number; uninherited: boolean }

export type CurveType = 'L' | 'P' | 'B' | 'C';

export interface SliderData {
  curveType: CurveType;
  /** Absolute control points, including the head position as the first point. */
  controlPoints: Vec2[];
  slides: number;
  length: number;
  spanDuration: number;
  /** Sampled path, already truncated/extended to `length`. */
  path: Vec2[];
  /** Cumulative distance for each point in `path`. */
  cumulative: number[];
  endX: number;
  endY: number;
}

export type HitObjectType = 'circle' | 'slider' | 'spinner';

export interface HitObject {
  index: number;
  type: HitObjectType;
  x: number;
  y: number;
  time: number;
  endTime: number;
  newCombo: boolean;
  comboSkip: number;
  comboNumber: number;
  comboColorIdx: number;
  slider?: SliderData;
}

export interface Beatmap {
  md5: string;
  fileName: string;
  beatmapId: number | null;
  beatmapSetId: number | null;
  title: string;
  titleUnicode: string;
  artist: string;
  artistUnicode: string;
  creator: string;
  version: string;
  mode: number;
  hp: number;
  cs: number;
  od: number;
  ar: number;
  sliderMultiplier: number;
  sliderTickRate: number;
  stackLeniency: number;
  bpm: number | null;
  timingPoints: TimingPoint[];
  hitObjects: HitObject[];
  durationMs: number;
  source: DataSource;
  /** Last modification time (ms) when known (from osu!.db), used to tell versions apart. */
  modifiedAt: number | null;
}

/** A frame as stored in the .osr stream: w = delta ms, z = key bits. */
export interface RawFrame { w: number; x: number; y: number; z: number }

export interface Frame { time: number; x: number; y: number; keys: number; k1: boolean; k2: boolean; velocity: number }

export type KeyName = 'K1' | 'K2';

export interface KeyPress {
  key: KeyName;
  time: number;
  endTime: number | null;
  holdMs: number | null;
  x: number;
  y: number;
  frameIndex: number;
  tapInterval: number | null;
}

export type JudgmentKind = '300' | '100' | '50' | 'MISS' | 'SKIP';

export interface Judgment {
  noteIndex: number;
  noteTime: number;
  noteX: number;
  noteY: number;
  objectType: HitObjectType;
  judgment: JudgmentKind;
  pressed: boolean;
  hitTime: number | null;
  hitX: number;
  hitY: number;
  timeError: number | null;
  radialOffset: number;
  longitudinalOffset: number | null;
  lateralOffset: number | null;
  isOveraim: boolean;
  isUnderaim: boolean;
  keyUsed: KeyName | null;
  missReason: string;
}

export interface EffectiveDifficulty {
  cs: number;
  od: number;
  ar: number;
  hp: number;
  radius: number;
  hw300: number;
  hw100: number;
  hw50: number;
  earlyMissWindow: number;
  preempt: number;
}

export interface ReplayHeader {
  count300: number;
  count100: number;
  count50: number;
  countGeki: number;
  countKatu: number;
  countMiss: number;
  totalScore: number;
  maxCombo: number;
  perfect: boolean;
  /** null when there are no judgements recorded in the header. */
  accuracy: number | null;
}

export interface SimulatedCounts { c300: number; c100: number; c50: number; cMiss: number }

export interface ReplayAnalysis {
  effective: EffectiveDifficulty;
  keyPresses: KeyPress[];
  judgments: Judgment[];
  simulated: SimulatedCounts;
}

export interface Replay {
  id: string;
  source: 'demo' | 'file';
  fileName: string;
  beatmapMd5: string;
  replayMd5: string;
  playerName: string;
  mode: number;
  gameVersion: number;
  mods: number;
  modNames: string[];
  playedAt: number | null;
  header: ReplayHeader;
  /** Frames in beatmap coordinates (HR already flipped back). null = trajectory unavailable. */
  frames: Frame[] | null;
  decodeError: string | null;
  colorIdx: number;
  analysis: ReplayAnalysis | null;
  /** Order of arrival; used as a tie-breaker when sorting. */
  importSeq: number;
}

export type ScopeType = 'full' | 'slice' | 'custom';

export interface Scope { type: ScopeType; startMs: number; endMs: number; sliceIndex?: number }

import type { Beatmap, Replay, Scope } from '../core/types';
import type { AnalyzedReplay } from '../core/analysis/metrics';

export const REPLAY_COLORS = ['#22d3ee', '#f472b6', '#fbbf24', '#34d399', '#a78bfa'] as const;
export const COMBO_COLORS = ['#38bdf8', '#f472b6', '#34d399', '#fbbf24'] as const;
export const DEFAULT_SLICE_MS = 2000;
export const DEFAULT_SPEED = 0.25;

export interface Group { key: string; beatmap: Beatmap; replays: Replay[]; nextColorIdx: number }

export type DetailTab = 'aim' | 'tap' | 'trend';

export type ImportStatus = 'ok' | 'duplicate' | 'nonStd' | 'pending' | 'failed' | 'ignored' | 'library';

export interface ImportItem { fileName: string; status: ImportStatus; detail: string }

export interface ImportReport { at: number; origin: string; items: ImportItem[] }

export type WatcherStatus = 'unbound' | 'scanning' | 'bound' | 'error';

export interface WatcherState {
  status: WatcherStatus;
  rootName: string | null;
  /** 'handle' = File System Access API (polling), 'files' = one-off webkitdirectory snapshot. */
  mode: 'handle' | 'files' | null;
  lastScanAt: number | null;
  error: string | null;
  dbEntries: number | null;
  songsAvailable: boolean;
  songsNeedsAuth: string | null;
  songsScan: { done: number; total: number } | null;
  baselineCount: number;
  failedCount: number;
  restorable: string | null;
}

export interface AppState {
  groups: Group[];
  pending: Replay[];
  activeKey: string | null;
  selectedIds: Set<string>;
  primaryId: string | null;
  sliceDurationMs: number;
  scope: Scope;
  currentTimeMs: number;
  isPlaying: boolean;
  playbackSpeed: number;
  showGhostTrails: boolean;
  showKeyMarkers: boolean;
  showAimVectors: boolean;
  loop: boolean;
  audioEnabled: boolean;
  activeTab: DetailTab;
  isRangeSelectMode: boolean;
  watcher: WatcherState;
  importLog: ImportReport[];
}

function initialState(): AppState {
  return {
    groups: [],
    pending: [],
    activeKey: null,
    selectedIds: new Set(),
    primaryId: null,
    sliceDurationMs: DEFAULT_SLICE_MS,
    scope: { type: 'full', startMs: 0, endMs: 10000 },
    currentTimeMs: 0,
    isPlaying: false,
    playbackSpeed: DEFAULT_SPEED,
    showGhostTrails: true,
    showKeyMarkers: true,
    showAimVectors: true,
    loop: true,
    audioEnabled: true,
    activeTab: 'aim',
    isRangeSelectMode: false,
    watcher: {
      status: 'unbound', rootName: null, mode: null, lastScanAt: null, error: null, dbEntries: null,
      songsAvailable: false, songsNeedsAuth: null, songsScan: null, baselineCount: 0, failedCount: 0, restorable: null,
    },
    importLog: [],
  };
}

export const state: AppState = initialState();

/** Restores the initial state in place (used by tests). */
export function resetState(): void {
  Object.assign(state, initialState());
}

export type Topic = 'groups' | 'selection' | 'scope' | 'time' | 'view' | 'tab' | 'playback' | 'watcher' | 'importLog';

type Listener = (topics: Set<Topic>) => void;
const listeners: Listener[] = [];
let queued: Set<Topic> | null = null;

export function subscribe(fn: Listener): void {
  listeners.push(fn);
}

/** Batches notifications in a microtask so a single action burst triggers one render. */
export function notify(...topics: Topic[]): void {
  if (!queued) {
    queued = new Set();
    queueMicrotask(() => {
      const t = queued!;
      queued = null;
      for (const l of listeners) l(t);
    });
  }
  for (const t of topics) queued.add(t);
}

export const isAnalyzable = (r: Replay): r is Replay & AnalyzedReplay => r.frames !== null && r.analysis !== null;

export function getActiveGroup(): Group | null {
  return state.groups.find((g) => g.key === state.activeKey) ?? null;
}

export function getSelectedReplays(): (Replay & AnalyzedReplay)[] {
  const g = getActiveGroup();
  if (!g) return [];
  return g.replays.filter((r) => state.selectedIds.has(r.id) && isAnalyzable(r)) as (Replay & AnalyzedReplay)[];
}

export function getPrimaryReplay(): (Replay & AnalyzedReplay) | null {
  return getSelectedReplays().find((r) => r.id === state.primaryId) ?? null;
}

export function getDurationMs(): number {
  return getActiveGroup()?.beatmap.durationMs ?? 10000;
}

export function replayColor(r: Pick<Replay, 'colorIdx'>): string {
  return REPLAY_COLORS[r.colorIdx % REPLAY_COLORS.length];
}

export function findReplay(id: string): Replay | null {
  for (const g of state.groups) for (const r of g.replays) if (r.id === id) return r;
  return null;
}

export function hasRealData(): boolean {
  return state.groups.some((g) => g.beatmap.source !== 'demo' || g.replays.some((r) => r.source !== 'demo'));
}

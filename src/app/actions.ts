import type { Beatmap, Replay, Scope } from '../core/types';
import { clampScope, fullScope, sliceScope, sliceIndexOf } from '../core/analysis/scope';
import { computeSlices, worstSlice } from '../core/analysis/slices';
import {
  DEFAULT_SLICE_MS, getActiveGroup, getDurationMs, getSelectedReplays, isAnalyzable, notify, state,
  type DetailTab, type Group, type ImportReport,
} from './state';

const playedKey = (r: Replay) => r.playedAt ?? Number.MAX_SAFE_INTEGER;
const byNewest = (a: Replay, b: Replay) => playedKey(b) - playedKey(a) || b.importSeq - a.importSeq;

function analyzableIds(g: Group): string[] {
  return g.replays.filter(isAnalyzable).map((r) => r.id);
}

/** Re-establishes invariants 1–4 after any change. */
function normalize(): void {
  const g = getActiveGroup();
  if (!g) {
    state.activeKey = state.groups[0]?.key ?? null;
    if (state.activeKey) return setActiveBeatmap(state.activeKey, true);
    state.selectedIds = new Set();
    state.primaryId = null;
    return;
  }
  const valid = new Set(analyzableIds(g));
  state.selectedIds = new Set([...state.selectedIds].filter((id) => valid.has(id)));
  if (state.selectedIds.size === 0 && valid.size > 0) state.selectedIds.add(analyzableIds(g)[0]);
  if (!state.primaryId || !state.selectedIds.has(state.primaryId)) {
    state.primaryId = g.replays.find((r) => state.selectedIds.has(r.id))?.id ?? null;
  }
  const d = g.beatmap.durationMs;
  state.scope = clampScope(state.scope, d);
  state.currentTimeMs = Math.min(d, Math.max(0, state.currentTimeMs));
}

export function setActiveBeatmap(key: string, force = false): void {
  const g = state.groups.find((x) => x.key === key);
  if (!g || (!force && key === state.activeKey)) return;
  state.activeKey = key;
  state.selectedIds = new Set(analyzableIds(g));
  state.primaryId = analyzableIds(g)[0] ?? null;
  state.scope = fullScope(g.beatmap.durationMs);
  state.scopeHistory = [];
  state.currentTimeMs = 0;
  state.isPlaying = false;
  state.isRangeSelectMode = false;
  notify('groups', 'selection', 'scope', 'time', 'playback', 'view');
}

export function addBeatmaps(maps: Beatmap[], transient = false): Group[] {
  const created: Group[] = [];
  for (const b of maps) {
    if (state.groups.some((g) => g.key === b.md5)) continue;
    const g: Group = { key: b.md5, beatmap: b, replays: [], nextColorIdx: 0, transient };
    state.groups.unshift(g);
    created.push(g);
  }
  if (created.length) notify('groups');
  return created;
}

/** Drops loaded groups (and their replays) and restores the selection invariants. */
export function removeGroups(keys: Set<string>): void {
  if (!state.groups.some((g) => keys.has(g.key))) return;
  state.groups = state.groups.filter((g) => !keys.has(g.key));
  if (state.activeKey && keys.has(state.activeKey)) state.activeKey = null;
  normalize();
  notify('groups', 'selection', 'scope', 'time');
}

/**
 * Adds replays to their beatmap groups (§7 addReplays). The active beatmap becomes the group of the
 * last added replay: if that is a different group only the new replays are selected, otherwise they
 * are added to the current selection. The newest new replay becomes the primary.
 * With `select = false` (paging in older local replays) the selection and active map are left alone.
 */
export function addReplays(list: Replay[], select = true): void {
  if (list.length === 0) return;
  for (const r of list) {
    const g = state.groups.find((x) => x.key === r.beatmapMd5);
    if (!g) throw new Error(`内部错误：回放 ${r.fileName} 没有对应的谱面组`);
    r.colorIdx = g.nextColorIdx++;
    g.replays.push(r);
    g.replays.sort(byNewest);
  }
  if (!select) {
    normalize();
    notify('groups', 'selection');
    return;
  }
  const target = list[list.length - 1].beatmapMd5;
  const g = state.groups.find((x) => x.key === target)!;
  const newIds = new Set(list.filter((r) => r.beatmapMd5 === target && isAnalyzable(r)).map((r) => r.id));
  if (target !== state.activeKey) {
    setActiveBeatmap(target, true);
    if (newIds.size) state.selectedIds = newIds;
  } else {
    for (const id of newIds) state.selectedIds.add(id);
  }
  const newest = g.replays.find((r) => newIds.has(r.id));
  if (newest) state.primaryId = newest.id;
  normalize();
  notify('groups', 'selection', 'scope', 'time');
}

export interface ActionResult { ok: boolean; message?: string; detail?: string }

export function toggleReplay(id: string, on: boolean): ActionResult {
  const g = getActiveGroup();
  const rep = g?.replays.find((r) => r.id === id);
  if (!g || !rep || !isAnalyzable(rep)) return { ok: false, message: '该回放无轨迹数据', detail: '轨迹解析失败的回放只能查看结算信息，无法勾选分析' };
  if (on) state.selectedIds.add(id);
  else {
    if (!state.selectedIds.has(id)) return { ok: true };
    if (getSelectedReplays().length <= 1) return { ok: false, message: '至少保留 1 个 Replay', detail: '对比分析至少需要勾选 1 条回放记录' };
    state.selectedIds.delete(id);
    if (state.primaryId === id) state.primaryId = g.replays.find((r) => state.selectedIds.has(r.id))?.id ?? null;
  }
  normalize();
  notify('selection');
  return { ok: true };
}

export function setPrimary(id: string): ActionResult {
  const g = getActiveGroup();
  const rep = g?.replays.find((r) => r.id === id);
  if (!rep || !isAnalyzable(rep)) return { ok: false, message: '该回放无轨迹数据', detail: '无法设为主视角' };
  state.selectedIds.add(id);
  state.primaryId = id;
  normalize();
  notify('selection');
  return { ok: true };
}

export type QuickSelectKind = 'all' | 'miss' | 'bestVsLatest';

/** Quick selections use the settled (.osr header) data, consistent with the list cards. */
export function quickSelect(kind: QuickSelectKind): ActionResult {
  const g = getActiveGroup();
  if (!g) return { ok: false, message: '没有谱面' };
  const pool = g.replays.filter(isAnalyzable);
  if (pool.length === 0) return { ok: false, message: '当前谱面没有可分析的回放' };
  if (kind === 'all') {
    state.selectedIds = new Set(pool.map((r) => r.id));
  } else if (kind === 'miss') {
    const withMiss = pool.filter((r) => r.header.countMiss > 0);
    if (!withMiss.length) return { ok: false, message: '当前谱面无 Miss 记录', detail: '所有可分析回放的结算 Miss 都为 0' };
    state.selectedIds = new Set(withMiss.map((r) => r.id));
    state.primaryId = withMiss[0].id;
  } else {
    if (pool.length < 2) return { ok: false, message: '回放不足 2 条', detail: '「最佳 vs 最新」至少需要 2 条可分析的回放' };
    const latest = pool[0];
    const best = pool.reduce((b, r) => ((r.header.accuracy ?? -1) > (b.header.accuracy ?? -1) ? r : b), pool[0]);
    state.selectedIds = new Set([latest.id, best.id]);
    state.primaryId = latest.id;
    normalize();
    notify('selection');
    if (best.id === latest.id) return { ok: true, message: '最新一条就是最佳', detail: '最新回放的准确率也是本图最高，只选中了 1 条' };
    return { ok: true };
  }
  normalize();
  notify('selection');
  return { ok: true };
}

/** Default view of a freshly opened map: newest vs best accuracy (or everything when there are ≤ 2). */
export function selectDefaultReplays(): void {
  const g = getActiveGroup();
  if (!g) return;
  if (g.replays.filter(isAnalyzable).length > 2) quickSelect('bestVsLatest');
  else quickSelect('all');
}

export function setScope(scope: Scope): void {
  state.scopeHistory = [];
  adjustScope(scope);
}

/** Changes the scope but keeps the drill-down history (fine-tuning the current level). */
export function adjustScope(scope: Scope): void {
  state.scope = clampScope(scope, getDurationMs());
  notify('scope');
}

/** Narrows into a sub-range from the detail bar; the current scope can be restored with popScope. */
export function drillScope(scope: Scope): void {
  state.scopeHistory.push(state.scope);
  adjustScope(scope);
}

export function popScope(): boolean {
  const parent = state.scopeHistory.pop();
  if (!parent) return false;
  adjustScope(parent);
  return true;
}

export function seek(t: number): void {
  state.currentTimeMs = Math.min(getDurationMs(), Math.max(0, t));
  notify('time');
}

export function selectSlice(index: number, jump = true): void {
  setScope(sliceScope(index, state.sliceDurationMs, getDurationMs()));
  if (jump) seek(state.scope.startMs);
}

export function setSliceDuration(ms: number): void {
  state.sliceDurationMs = ms > 0 ? ms : DEFAULT_SLICE_MS;
  selectSlice(0);
}

export function showFullMap(): void {
  setScope(fullScope(getDurationMs()));
}

export function jumpToWorstSlice(): boolean {
  const g = getActiveGroup();
  if (!g) return false;
  const worst = worstSlice(computeSlices(g.beatmap, getSelectedReplays(), state.sliceDurationMs));
  if (!worst) return false;
  selectSlice(worst.index);
  return worst.misses + worst.sliderBreaks > 0;
}

/** Moves the analysis scope to the slice containing t when t is outside the current scope (D8). */
export function ensureTimeInScope(t: number): void {
  const d = getDurationMs();
  const s = state.scope;
  const inside = t >= s.startMs && (t < s.endMs || (t === s.endMs && s.endMs >= d));
  if (!inside) setScope(sliceScope(sliceIndexOf(t, state.sliceDurationMs, d), state.sliceDurationMs, d));
}

export function setPlaying(on: boolean): void {
  if (state.isPlaying === on) return;
  if (on) {
    const d = getDurationMs();
    const s = state.scope;
    if (state.loop && (state.currentTimeMs < s.startMs || state.currentTimeMs >= s.endMs)) seek(s.startMs);
    else if (!state.loop && state.currentTimeMs >= d) seek(s.startMs);
    if (state.isRangeSelectMode) {
      state.isRangeSelectMode = false;
      notify('view');
    }
  }
  state.isPlaying = on;
  notify('playback');
}

export function setSpeed(speed: number): void {
  state.playbackSpeed = speed;
  notify('view');
}

export function setLayer(layer: 'showGhostTrails' | 'showKeyMarkers' | 'showAimVectors' | 'loop', on: boolean): void {
  state[layer] = on;
  notify('view');
}

export function setAudio(on: boolean): void {
  state.audioEnabled = on;
  notify('view');
}

export function setTab(tab: DetailTab): void {
  state.activeTab = tab;
  notify('tab');
}

export function setRangeSelectMode(on: boolean): void {
  state.isRangeSelectMode = on;
  if (on) state.isPlaying = false;
  notify('view', 'playback');
}

export function addPending(list: Replay[]): void {
  if (!list.length) return;
  state.pending.push(...list);
  notify('groups');
}

export function removePending(ids: Set<string>): void {
  state.pending = state.pending.filter((r) => !ids.has(r.id));
  notify('groups');
}

export function logImport(report: ImportReport): void {
  state.importLog.unshift(report);
  state.importLog.length = Math.min(state.importLog.length, 20);
  notify('importLog');
}

export function clearDemoData(): void {
  state.groups = state.groups
    .filter((g) => g.beatmap.source !== 'demo' || g.replays.some((r) => r.source !== 'demo'))
    .map((g) => ({ ...g, replays: g.replays.filter((r) => r.source !== 'demo') }));
  state.pending = state.pending.filter((r) => r.source !== 'demo');
  const active = getActiveGroup();
  if (!active) {
    state.activeKey = null;
    normalize();
  } else normalize();
  notify('groups', 'selection', 'scope', 'time');
}

export function updateWatcher(patch: Partial<typeof state.watcher>): void {
  Object.assign(state.watcher, patch);
  notify('watcher');
}

export function updateBrowser(patch: Partial<typeof state.browser>): void {
  Object.assign(state.browser, patch);
  notify('browser');
}

export function updatePreview(patch: Partial<typeof state.preview>): void {
  Object.assign(state.preview, patch);
  notify('preview');
}

/** Advance used by the playback loop only (does not count as a seek). */
export function advanceTime(t: number): void {
  state.currentTimeMs = t;
  notify('time');
}

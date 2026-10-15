import { parseOsu } from '../core/formats/osu';
import type { OsrHeader } from '../core/formats/osr';
import type { DecodedReplay } from '../core/replay/decode';
import { toReplayHeader } from '../core/replay/decode';
import { decodeMods } from '../core/replay/mods';
import type { Beatmap, Replay } from '../core/types';
import { addBeatmaps, addPending, addReplays, logImport, removePending, setActiveBeatmap, updateWatcher } from './actions';
import type { Engine } from './engine';
import type { Library } from './library';
import { state, type ImportItem, type ImportReport, type ImportStatus } from './state';

export interface ImportContext { engine: Engine; library: Library }

let importSeq = 0;
export const nextImportSeq = () => ++importSeq;

export function newReplayId(prefix = 'rep'): string {
  return `${prefix}_${Date.now().toString(36)}_${(++importSeq).toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export function replayKey(h: Pick<OsrHeader, 'replayMd5' | 'beatmapMd5' | 'playerName' | 'playedAt' | 'totalScore'>): string {
  return h.replayMd5 ? `r:${h.replayMd5}` : `c:${h.beatmapMd5}|${h.playerName}|${h.playedAt}|${h.totalScore}`;
}

export function replayFromDecoded(dec: DecodedReplay, fileName: string): Replay {
  const h = dec.header;
  return {
    id: newReplayId(),
    source: 'file',
    fileName,
    beatmapMd5: h.beatmapMd5,
    replayMd5: h.replayMd5,
    playerName: h.playerName,
    mode: h.mode,
    gameVersion: h.gameVersion,
    mods: h.mods,
    modNames: decodeMods(h.mods),
    playedAt: h.playedAt,
    header: toReplayHeader(h),
    frames: dec.frames,
    decodeError: dec.decodeError,
    colorIdx: 0,
    analysis: null,
    importSeq: nextImportSeq(),
  };
}

function existingKeys(): Set<string> {
  const keys = new Set<string>();
  const add = (r: Replay) => keys.add(replayKey({ ...r, totalScore: r.header.totalScore }));
  for (const g of state.groups) g.replays.forEach(add);
  state.pending.forEach(add);
  return keys;
}

const ext = (name: string) => name.toLowerCase().slice(name.lastIndexOf('.'));
const isOsuDb = (name: string) => name.toLowerCase() === 'osu!.db';

export interface ImportOutcome { report: ImportReport; statusByFile: Map<File, ImportStatus> }

let queue: Promise<unknown> = Promise.resolve();

/** Serialises imports (manual, drag & drop, watcher) so batches never interleave. */
export function importFiles(files: File[], ctx: ImportContext, origin: string): Promise<ImportOutcome> {
  const run = queue.then(() => doImport(files, ctx, origin));
  queue = run.catch(() => undefined);
  return run;
}

async function bytesOf(f: Blob): Promise<Uint8Array> {
  return new Uint8Array(await f.arrayBuffer());
}

/** Finds a beatmap for an MD5: loaded groups → this batch → library (osu!.db / Songs scan). */
async function makeResolver(ctx: ImportContext, batchMaps: Beatmap[]) {
  const libraryCache = new Map<string, Beatmap | string>();
  return async (md5: string): Promise<{ beatmap: Beatmap | null; error?: string }> => {
    const loaded = state.groups.find((g) => g.key === md5)?.beatmap ?? batchMaps.find((b) => b.md5 === md5);
    if (loaded) return { beatmap: loaded };
    if (!libraryCache.has(md5)) {
      const res = await ctx.library.resolve(md5);
      if (res && 'beatmap' in res) {
        libraryCache.set(md5, res.beatmap);
        batchMaps.push(res.beatmap);
      } else if (res) libraryCache.set(md5, res.error);
    }
    const hit = libraryCache.get(md5);
    if (hit && typeof hit !== 'string') return { beatmap: hit };
    return { beatmap: null, error: typeof hit === 'string' ? hit : undefined };
  };
}

async function doImport(files: File[], ctx: ImportContext, origin: string): Promise<ImportOutcome> {
  const items: ImportItem[] = [];
  const statusByFile = new Map<File, ImportStatus>();
  const record = (f: File, status: ImportStatus, detail: string) => {
    items.push({ fileName: f.name, status, detail });
    statusByFile.set(f, status);
  };

  const dbFiles: File[] = [];
  const osuFiles: File[] = [];
  const osrFiles: File[] = [];
  for (const f of files) {
    const e = ext(f.name);
    if (isOsuDb(f.name)) dbFiles.push(f);
    else if (e === '.osu') osuFiles.push(f);
    else if (e === '.osr') osrFiles.push(f);
    else record(f, 'ignored', e === '.db' ? '只支持 osu!.db（谱面库索引）' : '不支持的文件类型');
  }

  for (const f of dbFiles) {
    try {
      const idx = await ctx.engine.parseOsuDb(await bytesOf(f));
      const n = ctx.library.setDbIndex(idx.entries);
      updateWatcher({ dbEntries: ctx.library.size });
      record(f, 'library', `已建立谱面库索引：${n} 张谱面（版本 ${idx.version}）${ctx.library.songs ? '' : '；尚未绑定 Songs 目录，请绑定 osu! 根目录后才能按需读取谱面'}`);
    } catch (e) {
      record(f, 'failed', `osu!.db 解析失败：${(e as Error).message}`);
    }
  }

  const batchMaps: Beatmap[] = [];
  const mapsFromFiles: Beatmap[] = [];
  for (const f of osuFiles) {
    try {
      const map = parseOsu(await bytesOf(f), { fileName: f.name, source: 'file' });
      if (state.groups.some((g) => g.key === map.md5) || batchMaps.some((b) => b.md5 === map.md5)) {
        record(f, 'duplicate', `谱面已存在（MD5 ${map.md5.slice(0, 8)}…）`);
        continue;
      }
      if (map.mode !== 0) {
        record(f, 'nonStd', `非 std 模式谱面（Mode ${map.mode}）`);
        continue;
      }
      batchMaps.push(map);
      mapsFromFiles.push(map);
      record(f, 'ok', `${map.artist} - ${map.title} [${map.version}]，${map.hitObjects.length} 个物件`);
    } catch (e) {
      record(f, 'failed', `.osu 解析失败：${(e as Error).message}`);
    }
  }

  const resolve = await makeResolver(ctx, batchMaps);
  const keys = existingKeys();
  const resolved: Replay[] = [];
  const pending: Replay[] = [];

  for (const f of osrFiles) {
    try {
      const dec = await ctx.engine.decodeReplay(await bytesOf(f));
      const h = dec.header;
      const key = replayKey(h);
      if (keys.has(key)) {
        record(f, 'duplicate', `回放已导入过（${h.playerName}）`);
        continue;
      }
      if (h.mode !== 0) {
        record(f, 'nonStd', `非 std 模式（Mode ${h.mode}），已跳过`);
        continue;
      }
      keys.add(key);
      const rep = replayFromDecoded(dec, f.name);
      const { beatmap, error } = await resolve(h.beatmapMd5);
      if (!beatmap) {
        pending.push(rep);
        record(f, 'pending', `缺少谱面（MD5 ${h.beatmapMd5}）${error ? '：' + error : '，请导入对应的 .osu'}`);
        continue;
      }
      if (rep.frames) rep.analysis = await ctx.engine.analyze(beatmap, rep.frames, rep.mods);
      resolved.push(rep);
      record(f, 'ok', rep.decodeError ? `已导入结算信息，${rep.decodeError}（无轨迹数据）` : `${h.playerName} · ${beatmap.title} [${beatmap.version}]`);
    } catch (e) {
      record(f, 'failed', `.osr 解析失败：${(e as Error).message}`);
    }
  }

  // Previously pending replays whose beatmap arrived in this batch.
  const attachedIds = new Set<string>();
  for (const rep of state.pending) {
    const map = batchMaps.find((b) => b.md5 === rep.beatmapMd5);
    if (!map) continue;
    try {
      if (rep.frames) rep.analysis = await ctx.engine.analyze(map, rep.frames, rep.mods);
      resolved.push(rep);
      attachedIds.add(rep.id);
      items.push({ fileName: rep.fileName, status: 'ok', detail: `待匹配回放已挂到谱面 ${map.title} [${map.version}]` });
    } catch (e) {
      items.push({ fileName: rep.fileName, status: 'failed', detail: `待匹配回放分析失败：${(e as Error).message}` });
    }
  }

  commitBatch(batchMaps, resolved, pending, attachedIds, mapsFromFiles);
  const report: ImportReport = { at: Date.now(), origin, items };
  if (items.length) logImport(report);
  return { report, statusByFile };
}

function commitBatch(maps: Beatmap[], resolved: Replay[], pending: Replay[], attachedIds: Set<string>, mapsFromFiles: Beatmap[]): void {
  const neededMaps = maps.filter((m) => mapsFromFiles.includes(m) || resolved.some((r) => r.beatmapMd5 === m.md5));
  addBeatmaps(neededMaps);
  if (attachedIds.size) removePending(attachedIds);
  addPending(pending);
  if (resolved.length) addReplays(resolved);
  else if (mapsFromFiles.length) setActiveBeatmap(mapsFromFiles[mapsFromFiles.length - 1].md5);
}

/** Tries to resolve pending replays through the library (after osu!.db or a Songs scan becomes available). */
export function resolvePendingFromLibrary(ctx: ImportContext): Promise<number> {
  const run = queue.then(() => doResolvePending(ctx));
  queue = run.catch(() => undefined);
  return run;
}

async function doResolvePending(ctx: ImportContext): Promise<number> {
  if (!state.pending.length) return 0;
  const batchMaps: Beatmap[] = [];
  const resolve = await makeResolver(ctx, batchMaps);
  const resolved: Replay[] = [];
  const ids = new Set<string>();
  for (const rep of state.pending) {
    const { beatmap } = await resolve(rep.beatmapMd5);
    if (!beatmap) continue;
    if (rep.frames) rep.analysis = await ctx.engine.analyze(beatmap, rep.frames, rep.mods);
    resolved.push(rep);
    ids.add(rep.id);
  }
  if (resolved.length) {
    addBeatmaps(batchMaps);
    removePending(ids);
    addReplays(resolved);
  }
  return resolved.length;
}

const STATUS_LABEL: Record<ImportStatus, string> = {
  ok: '成功',
  duplicate: '重复跳过',
  nonStd: '非 std',
  pending: '缺少谱面',
  failed: '解析失败',
  ignored: '已忽略',
  library: '谱面库索引',
};

export function statusLabel(s: ImportStatus): string {
  return STATUS_LABEL[s];
}

export function summarize(report: ImportReport): string {
  const counts = new Map<ImportStatus, number>();
  for (const it of report.items) counts.set(it.status, (counts.get(it.status) ?? 0) + 1);
  const order: ImportStatus[] = ['ok', 'library', 'duplicate', 'nonStd', 'pending', 'failed', 'ignored'];
  return order.filter((s) => counts.get(s)).map((s) => `${STATUS_LABEL[s]} ${counts.get(s)}`).join(' · ');
}

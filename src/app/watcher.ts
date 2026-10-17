import { OSR_PEEK_BYTES, peekOsrHeader } from '../core/formats/osr';
import { parseDataRName } from '../core/formats/replayFiles';
import { updateBrowser, updateWatcher } from './actions';
import { publishRecent } from './browser';
import {
  getFileIn, hasFsObserver, listNames, observeDir, tryGetDir, type DirHandle, type FsChangeRecord, type FsObserver,
} from './fsAccess';
import { resolvePendingFromLibrary, type ImportContext } from './importer';
import { fileMapSongsSource, handleSongsSource } from './library';
import { ReplayIndex } from './replayIndex';
import { state } from './state';

/** Polling (only without FileSystemObserver): starts at 3 s, backs off to 15 s while nothing changes. */
export const POLL_MIN_MS = 3000;
export const POLL_MAX_MS = 15000;
const POLL_BACKOFF = 1.5;
/** Quiet time after a change before new replay files are read (osu! may still be writing them). */
export const SETTLE_MS = 600;
const HEADER_READ_CONCURRENCY = 8;

export type ReplayDir = 'data' | 'replays';
const REPLAY_DIRS: readonly ReplayDir[] = ['data', 'replays'];
const DIR_PATHS: Record<ReplayDir, string[]> = { data: ['Data', 'r'], replays: ['Replays'] };
const DIR_LABEL: Record<ReplayDir, string> = { data: 'Data/r', replays: 'Replays' };

export interface LocalReplayFile {
  key: string;
  dir: ReplayDir;
  name: string;
  /** From the Data/r file name; null for Replays/ files. */
  playedAt: number | null;
  getFile(): Promise<File>;
}

/** Read access to the two replay folders: live directory handles or a webkitdirectory snapshot. */
interface ReplaySource {
  /** Current .osr names; null when the folder does not exist. */
  list(dir: ReplayDir): Promise<string[] | null>;
  file(dir: ReplayDir, name: string): Promise<File>;
  /** Live directory handle for FileSystemObserver (handle mode only). */
  handle?(dir: ReplayDir): Promise<DirHandle | null>;
  /** Forget a cached directory handle (the folder was removed or replaced). */
  reset?(dir: ReplayDir): void;
}

const notFound = (msg: string) => Object.assign(new Error(msg), { name: 'NotFoundError' });

function handleSource(root: DirHandle): ReplaySource {
  const cache = new Map<ReplayDir, DirHandle>();
  const handle = async (dir: ReplayDir) => {
    const hit = cache.get(dir);
    if (hit) return hit;
    const d = await tryGetDir(root, DIR_PATHS[dir]);
    if (d) cache.set(dir, d);
    return d;
  };
  return {
    handle,
    reset: (dir) => cache.delete(dir),
    async list(dir) {
      const d = await handle(dir);
      if (!d) return null;
      try {
        return await listNames(d, '.osr');
      } catch (e) {
        if ((e as Error).name !== 'NotFoundError') throw e;
        cache.delete(dir);
        return null;
      }
    },
    async file(dir, name) {
      const d = await handle(dir);
      if (!d) throw notFound(`${DIR_LABEL[dir]} 目录不存在`);
      return (await d.getFileHandle(name)).getFile();
    },
  };
}

function snapshotSource(files: Record<ReplayDir, Map<string, File>>): ReplaySource {
  return {
    async list(dir) {
      return files[dir].size ? [...files[dir].keys()] : null;
    },
    async file(dir, name) {
      const f = files[dir].get(name);
      if (!f) throw notFound(`目录快照中没有 ${DIR_LABEL[dir]}/${name}`);
      return f;
    },
  };
}

function describeError(e: unknown): string {
  const err = e as Error;
  if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') return '目录访问权限已失效，请重新绑定 osu! 根目录';
  if (err?.name === 'NotFoundError') return `目录或文件不存在（可能被移动或删除）：${err.message}`;
  return err?.message ?? String(e);
}

/** BeatmapDirectory from osu!.<user>.cfg; null when unset. */
export function parseBeatmapDirectory(cfgText: string): string | null {
  for (const line of cfgText.split(/\r?\n/)) {
    const m = /^\s*BeatmapDirectory\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[1]) return m[1];
  }
  return null;
}

const isAbsolutePath = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/');
const isOsr = (name: string) => name.toLowerCase().endsWith('.osr');
const isHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Keeps an index of local replay *files* (names, plus Replays/ headers once needed) for the beatmap
 * browser; it never imports replays itself. Changes arrive from FileSystemObserver where available,
 * otherwise from polling that backs off while idle and pauses while the page is hidden.
 */
export class Watcher {
  readonly index = new ReplayIndex();
  /** Called with new or rewritten replay files of the map currently shown in the preview. */
  onActiveMapFiles: ((md5: string, files: LocalReplayFile[]) => Promise<void> | void) | null = null;

  private source: ReplaySource | null = null;
  private root: DirHandle | null = null;
  private observers = new Map<ReplayDir, FsObserver>();
  /** Maps played since binding that have not been opened yet. */
  private fresh = new Set<string>();
  private queued = new Map<string, { dir: ReplayDir; name: string }>();
  private rescan = new Set<ReplayDir>();
  private exportedSynced = false;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollDelay = POLL_MIN_MS;
  private polling = false;
  private flushing = false;
  /** Bumped on every (re)bind so late async work from an old binding is dropped. */
  private generation = 0;

  constructor(private ctx: ImportContext) {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (!isHidden()) this.wake();
      });
      window.addEventListener('focus', () => this.wake());
    }
  }

  get rootHandle(): DirHandle | null {
    return this.root;
  }

  get hasSource(): boolean {
    return this.source !== null;
  }

  /** Local replays of a beatmap known so far (Data/r names + Replays/ headers already read). */
  countFor(md5: string): number {
    return this.index.countFor(md5);
  }

  private stop(): void {
    this.generation++;
    for (const o of this.observers.values()) o.disconnect();
    this.observers.clear();
    if (this.settleTimer) clearTimeout(this.settleTimer);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.settleTimer = this.pollTimer = null;
    this.queued.clear();
    this.rescan.clear();
    this.fresh.clear();
    this.index.clear();
    this.exportedSynced = false;
    this.source = null;
    this.pollDelay = POLL_MIN_MS;
  }

  private async loadDb(read: () => Promise<File | null>): Promise<void> {
    const file = await read();
    if (!file) {
      updateWatcher({ dbEntries: null });
      return;
    }
    const idx = await this.ctx.engine.parseOsuDb(new Uint8Array(await file.arrayBuffer()));
    this.ctx.library.setDbIndex(idx.entries);
    updateWatcher({ dbEntries: this.ctx.library.size });
  }

  private publish(): void {
    publishRecent(this.index, this.ctx.library, this.fresh);
  }

  /** Called when a map is opened: it no longer counts as a new play. Also refreshes metadata. */
  markSeen(md5: string): void {
    this.fresh.delete(md5);
    if (this.source) this.publish();
  }

  /** Binds via File System Access API: reads osu!.db, indexes Data/r names, then watches for changes. */
  async bindHandle(root: DirHandle): Promise<void> {
    this.stop();
    const gen = this.generation;
    this.root = root;
    updateWatcher({
      status: 'scanning', rootName: root.name, mode: 'handle', detection: null, error: null,
      songsNeedsAuth: null, songsScan: null, restorable: null,
    });
    try {
      await this.loadDb(async () => {
        try {
          return await getFileIn(root, 'osu!.db');
        } catch {
          return null;
        }
      });
      let songsPath: string | null = null;
      for await (const [name, h] of root.entries()) {
        if (h.kind === 'file' && /^osu!\..+\.cfg$/i.test(name)) {
          songsPath = parseBeatmapDirectory(await (await h.getFile()).text());
          break;
        }
      }
      if (songsPath && isAbsolutePath(songsPath)) {
        this.ctx.library.songs = null;
        updateWatcher({ songsNeedsAuth: songsPath, songsAvailable: false });
      } else {
        const songs = await tryGetDir(root, (songsPath ?? 'Songs').split(/[\\/]+/).filter(Boolean));
        this.ctx.library.songs = songs ? handleSongsSource(songs) : null;
        updateWatcher({ songsAvailable: !!songs });
      }

      this.source = handleSource(root);
      // Observe first so nothing written during the initial listing is lost.
      for (const dir of REPLAY_DIRS) await this.observe(dir);
      const names = await this.source.list('data');
      if (gen !== this.generation) return;
      this.index.syncDataR(names ?? []);
      this.publish();
      updateWatcher({ status: 'bound', lastScanAt: Date.now(), localReplays: this.index.dataRCount, detection: this.detection() });
      updateBrowser({ tab: 'recent' });
      await resolvePendingFromLibrary(this.ctx);
      this.schedulePoll();
    } catch (e) {
      if (gen === this.generation) updateWatcher({ status: 'error', error: describeError(e) });
    }
  }

  /** Authorises a Songs folder that lives outside the osu! root (absolute BeatmapDirectory). */
  async bindSongs(dir: DirHandle): Promise<void> {
    this.ctx.library.songs = handleSongsSource(dir);
    updateWatcher({ songsNeedsAuth: null, songsAvailable: true });
    await resolvePendingFromLibrary(this.ctx);
  }

  /** webkitdirectory fallback: a one-off snapshot, looked up lazily by relative path (no bulk parsing). */
  async bindFiles(files: File[]): Promise<void> {
    this.stop();
    const gen = this.generation;
    this.root = null;
    const byPath = new Map<string, File>();
    let rootName = '';
    for (const f of files) {
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
      const parts = rel.split('/');
      rootName ||= parts.length > 1 ? parts[0] : '';
      byPath.set((parts.length > 1 ? parts.slice(1) : parts).join('/').toLowerCase(), f);
    }
    updateWatcher({
      status: 'scanning', rootName: rootName || '所选目录', mode: 'files', detection: null, error: null,
      songsNeedsAuth: null, songsScan: null,
    });
    try {
      await this.loadDb(async () => byPath.get('osu!.db') ?? null);
      let songsPath = 'songs';
      for (const [k, f] of byPath) {
        if (!k.includes('/') && /^osu!\..+\.cfg$/.test(k)) {
          const p = parseBeatmapDirectory(await f.text());
          if (p && !isAbsolutePath(p)) songsPath = p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
          break;
        }
      }
      const songs = new Map<string, File>();
      const prefix = songsPath + '/';
      for (const [k, f] of byPath) if (k.startsWith(prefix)) songs.set(k.slice(prefix.length), f);
      this.ctx.library.songs = songs.size ? fileMapSongsSource(songs) : null;

      const dirs: Record<ReplayDir, Map<string, File>> = { data: new Map(), replays: new Map() };
      for (const [k, f] of byPath) {
        if (!k.endsWith('.osr')) continue;
        if (k.startsWith('data/r/') && !k.slice(7).includes('/')) dirs.data.set(f.name, f);
        else if (k.startsWith('replays/') && !k.slice(8).includes('/')) dirs.replays.set(f.name, f);
      }
      if (gen !== this.generation) return;
      this.source = snapshotSource(dirs);
      this.index.syncDataR([...dirs.data.keys()]);
      this.publish();
      updateWatcher({ status: 'bound', songsAvailable: songs.size > 0, lastScanAt: Date.now(), localReplays: this.index.dataRCount });
      updateBrowser({ tab: 'recent' });
      await resolvePendingFromLibrary(this.ctx);
    } catch (e) {
      if (gen === this.generation) updateWatcher({ status: 'error', error: describeError(e) });
    }
  }

  /**
   * Local replay files of one beatmap, newest Data/r first, then Replays/ files whose header names
   * this map. The first call reads the header of every Replays/ file once; later calls only new ones.
   */
  async localReplayFiles(md5: string): Promise<LocalReplayFile[]> {
    const source = this.source;
    if (!source) return [];
    await this.syncExported();
    const out = this.index.dataRFor(md5).map((r) => this.ref(source, 'data', r.name, r.playedAt));
    for (const name of this.index.exportedFor(md5)) out.push(this.ref(source, 'replays', name, null));
    return out;
  }

  private ref(source: ReplaySource, dir: ReplayDir, name: string, playedAt: number | null): LocalReplayFile {
    return { key: `${dir}/${name}`, dir, name, playedAt, getFile: () => source.file(dir, name) };
  }

  private async syncExported(): Promise<void> {
    if (!this.source || (this.exportedSynced && this.observers.has('replays'))) return;
    const names = await this.source.list('replays');
    await forEachLimit(names ? this.index.syncExportedNames(names) : [], HEADER_READ_CONCURRENCY, (n) => this.readHeader(n));
    if (!this.exportedSynced) {
      this.exportedSynced = true;
      this.schedulePoll(); // Replays/ joins polling now if it is not observed
    }
  }

  private async readHeader(name: string): Promise<string | null> {
    let md5: string | null = null;
    try {
      const file = await this.source!.file('replays', name);
      md5 = peekOsrHeader(new Uint8Array(await file.slice(0, OSR_PEEK_BYTES).arrayBuffer()))?.beatmapMd5 ?? null;
    } catch {
      // unreadable or still being written; a later change event reads it again
    }
    this.index.setExported(name, md5);
    return md5;
  }

  // --- change detection -------------------------------------------------------------------------

  private detection(): 'events' | 'polling' {
    return hasFsObserver() && this.observers.has('data') ? 'events' : 'polling';
  }

  private async observe(dir: ReplayDir): Promise<boolean> {
    if (this.observers.has(dir)) return true;
    const handle = await this.source?.handle?.(dir);
    if (!handle) return false;
    const gen = this.generation;
    const obs = await observeDir(handle, (records) => {
      if (gen === this.generation) this.onRecords(dir, records);
    });
    if (!obs) return false;
    if (gen !== this.generation) {
      obs.disconnect();
      return false;
    }
    this.observers.set(dir, obs);
    return true;
  }

  private onRecords(dir: ReplayDir, records: FsChangeRecord[]): void {
    for (const r of records) {
      const name = r.relativePathComponents[r.relativePathComponents.length - 1] ?? r.changedHandle?.name ?? '';
      switch (r.type) {
        case 'appeared':
        case 'modified':
        case 'moved':
          if (r.type === 'moved' && r.relativePathMovedFrom?.length) this.forget(dir, r.relativePathMovedFrom[r.relativePathMovedFrom.length - 1]);
          if (isOsr(name)) this.queued.set(`${dir}/${name}`, { dir, name });
          break;
        case 'disappeared':
          this.forget(dir, name);
          break;
        case 'unknown':
          this.rescan.add(dir);
          break;
        case 'errored':
          // The observation stopped (e.g. the folder was deleted): fall back to polling this folder.
          this.observers.get(dir)?.disconnect();
          this.observers.delete(dir);
          this.source?.reset?.(dir);
          this.rescan.add(dir);
          updateWatcher({ detection: this.detection() });
          this.schedulePoll();
          break;
      }
    }
    this.scheduleSettle();
  }

  private forget(dir: ReplayDir, name: string): void {
    if (dir === 'data') this.index.removeDataR(name);
    else this.index.removeExported(name);
  }

  private scheduleSettle(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      void this.flush();
    }, SETTLE_MS);
  }

  /** Applies queued changes: indexes new names, reads new Replays/ headers, hands the previewed map its new files. */
  async flush(): Promise<void> {
    const source = this.source;
    if (!source) return;
    if (this.flushing) {
      this.scheduleSettle();
      return;
    }
    this.flushing = true;
    const gen = this.generation;
    try {
      for (const dir of [...this.rescan]) {
        this.rescan.delete(dir);
        const names = await source.list(dir);
        if (!names) continue;
        const unknown = dir === 'data' ? this.index.diffDataR(names) : this.exportedSynced ? this.index.syncExportedNames(names) : [];
        for (const name of unknown) this.queued.set(`${dir}/${name}`, { dir, name });
      }
      const items = [...this.queued.values()];
      this.queued.clear();
      const active = state.activeKey;
      const forActive: LocalReplayFile[] = [];
      for (const { dir, name } of items) {
        if (dir === 'data') {
          const parsed = parseDataRName(name);
          if (!parsed) continue;
          if (this.index.addDataR(name) && parsed.md5 !== active) this.fresh.add(parsed.md5);
          if (parsed.md5 === active) forActive.push(this.ref(source, 'data', name, parsed.playedAt));
        } else {
          const md5 = await this.readHeader(name);
          if (md5 && md5 === active) forActive.push(this.ref(source, 'replays', name, null));
        }
      }
      if (gen !== this.generation) return;
      this.publish();
      updateWatcher({ status: 'bound', error: null, lastScanAt: Date.now(), localReplays: this.index.dataRCount });
      if (forActive.length && active && this.onActiveMapFiles) await this.onActiveMapFiles(active, forActive);
    } catch (e) {
      if (gen === this.generation) updateWatcher({ status: 'error', error: describeError(e) });
    } finally {
      this.flushing = false;
    }
  }

  /** Folders that still need polling: not observed, and (for Replays/) only once its headers were needed. */
  private polledDirs(): ReplayDir[] {
    if (state.watcher.mode !== 'handle' || !this.source) return [];
    return REPLAY_DIRS.filter((d) => !this.observers.has(d) && (d === 'data' || this.exportedSynced));
  }

  private needsPolling(): boolean {
    return this.polledDirs().length > 0;
  }

  private schedulePoll(delay = this.pollDelay): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (!this.needsPolling()) return;
    this.pollTimer = setTimeout(() => void this.pollRound(), delay);
  }

  private async pollRound(): Promise<void> {
    this.pollTimer = null;
    if (isHidden()) return; // resumed by wake() when the page becomes visible
    const found = await this.poll();
    this.pollDelay = found ? POLL_MIN_MS : Math.min(POLL_MAX_MS, Math.round(this.pollDelay * POLL_BACKOFF));
    this.schedulePoll();
  }

  /** Back on the page (tab shown / window focused): check right away and reset the backoff. */
  private wake(): void {
    if (!this.needsPolling()) return;
    this.pollDelay = POLL_MIN_MS;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    void this.pollRound();
  }

  /**
   * One polling round over the folders that are not observed: list names only and queue unknown ones
   * (read after SETTLE_MS). Replays/ is only listed once its headers were needed. Returns whether
   * anything new turned up.
   */
  async poll(): Promise<boolean> {
    const source = this.source;
    if (!source || this.polling) return false;
    this.polling = true;
    const gen = this.generation;
    let found = false;
    try {
      for (const dir of this.polledDirs()) {
        const names = await source.list(dir);
        if (gen !== this.generation) return false;
        if (!names) continue;
        const unknown = dir === 'data' ? this.index.diffDataR(names) : this.index.syncExportedNames(names);
        for (const name of unknown) this.queued.set(`${dir}/${name}`, { dir, name });
        found ||= unknown.length > 0;
        // A folder that appeared after binding can switch to change events now.
        if (hasFsObserver() && (await this.observe(dir))) updateWatcher({ detection: this.detection() });
      }
      if (found) this.scheduleSettle();
      else {
        this.publish();
        updateWatcher({ lastScanAt: Date.now(), localReplays: this.index.dataRCount });
      }
    } catch (e) {
      if (gen === this.generation) updateWatcher({ status: 'error', error: describeError(e) });
    } finally {
      this.polling = false;
    }
    return found;
  }

  /** Manual fallback when osu!.db is missing: hash every .osu under Songs in the worker. */
  async scanSongs(): Promise<number> {
    const songs = this.ctx.library.songs;
    if (!songs) throw new Error('Songs 目录不可用');
    updateWatcher({ songsScan: { done: 0, total: 0 } });
    try {
      const files = await songs.listOsuFiles();
      updateWatcher({ songsScan: { done: 0, total: files.length } });
      const hashed = await this.ctx.engine.hashFiles(files, (done, total) => updateWatcher({ songsScan: { done, total } }));
      this.ctx.library.addScanResults(hashed);
      updateWatcher({ dbEntries: this.ctx.library.size });
      await resolvePendingFromLibrary(this.ctx);
      return hashed.length;
    } finally {
      updateWatcher({ songsScan: null });
    }
  }
}

// --- IndexedDB persistence of the root handle (restored after a page reload with a permission prompt) ---

const DB_NAME = 'osu-replay-ghost';
const STORE = 'handles';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveRootHandle(h: DirHandle): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(h, 'root');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // persistence is optional
  }
}

export async function loadRootHandle(): Promise<DirHandle | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get('root');
      req.onsuccess = () => resolve((req.result as DirHandle) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

import { updateWatcher } from './actions';
import { getFileIn, tryGetDir, type DirHandle } from './fsAccess';
import { importFiles, resolvePendingFromLibrary, type ImportContext, type ImportOutcome } from './importer';
import { fileMapSongsSource, handleSongsSource } from './library';
import { state } from './state';

export const POLL_INTERVAL_MS = 3000;
const REPLAY_DIRS = [['Replays'], ['Data', 'r']] as const;

interface ReplayEntry { key: string; name: string; getFile: () => Promise<File> }

/** Lists replay files: fresh from the directory (handle mode) or from a static snapshot (webkitdirectory). */
type ReplayLister = () => Promise<ReplayEntry[]>;

interface FailedInfo { size: number; lastModified: number; error: string }

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

export class Watcher {
  private lister: ReplayLister | null = null;
  private known = new Set<string>();
  private failed = new Map<string, FailedInfo>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanning = false;
  private root: DirHandle | null = null;

  constructor(private ctx: ImportContext, private onImported: (o: ImportOutcome) => void) {}

  get rootHandle(): DirHandle | null {
    return this.root;
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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

  /** Binds via File System Access API: reads osu!.db, records a baseline (D1), then polls. */
  async bindHandle(root: DirHandle): Promise<void> {
    this.stop();
    this.root = root;
    this.known.clear();
    this.failed.clear();
    updateWatcher({ status: 'scanning', rootName: root.name, mode: 'handle', error: null, songsNeedsAuth: null, songsScan: null, restorable: null });
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
      this.lister = async () => {
        const out: ReplayEntry[] = [];
        for (const path of REPLAY_DIRS) {
          const dir = await tryGetDir(root, [...path]);
          if (!dir) continue;
          for await (const [name, h] of dir.entries()) {
            if (h.kind === 'file' && name.toLowerCase().endsWith('.osr')) {
              out.push({ key: `${path.join('/')}/${name}`, name, getFile: () => h.getFile() });
            }
          }
        }
        return out;
      };
      for (const e of await this.lister()) this.known.add(e.key);
      updateWatcher({ status: 'bound', lastScanAt: Date.now(), baselineCount: this.known.size, failedCount: 0 });
      await resolvePendingFromLibrary(this.ctx);
      this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    } catch (e) {
      updateWatcher({ status: 'error', error: describeError(e) });
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
    this.root = null;
    this.known.clear();
    this.failed.clear();
    const byPath = new Map<string, File>();
    let rootName = '';
    for (const f of files) {
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
      const parts = rel.split('/');
      rootName ||= parts.length > 1 ? parts[0] : '';
      byPath.set((parts.length > 1 ? parts.slice(1) : parts).join('/').toLowerCase(), f);
    }
    updateWatcher({ status: 'scanning', rootName: rootName || '所选目录', mode: 'files', error: null, songsNeedsAuth: null, songsScan: null });
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
      const replays: ReplayEntry[] = [];
      for (const [k, f] of byPath) {
        if ((k.startsWith('replays/') || k.startsWith('data/r/')) && k.endsWith('.osr')) {
          replays.push({ key: k, name: f.name, getFile: async () => f });
        }
      }
      this.lister = async () => replays;
      for (const e of replays) this.known.add(e.key);
      updateWatcher({ status: 'bound', songsAvailable: songs.size > 0, lastScanAt: Date.now(), baselineCount: this.known.size, failedCount: 0 });
      await resolvePendingFromLibrary(this.ctx);
    } catch (e) {
      updateWatcher({ status: 'error', error: describeError(e) });
    }
  }

  private async importEntries(entries: { entry: ReplayEntry; file: File }[], origin: string): Promise<ImportOutcome | null> {
    if (!entries.length) return null;
    const outcome = await importFiles(entries.map((e) => e.file), this.ctx, origin);
    for (const { entry, file } of entries) {
      const status = outcome.statusByFile.get(file);
      if (status === 'failed') {
        const detail = outcome.report.items.find((i) => i.fileName === file.name && i.status === 'failed')?.detail ?? '';
        this.failed.set(entry.key, { size: file.size, lastModified: file.lastModified, error: detail });
        this.known.delete(entry.key);
      } else {
        this.failed.delete(entry.key);
        this.known.add(entry.key);
      }
    }
    updateWatcher({ failedCount: this.failed.size });
    this.onImported(outcome);
    return outcome;
  }

  /** One polling round: list names only, open just the new files. Rounds never overlap. */
  async poll(): Promise<void> {
    if (this.scanning || !this.lister || state.watcher.mode !== 'handle') return;
    this.scanning = true;
    try {
      const fresh: { entry: ReplayEntry; file: File }[] = [];
      for (const entry of await this.lister()) {
        if (this.known.has(entry.key)) continue;
        const file = await entry.getFile();
        const f = this.failed.get(entry.key);
        if (f && f.size === file.size && f.lastModified === file.lastModified) continue;
        fresh.push({ entry, file });
      }
      await this.importEntries(fresh, '目录监听');
      updateWatcher({ status: 'bound', lastScanAt: Date.now(), error: null });
    } catch (e) {
      updateWatcher({ status: 'error', error: describeError(e) });
    } finally {
      this.scanning = false;
    }
  }

  async retryFailed(): Promise<ImportOutcome | null> {
    if (!this.lister || !this.failed.size) return null;
    const list = (await this.lister()).filter((e) => this.failed.has(e.key));
    return this.importEntries(await Promise.all(list.map(async (entry) => ({ entry, file: await entry.getFile() }))), '重试失败文件');
  }

  /** D1: history is not auto-imported; these import on demand. */
  async importRecent(n: number): Promise<ImportOutcome | null> {
    if (!this.lister) return null;
    const all = await Promise.all((await this.lister()).map(async (entry) => ({ entry, file: await entry.getFile() })));
    all.sort((a, b) => b.file.lastModified - a.file.lastModified);
    return this.importEntries(all.slice(0, n), `导入最近 ${n} 条`);
  }

  /** Data/r file names start with the beatmap MD5, so this needs no file reads to filter. */
  async importBeatmapHistory(md5: string): Promise<ImportOutcome | null> {
    if (!this.lister) return null;
    const list = (await this.lister()).filter((e) => /(^|\/)data\/r\//i.test(e.key) && e.name.toLowerCase().startsWith(md5));
    const entries = await Promise.all(list.map(async (entry) => ({ entry, file: await entry.getFile() })));
    return this.importEntries(entries, '导入本谱面历史');
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

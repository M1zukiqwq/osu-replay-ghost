import { beatmapInfoFrom } from '../core/beatmapSearch';
import { parseOsu } from '../core/formats/osu';
import type { DbBeatmapEntry } from '../core/formats/osudb';
import type { Beatmap, BeatmapInfo } from '../core/types';
import type { Engine } from './engine';
import { getDir, getFileIn, type DirHandle } from './fsAccess';

export interface BeatmapLocation { folder: string; fileName: string; modifiedAt: number | null }

export interface OsuFileRef { path: string; file: Blob }

/** Where .osu files under Songs can be read from. */
export interface SongsSource {
  read(folder: string, fileName: string): Promise<File>;
  listOsuFiles(): Promise<OsuFileRef[]>;
  /** Names of the beatmap folders directly under Songs. */
  listFolders(): Promise<string[]>;
  /** .osu files directly inside one beatmap folder; paths are relative to Songs. */
  listOsuFilesIn(folder: string): Promise<OsuFileRef[]>;
}

const splitPath = (p: string) => p.split(/[\\/]+/).filter(Boolean);
const isOsu = (name: string) => name.toLowerCase().endsWith('.osu');

export function handleSongsSource(dir: DirHandle): SongsSource {
  return {
    async read(folder, fileName) {
      let d = dir;
      for (const part of splitPath(folder)) d = await getDir(d, part);
      return getFileIn(d, fileName);
    },
    async listOsuFiles() {
      const out: OsuFileRef[] = [];
      const walk = async (d: DirHandle, prefix: string, depth: number) => {
        for await (const [name, h] of d.entries()) {
          if (h.kind === 'directory' && depth < 2) await walk(h, prefix + name + '/', depth + 1);
          else if (h.kind === 'file' && isOsu(name)) out.push({ path: prefix + name, file: await h.getFile() });
        }
      };
      await walk(dir, '', 0);
      return out;
    },
    async listFolders() {
      const out: string[] = [];
      for await (const [name, h] of dir.entries()) if (h.kind === 'directory') out.push(name);
      return out;
    },
    async listOsuFilesIn(folder) {
      const d = await getDir(dir, folder);
      const out: OsuFileRef[] = [];
      for await (const [name, h] of d.entries()) if (h.kind === 'file' && isOsu(name)) out.push({ path: `${folder}/${name}`, file: await h.getFile() });
      return out;
    },
  };
}

/** Songs lookup over a webkitdirectory snapshot; keys are lower-cased paths relative to Songs. */
export function fileMapSongsSource(files: Map<string, File>): SongsSource {
  return {
    async read(folder, fileName) {
      const key = [...splitPath(folder), fileName].join('/').toLowerCase();
      const f = files.get(key);
      if (!f) throw Object.assign(new Error(`Songs 中找不到 ${folder}/${fileName}`), { name: 'NotFoundError' });
      return f;
    },
    async listOsuFiles() {
      return [...files.entries()].filter(([k]) => k.endsWith('.osu')).map(([path, file]) => ({ path, file }));
    },
    async listFolders() {
      const out = new Set<string>();
      for (const k of files.keys()) if (k.includes('/')) out.add(k.slice(0, k.indexOf('/')));
      return [...out];
    },
    async listOsuFilesIn(folder) {
      const prefix = folder.toLowerCase() + '/';
      return [...files.entries()]
        .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/') && k.endsWith('.osu'))
        .map(([path, file]) => ({ path, file }));
    },
  };
}

export type ResolveResult = { beatmap: Beatmap } | { error: string } | null;

export class Library {
  songs: SongsSource | null = null;
  private index = new Map<string, BeatmapLocation>();
  private infos = new Map<string, BeatmapInfo>();
  /** Lower-cased Songs folder names already indexed (osu!.db or a scan), so scans can skip them. */
  private knownFolders = new Set<string>();
  dbLoaded = false;

  get size(): number {
    return this.index.size;
  }

  setDbIndex(entries: DbBeatmapEntry[]): number {
    let n = 0;
    for (const e of entries) {
      if (!e.md5 || !e.fileName) continue;
      this.index.set(e.md5, { folder: e.folder, fileName: e.fileName, modifiedAt: e.modifiedAt });
      this.infos.set(e.md5, e);
      this.knownFolders.add(e.folder.toLowerCase());
      n++;
    }
    this.dbLoaded = true;
    return n;
  }

  addScanResults(results: { path: string; md5: string }[]): void {
    for (const r of results) {
      const parts = splitPath(r.path);
      const fileName = parts.pop() ?? '';
      this.index.set(r.md5, { folder: parts.join('/'), fileName, modifiedAt: null });
      if (parts.length) this.knownFolders.add(parts[0].toLowerCase());
    }
  }

  has(md5: string): boolean {
    return this.index.has(md5);
  }

  info(md5: string): BeatmapInfo | null {
    return this.infos.get(md5) ?? null;
  }

  allInfos(): IterableIterator<BeatmapInfo> {
    return this.infos.values();
  }

  /** Keeps browser metadata for a map osu!.db does not list (found by a scan or imported by hand). */
  remember(b: Beatmap): void {
    if (!this.infos.has(b.md5)) this.infos.set(b.md5, beatmapInfoFrom(b));
  }

  /** Reads and parses the .osu for an MD5, verifying that the file content still matches. */
  async resolve(md5: string): Promise<ResolveResult> {
    const loc = this.index.get(md5);
    if (!loc) return null;
    if (!this.songs) return { error: '谱面库中有记录，但 Songs 目录不可用' };
    try {
      const file = await this.songs.read(loc.folder, loc.fileName);
      const beatmap = parseOsu(new Uint8Array(await file.arrayBuffer()), {
        fileName: loc.fileName,
        source: 'library',
        modifiedAt: loc.modifiedAt,
      });
      if (beatmap.md5 !== md5) return { error: `Songs 中的 ${loc.fileName} 已被修改（MD5 不一致），请在游戏中刷新谱面库` };
      this.remember(beatmap);
      return { beatmap };
    } catch (e) {
      return { error: `读取 ${loc.folder}/${loc.fileName} 失败：${(e as Error).message}` };
    }
  }

  /**
   * Hashes the .osu files of Songs folders that are not indexed yet — maps added since osu! last wrote
   * osu!.db (it only does so on exit). Returns how many .osu files were indexed.
   */
  async scanNewFolders(engine: Engine): Promise<number> {
    if (!this.songs) return 0;
    const fresh = (await this.songs.listFolders()).filter((f) => !this.knownFolders.has(f.toLowerCase()));
    const files: OsuFileRef[] = [];
    for (const folder of fresh) {
      try {
        files.push(...(await this.songs.listOsuFilesIn(folder)));
      } catch {
        // unreadable folder: skip
      }
      this.knownFolders.add(folder.toLowerCase());
    }
    if (!files.length) return 0;
    const hashed = await engine.hashFiles(files);
    this.addScanResults(hashed);
    return hashed.length;
  }
}

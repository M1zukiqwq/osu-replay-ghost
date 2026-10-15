import { parseOsu } from '../core/formats/osu';
import type { DbBeatmapEntry } from '../core/formats/osudb';
import type { Beatmap } from '../core/types';
import { getDir, getFileIn, type DirHandle } from './fsAccess';

export interface BeatmapLocation { folder: string; fileName: string; modifiedAt: number | null }

/** Where .osu files under Songs can be read from. */
export interface SongsSource {
  read(folder: string, fileName: string): Promise<File>;
  listOsuFiles(): Promise<{ path: string; file: Blob }[]>;
}

const splitPath = (p: string) => p.split(/[\\/]+/).filter(Boolean);

export function handleSongsSource(dir: DirHandle): SongsSource {
  return {
    async read(folder, fileName) {
      let d = dir;
      for (const part of splitPath(folder)) d = await getDir(d, part);
      return getFileIn(d, fileName);
    },
    async listOsuFiles() {
      const out: { path: string; file: Blob }[] = [];
      const walk = async (d: DirHandle, prefix: string, depth: number) => {
        for await (const [name, h] of d.entries()) {
          if (h.kind === 'directory' && depth < 2) await walk(h, prefix + name + '/', depth + 1);
          else if (h.kind === 'file' && name.toLowerCase().endsWith('.osu')) out.push({ path: prefix + name, file: await h.getFile() });
        }
      };
      await walk(dir, '', 0);
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
  };
}

export type ResolveResult = { beatmap: Beatmap } | { error: string } | null;

export class Library {
  songs: SongsSource | null = null;
  private index = new Map<string, BeatmapLocation>();
  dbLoaded = false;

  get size(): number {
    return this.index.size;
  }

  setDbIndex(entries: DbBeatmapEntry[]): number {
    let n = 0;
    for (const e of entries) {
      if (!e.md5 || !e.fileName) continue;
      this.index.set(e.md5, { folder: e.folder, fileName: e.fileName, modifiedAt: e.modifiedAt });
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
    }
  }

  has(md5: string): boolean {
    return this.index.has(md5);
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
      return { beatmap };
    } catch (e) {
      return { error: `读取 ${loc.folder}/${loc.fileName} 失败：${(e as Error).message}` };
    }
  }
}

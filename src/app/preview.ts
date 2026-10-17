import type { Beatmap } from '../core/types';
import { addBeatmaps, removeGroups, selectDefaultReplays, setActiveBeatmap, updatePreview } from './actions';
import { importFiles, type ImportContext, type ImportOutcome } from './importer';
import { state } from './state';
import type { LocalReplayFile, Watcher } from './watcher';

/** Local replays read per step (newest first); the rest load on demand. */
export const PAGE_SIZE = 30;
/** Browser-opened maps kept in memory besides the one on screen; older ones are dropped with their replays. */
export const KEEP_TRANSIENT = 3;

export type PreviewImportKind = 'open' | 'more' | 'live';

/**
 * Replay preview for the map picked in the beatmap browser: resolves its .osu, then reads that map's
 * local replays (Data/r + Replays/) on demand. Nothing is read for maps that are never opened.
 */
export class Preview {
  /** Local file keys already imported (or skipped as duplicates) per beatmap. */
  private loaded = new Map<string, Set<string>>();
  private lru: string[] = [];
  private token = 0;

  constructor(
    private ctx: ImportContext,
    private watcher: Watcher,
    private report: (o: ImportOutcome, kind: PreviewImportKind) => void,
  ) {
    watcher.onActiveMapFiles = (md5, files) => this.addLive(md5, files);
  }

  private loadedSet(md5: string): Set<string> {
    let s = this.loaded.get(md5);
    if (!s) this.loaded.set(md5, (s = new Set()));
    return s;
  }

  /** Shows a map: loads its .osu if needed, then the newest page of its local replays. */
  async open(md5: string): Promise<void> {
    const token = ++this.token;
    updatePreview({ key: md5, loading: true, error: null, total: null, loaded: 0 });
    try {
      if (!state.groups.some((g) => g.key === md5)) {
        const beatmap = await this.resolve(md5);
        if (token !== this.token) return;
        addBeatmaps([beatmap], true);
      }
      const switching = state.activeKey !== md5;
      setActiveBeatmap(md5);
      this.watcher.markSeen(md5);
      this.touch(md5);
      await this.loadPage(md5, token, 'open');
      // Browser-opened maps can hold dozens of replays: start from latest vs best instead of all of them.
      const g = state.groups.find((x) => x.key === md5);
      if (token === this.token && switching && g?.transient) selectDefaultReplays();
    } catch (e) {
      if (token === this.token) updatePreview({ error: (e as Error).message });
    } finally {
      if (token === this.token) updatePreview({ loading: false });
    }
  }

  /** Reads the next page of older local replays of the active map. */
  async loadMore(): Promise<void> {
    const md5 = state.activeKey;
    if (!md5) return;
    const token = ++this.token;
    updatePreview({ key: md5, loading: true, error: null });
    try {
      await this.loadPage(md5, token, 'more');
    } catch (e) {
      if (token === this.token) updatePreview({ error: (e as Error).message });
    } finally {
      if (token === this.token) updatePreview({ loading: false });
    }
  }

  private async resolve(md5: string): Promise<Beatmap> {
    const lib = this.ctx.library;
    let res = await lib.resolve(md5);
    // osu!.db is only rewritten when the game exits: look for maps added since then.
    if (!res && lib.songs && (await lib.scanNewFolders(this.ctx.engine)) > 0) res = await lib.resolve(md5);
    if (res && 'beatmap' in res) {
      if (res.beatmap.mode !== 0) throw new Error(`这是非 std 模式的谱面（Mode ${res.beatmap.mode}），目前只能分析 osu!standard`);
      return res.beatmap;
    }
    if (res) throw new Error(res.error);
    throw new Error(lib.songs
      ? '在 osu!.db 和 Songs 中都找不到这张谱面（可能已被删除），可以手动导入对应的 .osu'
      : '找不到这张谱面：请绑定 osu! 根目录，或手动导入对应的 .osu');
  }

  private async loadPage(md5: string, token: number, kind: PreviewImportKind): Promise<void> {
    if (!this.watcher.hasSource) {
      updatePreview({ total: null, loaded: 0 });
      return;
    }
    const all = await this.watcher.localReplayFiles(md5);
    if (token !== this.token) return;
    const done = this.loadedSet(md5);
    const count = () => all.filter((f) => done.has(f.key)).length;
    updatePreview({ total: all.length, loaded: count() });
    const todo = all.filter((f) => !done.has(f.key)).slice(0, PAGE_SIZE);
    if (!todo.length) return;
    await this.importLocal(md5, todo, false, kind);
    if (token === this.token) updatePreview({ loaded: count() });
  }

  /** New or rewritten replay files of the map on screen (from the watcher). */
  private async addLive(md5: string, files: LocalReplayFile[]): Promise<void> {
    if (state.activeKey !== md5) return;
    const done = this.loadedSet(md5);
    const todo = files.filter((f) => !done.has(f.key));
    if (!todo.length) return;
    await this.importLocal(md5, todo, true, 'live');
    if (state.preview.key === md5) updatePreview({ total: this.watcher.countFor(md5), loaded: done.size });
  }

  private async importLocal(md5: string, refs: LocalReplayFile[], select: boolean, kind: PreviewImportKind): Promise<void> {
    const done = this.loadedSet(md5);
    const read: { ref: LocalReplayFile; file: File }[] = [];
    for (const ref of refs) {
      try {
        read.push({ ref, file: await ref.getFile() });
      } catch {
        // deleted since it was listed
      }
    }
    if (!read.length) return;
    const outcome = await importFiles(read.map((r) => r.file), this.ctx, kind === 'live' ? '新回放' : '读取本地回放', { transient: true, select });
    for (const { ref, file } of read) if (outcome.statusByFile.get(file) !== 'failed') done.add(ref.key);
    this.report(outcome, kind);
  }

  /** Most-recently-opened bookkeeping; drops browser-opened maps beyond KEEP_TRANSIENT. */
  private touch(md5: string): void {
    this.lru = [md5, ...this.lru.filter((k) => k !== md5)];
    const keep = new Set(this.lru.slice(0, KEEP_TRANSIENT + 1));
    const drop = new Set(state.groups.filter((g) => g.transient && !keep.has(g.key) && g.key !== state.activeKey).map((g) => g.key));
    if (!drop.size) return;
    for (const k of drop) this.loaded.delete(k);
    this.lru = this.lru.filter((k) => !drop.has(k));
    removeGroups(drop);
  }
}

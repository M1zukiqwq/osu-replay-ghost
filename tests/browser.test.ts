import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDirectEngine } from '../src/app/engine';
import type { DirHandle, FileHandle, FsChangeRecord } from '../src/app/fsAccess';
import type { ImportContext } from '../src/app/importer';
import { Library } from '../src/app/library';
import { KEEP_TRANSIENT, Preview, type PreviewImportKind } from '../src/app/preview';
import { ReplayIndex } from '../src/app/replayIndex';
import { getActiveGroup, getPrimaryReplay, resetState, state } from '../src/app/state';
import { SETTLE_MS, Watcher } from '../src/app/watcher';
import { md5Text } from '../src/core/binary/md5';
import { beatmapInfoFrom, parseSearchQuery, searchBeatmaps } from '../src/core/beatmapSearch';
import { decodeOsrFrames, parseOsr, peekOsrHeader, writeOsr } from '../src/core/formats/osr';
import { parseOsu } from '../src/core/formats/osu';
import { parseDataRName, replayStampToUnixMs } from '../src/core/formats/replayFiles';
import type { BeatmapInfo } from '../src/core/types';
import { fixture, map, osuText } from './helpers';

const FIXTURE_MD5 = parseOsu(fixture('fixture_map.osu')).md5;
const MS_2024 = Date.UTC(2024, 0, 2, 3, 4, 5);
/** Data/r stamp (Windows FILETIME) for a Unix time. */
const stamp = (ms: number) => String(BigInt(ms) * 10000n + 116444736000000000n);
const dataRName = (md5: string, ms: number) => `${md5}-${stamp(ms)}.osr`;

/** The NM fixture replay re-encoded under another player name (a distinct replay). */
function replayAs(player: string): Uint8Array {
  const src = parseOsr(fixture('replay_nm.osr'));
  return writeOsr({ ...src.header, playerName: player, replayMd5: md5Text(player) }, decodeOsrFrames(src.compressed));
}

describe('Data/r names and .osr header peeking', () => {
  it('reads the beatmap MD5 and the play time (FILETIME or .NET ticks) from the name', () => {
    expect(parseDataRName(dataRName('A'.repeat(32), MS_2024))).toEqual({ md5: 'a'.repeat(32), playedAt: MS_2024 });
    expect(replayStampToUnixMs(String(BigInt(MS_2024) * 10000n + 621355968000000000n))).toBe(MS_2024);
    expect(parseDataRName(`${'b'.repeat(32)}-12345.osr`)).toEqual({ md5: 'b'.repeat(32), playedAt: null });
    expect(parseDataRName('Player - Song [Hard] (2024-01-02) Osu.osr')).toBeNull();
  });

  it('peeks mode, beatmap MD5 and player from the first bytes only', () => {
    const head = fixture('replay_hr.osr').subarray(0, 128);
    expect(peekOsrHeader(head)).toEqual({ mode: 0, gameVersion: 20250107, beatmapMd5: FIXTURE_MD5, playerName: 'HRPlayer' });
    expect(peekOsrHeader(new Uint8Array([0, 1, 2]))).toBeNull();
  });
});

describe('beatmap search', () => {
  const info = (md5: string, o: Partial<BeatmapInfo>): BeatmapInfo => ({ ...beatmapInfoFrom(map({ objects: [] })), md5, ...o });
  const catalog = [
    info('1'.repeat(32), { beatmapId: 100, beatmapSetId: 7, artist: 'xi', title: 'FREEDOM DiVE', version: 'FOUR DIMENSIONS', lastPlayedAt: 5 }),
    info('2'.repeat(32), { beatmapId: 7, beatmapSetId: 50, artist: 'xi', title: 'Blue Zenith', creator: 'Asphyxia', lastPlayedAt: 9 }),
    info('3'.repeat(32), { beatmapId: 101, beatmapSetId: 7, title: 'FREEDOM DiVE', version: 'Another', tags: 'stream' }),
    info('4'.repeat(32), { beatmapId: 102, beatmapSetId: 7, title: 'FREEDOM DiVE', mode: 3 }),
  ];
  const ids = (q: string) => searchBeatmaps(catalog, parseSearchQuery(q), 10).items.map((i) => i.md5[0]);

  it('parses IDs, links, prefixes, MD5s and keywords', () => {
    expect(parseSearchQuery('  ')).toEqual({ kind: 'empty' });
    expect(parseSearchQuery('129891')).toMatchObject({ kind: 'id', anyId: 129891 });
    expect(parseSearchQuery('https://osu.ppy.sh/beatmapsets/39804#osu/129891')).toMatchObject({ kind: 'id', beatmapId: 129891, beatmapSetId: null });
    expect(parseSearchQuery('https://osu.ppy.sh/beatmapsets/39804')).toMatchObject({ kind: 'id', beatmapSetId: 39804 });
    expect(parseSearchQuery('https://osu.ppy.sh/b/129891')).toMatchObject({ kind: 'id', beatmapId: 129891 });
    expect(parseSearchQuery('s:39804')).toMatchObject({ kind: 'id', beatmapSetId: 39804 });
    expect(parseSearchQuery('A'.repeat(32))).toEqual({ kind: 'md5', md5: 'a'.repeat(32) });
    expect(parseSearchQuery('Freedom  dive')).toEqual({ kind: 'text', terms: ['freedom', 'dive'] });
  });

  it('a bare number matches Beatmap ID or set ID, exact Beatmap ID first; std only', () => {
    expect(ids('7')).toEqual(['2', '1', '3']);
    expect(ids('b:7')).toEqual(['2']);
    expect(ids('s:7')).toEqual(['1', '3']);
  });

  it('keywords must all match across title, artist, creator, difficulty and tags', () => {
    expect(ids('freedom dive')).toEqual(['1', '3']);
    expect(ids('xi asphyxia')).toEqual(['2']);
    expect(ids('dive stream')).toEqual(['3']);
    expect(ids('nothing')).toEqual([]);
  });

  it('reports the total beyond the display limit', () => {
    const r = searchBeatmaps(catalog, parseSearchQuery('freedom'), 1);
    expect(r.items).toHaveLength(1);
    expect(r.total).toBe(2);
  });
});

describe('replay index', () => {
  it('groups Data/r names by beatmap, orders maps by last play and diffs listings without adding', () => {
    const idx = new ReplayIndex();
    const a = 'a'.repeat(32);
    const b = 'b'.repeat(32);
    idx.syncDataR([dataRName(a, MS_2024), dataRName(a, MS_2024 + 5000), dataRName(b, MS_2024 + 1000), 'junk.osr']);
    expect(idx.dataRCount).toBe(3);
    expect(idx.recent(10)).toEqual([
      { md5: a, lastPlayedAt: MS_2024 + 5000, count: 2 },
      { md5: b, lastPlayedAt: MS_2024 + 1000, count: 1 },
    ]);
    expect(idx.dataRFor(a).map((r) => r.playedAt)).toEqual([MS_2024 + 5000, MS_2024]);
    const next = [dataRName(a, MS_2024), dataRName(b, MS_2024 + 9000)];
    expect(idx.diffDataR(next)).toEqual([dataRName(b, MS_2024 + 9000)]);
    expect(idx.dataRCount).toBe(1); // vanished names dropped, the new one not added yet
    idx.setExported('x.osr', a);
    idx.setExported('y.osr', null);
    expect(idx.exportedFor(a)).toEqual(['x.osr']);
    expect(idx.countFor(a)).toBe(2);
    expect(idx.syncExportedNames(['x.osr', 'z.osr'])).toEqual(['z.osr']);
  });
});

// --- Watcher + Preview against an in-memory directory tree -----------------------------------------

const notFound = (name: string) => Object.assign(new Error(name), { name: 'NotFoundError' });

class FakeDir implements DirHandle {
  readonly kind = 'directory' as const;
  readonly children = new Map<string, FakeDir | File>();
  listings = 0;
  constructor(readonly name: string) {}

  dir(name: string): FakeDir {
    let d = this.children.get(name);
    if (!(d instanceof FakeDir)) this.children.set(name, (d = new FakeDir(name)));
    return d;
  }

  put(name: string, bytes: Uint8Array | string): void {
    this.children.set(name, new File([bytes as BlobPart], name));
  }

  private handle(name: string, c: FakeDir | File): DirHandle | FileHandle {
    return c instanceof FakeDir ? c : { kind: 'file', name, getFile: async () => c };
  }

  async *entries(): AsyncIterableIterator<[string, DirHandle | FileHandle]> {
    this.listings++;
    for (const [n, c] of [...this.children]) yield [n, this.handle(n, c)];
  }

  async *keys(): AsyncIterableIterator<string> {
    this.listings++;
    for (const n of [...this.children.keys()]) yield n;
  }

  async getDirectoryHandle(name: string): Promise<DirHandle> {
    const c = this.children.get(name);
    if (c instanceof FakeDir) return c;
    throw notFound(name);
  }

  async getFileHandle(name: string): Promise<FileHandle> {
    const c = this.children.get(name);
    if (c instanceof File) return this.handle(name, c) as FileHandle;
    throw notFound(name);
  }
}

describe('beatmap browser and on-demand replay preview', () => {
  const engine = createDirectEngine();
  let ctx: ImportContext;
  let kinds: PreviewImportKind[];

  beforeEach(() => {
    resetState();
    vi.useFakeTimers();
    ctx = { engine, library: new Library() };
    kinds = [];
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as { FileSystemObserver?: unknown }).FileSystemObserver;
  });

  function osuFolder(): { root: FakeDir; dataR: FakeDir; replays: FakeDir } {
    const root = new FakeDir('osu!');
    root.dir('Songs').dir('999 Fixture').put('fixture.osu', fixture('fixture_map.osu'));
    const dataR = root.dir('Data').dir('r');
    dataR.put(dataRName(FIXTURE_MD5, MS_2024), fixture('replay_nm.osr'));
    dataR.put(dataRName('c'.repeat(32), MS_2024 + 60000), fixture('replay_missing_map.osr'));
    const replays = root.dir('Replays');
    replays.put('HRPlayer - Fixture [Judgement].osr', fixture('replay_hr.osr'));
    replays.put('Orphan - Other.osr', fixture('replay_missing_map.osr'));
    return { root, dataR, replays };
  }

  it('binding only indexes Data/r names; opening a map reads just its replays; a new play joins the open map', async () => {
    const { root, dataR, replays } = osuFolder();
    const watcher = new Watcher(ctx);
    const preview = new Preview(ctx, watcher, (_o, kind) => kinds.push(kind));
    await watcher.bindHandle(root);

    expect(state.watcher).toMatchObject({ status: 'bound', mode: 'handle', detection: 'polling', localReplays: 2, dbEntries: null });
    expect(state.browser.tab).toBe('recent');
    expect(state.browser.recent.map((r) => r.md5)).toEqual(['c'.repeat(32), FIXTURE_MD5]);
    expect(state.groups).toHaveLength(0);
    expect(replays.listings).toBe(0);

    // No osu!.db: the map is found by hashing only the Songs folders that are not indexed yet.
    await preview.open(FIXTURE_MD5);
    const g = getActiveGroup()!;
    expect(g).toMatchObject({ key: FIXTURE_MD5, transient: true });
    expect(g.replays.map((r) => r.playerName).sort()).toEqual(['FixturePlayer', 'HRPlayer']);
    expect(state.preview).toMatchObject({ key: FIXTURE_MD5, loading: false, total: 2, loaded: 2, error: null });
    expect(state.groups).toHaveLength(1); // the orphan in Replays/ belongs to another map and is not read further

    const newName = dataRName(FIXTURE_MD5, MS_2024 + 120000);
    dataR.put(newName, replayAs('NewPlayer'));
    expect(await watcher.poll()).toBe(true);
    await watcher.flush();
    expect(getActiveGroup()!.replays).toHaveLength(3);
    expect(getPrimaryReplay()!.playerName).toBe('NewPlayer');
    expect(state.browser.recent[0]).toMatchObject({ md5: FIXTURE_MD5, count: 2, isNew: false });
    expect(kinds).toEqual(['open', 'live']);

    // A play on another map only updates the list.
    dataR.put(dataRName('d'.repeat(32), MS_2024 + 180000), fixture('replay_missing_map.osr'));
    await watcher.poll();
    await watcher.flush();
    expect(state.browser.recent[0]).toMatchObject({ md5: 'd'.repeat(32), isNew: true });
    expect(state.activeKey).toBe(FIXTURE_MD5);

    // Coming back to a browser-opened map starts from latest vs best, not every loaded replay.
    const other = osuText({ title: 'Other', objects: ['100,100,1000,1,0'] });
    root.dir('Songs').dir('1000 Other').put('other.osu', other);
    await preview.open(parseOsu(new TextEncoder().encode(other)).md5);
    await preview.open(FIXTURE_MD5);
    expect(getActiveGroup()!.replays).toHaveLength(3);
    expect(state.selectedIds.size).toBeLessThanOrEqual(2);
    expect(getPrimaryReplay()!.playerName).toBe('NewPlayer');
  });

  it('polling backs off while idle instead of listing every 3 s', async () => {
    const { root, dataR } = osuFolder();
    await new Watcher(ctx).bindHandle(root);
    const before = dataR.listings;
    await vi.advanceTimersByTimeAsync(60000);
    const rounds = dataR.listings - before;
    expect(rounds).toBeGreaterThanOrEqual(5); // 3 s, 4.5 s, 6.75 s, … capped at 15 s
    expect(rounds).toBeLessThanOrEqual(6);
  });

  it('with FileSystemObserver nothing is polled; change events update the recent list', async () => {
    const observers: { cb: (r: FsChangeRecord[]) => void; dirs: DirHandle[] }[] = [];
    (globalThis as { FileSystemObserver?: unknown }).FileSystemObserver = class {
      dirs: DirHandle[] = [];
      constructor(public cb: (r: FsChangeRecord[]) => void) {
        observers.push(this);
      }
      async observe(d: DirHandle) {
        this.dirs.push(d);
      }
      disconnect() {}
    };
    const { root, dataR } = osuFolder();
    await new Watcher(ctx).bindHandle(root);
    expect(state.watcher.detection).toBe('events');
    const listed = dataR.listings;
    await vi.advanceTimersByTimeAsync(60000);
    expect(dataR.listings).toBe(listed);

    const name = dataRName('e'.repeat(32), MS_2024 + 999000);
    dataR.put(name, fixture('replay_missing_map.osr'));
    observers.find((o) => o.dirs.includes(dataR))!.cb([{ type: 'appeared', changedHandle: null, relativePathComponents: [name] }]);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(state.browser.recent[0]).toMatchObject({ md5: 'e'.repeat(32), isNew: true, count: 1 });
    expect(dataR.listings).toBe(listed);
  });

  it('keeps only a few browser-opened maps in memory and reports maps that cannot be found', async () => {
    const root = new FakeDir('osu!');
    const md5s: string[] = [];
    for (let i = 0; i < 5; i++) {
      const text = osuText({ title: `Map ${i}`, objects: ['100,100,1000,1,0'] });
      root.dir('Songs').dir(`${i} Map`).put(`map${i}.osu`, text);
      md5s.push(parseOsu(new TextEncoder().encode(text)).md5);
    }
    const watcher = new Watcher(ctx);
    const preview = new Preview(ctx, watcher, () => {});
    await watcher.bindHandle(root);
    for (const md5 of md5s) await preview.open(md5);
    expect(state.groups.map((g) => g.key).sort()).toEqual(md5s.slice(-(KEEP_TRANSIENT + 1)).sort());
    expect(state.activeKey).toBe(md5s[4]);
    expect(state.preview).toMatchObject({ total: 0, loaded: 0 });

    await preview.open('9'.repeat(32));
    expect(state.preview.error).toMatch(/找不到这张谱面/);
    expect(state.activeKey).toBe(md5s[4]);
  });
});

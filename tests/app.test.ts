import { beforeEach, describe, expect, it } from 'vitest';
import {
  adjustScope, clearDemoData, drillScope, popScope, quickSelect, seek, selectSlice, setActiveBeatmap, setPrimary, setScope,
  setSliceDuration, toggleReplay,
} from '../src/app/actions';
import { loadDemo, simulateNewPlay } from '../src/app/demo';
import { createDirectEngine } from '../src/app/engine';
import { buildSampleFiles } from '../src/app/exportSample';
import { importFiles, resolvePendingFromLibrary, type ImportContext } from '../src/app/importer';
import { fileMapSongsSource, Library } from '../src/app/library';
import { getActiveGroup, getPrimaryReplay, getSelectedReplays, isAnalyzable, resetState, state } from '../src/app/state';
import { parseOsu } from '../src/core/formats/osu';
import { mulberry32 } from '../src/core/demo/prng';
import { dbEntry, fixture, fixtureFile, osuText } from './helpers';

const engine = createDirectEngine();
let ctx: ImportContext;
const FIXTURE_MD5 = parseOsu(fixture('fixture_map.osu')).md5;

beforeEach(() => {
  resetState();
  ctx = { engine, library: new Library() };
});

function checkInvariants(): void {
  const g = getActiveGroup();
  if (!g) return;
  const analyzable = g.replays.filter(isAnalyzable).map((r) => r.id);
  for (const id of state.selectedIds) expect(analyzable).toContain(id);
  if (analyzable.length) {
    expect(state.selectedIds.size).toBeGreaterThan(0);
    expect(state.selectedIds.has(state.primaryId!)).toBe(true);
  }
  const d = g.beatmap.durationMs;
  expect(state.scope.startMs).toBeGreaterThanOrEqual(0);
  expect(state.scope.startMs).toBeLessThan(state.scope.endMs);
  expect(state.scope.endMs).toBeLessThanOrEqual(d);
  if (state.scope.type === 'custom') expect(state.scope.endMs - state.scope.startMs).toBeGreaterThanOrEqual(200);
  expect(state.currentTimeMs).toBeGreaterThanOrEqual(0);
  expect(state.currentTimeMs).toBeLessThanOrEqual(d);
}

describe('import pipeline', () => {
  it('replays without a beatmap wait in pending and attach to the right group later [B2]', async () => {
    await loadDemo(engine);
    const before = getActiveGroup()!.replays.length;
    const r1 = await importFiles([fixtureFile('replay_nm.osr')], ctx, 'test');
    expect(r1.report.items[0].status).toBe('pending');
    expect(state.pending).toHaveLength(1);
    expect(getActiveGroup()!.replays).toHaveLength(before);
    await importFiles([fixtureFile('fixture_map.osu')], ctx, 'test');
    expect(state.pending).toHaveLength(0);
    const g = state.groups.find((x) => x.key === FIXTURE_MD5)!;
    expect(g.replays).toHaveLength(1);
    expect(g.replays[0].analysis!.simulated.cMiss).toBe(0);
    expect(state.activeKey).toBe(FIXTURE_MD5);
    checkInvariants();
  });

  it('isolates failures, skips non-std and reports each file [B11 B36]', async () => {
    const out = await importFiles(
      ['fixture_map.osu', 'replay_truncated.osr', 'replay_nm.osr', 'replay_taiko.osr', 'notes.txt'].map((n) =>
        n.endsWith('.txt') ? new File(['x'], n) : fixtureFile(n),
      ),
      ctx,
      'test',
    );
    const byName = Object.fromEntries(out.report.items.map((i) => [i.fileName, i.status]));
    expect(byName).toMatchObject({
      'fixture_map.osu': 'ok', 'replay_truncated.osr': 'failed', 'replay_nm.osr': 'ok', 'replay_taiko.osr': 'nonStd', 'notes.txt': 'ignored',
    });
    expect(out.report.items.find((i) => i.status === 'failed')!.detail).toMatch(/越界/);
    expect(getActiveGroup()!.replays).toHaveLength(1);
    expect(state.importLog).toHaveLength(1);
  });

  it('re-importing the same .osu or .osr is a duplicate and changes nothing [B10]', async () => {
    await importFiles([fixtureFile('fixture_map.osu'), fixtureFile('replay_nm.osr')], ctx, 'test');
    const g = getActiveGroup()!;
    const out = await importFiles([fixtureFile('fixture_map.osu'), fixtureFile('replay_nm.osr')], ctx, 'test');
    expect(out.report.items.map((i) => i.status)).toEqual(['duplicate', 'duplicate']);
    expect(state.groups).toHaveLength(1);
    expect(getActiveGroup()).toBe(g);
    expect(g.replays).toHaveLength(1);
  });

  it('a replay whose trajectory cannot be decoded is kept with header data only, never synthesised [B3]', async () => {
    await importFiles([fixtureFile('fixture_map.osu')], ctx, 'test');
    const bytes = fixture('replay_nm.osr').slice();
    // Destroy the LZMA body but keep the container intact (body starts 13 bytes into the compressed block).
    const view = new DataView(bytes.buffer);
    let off = 1 + 4;
    const skipStr = () => { if (bytes[off++] === 0x0b) { let len = 0, shift = 0, b; do { b = bytes[off++]; len |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80); off += len; } };
    skipStr(); skipStr(); skipStr();
    off += 12 + 4 + 2 + 1 + 4;
    skipStr();
    off += 8;
    const compLen = view.getInt32(off, true);
    off += 4;
    bytes.fill(0x55, off + 13, off + compLen);
    await importFiles([new File([bytes], 'broken.osr')], ctx, 'test');
    const rep = getActiveGroup()!.replays[0];
    expect(rep.frames).toBeNull();
    expect(rep.analysis).toBeNull();
    expect(rep.decodeError).toMatch(/轨迹解析失败/);
    expect(getSelectedReplays()).toHaveLength(0);
    expect(toggleReplay(rep.id, true).ok).toBe(false);
  });

  it('two unsubmitted maps (BeatmapID 0) become two separate groups [B9]', async () => {
    const a = new File([osuText({ title: 'One', objects: ['1,1,1000,1,0'] })], 'a.osu');
    const b = new File([osuText({ title: 'Two', objects: ['1,1,1000,1,0'] })], 'b.osu');
    await importFiles([a, b], ctx, 'test');
    expect(state.groups.map((g) => g.beatmap.title).sort()).toEqual(['One', 'Two']);
    expect(state.groups.every((g) => g.beatmap.beatmapId === null)).toBe(true);
  });

  it('switching to an imported map resets scope and time [B12]', async () => {
    await loadDemo(engine);
    expect(state.scope.type).toBe('slice');
    await importFiles([fixtureFile('fixture_map.osu'), fixtureFile('replay_nm.osr')], ctx, 'test');
    expect(state.scope).toMatchObject({ type: 'full', startMs: 0, endMs: getActiveGroup()!.beatmap.durationMs });
    expect(state.currentTimeMs).toBe(0);
    expect(state.isPlaying).toBe(false);
  });

  it('resolves replays through osu!.db + Songs without importing the .osu manually [B1]', async () => {
    ctx.library.setDbIndex([dbEntry({ md5: FIXTURE_MD5, folder: '999 Fixture', fileName: 'fixture.osu' })]);
    ctx.library.songs = fileMapSongsSource(new Map([['999 fixture/fixture.osu', fixtureFile('fixture_map.osu')]]));
    const out = await importFiles([fixtureFile('replay_hr.osr')], ctx, 'test');
    expect(out.report.items[0].status).toBe('ok');
    expect(getActiveGroup()!.beatmap.source).toBe('library');
    expect(getActiveGroup()!.replays[0].analysis!.simulated.cMiss).toBe(0);
  });

  it('pending replays resolve once the library learns about their map', async () => {
    await importFiles([fixtureFile('replay_nm.osr')], ctx, 'test');
    expect(state.pending).toHaveLength(1);
    ctx.library.songs = fileMapSongsSource(new Map([['x/f.osu', fixtureFile('fixture_map.osu')]]));
    ctx.library.addScanResults([{ path: 'x/f.osu', md5: FIXTURE_MD5 }]);
    expect(await resolvePendingFromLibrary(ctx)).toBe(1);
    expect(state.pending).toHaveLength(0);
  });
});

describe('state actions and invariants [B18 B27]', () => {
  it('keeps colours fixed when new replays are added', async () => {
    await loadDemo(engine);
    const colours = new Map(getActiveGroup()!.replays.map((r) => [r.id, r.colorIdx]));
    await simulateNewPlay(engine);
    for (const r of getActiveGroup()!.replays) if (colours.has(r.id)) expect(r.colorIdx).toBe(colours.get(r.id));
    expect(new Set(getActiveGroup()!.replays.map((r) => r.colorIdx)).size).toBe(4);
  });

  it('holds invariants across random action sequences', async () => {
    await loadDemo(engine);
    await importFiles([fixtureFile('fixture_map.osu'), fixtureFile('replay_nm.osr'), fixtureFile('replay_hr.osr')], ctx, 'test');
    const rand = mulberry32(5);
    const pick = <T>(a: T[]) => a[Math.floor(rand() * a.length)];
    for (let i = 0; i < 400; i++) {
      const g = getActiveGroup()!;
      const ids = g.replays.map((r) => r.id);
      const d = g.beatmap.durationMs;
      const op = Math.floor(rand() * 9);
      if (op === 0) setActiveBeatmap(pick(state.groups).key);
      else if (op === 1) toggleReplay(pick(ids), rand() < 0.5);
      else if (op === 2) setPrimary(pick(ids));
      else if (op === 3) quickSelect(pick(['all', 'miss', 'bestVsLatest'] as const));
      else if (op === 4) setScope({ type: 'custom', startMs: rand() * d * 1.2 - 100, endMs: rand() * d * 1.2 - 100 });
      else if (op === 5) seek(rand() * d * 1.4 - 500);
      else if (op === 6) setSliceDuration(pick([1000, 2000, 3000, 5000]));
      else if (op === 7) selectSlice(Math.floor(rand() * 20));
      else for (const id of ids) toggleReplay(id, false);
      checkInvariants();
    }
  });

  it('detail-bar drill-down keeps a scope history that any other scope change resets', async () => {
    await loadDemo(engine);
    expect(state.scope).toMatchObject({ type: 'slice', startMs: 4000, endMs: 6000 });
    drillScope({ type: 'custom', startMs: 4500, endMs: 5500 });
    adjustScope({ type: 'custom', startMs: 4400, endMs: 5500 });
    drillScope({ type: 'custom', startMs: 4600, endMs: 4650 });
    expect(state.scope).toMatchObject({ startMs: 4600, endMs: 4800 }); // custom scopes stay >= 200 ms
    expect(state.scopeHistory).toHaveLength(2);
    expect(popScope()).toBe(true);
    expect(state.scope).toMatchObject({ startMs: 4400, endMs: 5500 });
    expect(popScope()).toBe(true);
    expect(state.scope).toMatchObject({ type: 'slice', sliceIndex: 2, startMs: 4000, endMs: 6000 });
    expect(popScope()).toBe(false);
    drillScope({ type: 'custom', startMs: 4500, endMs: 5500 });
    selectSlice(0);
    expect(state.scopeHistory).toHaveLength(0);
    drillScope({ type: 'custom', startMs: 500, endMs: 900 });
    setActiveBeatmap(state.groups[1].key);
    expect(state.scopeHistory).toHaveLength(0);
  });

  it('cannot deselect the last replay of the active map even if other maps have selections', async () => {
    await loadDemo(engine);
    for (const r of getActiveGroup()!.replays) toggleReplay(r.id, false);
    expect(getSelectedReplays()).toHaveLength(1);
    expect(toggleReplay(getSelectedReplays()[0].id, false).message).toMatch(/至少保留/);
  });

  it('“best vs latest” tells the user when only one replay could be chosen', async () => {
    await loadDemo(engine);
    setActiveBeatmap(state.groups[1].key);
    const res = quickSelect('bestVsLatest');
    expect(res.ok).toBe(true);
  });

  it('clearing demo data leaves real imports and valid state', async () => {
    await loadDemo(engine);
    await importFiles([fixtureFile('fixture_map.osu'), fixtureFile('replay_nm.osr')], ctx, 'test');
    clearDemoData();
    expect(state.groups.every((g) => g.beatmap.source !== 'demo')).toBe(true);
    expect(getPrimaryReplay()).not.toBeNull();
    checkInvariants();
  });
});

describe('demo data', () => {
  it('loads the documented initial view', async () => {
    await loadDemo(engine);
    const g = getActiveGroup()!;
    expect(g.beatmap.beatmapId).toBe(7562909);
    expect(g.beatmap.hitObjects).toHaveLength(40);
    expect(state.groups[1].beatmap.hitObjects).toHaveLength(29);
    expect([...state.selectedIds].sort()).toEqual(['rep_fd_1', 'rep_fd_2']);
    expect(state.primaryId).toBe('rep_fd_1');
    expect(state.scope).toMatchObject({ type: 'slice', sliceIndex: 2, startMs: 4000, endMs: 6000 });
    expect(state.currentTimeMs).toBe(4100);
    expect(state.playbackSpeed).toBe(0.25);
    expect(g.replays.every((r) => r.source === 'demo')).toBe(true);
  });

  it('HR demo replays are generated in HR conventions and are not mass-missed [B4]', async () => {
    await loadDemo(engine);
    const pb = getActiveGroup()!.replays.find((r) => r.id === 'rep_fd_2')!;
    expect(pb.modNames).toEqual(['HR', 'HD']);
    expect(pb.analysis!.simulated.cMiss).toBe(0);
    const overaim = getActiveGroup()!.replays.find((r) => r.id === 'rep_fd_1')!;
    expect(overaim.analysis!.judgments.filter((j) => j.judgment === 'MISS' && j.noteTime >= 4000 && j.noteTime < 6000).length).toBeGreaterThan(0);
  });

  it('“simulate new play” on an empty map reports instead of crashing [B22]', async () => {
    await importFiles([new File([osuText({ objects: [] })], 'empty.osu')], ctx, 'test');
    const res = await simulateNewPlay(engine);
    expect(res.ok).toBe(false);
  });
});

describe('sample export [B25]', () => {
  it('exports a .osu + .osr pair that re-imports and matches', async () => {
    await loadDemo(engine);
    const g = getActiveGroup()!;
    const files = buildSampleFiles(g.beatmap, getPrimaryReplay());
    const exported = parseOsu(files.osu);
    expect(exported.md5).toBe(files.beatmapMd5);
    expect(exported.hitObjects.map((o) => [o.type, o.newCombo, Math.round(o.endTime)])).toEqual(
      g.beatmap.hitObjects.map((o) => [o.type, o.newCombo, Math.round(o.endTime)]),
    );
    resetState();
    const fresh: ImportContext = { engine, library: new Library() };
    const out = await importFiles([new File([files.osr! as BlobPart], files.osrName!), new File([files.osu as BlobPart], files.osuName)], fresh, 'test');
    expect(out.report.items.map((i) => i.status)).toEqual(['ok', 'ok']);
    const rep = getActiveGroup()!.replays[0];
    const original = g.replays.find((r) => r.id === 'rep_fd_1')!;
    expect(rep.analysis!.simulated).toEqual(original.analysis!.simulated);
    expect(rep.playedAt).toBe(original.playedAt);
  });
});

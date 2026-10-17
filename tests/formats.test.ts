import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BinaryReader } from '../src/core/binary/reader';
import { BinaryWriter } from '../src/core/binary/writer';
import { md5Bytes } from '../src/core/binary/md5';
import { parseOsr, ticksToUnixMs, unixMsToTicks, writeOsr } from '../src/core/formats/osr';
import { parseOsuDb } from '../src/core/formats/osudb';
import { decodeReplayFile } from '../src/core/replay/decode';
import { decodeMods, MOD } from '../src/core/replay/mods';
import { fixture } from './helpers';

describe('md5', () => {
  it('matches node:crypto for every length 0..300 and a few large inputs', () => {
    let seed = 1;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xff;
    const lengths = [...Array.from({ length: 301 }, (_, i) => i), 1000, 4095, 4096, 4097, 65536 + 7];
    for (const n of lengths) {
      const data = new Uint8Array(n).map(() => rand());
      expect(md5Bytes(data), `length ${n}`).toBe(createHash('md5').update(data).digest('hex'));
    }
  });
});

describe('BinaryReader', () => {
  it('reports out-of-bounds reads with the field name instead of returning garbage', () => {
    const r = new BinaryReader(new Uint8Array([1, 2]));
    expect(() => r.i32('总分')).toThrow(/总分.*越界/);
  });

  it('rejects strings whose declared length exceeds the buffer', () => {
    const bytes = new BinaryWriter().u8(0x0b).uleb128(50).finish();
    expect(() => new BinaryReader(bytes).string('玩家名')).toThrow(/玩家名/);
  });

  it('round-trips writer output', () => {
    const w = new BinaryWriter().u8(7).u16(65535).i32(-5).i64(123456789012345n).f32(1.5).f64(Math.PI).string('héllo').string(null);
    const r = new BinaryReader(w.finish());
    expect([r.u8(), r.u16(), r.i32(), r.i64(), r.f32(), r.f64(), r.string(), r.string()]).toEqual([
      7, 65535, -5, 123456789012345n, 1.5, Math.PI, 'héllo', '',
    ]);
    expect(r.remaining).toBe(0);
  });
});

describe('.osr', () => {
  it('decodes a real LZMA (liblzma) replay and drops placeholder and seed frames', () => {
    const dec = decodeReplayFile(fixture('replay_nm.osr'));
    expect(dec.decodeError).toBeNull();
    const frames = dec.frames!;
    expect(frames.length).toBeGreaterThan(100);
    expect(frames.some((f) => f.y === -500)).toBe(false);
    expect(frames[0].time).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < frames.length; i++) expect(frames[i].time).toBeGreaterThanOrEqual(frames[i - 1].time);
    expect(frames.some((f) => f.time < 0 || f.keys === 7777777)).toBe(false);
  });

  it('accepts a known uncompressed size in the LZMA header (as osu! writes it)', () => {
    const a = decodeReplayFile(fixture('replay_nm.osr'));
    const b = decodeReplayFile(fixture('replay_nm_known_size.osr'));
    expect(b.frames).toEqual(a.frames);
  });

  it('converts the Windows ticks timestamp to the play time [B29]', () => {
    const { header } = parseOsr(fixture('replay_nm.osr'));
    expect(header.playedAt).toBe(Date.UTC(2024, 0, 2, 3, 4, 5));
    expect(ticksToUnixMs(unixMsToTicks(1700000000123))).toBe(1700000000123);
  });

  it('reads the header of non-std replays but does not decode them [B36]', () => {
    const dec = decodeReplayFile(fixture('replay_taiko.osr'));
    expect(dec.header.mode).toBe(1);
    expect(dec.frames).toBeNull();
  });

  it('throws a readable error for a truncated file [B11]', () => {
    expect(() => decodeReplayFile(fixture('replay_truncated.osr'))).toThrow(/回放帧数据.*越界/);
  });

  it('reports (not fabricates) a corrupt frame stream [B3]', () => {
    const { header } = parseOsr(fixture('replay_nm.osr'));
    const bytes = writeOsr(header, [{ w: 16, x: 1, y: 2, z: 0 }]);
    // Keep the .osr and LZMA headers intact; destroy the range-coded body (layout: …, len, data, Long id).
    const compLen = parseOsr(bytes).compressed.length;
    const bodyStart = bytes.length - 8 - compLen + 13;
    const corrupted = bytes.slice();
    corrupted.fill(0xff, bodyStart, bytes.length - 8);
    const dec = decodeReplayFile(corrupted);
    expect(dec.frames).toBeNull();
    expect(dec.decodeError).toMatch(/轨迹解析失败/);
  });

  it('writeOsr output parses back to the same header and frames', () => {
    const src = decodeReplayFile(fixture('replay_nm.osr'));
    const raw = src.frames!.map((f, i, a) => ({ w: f.time - (i ? a[i - 1].time : 0), x: f.x, y: f.y, z: f.keys }));
    const bytes = writeOsr(src.header, raw, 42);
    const back = decodeReplayFile(bytes);
    expect(back.header).toEqual(src.header);
    expect(back.frames).toEqual(src.frames);
  });

  it('decodes mods with NC over DT and PF over SD', () => {
    expect(decodeMods(MOD.DT | MOD.NC | MOD.HD)).toEqual(['NC', 'HD']);
    expect(decodeMods(MOD.SD | MOD.PF)).toEqual(['PF']);
    expect(decodeMods(MOD.HR | MOD.EZ | MOD.FL)).toEqual(['EZ', 'HR', 'FL']);
    expect(decodeMods(0)).toEqual([]);
  });
});

describe('osu!.db [B1]', () => {
  for (const version of [20140101, 20191105, 20191106, 20250107]) {
    it(`parses version ${version} and maps MD5 to folder and file name`, () => {
      const idx = parseOsuDb(fixture(`osudb_${version}.db`));
      expect(idx.version).toBe(version);
      expect(idx.playerName).toBe('DbPlayer');
      expect(idx.entries).toHaveLength(2);
      const [a, b] = idx.entries;
      expect(a).toMatchObject({
        md5: 'a'.repeat(32), folder: '123 Artist - Song', fileName: 'Artist - Song (Mapper) [Hard].osu',
        beatmapId: 1001, beatmapSetId: 2002, title: 'Song', version: 'Hard', mode: 0,
      });
      expect(b).toMatchObject({ md5: 'b'.repeat(32), beatmapId: null, beatmapSetId: null });
    });
  }

  it('reads browser metadata: names, creator, tags, difficulty, NoMod stars and last played', () => {
    const [a] = parseOsuDb(fixture('osudb_20250107.db')).entries;
    expect(a).toMatchObject({
      artistUnicode: 'ArtistU', titleUnicode: 'SongU', creator: 'Creator', source: 'source', tags: 'tag1 tag2',
      rankedStatus: 4, objectCount: 16, ar: 9, cs: 4, hp: 5, od: 8, stars: 5.5, totalTimeMs: 125000,
      lastPlayedAt: ticksToUnixMs(638398406450000000n),
    });
    // Before 2014-06-09 osu!.db stored byte difficulty values and no star ratings.
    expect(parseOsuDb(fixture('osudb_20140101.db')).entries[0]).toMatchObject({ ar: 9, cs: 4, od: 8, stars: null });
  });

  it('fails with a positioned message on a truncated database', () => {
    const bytes = fixture('osudb_20250107.db');
    expect(() => parseOsuDb(bytes.subarray(0, bytes.length - 120))).toThrow(/第 2\/2 个谱面条目解析失败/);
  });
});

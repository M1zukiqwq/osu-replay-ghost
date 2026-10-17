import { BinaryReader } from '../binary/reader';
import { BinaryWriter } from '../binary/writer';
import { lzmaCompress, lzmaDecompress } from '../lzma';
import { MOD } from '../replay/mods';
import type { RawFrame } from '../types';

export const SEED_FRAME_W = -12345;
export const SEED_FRAME_MIN_VERSION = 20130319;
const TICKS_AT_UNIX_EPOCH = 621355968000000000n;

export interface OsrHeader {
  mode: number;
  gameVersion: number;
  beatmapMd5: string;
  playerName: string;
  replayMd5: string;
  count300: number;
  count100: number;
  count50: number;
  countGeki: number;
  countKatu: number;
  countMiss: number;
  totalScore: number;
  maxCombo: number;
  perfect: boolean;
  mods: number;
  lifeBar: string;
  /** Unix ms converted from Windows ticks; null when the field is zero. */
  playedAt: number | null;
  onlineScoreId: bigint | null;
}

export interface OsrFile { header: OsrHeader; compressed: Uint8Array }

export function ticksToUnixMs(ticks: bigint): number | null {
  if (ticks <= 0n) return null;
  return Number((ticks - TICKS_AT_UNIX_EPOCH) / 10000n);
}

export function unixMsToTicks(ms: number): bigint {
  return BigInt(Math.round(ms)) * 10000n + TICKS_AT_UNIX_EPOCH;
}

/** Parses the .osr container. Throws BinaryReadError (with a readable message) on truncation. */
export function parseOsr(bytes: Uint8Array): OsrFile {
  const r = new BinaryReader(bytes);
  const mode = r.u8('游戏模式');
  const gameVersion = r.i32('游戏版本');
  const beatmapMd5 = r.string('谱面 MD5').toLowerCase();
  const playerName = r.string('玩家名');
  const replayMd5 = r.string('回放 MD5').toLowerCase();
  const count300 = r.u16('300 数');
  const count100 = r.u16('100 数');
  const count50 = r.u16('50 数');
  const countGeki = r.u16('Geki 数');
  const countKatu = r.u16('Katu 数');
  const countMiss = r.u16('Miss 数');
  const totalScore = r.i32('总分');
  const maxCombo = r.u16('最大连击');
  const perfect = r.bool('是否 FC');
  const mods = r.i32('Mods');
  const lifeBar = r.string('血条图');
  const playedAt = ticksToUnixMs(r.i64('时间戳'));
  const compressedLen = r.i32('压缩数据长度');
  const compressed = compressedLen > 0 ? r.take(compressedLen, '回放帧数据') : new Uint8Array(0);
  const onlineScoreId = r.remaining >= 8 ? r.i64('在线成绩 ID') : null;
  if (mods & MOD.TP && r.remaining >= 8) r.f64('Target Practice 准确率');
  return {
    header: {
      mode, gameVersion, beatmapMd5, playerName, replayMd5,
      count300, count100, count50, countGeki, countKatu, countMiss,
      totalScore, maxCombo, perfect, mods, lifeBar, playedAt, onlineScoreId,
    },
    compressed,
  };
}

export interface OsrPeek { mode: number; gameVersion: number; beatmapMd5: string; playerName: string }

/** Bytes that always cover mode, version, beatmap MD5 and a typical player name. */
export const OSR_PEEK_BYTES = 128;

/** Reads only the leading header fields (enough to match a replay to a beatmap); null when unreadable. */
export function peekOsrHeader(bytes: Uint8Array): OsrPeek | null {
  const r = new BinaryReader(bytes);
  try {
    const mode = r.u8();
    const gameVersion = r.i32();
    const beatmapMd5 = r.string().toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(beatmapMd5)) return null;
    let playerName = '';
    try {
      playerName = r.string();
    } catch {
      // name cut off by the peek window
    }
    return { mode, gameVersion, beatmapMd5, playerName };
  } catch {
    return null;
  }
}

/** Parses "w|x|y|z,..." into raw frames, dropping the trailing RNG seed frame. */
export function parseFrameString(text: string): RawFrame[] {
  const out: RawFrame[] = [];
  for (const token of text.split(',')) {
    const part = token.trim();
    if (!part) continue;
    const seg = part.split('|');
    if (seg.length < 4) continue;
    const w = parseFloat(seg[0]);
    const x = parseFloat(seg[1]);
    const y = parseFloat(seg[2]);
    const z = parseInt(seg[3], 10);
    if (![w, x, y].every(Number.isFinite)) continue;
    if (w === SEED_FRAME_W) continue;
    out.push({ w, x, y, z: Number.isFinite(z) ? z : 0 });
  }
  return out;
}

export function decodeOsrFrames(compressed: Uint8Array): RawFrame[] {
  if (compressed.length === 0) throw new Error('回放不含帧数据（压缩数据长度为 0）');
  const text = new TextDecoder('utf-8').decode(lzmaDecompress(compressed));
  const frames = parseFrameString(text);
  if (frames.length === 0) throw new Error('帧数据解压成功但没有可用的帧');
  return frames;
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 10000) / 10000));

export function encodeFrameString(frames: RawFrame[], seed: number | null): string {
  const parts = frames.map((f) => `${fmt(f.w)}|${fmt(f.x)}|${fmt(f.y)}|${f.z}`);
  if (seed !== null) parts.push(`${SEED_FRAME_W}|0|0|${seed}`);
  return parts.join(',') + ',';
}

export function writeOsr(header: OsrHeader, frames: RawFrame[], seed = 0): Uint8Array {
  const text = encodeFrameString(frames, header.gameVersion >= SEED_FRAME_MIN_VERSION ? seed : null);
  const compressed = lzmaCompress(new TextEncoder().encode(text));
  const w = new BinaryWriter();
  w.u8(header.mode).i32(header.gameVersion);
  w.string(header.beatmapMd5).string(header.playerName).string(header.replayMd5);
  w.u16(header.count300).u16(header.count100).u16(header.count50);
  w.u16(header.countGeki).u16(header.countKatu).u16(header.countMiss);
  w.i32(header.totalScore).u16(header.maxCombo).bool(header.perfect).i32(header.mods);
  w.string(header.lifeBar);
  w.i64(header.playedAt === null ? 0n : unixMsToTicks(header.playedAt));
  w.i32(compressed.length).bytes(compressed);
  w.i64(header.onlineScoreId ?? 0n);
  return w.finish();
}

import { BinaryReader, BinaryReadError } from '../binary/reader';
import type { BeatmapInfo } from '../types';
import { ticksToUnixMs } from './osr';

export const VERSION_FLOAT_DIFFICULTY = 20140609;
export const VERSION_NO_ENTRY_SIZE = 20191106;

export interface DbBeatmapEntry extends BeatmapInfo {
  folder: string;
  fileName: string;
  modifiedAt: number | null;
}

export interface OsuDbIndex { version: number; playerName: string; entries: DbBeatmapEntry[] }

/** Reads one star-rating list and returns the NoMod value (null when osu! has not calculated it). */
function readStarRatings(r: BinaryReader): number | null {
  const count = r.i32('星级列表数量');
  if (count < 0) throw new BinaryReadError(`星级列表数量无效：${count}`);
  let noMod: number | null = null;
  for (let i = 0; i < count; i++) {
    r.skip(1, '星级 Int 标记');
    const mods = r.i32('星级 Mods');
    const tag = r.u8('星级数值类型');
    let value: number;
    if (tag === 0x0d) value = r.f64('星级 Double');
    else if (tag === 0x0c) value = r.f32('星级 Float');
    else throw new BinaryReadError(`星级数值类型未知：0x${tag.toString(16)}（偏移 ${r.offset - 1}）`);
    if (mods === 0 && Number.isFinite(value) && value > 0) noMod = value;
  }
  return noMod;
}

function readEntry(r: BinaryReader, version: number): DbBeatmapEntry {
  const floatDiff = version >= VERSION_FLOAT_DIFFICULTY;
  const entryEnd = version < VERSION_NO_ENTRY_SIZE ? r.i32('条目字节数') + r.offset : -1;

  const artist = r.string('艺术家');
  const artistUnicode = r.string('艺术家 Unicode');
  const title = r.string('标题');
  const titleUnicode = r.string('标题 Unicode');
  const creator = r.string('作者');
  const diffName = r.string('难度名');
  r.skipString('音频文件名');
  const md5 = r.string('MD5').toLowerCase();
  const fileName = r.string('.osu 文件名');
  const rankedStatus = r.u8('排名状态');
  const objectCount = r.u16('圆圈数') + r.u16('滑条数') + r.u16('转盘数');
  const modifiedAt = ticksToUnixMs(r.i64('修改时间'));
  const diff = floatDiff
    ? [r.f32('AR'), r.f32('CS'), r.f32('HP'), r.f32('OD')]
    : [r.u8('AR'), r.u8('CS'), r.u8('HP'), r.u8('OD')];
  r.skip(8, '滑条速度');
  let stars: number | null = null;
  if (floatDiff) {
    stars = readStarRatings(r);
    for (let i = 0; i < 3; i++) readStarRatings(r);
  }
  r.skip(4, 'Drain 时长');
  const totalTimeMs = r.i32('总时长');
  r.skip(4, '预览时间');
  const tpCount = r.i32('Timing point 数量');
  if (tpCount < 0) throw new BinaryReadError(`Timing point 数量无效：${tpCount}`);
  r.skip(tpCount * 17, 'Timing points');
  const beatmapId = r.i32('Difficulty ID');
  const beatmapSetId = r.i32('Beatmap ID');
  r.skip(4, 'Thread ID');
  r.skip(4, '评级');
  r.skip(2, '本地 offset');
  r.skip(4, '堆叠系数');
  const mode = r.u8('模式');
  const source = r.string('来源');
  const tags = r.string('标签');
  r.skip(2, '在线 offset');
  r.skipString('标题字体');
  r.skip(1, '是否未玩过');
  const lastPlayedAt = ticksToUnixMs(r.i64('上次游玩时间'));
  r.skip(1, '是否 osz2');
  const folder = r.string('文件夹名');
  r.skip(8, '上次检查时间');
  r.skip(5, '忽略设置');
  if (!floatDiff) r.skip(2, '未知 Short');
  r.skip(4, '修改时间 Int');
  r.skip(1, 'mania 滚动速度');

  if (entryEnd >= 0 && r.offset !== entryEnd) {
    if (entryEnd < r.offset || entryEnd > r.bytes.length) {
      throw new BinaryReadError(`谱面条目长度不一致（期望结束于 ${entryEnd}，实际 ${r.offset}）`);
    }
    r.offset = entryEnd;
  }
  const [ar, cs, hp, od] = diff.map((v) => Math.round(v * 100) / 100);
  return {
    md5, folder, fileName, modifiedAt,
    artist, artistUnicode, title, titleUnicode, creator, version: diffName, source, tags, mode,
    rankedStatus, cs, ar, od, hp, stars,
    totalTimeMs: totalTimeMs > 0 ? totalTimeMs : null,
    objectCount,
    lastPlayedAt,
    beatmapId: beatmapId > 0 ? beatmapId : null,
    beatmapSetId: beatmapSetId > 0 ? beatmapSetId : null,
  };
}

/** Parses osu!.db into a lookup list with the metadata the beatmap browser shows. */
export function parseOsuDb(bytes: Uint8Array): OsuDbIndex {
  const r = new BinaryReader(bytes);
  const version = r.i32('版本号');
  r.skip(4, '文件夹数');
  r.skip(1, '账号是否解锁');
  r.skip(8, '解锁时间');
  const playerName = r.string('玩家名');
  const count = r.i32('谱面数');
  if (count < 0) throw new BinaryReadError(`谱面数无效：${count}`);
  const entries: DbBeatmapEntry[] = [];
  for (let i = 0; i < count; i++) {
    try {
      entries.push(readEntry(r, version));
    } catch (e) {
      throw new BinaryReadError(`第 ${i + 1}/${count} 个谱面条目解析失败：${(e as Error).message}`);
    }
  }
  return { version, playerName, entries };
}

import { BinaryReader, BinaryReadError } from '../binary/reader';
import { ticksToUnixMs } from './osr';

export const VERSION_FLOAT_DIFFICULTY = 20140609;
export const VERSION_NO_ENTRY_SIZE = 20191106;

export interface DbBeatmapEntry {
  md5: string;
  folder: string;
  fileName: string;
  beatmapId: number | null;
  beatmapSetId: number | null;
  artist: string;
  title: string;
  version: string;
  mode: number;
  modifiedAt: number | null;
}

export interface OsuDbIndex { version: number; playerName: string; entries: DbBeatmapEntry[] }

function skipStarRatings(r: BinaryReader): void {
  const count = r.i32('星级列表数量');
  if (count < 0) throw new BinaryReadError(`星级列表数量无效：${count}`);
  for (let i = 0; i < count; i++) {
    r.skip(1, '星级 Int 标记');
    r.skip(4, '星级 Mods');
    const tag = r.u8('星级数值类型');
    if (tag === 0x0d) r.skip(8, '星级 Double');
    else if (tag === 0x0c) r.skip(4, '星级 Float');
    else throw new BinaryReadError(`星级数值类型未知：0x${tag.toString(16)}（偏移 ${r.offset - 1}）`);
  }
}

function readEntry(r: BinaryReader, version: number): DbBeatmapEntry {
  const floatDiff = version >= VERSION_FLOAT_DIFFICULTY;
  const entryEnd = version < VERSION_NO_ENTRY_SIZE ? r.i32('条目字节数') + r.offset : -1;

  const artist = r.string('艺术家');
  r.skipString('艺术家 Unicode');
  const title = r.string('标题');
  r.skipString('标题 Unicode');
  r.skipString('作者');
  const diffName = r.string('难度名');
  r.skipString('音频文件名');
  const md5 = r.string('MD5').toLowerCase();
  const fileName = r.string('.osu 文件名');
  r.skip(1, '排名状态');
  r.skip(6, '物件数');
  const modifiedAt = ticksToUnixMs(r.i64('修改时间'));
  r.skip(floatDiff ? 16 : 4, 'AR/CS/HP/OD');
  r.skip(8, '滑条速度');
  if (floatDiff) for (let i = 0; i < 4; i++) skipStarRatings(r);
  r.skip(12, '时长信息');
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
  r.skipString('来源');
  r.skipString('标签');
  r.skip(2, '在线 offset');
  r.skipString('标题字体');
  r.skip(1, '是否未玩过');
  r.skip(8, '上次游玩时间');
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
  return {
    md5, folder, fileName, artist, title, version: diffName, mode, modifiedAt,
    beatmapId: beatmapId > 0 ? beatmapId : null,
    beatmapSetId: beatmapSetId > 0 ? beatmapSetId : null,
  };
}

/** Parses osu!.db into a lookup list. Only the fields needed to locate .osu files are decoded. */
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

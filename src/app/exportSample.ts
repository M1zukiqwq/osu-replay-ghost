import { md5Bytes, md5Text } from '../core/binary/md5';
import { writeOsr, type OsrHeader } from '../core/formats/osr';
import { writeOsu } from '../core/formats/osuWriter';
import { framesToRaw } from '../core/replay/frames';
import type { Beatmap, Replay } from '../core/types';
import { getActiveGroup, getPrimaryReplay, isAnalyzable } from './state';

export interface SampleFiles { osuName: string; osu: Uint8Array; osrName: string | null; osr: Uint8Array | null; beatmapMd5: string }

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);

/** Builds a matching .osu + .osr pair: the .osr's beatmap MD5 is the MD5 of the exported .osu bytes. */
export function buildSampleFiles(beatmap: Beatmap, replay: Replay | null): SampleFiles {
  const osu = new TextEncoder().encode(writeOsu(beatmap));
  const beatmapMd5 = md5Bytes(osu);
  const base = safeName(`${beatmap.artist} - ${beatmap.title} [${beatmap.version}]`);
  const out: SampleFiles = { osuName: `${base} (sample).osu`, osu, osrName: null, osr: null, beatmapMd5 };
  if (!replay?.frames) return out;
  const h = replay.header;
  const header: OsrHeader = {
    mode: 0,
    gameVersion: replay.gameVersion || 20250107,
    beatmapMd5,
    playerName: replay.playerName,
    replayMd5: md5Text(`${beatmapMd5}|${replay.playerName}|${replay.playedAt}|${h.totalScore}|sample`),
    count300: h.count300,
    count100: h.count100,
    count50: h.count50,
    countGeki: h.countGeki,
    countKatu: h.countKatu,
    countMiss: h.countMiss,
    totalScore: h.totalScore,
    maxCombo: h.maxCombo,
    perfect: h.perfect,
    mods: replay.mods,
    lifeBar: '',
    playedAt: replay.playedAt,
    onlineScoreId: 0n,
  };
  out.osr = writeOsr(header, framesToRaw(replay.frames, replay.mods));
  out.osrName = `${safeName(replay.playerName)} - ${base} (sample).osr`;
  return out;
}

function download(name: string, bytes: Uint8Array, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function downloadSampleFiles(): { ok: boolean; title: string; detail: string } {
  const g = getActiveGroup();
  if (!g) return { ok: false, title: '没有谱面', detail: '请先选择一张谱面' };
  const rep = getPrimaryReplay() ?? g.replays.find(isAnalyzable) ?? null;
  const files = buildSampleFiles(g.beatmap, rep);
  download(files.osuName, files.osu, 'text/plain;charset=utf-8');
  if (files.osr && files.osrName) {
    setTimeout(() => download(files.osrName!, files.osr!, 'application/octet-stream'), 300);
    return { ok: true, title: '已生成测试用 .osu + .osr', detail: `两个文件互相匹配（谱面 MD5 ${files.beatmapMd5.slice(0, 8)}…），可拖回页面重新导入` };
  }
  return { ok: true, title: '只生成了 .osu', detail: '当前谱面没有带轨迹的回放，无法生成 .osr' };
}

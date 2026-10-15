import { md5Text } from '../core/binary/md5';
import { DEMO_MAPS, DEMO_REPLAYS, demoOsuText, liveRunConfig } from '../core/demo/demoMaps';
import type { SynthConfig } from '../core/demo/synthetic';
import { parseOsu } from '../core/formats/osu';
import { headerAccuracy } from '../core/replay/decode';
import { decodeMods } from '../core/replay/mods';
import type { Beatmap, Judgment, Replay } from '../core/types';
import { addBeatmaps, addReplays, jumpToWorstSlice, seek, selectSlice, setActiveBeatmap, setPrimary, toggleReplay } from './actions';
import type { Engine } from './engine';
import { newReplayId, nextImportSeq } from './importer';
import { getActiveGroup, state } from './state';

function maxComboOf(judgments: Judgment[]): number {
  let best = 0;
  let cur = 0;
  for (const j of judgments) {
    if (j.judgment === 'SKIP') continue;
    if (j.judgment === 'MISS') cur = 0;
    else best = Math.max(best, ++cur);
  }
  return best;
}

async function synthesizeReplay(
  engine: Engine, map: Beatmap, cfg: SynthConfig,
  meta: { id: string; playerName: string; fileName: string; playedAt: number; totalScore?: number },
): Promise<Replay> {
  const { frames, analysis } = await engine.synthesize(map, cfg);
  const s = analysis.simulated;
  return {
    id: meta.id,
    source: 'demo',
    fileName: meta.fileName,
    beatmapMd5: map.md5,
    replayMd5: md5Text(`${meta.id}|${map.md5}|${cfg.seed}|${meta.playedAt}`),
    playerName: meta.playerName,
    mode: 0,
    gameVersion: 20250107,
    mods: cfg.mods,
    modNames: decodeMods(cfg.mods),
    playedAt: meta.playedAt,
    header: {
      count300: s.c300, count100: s.c100, count50: s.c50, countGeki: 0, countKatu: 0, countMiss: s.cMiss,
      totalScore: meta.totalScore ?? (s.c300 * 300 + s.c100 * 100 + s.c50 * 50) * 10,
      maxCombo: maxComboOf(analysis.judgments),
      perfect: s.cMiss === 0,
      accuracy: headerAccuracy(s.c300, s.c100, s.c50, s.cMiss),
    },
    frames,
    decodeError: null,
    colorIdx: 0,
    analysis,
    importSeq: nextImportSeq(),
  };
}

/** Loads the two hand-written demo maps and five synthetic replays, then sets the documented initial view. */
export async function loadDemo(engine: Engine): Promise<void> {
  const enc = new TextEncoder();
  const maps = new Map<string, Beatmap>();
  for (const spec of DEMO_MAPS) {
    const map = parseOsu(enc.encode(demoOsuText(spec)), { fileName: `${spec.artist} - ${spec.title} [${spec.version}].osu`, source: 'demo' });
    maps.set(spec.key, map);
  }
  addBeatmaps([...maps.values()].reverse());
  const now = Date.now();
  for (const spec of [...DEMO_REPLAYS].reverse()) {
    const map = maps.get(spec.mapKey)!;
    const rep = await synthesizeReplay(engine, map, spec.synth, {
      id: spec.id,
      playerName: spec.playerName,
      fileName: `${spec.playerName}.osr`,
      playedAt: now - spec.minutesAgo * 60000,
      totalScore: spec.totalScore,
    });
    addReplays([rep]);
  }
  const fd = maps.get('fd')!;
  setActiveBeatmap(fd.md5, true);
  toggleReplay('rep_fd_3', false);
  setPrimary('rep_fd_1');
  selectSlice(2, false);
  seek(4100);
}

/** "模拟打完自动导入新成绩": synthesises a new run for the active map (alternating over/underaim). */
export async function simulateNewPlay(engine: Engine): Promise<{ ok: boolean; title: string; detail: string }> {
  const g = getActiveGroup();
  if (!g) return { ok: false, title: '没有谱面', detail: '请先导入一张谱面' };
  if (g.beatmap.hitObjects.filter((o) => o.type !== 'spinner').length === 0) {
    return { ok: false, title: '无法模拟', detail: '当前谱面没有可点击的物件，无法生成模拟回放' };
  }
  const run = g.replays.length + 1;
  const now = Date.now();
  const cfg = liveRunConfig(run, (now % 100000) + run, g.beatmap.durationMs);
  const over = run % 2 === 0;
  const rep = await synthesizeReplay(engine, g.beatmap, cfg, {
    id: newReplayId('rep_live'),
    playerName: `LocalPlayer (刚打完 #${run} · ${over ? 'Overaim' : 'Underaim'})`,
    fileName: `Data/r/${g.beatmap.md5}-${now}.osr（演示）`,
    playedAt: now,
  });
  addReplays([rep]);
  const hasMiss = jumpToWorstSlice();
  const len = state.sliceDurationMs / 1000;
  const acc = rep.header.accuracy === null ? '—' : `${rep.header.accuracy.toFixed(2)}%`;
  return {
    ok: true,
    title: '⚡ 已生成一条演示用新成绩',
    detail: `为当前谱面合成了新回放（${acc}，${rep.header.countMiss} Miss）${hasMiss ? `，已定位到 Miss 最多的 ${len}s 时间片` : ''}`,
  };
}

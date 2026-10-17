import { getActiveGroup, getPrimaryReplay, getSelectedReplays, replayColor, state } from '../app/state';
import type { AnalyzedReplay } from '../core/analysis/metrics';
import { sampleCursor } from '../core/replay/frames';
import type { Judgment, Replay } from '../core/types';
import { $, h, setChildren, setText } from './dom';
import { DASH, formatTimeMs } from './format';

const NEAREST_JUDGMENT_MS = 450;

interface KeyCard {
  status: HTMLElement;
  k1Tile: HTMLElement;
  k2Tile: HTMLElement;
  k1Count: HTMLElement;
  k2Count: HTMLElement;
  k1Times: number[];
  k2Times: number[];
  rep: Replay & AnalyzedReplay;
}

let cards: KeyCard[] = [];

function upperBound(arr: number[], t: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Rebuilt only when the selection changes; per-frame updates touch text and classes only (B30). */
export function rebuildKeyCards(): void {
  const container = $('liveKeyOverlayContainer');
  cards = [];
  const nodes = getSelectedReplays().map((rep) => {
    const status = h('span', { class: 'font-mono text-[9px] text-slate-400 shrink-0' }, '空闲');
    const k1Count = h('span', { class: 'text-xs font-mono font-extrabold text-white' }, '0');
    const k2Count = h('span', { class: 'text-xs font-mono font-extrabold text-white' }, '0');
    const tile = (label: string, cls: string, count: HTMLElement) =>
      h('div', { class: 'key-tile rounded-md border border-slate-700 bg-slate-950 py-1.5 px-2 flex items-center justify-between' },
        h('span', { class: `text-[10px] font-bold ${cls}` }, label), count);
    const k1Tile = tile('K1', 'text-cyan-300', k1Count);
    const k2Tile = tile('K2', 'text-pink-300', k2Count);
    cards.push({
      status, k1Tile, k2Tile, k1Count, k2Count, rep,
      k1Times: rep.analysis.keyPresses.filter((k) => k.key === 'K1').map((k) => k.time),
      k2Times: rep.analysis.keyPresses.filter((k) => k.key === 'K2').map((k) => k.time),
    });
    return h('div', { class: 'bg-slate-900/90 border border-slate-800 rounded-lg p-2 flex flex-col gap-1.5', style: { 'border-left': `3px solid ${replayColor(rep)}` } },
      h('div', { class: 'text-[10px] font-semibold text-slate-200 flex items-center justify-between gap-1 min-w-0' },
        h('span', { class: 'truncate', title: rep.playerName }, rep.playerName.replace(/^LocalPlayer /, '')), status),
      h('div', { class: 'grid grid-cols-2 gap-1.5' }, k1Tile, k2Tile),
    );
  });
  setChildren(container, ...nodes);
}

function nearestJudgment(judgments: Judgment[], t: number): Judgment | null {
  let lo = 0;
  let hi = judgments.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (judgments[mid].noteTime < t) lo = mid + 1;
    else hi = mid;
  }
  let best: Judgment | null = null;
  for (let i = Math.max(0, lo - 3); i < Math.min(judgments.length, lo + 3); i++) {
    const j = judgments[i];
    if (j.judgment === 'SKIP') continue;
    if (!best || Math.abs(j.noteTime - t) < Math.abs(best.noteTime - t)) best = j;
  }
  return best && Math.abs(best.noteTime - t) < NEAREST_JUDGMENT_MS ? best : null;
}

export function renderHud(): void {
  const g = getActiveGroup();
  const t = state.currentTimeMs;
  if (!g) {
    setText('canvasBeatmapTitleHud', '没有谱面');
    setText('canvasFrameMetricsHud', '');
    return;
  }
  const b = g.beatmap;
  setText('canvasBeatmapTitleHud', `${b.beatmapId === null ? '未上传' : '#' + b.beatmapId} ${b.artist} - ${b.title} [${b.version}]`);
  const pri = getPrimaryReplay();
  const cur = pri ? sampleCursor(pri.frames, t) : null;
  const frameLabel = cur ? `#${cur.frameIndex}` : DASH;
  setText('canvasFrameMetricsHud', `时间: ${formatTimeMs(t)} | 帧 ${frameLabel} | 叠加轨迹: ${cards.length} 条`);
  setText('hudCurrentTimeFrame', `${(t / 1000).toFixed(3)}s (${frameLabel})`);
  setText('hudCursorXY', cur ? `(${cur.x.toFixed(1)}, ${cur.y.toFixed(1)})` : DASH);
  setText('hudCursorVelocity', cur ? `${cur.velocity.toFixed(2)} px/ms` : DASH);

  const jEl = $('hudNearestJudgment');
  const near = pri ? nearestJudgment(pri.analysis.judgments, t) : null;
  if (near) {
    const brk = near.judgment !== 'MISS' ? near.slider?.break ?? null : null;
    const parts = near.slider && near.judgment !== 'MISS' ? ` · 滑条 ${near.slider.hitParts}/${near.slider.totalParts}` : '';
    jEl.textContent = `${near.judgment}${brk ? ' 断连' : ''} (${near.radialOffset.toFixed(1)}px / ${near.keyUsed ?? '无按键'})${parts}`;
    jEl.className = near.judgment === 'MISS'
      ? 'text-rose-400 font-bold truncate ml-auto max-w-full'
      : brk ? 'text-orange-300 font-bold truncate ml-auto max-w-full' : 'text-emerald-300 font-semibold truncate ml-auto max-w-full';
    jEl.title = brk ? brk.reason : near.missReason || (near.slider?.checks.find((c) => !c.hit)?.reason ?? '');
  } else {
    jEl.textContent = pri ? '移动中' : DASH;
    jEl.className = 'text-slate-400 truncate ml-auto max-w-full';
    jEl.title = '';
  }

  for (const card of cards) {
    const s = sampleCursor(card.rep.frames, t);
    const k1 = !!s?.k1;
    const k2 = !!s?.k2;
    const status = k1 || k2 ? '按下中' : '空闲';
    if (card.status.textContent !== status) card.status.textContent = status;
    card.k1Tile.classList.toggle('pressed-k1', k1);
    card.k2Tile.classList.toggle('pressed-k2', k2);
    const c1 = String(upperBound(card.k1Times, t));
    const c2 = String(upperBound(card.k2Times, t));
    if (card.k1Count.textContent !== c1) card.k1Count.textContent = c1;
    if (card.k2Count.textContent !== c2) card.k2Count.textContent = c2;
  }
}

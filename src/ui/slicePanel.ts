import { jumpToWorstSlice, selectSlice, setSliceDuration, showFullMap } from '../app/actions';
import { getActiveGroup, getSelectedReplays, state } from '../app/state';
import { computeSlices, type SliceStat } from '../core/analysis/slices';
import type { Scope } from '../core/types';
import { $, h, setChildren, setText } from './dom';
import { DASH, num, secs, sliceLenLabel } from './format';
import { showToast } from './toast';

const MAX_AXIS_LABELS = 24;
const MIN_BAR_PX = 18;

export function scopeLabel(scope: Scope, sliceMs: number): string {
  const range = `${secs(scope.startMs, 1)} - ${secs(scope.endMs, 1)}`;
  if (scope.type === 'full') return '全图概览';
  if (scope.type === 'slice') return `${sliceLenLabel(sliceMs)} 时间片 #${(scope.sliceIndex ?? 0) + 1} (${range})`;
  return `自定义区间 (${secs(scope.startMs)} - ${secs(scope.endMs)})`;
}

let cacheKey = '';
let cached: SliceStat[] = [];
let bars: HTMLButtonElement[] = [];

/** Slice stats depend only on map, selection and slice length; the scope only changes the highlight. */
export function currentSlices(): SliceStat[] {
  const g = getActiveGroup();
  if (!g) return [];
  const sel = getSelectedReplays();
  const key = `${g.key}|${state.sliceDurationMs}|${sel.map((r) => r.id).join(',')}`;
  if (key !== cacheKey) {
    cacheKey = key;
    cached = computeSlices(g.beatmap, sel, state.sliceDurationMs);
    bars = [];
  }
  return cached;
}

function barClass(s: SliceStat): string {
  if (s.misses >= 2) return 'bg-rose-500/90 hover:bg-rose-400 border-rose-300';
  if (s.misses === 1) return 'bg-rose-500/70 hover:bg-rose-400 border-rose-400/70';
  if (s.sliderBreaks > 0) return 'bg-orange-500/80 hover:bg-orange-400 border-orange-300/70';
  if (s.c100 + s.c50 > 0) return 'bg-amber-400/80 hover:bg-amber-300 border-amber-300/70';
  return 'bg-emerald-500/75 hover:bg-emerald-400 border-emerald-400/50';
}

function buildBars(slices: SliceStat[]): void {
  const strip = $('timeSliceStrip');
  const axis = $('timeSliceAxisLabels');
  const n = slices.length;
  const cols = `repeat(${n}, minmax(${MIN_BAR_PX}px, 1fr))`;
  strip.style.gridTemplateColumns = cols;
  axis.style.gridTemplateColumns = cols;
  const maxNotes = Math.max(1, ...slices.map((s) => s.noteCount));
  const len = sliceLenLabel(state.sliceDurationMs);
  bars = slices.map((s) => {
    const btn = h(
      'button',
      {
        type: 'button',
        class: `slice-bar relative w-full rounded-t-md border-t flex flex-col items-center justify-between p-0.5 cursor-pointer overflow-hidden ${barClass(s)}`,
        style: { height: `${Math.max(22, Math.round((s.noteCount / maxNotes) * 100))}%` },
        title: `${len} 时间片 #${s.index + 1} (${secs(s.startMs, 1)} - ${secs(s.endMs, 1)})\n物件: ${s.noteCount} | Miss: ${s.misses} | 滑条断连: ${s.sliderBreaks} | 100: ${s.c100} | 50: ${s.c50}\nK1: ${s.k1} / K2: ${s.k2} | 平均偏差: ${num(s.meanDeviation, 1, 'px')}`,
        on: { click: () => selectSlice(s.index) },
      },
      h('span', { class: 'text-[10px] font-mono font-extrabold text-white drop-shadow leading-none' },
        s.misses > 0 ? `${s.misses}M` : s.sliderBreaks > 0 ? `${s.sliderBreaks}断` : ''),
      h('span', { class: 'text-[9px] font-mono text-slate-950 font-bold leading-none' }, `#${s.index + 1}`),
    );
    return btn;
  });
  setChildren(strip, ...bars);
  const step = Math.max(1, Math.ceil(n / MAX_AXIS_LABELS));
  setChildren(axis, ...slices.map((s) =>
    h('span', { class: 'whitespace-nowrap overflow-visible' }, s.index % step === 0 ? sliceLenLabel(s.startMs) : ''),
  ));
}

export function renderSlicePanel(): void {
  const slices = currentSlices();
  if (!slices.length) {
    setChildren($('timeSliceStrip'));
    setChildren($('timeSliceAxisLabels'));
    bars = [];
  } else if (bars.length !== slices.length) buildBars(slices);
  const s = state.scope;
  bars.forEach((b, i) => b.classList.toggle('active-slice', s.type === 'slice' && s.sliceIndex === i));
  setText('sliceTotalCountLabel', String(slices.length));
  setText('currentScopeBadge', `当前分析：${scopeLabel(s, state.sliceDurationMs)}`);
  setText('sliceLenHint', `${sliceLenLabel(state.sliceDurationMs)} 时间片`);
  const rangeText = `${secs(s.startMs)} - ${secs(s.endMs)}`;
  setText('customRangeSummaryText', getActiveGroup() ? `当前区间: ${rangeText} (时长 ${secs(s.endMs - s.startMs)})` : `当前区间: ${DASH}`);
  ($('sliceDurationSelect') as HTMLSelectElement).value = String(state.sliceDurationMs);
}

/** Scrolls the active slice bar into view when the strip overflows. */
export function revealActiveSlice(): void {
  const s = state.scope;
  if (s.type !== 'slice' || s.sliceIndex === undefined) return;
  bars[s.sliceIndex]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

export function bindSlicePanel(): void {
  $('sliceDurationSelect').addEventListener('change', (e) => {
    setSliceDuration(parseInt((e.target as HTMLSelectElement).value, 10));
  });
  $('btnResetFullMapScope').addEventListener('click', () => showFullMap());
  $('btnJumpWorstSlice').addEventListener('click', () => {
    if (!jumpToWorstSlice()) showToast('没有 Miss', '已选回放在整张图上都没有模拟 Miss 或滑条断连，已定位到第 1 个分片', 'cyan');
    requestAnimationFrame(revealActiveSlice);
  });
}

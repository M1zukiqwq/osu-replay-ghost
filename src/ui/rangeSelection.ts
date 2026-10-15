import { seek, setPlaying, setRangeSelectMode, setScope } from '../app/actions';
import { getActiveGroup, getDurationMs, state } from '../app/state';
import { $, setText } from './dom';
import { DASH, formatTimeMs, secs } from './format';

const SWEEP_INITIAL_MS = 500;

const PILL_ON = 'px-2.5 py-1 rounded-lg bg-pink-500 text-white border border-pink-300 font-bold text-xs transition flex items-center gap-1.5 shadow-md shadow-pink-500/30';
const PILL_OFF = 'px-2.5 py-1 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 border border-cyan-500/40 font-semibold text-xs transition flex items-center gap-1.5';
const TOP_ON = 'px-3 py-1 rounded-lg bg-pink-500 text-white border border-pink-300 font-bold text-xs transition flex items-center gap-1.5 shadow-md shadow-pink-500/30';
const TOP_OFF = 'px-3 py-1 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-400/50 font-semibold text-xs transition flex items-center gap-1.5';

/** Updates the scrubber, scope highlight, handles and range labels. Called every rendered frame. */
export function renderProgress(): void {
  const d = getDurationMs();
  const { startMs, endMs } = state.scope;
  const pct = (ms: number) => Math.max(0, Math.min(100, (ms / Math.max(1, d)) * 100));
  const left = pct(startMs);
  const right = pct(endMs);
  const hl = $('scrubberRangeHighlight');
  hl.style.left = `${left}%`;
  hl.style.width = `${Math.max(0.5, right - left)}%`;
  hl.className = state.isRangeSelectMode
    ? 'bg-cyan-400/50 border-x-2 border-cyan-200 shadow-sm shadow-cyan-400/30'
    : 'bg-cyan-400/30 border-x-2 border-cyan-300/75';
  $('scrubberPlayhead').style.left = `${pct(state.currentTimeMs)}%`;
  $('rangeHandleStart').style.left = `${left}%`;
  $('rangeHandleEnd').style.left = `${right}%`;
  $('rangeSelectOverlay').classList.toggle('hidden', !state.isRangeSelectMode);

  const scrubber = $('timelineScrubber') as HTMLInputElement;
  if (scrubber.max !== String(d)) scrubber.max = String(d);
  scrubber.value = String(Math.round(state.currentTimeMs));
  setText('timeCurrentLabel', formatTimeMs(state.currentTimeMs));
  setText('timeTotalLabel', formatTimeMs(d));
  setText('scrubberSelectedRangeBadge', getActiveGroup() ? `区间: ${secs(startMs)} - ${secs(endMs)} (${secs(endMs - startMs)})` : `区间: ${DASH}`);
}

export function renderRangeModeControls(): void {
  const on = state.isRangeSelectMode;
  $('btnToggleRangeSelect').className = on ? PILL_ON : PILL_OFF;
  setText('rangeSelectBtnText', on ? '正在进度条选区间 (点击退出)' : '开启进度条选区间');
  $('btnTopToggleRangeSelect').className = on ? TOP_ON : TOP_OFF;
  setText('topRangeSelectText', on ? '✂ 正在进度条选区间 (点击完成)' : '✂ 开启进度条选区间');
  const hint = $('rangeSelectModeHint');
  hint.textContent = on ? '👉 在下方进度条上按住左右拖动框选区间，或拖动两端游标微调起止点' : '点击开启后，直接在下方进度条拖拽框选任意时间段';
  hint.className = on ? 'text-cyan-300 font-semibold text-[11px]' : 'text-slate-400 text-[11px]';
}

export function bindRangeSelection(): void {
  $('btnToggleRangeSelect').addEventListener('click', () => setRangeSelectMode(!state.isRangeSelectMode));
  $('btnTopToggleRangeSelect').addEventListener('click', () => {
    setRangeSelectMode(!state.isRangeSelectMode);
    $('timelineTrackWrapper').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  $('timelineScrubber').addEventListener('input', (e) => {
    setPlaying(false);
    seek(parseFloat((e.target as HTMLInputElement).value) || 0);
  });

  const track = $('timelineTrackWrapper');
  const overlay = $('rangeSelectOverlay');
  const handleStart = $('rangeHandleStart');
  const handleEnd = $('rangeHandleEnd');

  let anchorMs = 0;
  let dragging: HTMLElement | null = null;
  let pendingX: number | null = null;
  let raf = 0;

  const timeAt = (clientX: number) => {
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    return Math.round(ratio * getDurationMs());
  };

  const apply = (a: number, b: number) => {
    setScope({ type: 'custom', startMs: Math.min(a, b), endMs: Math.max(a, b) });
    seek(state.scope.startMs);
  };

  const flush = () => {
    raf = 0;
    if (pendingX === null || !dragging) return;
    apply(anchorMs, timeAt(pendingX));
    pendingX = null;
  };

  const begin = (el: HTMLElement, e: PointerEvent, anchor: number) => {
    if (!state.isRangeSelectMode || !getActiveGroup()) return;
    e.preventDefault();
    e.stopPropagation();
    dragging = el;
    anchorMs = anchor;
    el.setPointerCapture(e.pointerId);
  };

  // The opposite end is fixed as the anchor when a handle drag starts, so crossing it never loses the range.
  handleStart.addEventListener('pointerdown', (e) => begin(handleStart, e, state.scope.endMs));
  handleEnd.addEventListener('pointerdown', (e) => begin(handleEnd, e, state.scope.startMs));
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target !== overlay) return;
    const t = timeAt(e.clientX);
    begin(overlay, e, t);
    if (dragging) apply(t, t + SWEEP_INITIAL_MS);
  });

  for (const el of [overlay, handleStart, handleEnd]) {
    el.addEventListener('pointermove', (e) => {
      if (dragging !== el) return;
      pendingX = e.clientX;
      if (!raf) raf = requestAnimationFrame(flush);
    });
    const end = (e: PointerEvent) => {
      if (dragging !== el) return;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      if (pendingX !== null) flush();
      dragging = null;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }
}

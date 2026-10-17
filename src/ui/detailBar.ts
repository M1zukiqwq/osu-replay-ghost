import { adjustScope, drillScope, popScope, seek, setPlaying } from '../app/actions';
import { getActiveGroup, getDurationMs, getPrimaryReplay, state } from '../app/state';
import { judgmentMarks, type JudgmentMark, type MarkKind } from '../core/analysis/marks';
import { detailFrame } from '../core/analysis/scope';
import type { Judgment, Scope } from '../core/types';
import { $, setText } from './dom';
import { formatTimeMs, secs } from './format';

// Detail bar: a zoomed timeline of the current scope. Click seeks, dragging selects a sub-range and zooms
// into it (drill-down, undone with “返回上一区间”), the handles fine-tune the scope's edges.

const DRAG_THRESHOLD_PX = 4;
const HOVER_RADIUS_PX = 5;
const MARK_COLOR: Record<MarkKind, string> = { miss: '#f43f5e', break: '#fb923c', meh: '#fbbf24' };
/** Drawn back to front so misses stay visible when marks overlap. */
const MARK_ORDER: MarkKind[] = ['meh', 'break', 'miss'];

interface TimeWindow { startMs: number; endMs: number }

/** Window kept still while a drag is in progress, so the bar doesn't rescale under the pointer. */
let frozen: TimeWindow | null = null;
let size = { width: 0, height: 0 };
let drawnKey = '';
let drawnJudgments: Judgment[] | null = null;
let marks: { x: number; mark: JudgmentMark }[] = [];

function currentWindow(): TimeWindow {
  return frozen ?? detailFrame(state.scope, getDurationMs());
}

const scopeText = (s: Scope) => `${secs(s.startMs)} - ${secs(s.endMs)}`;

function drawMarks(w: TimeWindow): void {
  const judgments = getPrimaryReplay()?.analysis.judgments ?? null;
  const key = `${w.startMs}|${w.endMs}|${size.width}|${size.height}`;
  if (key === drawnKey && judgments === drawnJudgments) return;
  drawnKey = key;
  drawnJudgments = judgments;

  const canvas = $<HTMLCanvasElement>('detailCanvas');
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  canvas.width = Math.round(size.width * dpr);
  canvas.height = Math.round(size.height * dpr);
  const c = canvas.getContext('2d');
  marks = [];
  if (!c || !judgments || size.width <= 0) return;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const span = Math.max(1, w.endMs - w.startMs);
  const top = 6;
  const bottom = size.height - 6;
  const list = judgmentMarks(judgments, w.startMs, w.endMs);
  marks = list.map((mark) => ({ x: ((mark.time - w.startMs) / span) * size.width, mark }));
  for (const kind of MARK_ORDER) {
    c.strokeStyle = MARK_COLOR[kind];
    c.fillStyle = MARK_COLOR[kind];
    c.lineWidth = kind === 'meh' ? 1.5 : 2;
    for (const { x, mark } of marks) {
      if (mark.kind !== kind) continue;
      const y0 = kind === 'meh' ? (top + bottom) / 2 : top;
      c.beginPath();
      c.moveTo(x, y0);
      c.lineTo(x, bottom);
      c.stroke();
      if (kind !== 'meh') {
        c.beginPath();
        c.moveTo(x - 3.5, top - 3);
        c.lineTo(x + 3.5, top - 3);
        c.lineTo(x, top + 3);
        c.closePath();
        c.fill();
      }
    }
  }
}

/** Positions, labels and marks; called with the playfield every rendered frame (marks redraw only on change). */
export function renderDetailBar(): void {
  const active = !!getActiveGroup();
  const w = currentWindow();
  const span = Math.max(1, w.endMs - w.startMs);
  const pct = (ms: number) => Math.max(0, Math.min(100, ((ms - w.startMs) / span) * 100));
  const s = state.scope;
  const left = pct(s.startMs);
  const right = pct(s.endMs);

  const hl = $('detailScopeHighlight');
  hl.style.left = `${left}%`;
  hl.style.width = `${Math.max(0.3, right - left)}%`;
  $('detailHandleStart').style.left = `${left}%`;
  $('detailHandleEnd').style.left = `${right}%`;
  const t = state.currentTimeMs;
  const playhead = $('detailPlayhead');
  playhead.style.left = `${pct(t)}%`;
  playhead.classList.toggle('hidden', !active || t < w.startMs || t > w.endMs);
  for (const id of ['detailHandleStart', 'detailHandleEnd', 'detailScopeHighlight']) $(id).classList.toggle('hidden', !active);
  setText('detailStartLabel', active ? formatTimeMs(w.startMs) : '—');
  setText('detailEndLabel', active ? formatTimeMs(w.endMs) : '—');

  const back = $('btnScopeBack');
  const parent = state.scopeHistory[state.scopeHistory.length - 1];
  back.classList.toggle('hidden', !parent);
  if (parent) setText('btnScopeBack', `↩ 返回上一区间（${scopeText(parent)}）`);

  drawMarks(w);
}

export function bindDetailBar(): void {
  const track = $('detailTrack');
  const selection = $('detailSelection');

  new ResizeObserver((entries) => {
    const r = entries[0].contentRect;
    size = { width: r.width, height: r.height };
    renderDetailBar();
  }).observe(track);

  const timeAt = (clientX: number) => {
    const w = currentWindow();
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    return Math.round(w.startMs + ratio * (w.endMs - w.startMs));
  };

  let mode: 'idle' | 'press' | 'sweep' | 'handle' = 'idle';
  let downX = 0;
  let anchor = 0;
  let pendingX: number | null = null;
  let raf = 0;

  const showSelection = (a: number, b: number) => {
    const w = currentWindow();
    const span = Math.max(1, w.endMs - w.startMs);
    const lo = ((Math.min(a, b) - w.startMs) / span) * 100;
    const hi = ((Math.max(a, b) - w.startMs) / span) * 100;
    selection.style.left = `${lo}%`;
    selection.style.width = `${Math.max(0.3, hi - lo)}%`;
    selection.classList.remove('hidden');
  };

  const flushMove = () => {
    raf = 0;
    if (pendingX === null) return;
    const t = timeAt(pendingX);
    pendingX = null;
    if (mode === 'handle') adjustScope({ type: 'custom', startMs: Math.min(anchor, t), endMs: Math.max(anchor, t) });
    else if (mode === 'sweep') showSelection(anchor, t);
  };

  const finish = () => {
    mode = 'idle';
    frozen = null;
    pendingX = null;
    selection.classList.add('hidden');
    renderDetailBar();
  };

  track.addEventListener('pointerdown', (e) => {
    if (!getActiveGroup() || e.button !== 0) return;
    e.preventDefault();
    setPlaying(false);
    frozen = currentWindow();
    track.setPointerCapture(e.pointerId);
    const handle = (e.target as HTMLElement).closest('#detailHandleStart, #detailHandleEnd');
    if (handle) {
      mode = 'handle';
      // The opposite edge is the anchor, so dragging across it never loses the range.
      anchor = handle.id === 'detailHandleStart' ? state.scope.endMs : state.scope.startMs;
    } else {
      mode = 'press';
      downX = e.clientX;
      anchor = timeAt(e.clientX);
    }
  });

  track.addEventListener('pointermove', (e) => {
    if (mode === 'idle') {
      // Hovering a judgement mark explains it.
      const x = e.clientX - track.getBoundingClientRect().left;
      let best: (typeof marks)[number] | null = null;
      for (const m of marks) if (Math.abs(m.x - x) <= HOVER_RADIUS_PX && (!best || Math.abs(m.x - x) < Math.abs(best.x - x))) best = m;
      const title = best ? `${secs(best.mark.time, 3)} · ${best.mark.text}` : '';
      if (track.title !== title) track.title = title;
      return;
    }
    if (mode === 'press' && Math.abs(e.clientX - downX) >= DRAG_THRESHOLD_PX) mode = 'sweep';
    if (mode === 'press') return;
    pendingX = e.clientX;
    if (!raf) raf = requestAnimationFrame(flushMove);
  });

  track.addEventListener('pointerup', (e) => {
    if (mode === 'idle') return;
    if (track.hasPointerCapture(e.pointerId)) track.releasePointerCapture(e.pointerId);
    const t = timeAt(e.clientX);
    if (mode === 'press') seek(t);
    else if (mode === 'sweep') {
      drillScope({ type: 'custom', startMs: Math.min(anchor, t), endMs: Math.max(anchor, t) });
      seek(state.scope.startMs);
    } else adjustScope({ type: 'custom', startMs: Math.min(anchor, t), endMs: Math.max(anchor, t) });
    finish();
  });

  track.addEventListener('pointercancel', (e) => {
    if (mode === 'idle') return;
    if (track.hasPointerCapture(e.pointerId)) track.releasePointerCapture(e.pointerId);
    finish();
  });

  $('btnScopeBack').addEventListener('click', () => popScope());
}

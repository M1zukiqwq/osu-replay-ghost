import { advanceTime, ensureTimeInScope, seek, setLayer, setPlaying, setSpeed } from '../app/actions';
import { getDurationMs, getPrimaryReplay, state } from '../app/state';
import { frameIndexAt } from '../core/replay/frames';
import { playHitsound, warmUpAudio } from './audio';
import { $ } from './dom';
import { showToast } from './toast';

const FALLBACK_STEP_MS = 16;

function togglePlay(): void {
  if (!state.isPlaying) warmUpAudio();
  setPlaying(!state.isPlaying);
}

let lastTs = 0;

/** Advances playback by the elapsed wall time × speed; triggers hitsounds for notes crossed in (prev, next]. */
export function playbackStep(ts: number): void {
  if (!state.isPlaying) {
    lastTs = 0;
    return;
  }
  const elapsed = lastTs ? Math.min(100, ts - lastTs) : 0;
  lastTs = ts;
  const d = getDurationMs();
  const s = state.scope;
  const prev = state.currentTimeMs;
  const next = prev + elapsed * state.playbackSpeed;
  const end = state.loop ? s.endMs : d;
  if (next >= end) {
    triggerHitsounds(prev, end);
    if (state.loop) advanceTime(s.startMs);
    else {
      advanceTime(d);
      setPlaying(false);
    }
    return;
  }
  triggerHitsounds(prev, next);
  advanceTime(next);
}

export function resetPlaybackClock(): void {
  lastTs = 0;
}

function triggerHitsounds(from: number, to: number): void {
  const pri = getPrimaryReplay();
  if (!pri || !state.audioEnabled || to <= from) return;
  const js = pri.analysis.judgments;
  let lo = 0;
  let hi = js.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (js[mid].noteTime <= from) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < js.length && js[i].noteTime <= to; i++) {
    if (js[i].judgment === 'SKIP') continue;
    playHitsound(js[i].judgment === 'MISS', js[i].keyUsed === 'K2');
  }
}

/** ±n frames on the primary replay's real frames; falls back to 16 ms steps without frames (B20). */
export function stepFrames(n: number): void {
  setPlaying(false);
  const pri = getPrimaryReplay();
  const t = state.currentTimeMs;
  if (!pri || pri.frames.length === 0) {
    seek(t + n * FALLBACK_STEP_MS);
    return;
  }
  const frames = pri.frames;
  const idx = frameIndexAt(frames, t);
  const exact = idx >= 0 && frames[idx].time === t;
  let target: number;
  if (n > 0) target = idx < 0 ? n - 1 : idx + n;
  else target = exact ? idx + n : idx + n + 1;
  target = Math.max(0, Math.min(frames.length - 1, target));
  // Skip over frames that share a timestamp so each step visibly moves.
  if (frames[target].time === t && target + Math.sign(n) >= 0 && target + Math.sign(n) < frames.length) target += Math.sign(n);
  seek(frames[target].time);
}

/** Jumps to the primary replay's previous/next miss, wrapping around; switches scope if needed (D8). */
export function jumpToMiss(dir: 1 | -1): void {
  setPlaying(false);
  const pri = getPrimaryReplay();
  if (!pri) {
    showToast('没有主视角回放', '请先勾选一条有轨迹数据的回放', 'cyan');
    return;
  }
  const misses = pri.analysis.judgments.filter((j) => j.judgment === 'MISS');
  if (!misses.length) {
    showToast('当前主视角无 Miss', '该 Replay 在模拟判定中没有 Miss', 'emerald');
    return;
  }
  const t = state.currentTimeMs;
  const target = dir > 0
    ? misses.find((m) => m.noteTime > t + 1) ?? misses[0]
    : [...misses].reverse().find((m) => m.noteTime < t - 1) ?? misses[misses.length - 1];
  ensureTimeInScope(target.noteTime);
  seek(target.noteTime);
}

const SPEED_ON = 'speed-btn px-1.5 py-0.5 rounded bg-pink-500/20 text-pink-300 border border-pink-500/40 font-mono font-bold';
const SPEED_OFF = 'speed-btn px-1.5 py-0.5 rounded text-slate-400 hover:text-white font-mono border border-transparent';

export function renderPlayerControls(): void {
  $('playPauseIcon').textContent = state.isPlaying ? '⏸' : '▶';
  $('playPauseText').textContent = state.isPlaying ? '暂停' : '播放';
  document.querySelectorAll<HTMLButtonElement>('.speed-btn').forEach((b) => {
    b.className = parseFloat(b.dataset.speed ?? '') === state.playbackSpeed ? SPEED_ON : SPEED_OFF;
  });
  ($('chkShowGhostTrails') as HTMLInputElement).checked = state.showGhostTrails;
  ($('chkShowKeyMarkers') as HTMLInputElement).checked = state.showKeyMarkers;
  ($('chkShowAimVectors') as HTMLInputElement).checked = state.showAimVectors;
  ($('chkLoopSlice') as HTMLInputElement).checked = state.loop;
}

export function bindPlayer(): void {
  const layer = (id: string, key: 'showGhostTrails' | 'showKeyMarkers' | 'showAimVectors' | 'loop') =>
    $(id).addEventListener('change', (e) => setLayer(key, (e.target as HTMLInputElement).checked));
  layer('chkShowGhostTrails', 'showGhostTrails');
  layer('chkShowKeyMarkers', 'showKeyMarkers');
  layer('chkShowAimVectors', 'showAimVectors');
  layer('chkLoopSlice', 'loop');

  $('btnPlayPause').addEventListener('click', togglePlay);
  $('btnStepBack10F').addEventListener('click', () => stepFrames(-10));
  $('btnStepBack1F').addEventListener('click', () => stepFrames(-1));
  $('btnStepForward1F').addEventListener('click', () => stepFrames(1));
  $('btnStepForward10F').addEventListener('click', () => stepFrames(10));
  $('btnStepPrevMiss').addEventListener('click', () => jumpToMiss(-1));
  $('btnStepNextMiss').addEventListener('click', () => jumpToMiss(1));
  document.querySelectorAll<HTMLButtonElement>('.speed-btn').forEach((b) => {
    b.addEventListener('click', () => setSpeed(parseFloat(b.dataset.speed ?? '0.25')));
  });

  window.addEventListener('keydown', (e) => {
    const tag = (document.activeElement as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (!$('importModal').classList.contains('hidden')) return;
    if (e.code === 'Space') {
      e.preventDefault();
      // A focused button would also activate on Space; drop focus so the toggle happens once.
      if (tag === 'BUTTON') (document.activeElement as HTMLElement).blur();
      togglePlay();
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault();
      stepFrames(e.shiftKey ? -10 : -1);
    } else if (e.code === 'ArrowRight') {
      e.preventDefault();
      stepFrames(e.shiftKey ? 10 : 1);
    }
  });
}

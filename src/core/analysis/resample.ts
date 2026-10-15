import type { Frame, Scope } from '../types';
import { cursorPositionAt } from '../replay/frames';

export const SPEED_SAMPLES = 120;

/** Uniform time grid over the scope (inclusive of both ends). */
export function timeGrid(scope: Pick<Scope, 'startMs' | 'endMs'>, n = SPEED_SAMPLES): number[] {
  const span = scope.endMs - scope.startMs;
  if (n < 2 || span <= 0) return [scope.startMs];
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(scope.startMs + (span * i) / (n - 1));
  return out;
}

/**
 * Cursor speed (px/ms) at each grid time, from the displacement between consecutive grid points
 * of the interpolated cursor. Times outside the replay's frame range yield null.
 */
export function resampleSpeed(frames: Frame[], grid: number[]): (number | null)[] {
  if (frames.length < 2 || grid.length < 2) return grid.map(() => null);
  const first = frames[0].time;
  const last = frames[frames.length - 1].time;
  const step = grid[1] - grid[0];
  return grid.map((t) => {
    const t0 = t - step;
    if (t0 < first || t > last) return null;
    const a = cursorPositionAt(frames, t0)!;
    const b = cursorPositionAt(frames, t)!;
    return Math.hypot(b.x - a.x, b.y - a.y) / step;
  });
}

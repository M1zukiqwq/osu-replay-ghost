import type { Scope } from '../types';

export const MIN_CUSTOM_SCOPE_MS = 200;

/** Half-open [start, end); closed on the right when the scope ends at the map's duration. */
export function inScope(t: number, scope: Pick<Scope, 'startMs' | 'endMs'>, durationMs: number): boolean {
  if (t < scope.startMs) return false;
  if (t < scope.endMs) return true;
  return t === scope.endMs && scope.endMs >= durationMs;
}

export function fullScope(durationMs: number): Scope {
  return { type: 'full', startMs: 0, endMs: durationMs };
}

export function sliceCount(durationMs: number, sliceLen: number): number {
  return Math.max(1, Math.ceil(durationMs / sliceLen));
}

export function sliceScope(index: number, sliceLen: number, durationMs: number): Scope {
  const n = sliceCount(durationMs, sliceLen);
  const i = Math.min(Math.max(0, index), n - 1);
  return { type: 'slice', sliceIndex: i, startMs: i * sliceLen, endMs: Math.min((i + 1) * sliceLen, durationMs) };
}

/** Index of the slice containing t (same rule as inScope; t == duration goes to the last slice). */
export function sliceIndexOf(t: number, sliceLen: number, durationMs: number): number {
  if (t < 0 || t > durationMs) return -1;
  return Math.min(Math.floor(t / sliceLen), sliceCount(durationMs, sliceLen) - 1);
}

/** Enforces invariant 3: 0 <= start < end <= duration, custom scopes >= 200 ms. */
export function clampScope(scope: Scope, durationMs: number): Scope {
  const minLen = scope.type === 'custom' ? Math.min(MIN_CUSTOM_SCOPE_MS, durationMs) : 1;
  let start = Math.max(0, Math.min(scope.startMs, scope.endMs));
  let end = Math.min(durationMs, Math.max(scope.startMs, scope.endMs));
  if (end - start < minLen) {
    end = Math.min(durationMs, start + minLen);
    start = Math.max(0, end - minLen);
  }
  return { ...scope, startMs: start, endMs: end };
}

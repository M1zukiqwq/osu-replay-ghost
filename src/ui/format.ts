export const DASH = '—';

export function formatTimeMs(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const totalSec = Math.floor(clamped / 1000);
  const mins = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const secs = String(totalSec % 60).padStart(2, '0');
  const milli = String(clamped % 1000).padStart(3, '0');
  return `${mins}:${secs}.${milli}`;
}

export function secs(ms: number, digits = 2): string {
  return `${(ms / 1000).toFixed(digits)}s`;
}

/** Formats a nullable number; null renders as "—" (P2). */
export function num(v: number | null | undefined, digits = 1, suffix = ''): string {
  return v === null || v === undefined || !Number.isFinite(v) ? DASH : `${v.toFixed(digits)}${suffix}`;
}

export function signed(v: number, digits = 1): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`;
}

export function playedAtLabel(ms: number | null): string {
  if (ms === null) return DASH;
  return new Date(ms).toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function clockLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });
}

export function sliceLenLabel(ms: number): string {
  const s = ms / 1000;
  return `${Number.isInteger(s) ? s : s.toFixed(1)}s`;
}

import type { Frame, KeyName, KeyPress } from '../types';

export const ALT_INTERVAL_MS = 450;

/** Extracts K1/K2 press events (§5.3). holdMs is null when the key is still down at the end. */
export function extractKeyPresses(frames: Frame[]): KeyPress[] {
  const presses: KeyPress[] = [];
  const active: Record<KeyName, KeyPress | null> = { K1: null, K2: null };
  const prevDown: Record<KeyName, boolean> = { K1: false, K2: false };
  let lastStart: number | null = null;

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    for (const key of ['K1', 'K2'] as const) {
      const down = key === 'K1' ? f.k1 : f.k2;
      if (down && !prevDown[key]) {
        const kp: KeyPress = {
          key,
          time: f.time,
          endTime: null,
          holdMs: null,
          x: f.x,
          y: f.y,
          frameIndex: i,
          tapInterval: lastStart === null ? null : f.time - lastStart,
        };
        presses.push(kp);
        active[key] = kp;
        lastStart = f.time;
      } else if (!down && prevDown[key]) {
        const kp = active[key];
        if (kp) {
          kp.endTime = f.time;
          kp.holdMs = f.time - kp.time;
        }
        active[key] = null;
      }
      prevDown[key] = down;
    }
  }
  return presses;
}

export interface AltCounts { alternate: number; single: number }

/** Counts alternate vs single-key transitions between consecutive presses closer than 450 ms. */
export function countAlternation(presses: KeyPress[]): AltCounts {
  let alternate = 0;
  let single = 0;
  for (let i = 1; i < presses.length; i++) {
    if (presses[i].time - presses[i - 1].time >= ALT_INTERVAL_MS) continue;
    if (presses[i].key !== presses[i - 1].key) alternate++;
    else single++;
  }
  return { alternate, single };
}

import type { Beatmap, EffectiveDifficulty } from '../types';
import { MOD } from '../replay/mods';

export const EARLY_MISS_WINDOW_MS = 400;

export function circleRadius(cs: number): number {
  return 54.4 - 4.48 * cs;
}

export function preemptFor(ar: number): number {
  return ar < 5 ? 1200 + (600 * (5 - ar)) / 5 : 1200 - (750 * (ar - 5)) / 5;
}

/** Difficulty parameters after applying HR/EZ (§5.1). DT/HT do not change windows on the song timeline. */
export function effectiveDifficulty(map: Pick<Beatmap, 'cs' | 'od' | 'ar' | 'hp'>, mods: number): EffectiveDifficulty {
  let { cs, od, ar, hp } = map;
  if (mods & MOD.HR) {
    cs = Math.min(10, cs * 1.3);
    ar = Math.min(10, ar * 1.4);
    od = Math.min(10, od * 1.4);
    hp = Math.min(10, hp * 1.4);
  } else if (mods & MOD.EZ) {
    cs *= 0.5;
    ar *= 0.5;
    od *= 0.5;
    hp *= 0.5;
  }
  return {
    cs,
    od,
    ar,
    hp,
    radius: circleRadius(cs),
    hw300: 80 - 6 * od,
    hw100: 140 - 8 * od,
    hw50: 200 - 10 * od,
    earlyMissWindow: EARLY_MISS_WINDOW_MS,
    preempt: preemptFor(ar),
  };
}

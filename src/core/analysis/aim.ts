import type { HitObject, Vec2 } from '../types';

export const AIM_CLASSIFY_THRESHOLD_PX = 1.5;
export const MIN_MOVEMENT_PX = 1;
export const PLAYFIELD_CENTRE: Vec2 = { x: 256, y: 192 };

/** Start point of the movement into object i: previous slider's end position, previous circle, or the centre. */
export function movementOrigin(objects: HitObject[], i: number): Vec2 {
  const prev = i > 0 ? objects[i - 1] : null;
  if (!prev || prev.type === 'spinner') return PLAYFIELD_CENTRE;
  if (prev.slider) return { x: prev.slider.endX, y: prev.slider.endY };
  return { x: prev.x, y: prev.y };
}

export interface AimDecomposition {
  radialOffset: number;
  longitudinalOffset: number | null;
  lateralOffset: number | null;
  isOveraim: boolean;
  isUnderaim: boolean;
}

export function decomposeAim(origin: Vec2, target: Vec2, landing: Vec2): AimDecomposition {
  const ex = landing.x - target.x;
  const ey = landing.y - target.y;
  const radialOffset = Math.hypot(ex, ey);
  const mx = target.x - origin.x;
  const my = target.y - origin.y;
  const len = Math.hypot(mx, my);
  if (len < MIN_MOVEMENT_PX) {
    return { radialOffset, longitudinalOffset: null, lateralOffset: null, isOveraim: false, isUnderaim: false };
  }
  const dx = mx / len;
  const dy = my / len;
  const longitudinalOffset = ex * dx + ey * dy;
  const lateralOffset = -ex * dy + ey * dx;
  return {
    radialOffset,
    longitudinalOffset,
    lateralOffset,
    isOveraim: longitudinalOffset > AIM_CLASSIFY_THRESHOLD_PX,
    isUnderaim: longitudinalOffset < -AIM_CLASSIFY_THRESHOLD_PX,
  };
}

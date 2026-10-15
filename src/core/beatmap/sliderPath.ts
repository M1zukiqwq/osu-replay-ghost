import type { CurveType, Vec2 } from '../types';

// Approximation follows osu-framework's PathApproximator and lazer's SliderPath.
const BEZIER_TOLERANCE = 0.25;
const CIRCULAR_ARC_TOLERANCE = 0.1;
const CATMULL_DETAIL = 50;

const eq = (a: Vec2, b: Vec2) => a.x === b.x && a.y === b.y;

function bezierIsFlatEnough(cp: Vec2[]): boolean {
  const limit = BEZIER_TOLERANCE * BEZIER_TOLERANCE * 4;
  for (let i = 1; i < cp.length - 1; i++) {
    const dx = cp[i - 1].x - 2 * cp[i].x + cp[i + 1].x;
    const dy = cp[i - 1].y - 2 * cp[i].y + cp[i + 1].y;
    if (dx * dx + dy * dy > limit) return false;
  }
  return true;
}

function bezierSubdivide(cp: Vec2[], left: Vec2[], right: Vec2[]): void {
  const count = cp.length;
  const mid = cp.map((p) => ({ x: p.x, y: p.y }));
  for (let i = 0; i < count; i++) {
    left[i] = { x: mid[0].x, y: mid[0].y };
    right[count - i - 1] = { x: mid[count - i - 1].x, y: mid[count - i - 1].y };
    for (let j = 0; j < count - i - 1; j++) {
      mid[j] = { x: (mid[j].x + mid[j + 1].x) / 2, y: (mid[j].y + mid[j + 1].y) / 2 };
    }
  }
}

function bezierApproximate(cp: Vec2[], out: Vec2[]): void {
  const count = cp.length;
  const l: Vec2[] = new Array(count * 2 - 1);
  const r: Vec2[] = new Array(count);
  bezierSubdivide(cp, l, r);
  for (let i = 0; i < count - 1; i++) l[count + i] = r[i + 1];
  out.push(cp[0]);
  for (let i = 1; i < count - 1; i++) {
    const idx = 2 * i;
    out.push({
      x: 0.25 * (l[idx - 1].x + 2 * l[idx].x + l[idx + 1].x),
      y: 0.25 * (l[idx - 1].y + 2 * l[idx].y + l[idx + 1].y),
    });
  }
}

export function bezierToPolyline(cp: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  if (cp.length === 0) return out;
  const stack: Vec2[][] = [cp.slice()];
  while (stack.length > 0) {
    const parent = stack.pop()!;
    if (bezierIsFlatEnough(parent)) {
      bezierApproximate(parent, out);
      continue;
    }
    const left: Vec2[] = new Array(parent.length);
    const right: Vec2[] = new Array(parent.length);
    bezierSubdivide(parent, left, right);
    stack.push(right);
    stack.push(left);
  }
  out.push(cp[cp.length - 1]);
  return out;
}

interface ArcProps { centre: Vec2; radius: number; thetaStart: number; thetaRange: number; dir: number }

function circularArcProperties(a: Vec2, b: Vec2, c: Vec2): ArcProps | null {
  const cross = (b.y - a.y) * (c.x - a.x) - (b.x - a.x) * (c.y - a.y);
  if (Math.abs(cross) < 1e-3) return null;
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  const aSq = a.x * a.x + a.y * a.y;
  const bSq = b.x * b.x + b.y * b.y;
  const cSq = c.x * c.x + c.y * c.y;
  const centre = {
    x: (aSq * (b.y - c.y) + bSq * (c.y - a.y) + cSq * (a.y - b.y)) / d,
    y: (aSq * (c.x - b.x) + bSq * (a.x - c.x) + cSq * (b.x - a.x)) / d,
  };
  const dA = { x: a.x - centre.x, y: a.y - centre.y };
  const dC = { x: c.x - centre.x, y: c.y - centre.y };
  const radius = Math.hypot(dA.x, dA.y);
  const thetaStart = Math.atan2(dA.y, dA.x);
  let thetaEnd = Math.atan2(dC.y, dC.x);
  while (thetaEnd < thetaStart) thetaEnd += 2 * Math.PI;
  let dir = 1;
  let thetaRange = thetaEnd - thetaStart;
  const ortho = { x: c.y - a.y, y: -(c.x - a.x) };
  if (ortho.x * (b.x - a.x) + ortho.y * (b.y - a.y) < 0) {
    dir = -1;
    thetaRange = 2 * Math.PI - thetaRange;
  }
  return { centre, radius, thetaStart, thetaRange, dir };
}

export function circularArcToPolyline(cp: Vec2[]): Vec2[] {
  const pr = cp.length === 3 ? circularArcProperties(cp[0], cp[1], cp[2]) : null;
  if (!pr) return bezierToPolyline(cp);
  const amount =
    2 * pr.radius <= CIRCULAR_ARC_TOLERANCE
      ? 2
      : Math.max(2, Math.ceil(pr.thetaRange / (2 * Math.acos(1 - CIRCULAR_ARC_TOLERANCE / pr.radius))));
  const out: Vec2[] = [];
  for (let i = 0; i < amount; i++) {
    const theta = pr.thetaStart + pr.dir * (i / (amount - 1)) * pr.thetaRange;
    out.push({ x: pr.centre.x + Math.cos(theta) * pr.radius, y: pr.centre.y + Math.sin(theta) * pr.radius });
  }
  return out;
}

function catmullPoint(v1: Vec2, v2: Vec2, v3: Vec2, v4: Vec2, t: number): Vec2 {
  const t2 = t * t;
  const t3 = t * t2;
  const f = (a: number, b: number, c: number, d: number) =>
    0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return { x: f(v1.x, v2.x, v3.x, v4.x), y: f(v1.y, v2.y, v3.y, v4.y) };
}

/** Uniform Catmull-Rom as used by osu! stable (and lazer's legacy conversion). */
export function catmullToPolyline(cp: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < cp.length - 1; i++) {
    const v1 = i > 0 ? cp[i - 1] : cp[i];
    const v2 = cp[i];
    const v3 = cp[i + 1];
    const v4 = i < cp.length - 2 ? cp[i + 2] : { x: 2 * v3.x - v2.x, y: 2 * v3.y - v2.y };
    for (let c = 0; c < CATMULL_DETAIL; c++) {
      out.push(catmullPoint(v1, v2, v3, v4, c / CATMULL_DETAIL));
      out.push(catmullPoint(v1, v2, v3, v4, (c + 1) / CATMULL_DETAIL));
    }
  }
  return out;
}

function isCollinear(a: Vec2, b: Vec2, c: Vec2): boolean {
  return Math.abs((b.y - a.y) * (c.x - a.x) - (b.x - a.x) * (c.y - a.y)) < 1e-3;
}

/** Resolve the effective curve type with stable's edge-case rules. */
export function effectiveCurveType(type: CurveType, cp: Vec2[]): CurveType {
  if (type === 'P') {
    if (cp.length !== 3) return 'B';
    if (isCollinear(cp[0], cp[1], cp[2])) return 'L';
  }
  return type;
}

/** Split control points into segments at repeated points ("red anchors"). */
function splitSegments(type: CurveType, cp: Vec2[]): Vec2[][] {
  if (type === 'C' || type === 'L') return [cp];
  const segments: Vec2[][] = [];
  let cur: Vec2[] = [cp[0]];
  for (let k = 1; k < cp.length; k++) {
    if (eq(cp[k], cp[k - 1]) && k < cp.length - 1) {
      segments.push(cur);
      cur = [cp[k]];
    } else cur.push(cp[k]);
  }
  segments.push(cur);
  return segments;
}

function segmentPolyline(type: CurveType, seg: Vec2[]): Vec2[] {
  if (seg.length <= 1) return seg.slice();
  switch (type) {
    case 'L':
      return seg.slice();
    case 'P':
      return circularArcToPolyline(seg);
    case 'C':
      return catmullToPolyline(seg);
    default:
      return bezierToPolyline(seg);
  }
}

export interface ComputedPath { path: Vec2[]; cumulative: number[] }

/** Builds the sampled path and fits it to `expectedLength` (truncate, or extend along the last segment). */
export function computeSliderPath(curveType: CurveType, controlPoints: Vec2[], expectedLength: number): ComputedPath {
  const type = effectiveCurveType(curveType, controlPoints);
  const path: Vec2[] = [];
  for (const seg of splitSegments(type, controlPoints)) {
    const sub = segmentPolyline(type, seg);
    const skipFirst = path.length > 0 && sub.length > 0 && eq(path[path.length - 1], sub[0]);
    for (let j = skipFirst ? 1 : 0; j < sub.length; j++) path.push(sub[j]);
  }
  if (path.length === 0) path.push(controlPoints[0] ?? { x: 0, y: 0 });

  const cumulative = [0];
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    total += Math.hypot(path[i + 1].x - path[i].x, path[i + 1].y - path[i].y);
    cumulative.push(total);
  }

  if (!(expectedLength > 0) || total === expectedLength) return { path, cumulative };

  // osu! stable does not extend when the last two points coincide.
  if (path.length >= 2 && eq(path[path.length - 1], path[path.length - 2]) && expectedLength > total) {
    return { path, cumulative };
  }

  cumulative.pop();
  let end = path.length - 1;
  if (total > expectedLength) {
    while (cumulative.length > 0 && cumulative[cumulative.length - 1] >= expectedLength) {
      cumulative.pop();
      path.pop();
      end--;
    }
  }
  if (end <= 0) {
    return { path: [path[0] ?? controlPoints[0]], cumulative: [0] };
  }
  const a = path[end - 1];
  const b = path[end];
  const segLen = Math.hypot(b.x - a.x, b.y - a.y);
  const dir = segLen > 0 ? { x: (b.x - a.x) / segLen, y: (b.y - a.y) / segLen } : { x: 0, y: 0 };
  const remain = expectedLength - cumulative[cumulative.length - 1];
  path[end] = { x: a.x + dir.x * remain, y: a.y + dir.y * remain };
  cumulative.push(expectedLength);
  path.length = end + 1;
  return { path, cumulative };
}

/** Position at a distance along the path (clamped to its ends). */
export function positionAtDistance(path: Vec2[], cumulative: number[], d: number): Vec2 {
  if (path.length === 1 || d <= 0) return path[0];
  const total = cumulative[cumulative.length - 1];
  if (d >= total) return path[path.length - 1];
  let lo = 0;
  let hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid] < d) lo = mid + 1;
    else hi = mid;
  }
  const i = Math.max(1, lo);
  const d0 = cumulative[i - 1];
  const d1 = cumulative[i];
  const w = d1 - d0 > 0 ? (d - d0) / (d1 - d0) : 0;
  return { x: path[i - 1].x + (path[i].x - path[i - 1].x) * w, y: path[i - 1].y + (path[i].y - path[i - 1].y) * w };
}

/** Progress (0..1 along the path) of a slider at a time, accounting for repeats. */
export function sliderProgressAt(time: number, start: number, spanDuration: number, slides: number): number {
  if (spanDuration <= 0) return 0;
  const raw = Math.min(slides, Math.max(0, (time - start) / spanDuration));
  const span = Math.min(slides - 1, Math.floor(raw));
  const f = raw - span;
  return span % 2 === 1 ? 1 - f : f;
}

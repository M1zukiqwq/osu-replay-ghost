import type { RadarPoint } from '../core/analysis/metrics';
import { $ } from './dom';

const SIZE = 210;

/** Landing points relative to the circle centre, rotated so that "up" is the movement direction (overaim). */
export function drawAimRadar(points: RadarPoint[], radius: number, colorOf: (replayId: string) => string): void {
  const canvas = $<HTMLCanvasElement>('aimRadarCanvas');
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  if (canvas.width !== Math.round(SIZE * dpr)) {
    canvas.width = Math.round(SIZE * dpr);
    canvas.height = Math.round(SIZE * dpr);
  }
  const c = canvas.getContext('2d');
  if (!c) return;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const scale = (SIZE * 0.36) / radius;
  c.clearRect(0, 0, SIZE, SIZE);

  c.strokeStyle = '#1e293b';
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(cx, 8);
  c.lineTo(cx, SIZE - 8);
  c.moveTo(8, cy);
  c.lineTo(SIZE - 8, cy);
  c.stroke();

  c.strokeStyle = '#38bdf8';
  c.lineWidth = 1.8;
  c.beginPath();
  c.arc(cx, cy, radius * scale, 0, Math.PI * 2);
  c.stroke();

  c.strokeStyle = 'rgba(148, 163, 184, 0.25)';
  c.setLineDash([3, 3]);
  c.beginPath();
  c.arc(cx, cy, radius * scale * 0.5, 0, Math.PI * 2);
  c.stroke();
  c.setLineDash([]);

  c.fillStyle = '#94a3b8';
  c.font = '10px Inter, sans-serif';
  c.textAlign = 'center';
  c.fillText('Overaim (拉过头)', cx, 14);
  c.fillText('Underaim (未到位)', cx, SIZE - 6);

  // Far-off points are clamped to the edge, leaving room for the top/bottom labels.
  const limX = SIZE / 2 - 6;
  const limY = SIZE / 2 - 22;
  for (const p of points) {
    const px = cx + Math.max(-limX, Math.min(limX, p.lateral * scale));
    const py = cy - Math.max(-limY, Math.min(limY, p.longitudinal * scale));
    c.beginPath();
    if (p.miss) {
      c.strokeStyle = '#f43f5e';
      c.lineWidth = 2;
      c.moveTo(px - 4, py - 4);
      c.lineTo(px + 4, py + 4);
      c.moveTo(px + 4, py - 4);
      c.lineTo(px - 4, py + 4);
      c.stroke();
    } else {
      c.fillStyle = colorOf(p.replayId);
      c.arc(px, py, 3.5, 0, Math.PI * 2);
      c.fill();
    }
  }
}

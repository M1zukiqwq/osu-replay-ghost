import {
  BarController, BarElement, CategoryScale, Chart, Legend, LinearScale, LineController, LineElement, PointElement,
  ScatterController, Tooltip, type ChartDataset,
} from 'chart.js';
import { $ } from './dom';

Chart.register(BarController, BarElement, CategoryScale, LinearScale, LineController, LineElement, PointElement, ScatterController, Legend, Tooltip);

const TICK = { color: '#94a3b8', font: { size: 9 } };
const GRID = { color: '#1e293b' };
const LEGEND = { labels: { color: '#cbd5e1', font: { size: 10 }, boxWidth: 10 } };

let tapChart: Chart<'bar'> | null = null;
let speedChart: Chart | null = null;

export interface SeriesStyle { label: string; color: string }

/** Updated in place (no destroy/re-create) so dragging the range stays smooth (B30). */
export function updateTapChart(labels: string[], series: (SeriesStyle & { counts: number[] })[]): void {
  const datasets = series.map((s) => ({
    label: s.label,
    data: s.counts,
    backgroundColor: s.color + '99',
    borderColor: s.color,
    borderWidth: 1.5,
    borderRadius: 4,
  }));
  if (!tapChart) {
    tapChart = new Chart($<HTMLCanvasElement>('tapTimingChart'), {
      type: 'bar',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: { legend: LEGEND, tooltip: { callbacks: { title: (items) => `打击误差 ${items[0]?.label ?? ''} ms（仅命中）` } } },
        scales: {
          x: { ticks: TICK, grid: GRID, title: { display: true, text: '打击误差 (ms)', color: '#64748b', font: { size: 9 } } },
          y: { beginAtZero: true, ticks: { ...TICK, precision: 0 }, grid: GRID },
        },
      },
    });
    return;
  }
  tapChart.data.labels = labels;
  tapChart.data.datasets = datasets;
  tapChart.update('none');
}

export function updateSpeedChart(
  speedSeries: (SeriesStyle & { points: { x: number; y: number | null }[] })[],
  intervals: (SeriesStyle & { points: { x: number; y: number }[] }) | null,
  xRange: [number, number],
): void {
  const datasets: ChartDataset[] = speedSeries.map((s) => ({
    type: 'line' as const,
    label: `${s.label} 速度`,
    data: s.points,
    borderColor: s.color,
    backgroundColor: s.color + '22',
    tension: 0.3,
    pointRadius: 0,
    borderWidth: 2,
    spanGaps: false,
    yAxisID: 'y',
  }));
  if (intervals) {
    datasets.push({
      type: 'scatter' as const,
      label: `${intervals.label} 连打间隔`,
      data: intervals.points,
      borderColor: '#e2e8f0',
      backgroundColor: intervals.color,
      pointRadius: 2.5,
      pointStyle: 'rectRot',
      yAxisID: 'y2',
    });
  }
  const opts = {
    x: { type: 'linear' as const, min: xRange[0], max: xRange[1], ticks: { ...TICK, callback: (v: string | number) => `${Number(v).toFixed(1)}s` }, grid: GRID },
    y: { beginAtZero: true, ticks: TICK, grid: GRID, title: { display: true, text: 'px/ms', color: '#64748b', font: { size: 9 } } },
    y2: { position: 'right' as const, beginAtZero: true, ticks: TICK, grid: { drawOnChartArea: false }, title: { display: true, text: '间隔 ms', color: '#64748b', font: { size: 9 } } },
  };
  if (!speedChart) {
    speedChart = new Chart($<HTMLCanvasElement>('velocityTrendChart'), {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        parsing: false,
        normalized: true,
        plugins: { legend: LEGEND },
        scales: opts,
      },
    });
    return;
  }
  speedChart.data.datasets = datasets;
  if (speedChart.options.scales?.x) {
    speedChart.options.scales.x.min = xRange[0];
    speedChart.options.scales.x.max = xRange[1];
  }
  speedChart.update('none');
}

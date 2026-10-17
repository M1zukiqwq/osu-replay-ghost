import { setTab } from '../app/actions';
import { getActiveGroup, getDurationMs, getPrimaryReplay, getSelectedReplays, replayColor, state, type DetailTab } from '../app/state';
import { computeScopeMetrics, histogramLabels, hitErrorHistogram, tapIntervalSeries, type ScopeMetrics } from '../core/analysis/metrics';
import { resampleSpeed, timeGrid } from '../core/analysis/resample';
import { effectiveDifficulty } from '../core/beatmap/difficulty';
import { drawAimRadar } from './aimRadar';
import { updateSpeedChart, updateTapChart } from './charts';
import { $, h, setChildren, setText, type Child } from './dom';
import { DASH, num, secs, signed } from './format';

const TAB_ON = 'detail-tab-btn py-1.5 px-2 rounded-md bg-pink-500 text-white transition';
const TAB_OFF = 'detail-tab-btn py-1.5 px-2 rounded-md text-slate-400 hover:text-white transition';
const strong = (cls: string, text: string) => h('strong', { class: cls }, text);
const shortName = (name: string) => name.replace(/^LocalPlayer /, '').slice(0, 18);

function pctText(v: number | null): string {
  return v === null ? DASH : `${Math.round(v)}%`;
}

function renderSummary(m: ScopeMetrics): void {
  setText('statK1Count', String(m.k1));
  setText('statK2Count', String(m.k2));
  setText('statK1Pct', num(m.k1Pct, 1, '%'));
  setText('statK2Pct', num(m.k2Pct, 1, '%'));
  $('k1RatioBar').style.width = `${m.k1Pct ?? 0}%`;
  $('k2RatioBar').style.width = `${m.k2Pct ?? 0}%`;
  setText('kpsBadge', `平均 ${num(m.kps, 1)} KPS`);
  setText('statSliceMissCount', String(m.missCount));
  setText('statSliceBreakCount', m.sliderBreakCount ? `+${m.sliderBreakCount} 断连` : '');
  const reason = $('statSliceMissReason');
  // Misses explain first; with none, the first slider break's reason is shown instead.
  reason.textContent = m.missCount === 0 && m.sliderBreakReason ? `断连：${m.sliderBreakReason}` : m.missReason;
  reason.title = [m.missCount ? `Miss：${m.missReason}` : '', m.sliderBreakReason ? `断连：${m.sliderBreakReason}` : '']
    .filter(Boolean).join('\n') || m.missReason;
  setText('statSliceAimOffset', num(m.meanDeviation, 1, ' px'));
  setText('statSliceUR', `UR ${num(m.primary?.ur ?? null, 1)}`);

  const selected = getSelectedReplays();
  setChildren($('perReplayKeyTableBody'), ...m.rows.map((row) => {
    const rep = selected.find((r) => r.id === row.id)!;
    return h('tr', null,
      h('td', { class: 'py-1.5 font-sans' },
        h('span', { class: 'flex items-center gap-1.5' },
          h('span', { class: 'w-2 h-2 rounded-full shrink-0', style: { background: replayColor(rep) } }),
          h('span', { class: 'text-slate-200 truncate max-w-[115px]', title: rep.playerName }, rep.playerName))),
      h('td', { class: 'py-1.5 text-right text-cyan-300 font-bold' }, String(row.k1)),
      h('td', { class: 'py-1.5 text-right text-pink-300 font-bold' }, String(row.k2)),
      h('td', { class: 'py-1.5 text-right text-slate-300' }, row.altPct === null ? DASH : `Alt ${Math.round(row.altPct)}%`),
      h('td', { class: `py-1.5 text-right ${row.miss > 0 ? 'text-rose-400 font-bold' : 'text-emerald-400'}` }, String(row.miss)),
      h('td', { class: `py-1.5 text-right ${row.sliderBreaks > 0 ? 'text-orange-300 font-bold' : 'text-slate-500'}` }, String(row.sliderBreaks)),
      h('td', { class: 'py-1.5 text-right text-amber-300' }, num(row.meanDeviation, 1, 'px')),
    );
  }));
}

function renderAimTab(m: ScopeMetrics): void {
  setText('statOveraimPct', pctText(m.overaimPct));
  setText('statUnderaimPct', pctText(m.underaimPct));
  $('barOveraim').style.width = `${m.overaimPct ?? 0}%`;
  $('barUnderaim').style.width = `${m.underaimPct ?? 0}%`;
  setText('statMeanRadialError', num(m.meanDeviation, 1, ' px'));
  setText('statEffectiveCount', String(m.effectiveCount));

  const g = getActiveGroup()!;
  const pri = getPrimaryReplay();
  const radius = pri ? pri.analysis.effective.radius : effectiveDifficulty(g.beatmap, 0).radius;
  const colors = new Map(getSelectedReplays().map((r) => [r.id, replayColor(r)]));
  drawAimRadar(m.radar, radius, (id) => colors.get(id) ?? '#22d3ee');

  let parts: Child[];
  if (m.effectiveCount === 0) {
    parts = ['ℹ️ ', strong('', '本区间诊断：'), '当前区间内没有可判定的物件（转盘不参与 Aim 判定）。'];
  } else if (m.missCount > 0) {
    const over = m.overaimPct ?? 0;
    const under = m.underaimPct ?? 0;
    const tendency = over >= under
      ? ['明显偏向 ', strong('text-rose-400', `Overaim（拉过头 ${Math.round(over)}%）`), '，跳跃时手部惯性越过圆心']
      : ['明显偏向 ', strong('text-amber-300', `Underaim（未拉到位 ${Math.round(under)}%）`), '，光标还没到圆心就按下了'];
    const breaks = m.sliderBreakCount ? ['，另有 ', strong('text-orange-300', `${m.sliderBreakCount} 次滑条断连`)] : [];
    parts = ['🔍 ', strong('', '本区间诊断：'), '共检测到 ', strong('text-rose-400', `${m.missCount} 次 Miss`), ...breaks, '（模拟判定），落点趋势',
      ...tendency, '。建议用播放器下方的 ', strong('', '「◀ -1帧 / +1帧 ▶」'), '（或键盘 ←/→）逐帧对照各回放颜色的轨迹，观察急停时机。'];
  } else if (m.sliderBreakCount > 0) {
    parts = ['🔗 ', strong('', '本区间诊断：'), '没有 Miss，但有 ', strong('text-orange-300', `${m.sliderBreakCount} 次滑条断连`),
      '（模拟判定）：', m.sliderBreakReason, '。打开「圆心落点偏差线」后，播放器里会用橙色 ✕ 标出没跟住的 tick / 折返 / 滑条尾，并连线到当时的光标位置。'];
  } else {
    parts = ['✅ ', strong('', '本区间诊断：'), '所选 Replay 在此区间内零 Miss、零断连（模拟判定），平均距圆心偏差 ',
      strong('text-cyan-300', num(m.meanDeviation, 1, 'px')), '。'];
  }
  setChildren($('aimDiagnosticCallout'), ...parts);
}

function renderTapTab(m: ScopeMetrics, scope: { startMs: number; endMs: number }, d: number): void {
  const p = m.primary;
  const err = p?.meanHitError ?? null;
  setText('statMeanHitError', err === null ? DASH : `${signed(err)} ms (${err < 0 ? '偏早' : '偏晚'})`);
  const hold = (v: number | null) => (v === null ? DASH : String(Math.round(v)));
  setText('statHoldDuration', p ? `${hold(p.holdK1)} / ${hold(p.holdK2)} ms` : DASH);
  setText('statAlternateRatio', num(p?.altPct ?? null, 1, '%'));
  setChildren($('tapDiagnosticCallout'),
    '⌨️ ', strong('', '按键统计（主视角）：'), 'K1 平均按下 ', strong('', p ? `${hold(p.holdK1)} ms` : DASH),
    '，K2 平均按下 ', strong('', p ? `${hold(p.holdK2)} ms` : DASH), '，平均打击偏移 ',
    strong('', err === null ? DASH : `${signed(err)} ms`), '。直方图只统计真正命中的判定。');

  const selected = getSelectedReplays();
  const hist = hitErrorHistogram(selected, scope, d);
  updateTapChart(histogramLabels(), hist.map((s) => {
    const rep = selected.find((r) => r.id === s.id)!;
    return { label: shortName(rep.playerName), color: replayColor(rep), counts: s.counts };
  }));
}

function renderTrendTab(m: ScopeMetrics, scope: { startMs: number; endMs: number }, d: number): void {
  const p = m.primary;
  setText('statPeakVelocity', num(p?.peakVelocity ?? null, 2, ' px/ms'));
  setText('statMeanTapInterval', num(p?.meanTapInterval ?? null, 1, ' ms'));
  setText('statEquivalentBpm', p?.equivalentBpm ? `${Math.round(p.equivalentBpm)} BPM` : DASH);
  setChildren($('trendDiagnosticCallout'),
    '📈 ', strong('', '速度与节奏（主视角）：'), '区间峰值移动速度 ', strong('', num(p?.peakVelocity ?? null, 2, ' px/ms')),
    '，平均连打间隔 ', strong('', num(p?.meanTapInterval ?? null, 1, ' ms')),
    '（等效 ', strong('', p?.equivalentBpm ? `${Math.round(p.equivalentBpm)} BPM` : DASH), '，按 1/4 拍串打折算）。速度曲线按统一时间网格重采样，各回放在时间轴上对齐。');

  const selected = getSelectedReplays();
  const grid = timeGrid(scope);
  const series = selected.map((rep) => {
    const speeds = resampleSpeed(rep.frames, grid);
    return { label: shortName(rep.playerName), color: replayColor(rep), points: grid.map((t, i) => ({ x: t / 1000, y: speeds[i] })) };
  });
  const pri = getPrimaryReplay();
  const intervals = pri
    ? { label: shortName(pri.playerName), color: replayColor(pri), points: tapIntervalSeries(pri, scope, d).map((q) => ({ x: q.time / 1000, y: q.interval })) }
    : null;
  updateSpeedChart(series, intervals, [scope.startMs / 1000, scope.endMs / 1000]);
}

export function renderAnalytics(): void {
  const tab = state.activeTab;
  document.querySelectorAll<HTMLButtonElement>('.detail-tab-btn').forEach((b) => {
    b.className = b.dataset.tab === tab ? TAB_ON : TAB_OFF;
  });
  $('tabPanelAim').classList.toggle('hidden', tab !== 'aim');
  $('tabPanelTap').classList.toggle('hidden', tab !== 'tap');
  $('tabPanelTrend').classList.toggle('hidden', tab !== 'trend');

  const g = getActiveGroup();
  const scope = state.scope;
  setText('analyticsSliceTimeLabel', g ? `${secs(scope.startMs, 1)} - ${secs(scope.endMs, 1)} (${secs(scope.endMs - scope.startMs, 1)})` : DASH);
  if (!g) return;
  const d = getDurationMs();
  const m = computeScopeMetrics(getSelectedReplays(), getPrimaryReplay(), scope, d);
  renderSummary(m);
  if (tab === 'aim') renderAimTab(m);
  else if (tab === 'tap') renderTapTab(m, scope, d);
  else renderTrendTab(m, scope, d);
}

export function bindAnalytics(): void {
  document.querySelectorAll<HTMLButtonElement>('.detail-tab-btn').forEach((b) => {
    b.addEventListener('click', () => setTab(b.dataset.tab as DetailTab));
  });
}

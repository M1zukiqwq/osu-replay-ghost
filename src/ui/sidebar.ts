import { quickSelect, setActiveBeatmap, setPrimary, toggleReplay, type ActionResult } from '../app/actions';
import { getActiveGroup, isAnalyzable, replayColor, state, type Group } from '../app/state';
import { unstableRate, isHit } from '../core/analysis/metrics';
import { modsLabel } from '../core/replay/mods';
import type { Beatmap, Replay } from '../core/types';
import { $, h, setChildren, setText } from './dom';
import { DASH, num, playedAtLabel } from './format';
import { showToast } from './toast';

const demoChip = () => h('span', { class: 'px-1 rounded bg-emerald-500/20 text-emerald-300 text-[9px] font-bold shrink-0' }, '演示');

function report(res: ActionResult): void {
  if (res.message) showToast(res.message, res.detail ?? '', 'cyan');
}

/** Labels that tell apart different versions of the same BeatmapID. */
function versionHint(b: Beatmap): string | null {
  const siblings = state.groups.filter((g) => b.beatmapId !== null && g.beatmap.beatmapId === b.beatmapId);
  if (siblings.length < 2) return null;
  const when = b.modifiedAt ? ` · 修改于 ${playedAtLabel(b.modifiedAt)}` : '';
  return `版本 MD5 ${b.md5.slice(0, 8)}${when}`;
}

function matches(g: Group, q: string): boolean {
  if (!q) return true;
  const b = g.beatmap;
  return [b.beatmapId === null ? '' : String(b.beatmapId), b.title, b.titleUnicode, b.artist, b.artistUnicode, b.version]
    .some((s) => s.toLowerCase().includes(q));
}

export function renderBeatmapGroups(): void {
  const q = ($('beatmapSearchInput') as HTMLInputElement).value.trim().toLowerCase();
  setText('beatmapCountBadge', `${state.groups.length} 张谱面`);
  const cards = state.groups.filter((g) => matches(g, q)).map((g) => {
    const b = g.beatmap;
    const active = g.key === state.activeKey;
    const settledMiss = g.replays.reduce((a, r) => a + r.header.countMiss, 0);
    const hint = versionHint(b);
    return h(
      'button',
      {
        type: 'button',
        class: `w-full text-left p-2.5 rounded-xl border transition flex flex-col gap-1 ${
          active ? 'bg-gradient-to-r from-pink-500/20 to-cyan-500/10 border-pink-500/60 shadow-md' : 'bg-slate-900/70 hover:bg-slate-800/80 border-slate-800'
        }`,
        on: { click: () => setActiveBeatmap(g.key) },
      },
      h('div', { class: 'flex items-center justify-between gap-1' },
        h('span', { class: 'flex items-center gap-1 min-w-0' },
          h('span', { class: 'px-1.5 py-0.5 rounded bg-slate-950 text-[10px] font-mono font-bold text-cyan-300 border border-slate-700 shrink-0' },
            b.beatmapId === null ? '未上传' : `ID #${b.beatmapId}`),
          b.source === 'demo' ? demoChip() : null,
        ),
        h('span', { class: 'text-[10px] font-mono text-slate-400 truncate' },
          `${b.bpm === null ? DASH : Math.round(b.bpm)} BPM · CS${b.cs} AR${b.ar} OD${b.od}`),
      ),
      h('div', { class: 'font-bold text-xs text-white truncate', title: `${b.artist} - ${b.title}` }, `${b.artist} - ${b.title}`),
      hint ? h('div', { class: 'text-[10px] font-mono text-amber-300/80 truncate' }, hint) : null,
      h('div', { class: 'flex items-center justify-between text-[11px] gap-1' },
        h('span', { class: 'text-pink-300 font-medium truncate' }, `[${b.version}]`),
        h('div', { class: 'flex items-center gap-1.5 font-mono text-[10px] shrink-0' },
          h('span', { class: 'px-1.5 py-0.5 rounded bg-slate-800 text-slate-200' }, `${g.replays.length} Replays`),
          h('span', {
            class: `px-1.5 py-0.5 rounded ${settledMiss > 0 ? 'bg-rose-500/20 text-rose-300' : 'bg-emerald-500/20 text-emerald-300'}`,
            title: '各回放 .osr 结算 Miss 之和',
          }, `结算 ${settledMiss} Miss`),
        ),
      ),
    );
  });
  setChildren($('beatmapGroupList'), ...cards);
}

function fullMapUr(r: Replay): number | null {
  if (!r.analysis) return null;
  return unstableRate(r.analysis.judgments.filter(isHit).map((j) => j.timeError as number));
}

function replayRow(rep: Replay): HTMLElement {
  const analyzable = isAnalyzable(rep);
  const checked = analyzable && state.selectedIds.has(rep.id);
  const primary = analyzable && state.primaryId === rep.id;
  const color = replayColor(rep);
  const h0 = rep.header;
  const a = rep.analysis;
  const k1 = a ? a.keyPresses.filter((k) => k.key === 'K1').length : null;
  const k2 = a ? a.keyPresses.filter((k) => k.key === 'K2').length : null;

  const checkbox = h('input', {
    type: 'checkbox',
    class: 'rounded accent-pink-500 cursor-pointer disabled:cursor-not-allowed',
    on: {
      change: (e) => {
        const box = e.target as HTMLInputElement;
        const res = toggleReplay(rep.id, box.checked);
        if (!res.ok) box.checked = !box.checked;
        report(res);
      },
    },
  });
  checkbox.checked = checked;
  checkbox.disabled = !analyzable;

  const row = h(
    'div',
    {
      class: `p-2.5 rounded-xl border transition flex flex-col gap-1.5 ${
        checked ? 'bg-slate-900/95 border-slate-700 shadow-sm' : 'bg-slate-950/50 border-slate-800/60 opacity-65 hover:opacity-95'
      }`,
      style: checked ? { 'border-left': `4px solid ${color}` } : undefined,
    },
    h('div', { class: 'flex items-center justify-between gap-1.5' },
      h('label', { class: `flex items-center gap-2 flex-1 min-w-0 ${analyzable ? 'cursor-pointer' : 'cursor-not-allowed'}` },
        checkbox,
        h('span', { class: 'w-2.5 h-2.5 rounded-full shrink-0', style: { background: color } }),
        h('span', { class: 'text-xs font-bold text-white truncate', title: `${rep.playerName}\n${rep.fileName}` }, rep.playerName || '(无名)'),
        rep.source === 'demo' ? demoChip() : null,
      ),
      analyzable
        ? h('button', {
            type: 'button',
            class: `px-1.5 py-0.5 rounded text-[10px] font-semibold border transition shrink-0 ${
              primary ? 'bg-amber-400/20 text-amber-300 border-amber-400/50' : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-white'
            }`,
            title: '设为主视角回放',
            on: { click: () => report(setPrimary(rep.id)) },
          }, primary ? '★ 主视角' : '☆ 设为主视角')
        : h('span', {
            class: 'px-1.5 py-0.5 rounded text-[10px] font-semibold bg-rose-500/15 text-rose-300 border border-rose-500/40 shrink-0',
            title: rep.decodeError ?? '',
          }, '无轨迹数据'),
    ),
    h('div', { class: 'flex flex-wrap items-center justify-between text-[11px] font-mono pl-5 gap-1', title: '.osr 结算数据' },
      h('div', { class: 'flex items-center gap-1.5' },
        h('span', { class: 'text-[9px] text-slate-500 font-sans' }, '结算'),
        h('span', { class: 'text-cyan-300 font-bold' }, num(h0.accuracy, 2, '%')),
        h('span', { class: 'text-slate-400' }, `${h0.maxCombo}x`),
        h('span', { class: 'px-1 rounded bg-slate-800 text-pink-300 text-[10px]' }, modsLabel(rep.modNames)),
      ),
      h('div', { class: 'flex items-center gap-1 text-[10px]' },
        h('span', { class: 'text-emerald-300' }, String(h0.count300)), '/',
        h('span', { class: 'text-amber-300' }, String(h0.count100)), '/',
        h('span', { class: 'text-amber-500' }, String(h0.count50)), '/',
        h('span', { class: 'text-rose-400 font-bold' }, `${h0.countMiss}M`),
      ),
    ),
    h('div', { class: 'flex flex-wrap items-center justify-between gap-1 text-[10px] font-mono text-slate-400 pl-5 pt-0.5 border-t border-slate-800/70' },
      a
        ? h('span', null, 'K1: ', h('strong', { class: 'text-cyan-300' }, String(k1)), ' · K2: ', h('strong', { class: 'text-pink-300' }, String(k2)))
        : h('span', { class: 'text-rose-300/80 truncate', title: rep.decodeError ?? '' }, rep.decodeError ?? '谱面缺失，未分析'),
      h('span', { title: 'UR 与 Miss 为全图模拟判定；时间为 .osr 记录的游玩时间' },
        `UR(模拟) ${num(fullMapUr(rep), 1)}${a ? ` · 模拟 ${a.simulated.cMiss}M` : ''} · ${playedAtLabel(rep.playedAt)}`),
    ),
  );
  return row;
}

export function renderReplayList(): void {
  const g = getActiveGroup();
  const container = $('replayListContainer');
  if (!g) {
    setText('selectedReplayCountBadge', '已选 0 / 0 个');
    setChildren(container, h('div', { class: 'text-[11px] text-slate-500 p-2' }, '还没有谱面。请导入 .osu / .osr 或绑定 osu! 目录。'));
    return;
  }
  const selected = g.replays.filter((r) => isAnalyzable(r) && state.selectedIds.has(r.id)).length;
  setText('selectedReplayCountBadge', `已选 ${selected} / ${g.replays.length} 个`);
  if (!g.replays.length) {
    setChildren(container, h('div', { class: 'text-[11px] text-slate-500 p-2' }, '这张谱面还没有回放。'));
    return;
  }
  setChildren(container, ...g.replays.map(replayRow));
}

export function renderPending(): void {
  const list = state.pending;
  $('pendingSection').classList.toggle('hidden', list.length === 0);
  setText('pendingCountBadge', `${list.length} 条`);
  setChildren($('pendingList'), ...list.map((r) =>
    h('div', { class: 'p-2 rounded-lg bg-slate-900/80 border border-slate-800 text-[11px] flex flex-col gap-0.5' },
      h('div', { class: 'flex items-center justify-between gap-1' },
        h('span', { class: 'font-semibold text-slate-200 truncate', title: r.fileName }, r.playerName || r.fileName),
        h('span', { class: 'text-[10px] text-slate-500 shrink-0' }, playedAtLabel(r.playedAt)),
      ),
      h('div', { class: 'font-mono text-[10px] text-amber-300 break-all', title: '回放记录的谱面 MD5' }, `谱面 MD5 ${r.beatmapMd5}`),
      r.decodeError ? h('div', { class: 'text-[10px] text-rose-300/80' }, r.decodeError) : null,
    ),
  ));
}

export function bindSidebar(): void {
  $('beatmapSearchInput').addEventListener('input', renderBeatmapGroups);
  $('btnSelectAllReplays').addEventListener('click', () => report(quickSelect('all')));
  $('btnSelectMissReplays').addEventListener('click', () => report(quickSelect('miss')));
  $('btnSelectBestVsLatest').addEventListener('click', () => report(quickSelect('bestVsLatest')));
}

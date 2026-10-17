import { quickSelect, setPrimary, toggleReplay, type ActionResult } from '../app/actions';
import { SEARCH_LIMIT, searchCatalog, setBrowserTab } from '../app/browser';
import type { Library } from '../app/library';
import { PAGE_SIZE } from '../app/preview';
import { getActiveGroup, isAnalyzable, replayColor, state, type BrowserTab, type Group, type RecentMap } from '../app/state';
import { unstableRate, isHit } from '../core/analysis/metrics';
import { modsLabel } from '../core/replay/mods';
import type { Beatmap, BeatmapInfo, Replay } from '../core/types';
import { $, h, setChildren, setText, type Child } from './dom';
import { agoLabel, DASH, lengthLabel, num, playedAtLabel } from './format';
import { showToast } from './toast';

/** What the browser needs from the app: catalog lookups and the preview loader. */
export interface BrowserDeps {
  library: Library;
  open(md5: string): void;
  loadMore(): void;
  /** Local replays known for a map; null when no osu! folder is bound. */
  localCount(md5: string): number | null;
}

let deps: BrowserDeps;

const demoChip = () => h('span', { class: 'px-1 rounded bg-emerald-500/20 text-emerald-300 text-[9px] font-bold shrink-0' }, '演示');
const newChip = () => h('span', { class: 'px-1 rounded bg-pink-500/25 text-pink-200 text-[9px] font-bold shrink-0', title: '绑定目录后新打的谱面' }, '新');
const chip = (cls: string, text: string, title?: string) =>
  h('span', { class: `px-1.5 py-0.5 rounded text-[10px] font-mono shrink-0 ${cls}`, title }, text);

const RANKED: Record<number, string> = { 1: '未提交', 2: 'Pending', 4: 'Ranked', 5: 'Approved', 6: 'Qualified', 7: 'Loved' };

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

function cardShell(md5: string, ...children: Child[]): HTMLButtonElement {
  const active = md5 === state.activeKey;
  return h(
    'button',
    {
      type: 'button',
      class: `w-full text-left p-2.5 rounded-xl border transition flex flex-col gap-1 ${
        active ? 'bg-gradient-to-r from-pink-500/20 to-cyan-500/10 border-pink-500/60 shadow-md' : 'bg-slate-900/70 hover:bg-slate-800/80 border-slate-800'
      }`,
      on: { click: () => deps.open(md5) },
    },
    ...children,
  );
}

function idChip(info: BeatmapInfo | null, md5: string): HTMLElement {
  if (!info) return chip('bg-slate-950 text-slate-400 border border-slate-700', `MD5 ${md5.slice(0, 8)}`, md5);
  return chip('bg-slate-950 font-bold text-cyan-300 border border-slate-700', info.beatmapId === null ? '未上传' : `ID #${info.beatmapId}`,
    info.beatmapSetId === null ? undefined : `谱面集 #${info.beatmapSetId}`);
}

function loadingChip(md5: string): HTMLElement | null {
  const p = state.preview;
  return p.loading && p.key === md5 ? chip('bg-cyan-500/15 text-cyan-300', '读取中…') : null;
}

function localChip(md5: string): HTMLElement | null {
  const n = deps.localCount(md5);
  if (n === null) return null;
  return chip(n ? 'bg-slate-800 text-slate-200' : 'bg-slate-900 text-slate-500', n ? `${n} 条本地回放` : '无本地回放', 'Data/r 与 Replays/ 中这张谱面的回放');
}

function titleLine(info: BeatmapInfo | null, fallback: string): HTMLElement {
  const text = info ? `${info.artist} - ${info.title}` : fallback;
  return h('div', { class: `font-bold text-xs truncate ${info ? 'text-white' : 'text-slate-400'}`, title: text }, text);
}

function versionLine(info: BeatmapInfo | null, right: Child): HTMLElement {
  return h('div', { class: 'flex items-center justify-between text-[11px] gap-1' },
    h('span', { class: 'text-pink-300 font-medium truncate', title: info?.creator ? `作者 ${info.creator}` : undefined },
      info ? `[${info.version}]${info.creator ? ` · ${info.creator}` : ''}` : ''),
    right,
  );
}

function recentCard(r: RecentMap): HTMLButtonElement {
  const i = r.info;
  return cardShell(r.md5,
    h('div', { class: 'flex items-center justify-between gap-1' },
      h('span', { class: 'flex items-center gap-1 min-w-0' },
        idChip(i, r.md5),
        i?.stars ? chip('text-amber-300', `★${i.stars.toFixed(2)}`) : null,
        r.isNew ? newChip() : null,
        loadingChip(r.md5),
      ),
      h('span', { class: 'text-[10px] text-slate-400 shrink-0', title: r.lastPlayedAt === null ? undefined : playedAtLabel(r.lastPlayedAt) }, agoLabel(r.lastPlayedAt)),
    ),
    titleLine(i, '不在 osu!.db 中的谱面（点击后在 Songs 中查找）'),
    versionLine(i, chip('bg-slate-800 text-slate-200', `${r.count} 条本地回放`)),
  );
}

function searchCard(i: BeatmapInfo): HTMLButtonElement {
  const diff = [i.cs, i.ar, i.od].every((v) => v !== null) ? `CS${i.cs} AR${i.ar} OD${i.od}` : '';
  return cardShell(i.md5,
    h('div', { class: 'flex items-center justify-between gap-1' },
      h('span', { class: 'flex items-center gap-1 min-w-0' },
        idChip(i, i.md5),
        i.stars ? chip('text-amber-300', `★${i.stars.toFixed(2)}`) : null,
        i.rankedStatus !== null && RANKED[i.rankedStatus] ? chip('bg-slate-800 text-slate-400', RANKED[i.rankedStatus]) : null,
        loadingChip(i.md5),
      ),
      h('span', { class: 'text-[10px] font-mono text-slate-400 truncate' }, [diff, lengthLabel(i.totalTimeMs)].filter((s) => s && s !== DASH).join(' · ')),
    ),
    titleLine(i, ''),
    versionLine(i, localChip(i.md5)),
  );
}

function loadedCard(g: Group): HTMLButtonElement {
  const b = g.beatmap;
  const settledMiss = g.replays.reduce((a, r) => a + r.header.countMiss, 0);
  const hint = versionHint(b);
  return cardShell(g.key,
    h('div', { class: 'flex items-center justify-between gap-1' },
      h('span', { class: 'flex items-center gap-1 min-w-0' },
        chip('bg-slate-950 font-bold text-cyan-300 border border-slate-700', b.beatmapId === null ? '未上传' : `ID #${b.beatmapId}`),
        b.source === 'demo' ? demoChip() : null,
        g.transient ? chip('bg-slate-800 text-slate-400', '临时', '从谱面浏览打开，打开更多谱面后会自动释放') : null,
        loadingChip(g.key),
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
}

const TAB_ON = 'browser-tab-btn py-1 rounded-md bg-pink-500 text-white transition';
const TAB_OFF = 'browser-tab-btn py-1 rounded-md text-slate-400 hover:text-white transition';

function browserHint(tab: BrowserTab): string {
  const w = state.watcher;
  const b = state.browser;
  if (tab === 'recent') {
    if (w.status !== 'bound') return '绑定 osu! 根目录后，这里列出 Data/r 中最近打过的谱面。只读取文件名，选中谱面后才读取它的回放。';
    if (!b.recentTotal) return 'Data/r 中还没有本地回放。打完一局后会自动出现在这里。';
    const live = w.mode === 'handle' ? (w.detection === 'events' ? '，新成绩实时出现' : '，新成绩定时检查') : '';
    return `${b.recentTotal} 张谱面有本地回放，按最近游玩排序${b.recentTotal > b.recent.length ? `（显示前 ${b.recent.length} 张）` : ''}${live}。`;
  }
  if (tab === 'search') {
    if (!b.query.trim()) return '输入 Beatmap ID、谱面集 ID、osu! 链接、MD5，或标题 / 艺术家 / 作者 / 难度名 / 标签关键词。';
    const scope = w.dbEntries === null ? '（未加载 osu!.db，只搜索已加载的谱面）' : '';
    if (!b.resultTotal) return `没有匹配的 osu!standard 谱面${scope}`;
    return `找到 ${b.resultTotal} 张${b.resultTotal > SEARCH_LIMIT ? `，显示前 ${SEARCH_LIMIT} 张` : ''}${scope}`;
  }
  return '内存中的谱面：演示、手动导入，以及最近从「最近游玩 / 搜索」打开的几张（更早的会自动释放）。';
}

export function renderBrowser(): void {
  const b = state.browser;
  document.querySelectorAll<HTMLButtonElement>('.browser-tab-btn').forEach((btn) => {
    btn.className = btn.dataset.browserTab === b.tab ? TAB_ON : TAB_OFF;
  });
  setText('browserHint', browserHint(b.tab));
  let cards: HTMLElement[];
  if (b.tab === 'recent') {
    setText('beatmapCountBadge', `最近 ${b.recentTotal} 张`);
    cards = b.recent.map(recentCard);
  } else if (b.tab === 'search') {
    setText('beatmapCountBadge', `${b.resultTotal} 个结果`);
    cards = b.results.map(searchCard);
  } else {
    setText('beatmapCountBadge', `${state.groups.length} 张谱面`);
    cards = state.groups.map(loadedCard);
  }
  setChildren($('beatmapGroupList'), ...cards);
}

/** Loading / paging line of the replay preview. */
export function renderPreviewStatus(): void {
  const p = state.preview;
  const box = $('previewStatus');
  const more = $<HTMLButtonElement>('btnPreviewLoadMore');
  const relevant = p.key !== null && p.key === state.activeKey && (p.loading || p.error !== null || p.total !== null);
  box.classList.toggle('hidden', !relevant);
  if (!relevant) return;
  const text = $('previewStatusText');
  let msg: string;
  if (p.error) msg = `⚠ ${p.error}`;
  else if (p.loading) msg = p.total === null ? '正在查找本地回放…' : `正在读取本地回放（共 ${p.total} 条）…`;
  else if (p.total === 0) msg = 'Data/r 与 Replays/ 中没有这张谱面的回放';
  else msg = `本地回放 ${p.total} 条，已读取 ${p.loaded} 条`;
  text.textContent = msg;
  text.className = p.error ? 'text-rose-300 min-w-0' : 'text-slate-300 min-w-0';
  const rest = p.total === null ? 0 : p.total - p.loaded;
  more.classList.toggle('hidden', p.loading || rest <= 0);
  more.textContent = `再读取 ${Math.min(PAGE_SIZE, rest)} 条更早的`;
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

  const simulated = a ? ` · 模拟 ${a.simulated.cMiss}M${a.simulated.sliderBreaks ? ` ${a.simulated.sliderBreaks}断` : ''}` : '';
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
      h('span', { title: 'UR、Miss 与滑条断连为全图模拟判定；时间为 .osr 记录的游玩时间' },
        `UR(模拟) ${num(fullMapUr(rep), 1)}${simulated} · ${playedAtLabel(rep.playedAt)}`),
    ),
  );
  return row;
}

export function renderReplayList(): void {
  const g = getActiveGroup();
  const container = $('replayListContainer');
  if (!g) {
    setText('selectedReplayCountBadge', '已选 0 / 0 个');
    setChildren(container, h('div', { class: 'text-[11px] text-slate-500 p-2' }, '还没有谱面。请在「谱面浏览」中选择谱面，导入 .osu / .osr，或绑定 osu! 目录。'));
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

const SEARCH_DEBOUNCE_MS = 150;

export function bindSidebar(d: BrowserDeps): void {
  deps = d;
  const input = $<HTMLInputElement>('beatmapSearchInput');
  let timer: ReturnType<typeof setTimeout> | null = null;
  input.addEventListener('input', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => searchCatalog(deps.library, input.value), SEARCH_DEBOUNCE_MS);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (timer) clearTimeout(timer);
    searchCatalog(deps.library, input.value);
    const first = state.browser.results[0];
    if (first && state.browser.resultTotal === 1) deps.open(first.md5);
  });
  document.querySelectorAll<HTMLButtonElement>('.browser-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.browserTab as BrowserTab;
      setBrowserTab(tab);
      if (tab === 'search') input.focus();
    });
  });
  $('btnPreviewLoadMore').addEventListener('click', () => deps.loadMore());
  $('btnSelectAllReplays').addEventListener('click', () => report(quickSelect('all')));
  $('btnSelectMissReplays').addEventListener('click', () => report(quickSelect('miss')));
  $('btnSelectBestVsLatest').addEventListener('click', () => report(quickSelect('bestVsLatest')));
}

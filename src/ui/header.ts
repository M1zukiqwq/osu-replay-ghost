import { clearDemoData, setAudio, updateWatcher } from '../app/actions';
import { simulateNewPlay } from '../app/demo';
import type { Engine } from '../app/engine';
import { hasDirectoryPicker, pickDirectory, type DirHandle } from '../app/fsAccess';
import type { ImportOutcome } from '../app/importer';
import { getActiveGroup, hasRealData, state } from '../app/state';
import { loadRootHandle, POLL_INTERVAL_MS, saveRootHandle, type Watcher } from '../app/watcher';
import { $, h, setChildren, setText } from './dom';
import { clockLabel } from './format';
import { showToast } from './toast';

const DOT = {
  idle: 'w-2 h-2 shrink-0 rounded-full bg-emerald-400 animate-pulse',
  scanning: 'w-2 h-2 shrink-0 rounded-full bg-amber-400 animate-pulse',
  bound: 'w-2 h-2 shrink-0 rounded-full bg-cyan-400',
  error: 'w-2 h-2 shrink-0 rounded-full bg-rose-500',
};

const actionBtn = (label: string, title: string, run: () => void, tone = 'text-cyan-300 border-cyan-500/30') =>
  h('button', { type: 'button', class: `px-2 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border text-[11px] font-semibold transition ${tone}`, title, on: { click: run } }, label);

function statusText(): { text: string; dot: string; title: string } {
  const w = state.watcher;
  if (w.status === 'scanning') return { text: `正在读取 ${w.rootName ?? ''}…`, dot: DOT.scanning, title: '' };
  if (w.status === 'error') return { text: `出错：${w.error ?? '未知错误'}`, dot: DOT.error, title: w.error ?? '' };
  if (w.status === 'bound') {
    const db = w.dbEntries !== null ? `谱面库 ${w.dbEntries} 张` : '未找到 osu!.db';
    const songs = w.songsAvailable ? '' : ' · Songs 不可用';
    const scan = w.songsScan ? ` · 扫描 Songs ${w.songsScan.done}/${w.songsScan.total || '…'}` : '';
    if (w.mode === 'files') {
      return {
        text: `已读取目录快照 ${w.rootName} · ${db}${songs}${scan}（此浏览器不支持自动监听）`,
        dot: DOT.bound,
        title: '通过文件夹选择框读取，只能按需查找谱面，不能持续监听新回放。建议使用 Chrome / Edge。',
      };
    }
    const last = w.lastScanAt ? ` · 最近扫描 ${clockLabel(w.lastScanAt)}` : '';
    return {
      text: `已绑定 ${w.rootName} · 每 ${POLL_INTERVAL_MS / 1000} 秒扫描${last} · ${db}${songs}${scan}`,
      dot: DOT.bound,
      title: `基线 ${w.baselineCount} 个已有回放（不自动导入）${w.failedCount ? `；${w.failedCount} 个文件解析失败，将在文件变化后重试` : ''}`,
    };
  }
  return { text: '内置演示库已就绪 (未绑定本地目录)', dot: DOT.idle, title: '' };
}

export interface HeaderDeps { engine: Engine; watcher: Watcher; onImported: (o: ImportOutcome) => void }

export function renderHeader(deps: HeaderDeps): void {
  const w = state.watcher;
  const st = statusText();
  setText('watcherStatusText', st.text);
  $('watcherStatusText').title = st.title || st.text;
  $('watcherDot').className = st.dot;
  setText('audioIcon', state.audioEnabled ? '🔊' : '🔇');
  setText('audioLabel', state.audioEnabled ? '音效开启' : '音效静音');

  const pending = $('pendingBadge');
  pending.classList.toggle('hidden', state.pending.length === 0);
  pending.textContent = `${state.pending.length} 条回放等待匹配谱面`;

  const hasDemo = state.groups.some((g) => g.beatmap.source === 'demo' || g.replays.some((r) => r.source === 'demo'));
  $('btnClearDemo').classList.toggle('hidden', !(hasDemo && hasRealData()));

  const actions: HTMLElement[] = [];
  const run = (p: Promise<ImportOutcome | null>) => p.then((o) => {
    if (o) deps.onImported(o);
    else showToast('没有可导入的回放', '', 'cyan');
  }).catch((e) => showToast('操作失败', (e as Error).message, 'pink'));

  if (w.restorable && w.status !== 'bound') {
    actions.push(actionBtn(`恢复绑定 ${w.restorable}`, '重新授权上次绑定的 osu! 目录', () => void restoreBinding(deps)));
  }
  if (w.songsNeedsAuth) {
    actions.push(actionBtn('授权 Songs 目录', `osu! 配置中的 Songs 位于根目录之外：${w.songsNeedsAuth}`, () => void authoriseSongs(deps), 'text-amber-300 border-amber-500/40'));
  }
  if (w.status === 'bound') {
    if (w.dbEntries === null && w.songsAvailable && !w.songsScan) {
      actions.push(actionBtn('扫描 Songs', '没有 osu!.db 时，逐个计算 Songs 中 .osu 的 MD5 来匹配谱面（较慢，在后台线程执行）', () => {
        deps.watcher.scanSongs()
          .then((n) => showToast('Songs 扫描完成', `已索引 ${n} 个 .osu 文件`, 'emerald'))
          .catch((e) => showToast('Songs 扫描失败', (e as Error).message, 'pink'));
      }));
    }
    actions.push(actionBtn('导入最近 10 条', '从 Replays/ 与 Data/r/ 中按修改时间导入最近 10 条历史回放', () => void run(deps.watcher.importRecent(10))));
    const g = getActiveGroup();
    if (g && g.beatmap.source !== 'demo') {
      actions.push(actionBtn('导入本谱面历史', 'Data/r/ 中以当前谱面 MD5 开头的本地成绩回放', () => void run(deps.watcher.importBeatmapHistory(g.key))));
    }
    if (w.failedCount) {
      actions.push(actionBtn(`重试失败 (${w.failedCount})`, '重新读取解析失败的回放文件', () => void run(deps.watcher.retryFailed()), 'text-rose-300 border-rose-500/40'));
    }
  }
  setChildren($('watcherActions'), ...actions);
}

async function bindRoot(deps: HeaderDeps, root: DirHandle): Promise<void> {
  await deps.watcher.bindHandle(root);
  if (state.watcher.status === 'bound') {
    void saveRootHandle(root);
    const w = state.watcher;
    showToast(
      '成功绑定本地 osu! 根目录',
      `${w.dbEntries !== null ? `已索引 ${w.dbEntries} 张谱面` : '未找到 osu!.db，可点击「扫描 Songs」'}；已记录 ${w.baselineCount} 个已有回放作为基线，之后每 ${POLL_INTERVAL_MS / 1000} 秒检查 Data/r 与 Replays 的新回放`,
      'emerald',
    );
  }
}

async function restoreBinding(deps: HeaderDeps): Promise<void> {
  const handle = await loadRootHandle();
  if (!handle) return updateWatcher({ restorable: null });
  const perm = (await handle.requestPermission?.({ mode: 'read' })) ?? 'granted';
  if (perm !== 'granted') {
    showToast('没有获得目录权限', '可以重新点击「绑定本地 osu! 根目录」', 'cyan');
    return;
  }
  await bindRoot(deps, handle);
}

async function authoriseSongs(deps: HeaderDeps): Promise<void> {
  try {
    await deps.watcher.bindSongs(await pickDirectory('osu-songs'));
    showToast('已授权 Songs 目录', '', 'emerald');
  } catch (e) {
    if ((e as Error).name !== 'AbortError') showToast('授权失败', (e as Error).message, 'pink');
  }
}

export async function initHeader(deps: HeaderDeps): Promise<void> {
  $('btnToggleAudio').addEventListener('click', () => setAudio(!state.audioEnabled));
  $('btnSimulateLiveScore').addEventListener('click', async () => {
    const res = await simulateNewPlay(deps.engine);
    showToast(res.title, res.detail, res.ok ? 'emerald' : 'cyan');
  });
  $('btnClearDemo').addEventListener('click', () => {
    clearDemoData();
    showToast('已清除演示数据', '只保留你导入的谱面与回放', 'cyan');
  });
  $('pendingBadge').addEventListener('click', () => $('pendingSection').scrollIntoView({ behavior: 'smooth', block: 'nearest' }));

  $('btnBindOsuDir').addEventListener('click', async () => {
    if (hasDirectoryPicker()) {
      try {
        await bindRoot(deps, await pickDirectory('osu-root'));
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        showToast('绑定失败', (e as Error).message, 'pink');
      }
      return;
    }
    $('fallbackDirInput').click();
  });

  const fallback = $<HTMLInputElement>('fallbackDirInput');
  fallback.addEventListener('change', async () => {
    const files = fallback.files ? Array.from(fallback.files) : [];
    fallback.value = '';
    if (!files.length) return;
    await deps.watcher.bindFiles(files);
    if (state.watcher.status === 'bound') {
      showToast('已读取 osu! 目录', `${state.watcher.dbEntries !== null ? `谱面库 ${state.watcher.dbEntries} 张` : '未找到 osu!.db'}；历史回放可用顶栏按钮按需导入`, 'emerald');
    }
  });

  const saved = await loadRootHandle();
  if (saved && hasDirectoryPicker()) updateWatcher({ restorable: saved.name });
}

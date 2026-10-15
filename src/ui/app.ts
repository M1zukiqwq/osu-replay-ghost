import { loadDemo } from '../app/demo';
import { createEngine } from '../app/engine';
import { importFiles, summarize, type ImportContext, type ImportOutcome } from '../app/importer';
import { Library } from '../app/library';
import { state, subscribe, type Topic } from '../app/state';
import { Watcher } from '../app/watcher';
import { bindAnalytics, renderAnalytics } from './analytics';
import { bindImportModal, openImportModal, renderImportResults } from './importModal';
import { initHeader, renderHeader, type HeaderDeps } from './header';
import { rebuildKeyCards, renderHud } from './liveHud';
import { bindPlayer, playbackStep, renderPlayerControls, resetPlaybackClock } from './player';
import { renderPlayfield, setupCanvas } from './playfield';
import { bindRangeSelection, renderProgress, renderRangeModeControls } from './rangeSelection';
import { bindSidebar, renderBeatmapGroups, renderPending, renderReplayList } from './sidebar';
import { bindSlicePanel, renderSlicePanel } from './slicePanel';
import { showToast } from './toast';

type Part = 'sidebar' | 'slices' | 'analytics' | 'keyCards' | 'playfield' | 'controls' | 'header' | 'importLog';

const TOPIC_PARTS: Record<Topic, Part[]> = {
  groups: ['sidebar', 'slices', 'analytics', 'keyCards', 'playfield', 'header', 'controls'],
  selection: ['sidebar', 'slices', 'analytics', 'keyCards', 'playfield'],
  scope: ['slices', 'analytics', 'playfield'],
  time: ['playfield'],
  view: ['controls', 'playfield', 'header'],
  tab: ['analytics'],
  playback: ['controls'],
  watcher: ['header'],
  importLog: ['importLog'],
};

const dirty = new Set<Part>();
let raf = 0;
let headerDeps: HeaderDeps;

function invalidate(parts: Iterable<Part>): void {
  for (const p of parts) dirty.add(p);
  if (!raf) raf = requestAnimationFrame(frame);
}

/** Single animation loop: advances playback, then renders only what changed (heavy panels at most once per frame). */
function frame(ts: number): void {
  raf = 0;
  if (state.isPlaying) {
    playbackStep(ts);
    dirty.add('playfield');
  } else resetPlaybackClock();

  if (dirty.has('sidebar')) {
    renderBeatmapGroups();
    renderReplayList();
    renderPending();
  }
  if (dirty.has('slices')) renderSlicePanel();
  if (dirty.has('analytics')) renderAnalytics();
  if (dirty.has('keyCards')) rebuildKeyCards();
  if (dirty.has('controls')) {
    renderPlayerControls();
    renderRangeModeControls();
  }
  if (dirty.has('header')) renderHeader(headerDeps);
  if (dirty.has('importLog')) renderImportResults();
  if (dirty.has('playfield')) {
    renderPlayfield();
    renderHud();
    renderProgress();
  }
  dirty.clear();
  if (state.isPlaying && !raf) raf = requestAnimationFrame(frame);
}

export async function startApp(): Promise<void> {
  const engine = createEngine();
  const ctx: ImportContext = { engine, library: new Library() };

  const onImported = (o: ImportOutcome) => {
    if (!o.report.items.length) return;
    const failed = o.report.items.some((i) => i.status === 'failed' || i.status === 'pending');
    showToast(`导入完成（${o.report.origin}）`, summarize(o.report), failed ? 'pink' : 'emerald', {
      label: '查看明细',
      run: () => openImportModal(true),
    });
  };
  const watcher = new Watcher(ctx, onImported);
  headerDeps = { engine, watcher, onImported };

  setupCanvas();
  subscribe((topics) => {
    const parts = new Set<Part>();
    for (const t of topics) for (const p of TOPIC_PARTS[t]) parts.add(p);
    invalidate(parts);
  });

  bindSidebar();
  bindSlicePanel();
  bindRangeSelection();
  bindPlayer();
  bindAnalytics();
  bindImportModal(async (files) => {
    try {
      onImported(await importFiles(files, ctx, '手动导入'));
    } catch (e) {
      showToast('导入失败', (e as Error).message, 'pink');
    }
  });
  await initHeader(headerDeps);

  invalidate(['sidebar', 'slices', 'analytics', 'keyCards', 'playfield', 'controls', 'header', 'importLog']);
  try {
    await loadDemo(engine);
  } catch (e) {
    showToast('演示数据加载失败', (e as Error).message, 'pink');
  }
  // Canvas text uses the bundled fonts; redraw once they are ready.
  void document.fonts?.ready.then(() => invalidate(['playfield']));
}

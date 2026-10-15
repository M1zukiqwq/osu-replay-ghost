import { downloadSampleFiles } from '../app/exportSample';
import { statusLabel, summarize } from '../app/importer';
import { state, type ImportStatus } from '../app/state';
import { $, h, setChildren, setText } from './dom';
import { clockLabel } from './format';
import { showToast } from './toast';

const STATUS_CLASS: Record<ImportStatus, string> = {
  ok: 'text-emerald-300',
  library: 'text-cyan-300',
  duplicate: 'text-slate-400',
  nonStd: 'text-slate-400',
  pending: 'text-amber-300',
  failed: 'text-rose-400',
  ignored: 'text-slate-500',
};

export function openImportModal(showResults = false): void {
  $('importModal').classList.remove('hidden');
  if (showResults) $('importResultsSection').scrollIntoView({ block: 'nearest' });
}

function closeImportModal(): void {
  $('importModal').classList.add('hidden');
}

export function renderImportResults(): void {
  const report = state.importLog[0];
  $('importResultsSection').classList.toggle('hidden', !report);
  if (!report) return;
  setText('importResultsSummary', `${clockLabel(report.at)} · ${report.origin} · ${summarize(report)}`);
  setChildren($('importResultsList'), ...report.items.map((it) =>
    h('li', { class: 'flex flex-col gap-0.5 border-b border-slate-800/70 pb-1' },
      h('div', { class: 'flex items-center gap-2 min-w-0' },
        h('span', { class: `shrink-0 font-semibold ${STATUS_CLASS[it.status]}` }, statusLabel(it.status)),
        h('span', { class: 'truncate text-slate-200 font-mono', title: it.fileName }, it.fileName)),
      h('span', { class: 'text-slate-400 break-words' }, it.detail),
    ),
  ));
}

/** Imports files and closes the modal; drop is accepted anywhere on the page (B33). */
export function bindImportModal(importFiles: (files: File[]) => Promise<void>): void {
  const modal = $('importModal');
  $('btnOpenImportModal').addEventListener('click', () => openImportModal());
  $('btnCloseImportModal').addEventListener('click', closeImportModal);
  $('btnCloseImportModalBottom').addEventListener('click', closeImportModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeImportModal();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeImportModal();
  });

  const input = $<HTMLInputElement>('manualFileInput');
  input.addEventListener('change', async () => {
    const files = input.files ? Array.from(input.files) : [];
    input.value = '';
    if (!files.length) return;
    closeImportModal();
    await importFiles(files);
  });

  $('btnDownloadSampleFiles').addEventListener('click', () => {
    const res = downloadSampleFiles();
    showToast(res.title, res.detail, res.ok ? 'cyan' : 'pink');
  });

  const overlay = $('dropOverlay');
  const dropZone = $('dropZoneArea');
  let depth = 0;
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    overlay.classList.remove('hidden');
    dropZone.classList.add('border-pink-500');
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) {
      overlay.classList.add('hidden');
      dropZone.classList.remove('border-pink-500');
    }
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.classList.add('hidden');
    dropZone.classList.remove('border-pink-500');
    const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
    if (!files.length) return;
    closeImportModal();
    await importFiles(files);
  });
}

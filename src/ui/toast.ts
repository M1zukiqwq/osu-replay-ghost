import { $, h } from './dom';

export type Tone = 'pink' | 'emerald' | 'cyan';

const BORDER: Record<Tone, string> = {
  pink: 'border-pink-500/60',
  emerald: 'border-emerald-500/60',
  cyan: 'border-cyan-500/60',
};

const SHOW_MS = 3600;
const FADE_MS = 300;

/** Plain-text notification (P3); an optional action button keeps the toast until clicked or timed out. */
export function showToast(title: string, detail = '', tone: Tone = 'pink', action?: { label: string; run: () => void }): void {
  const container = $('toastContainer');
  const el = h(
    'div',
    { class: `pointer-events-auto bg-[#13192b]/95 border ${BORDER[tone]} rounded-xl px-3.5 py-2.5 shadow-xl text-xs transition-all duration-300` },
    h('div', { class: 'font-bold text-white mb-0.5' }, title),
    detail ? h('div', { class: 'text-[11px] text-slate-300 break-words' }, detail) : null,
    action
      ? h('button', {
          type: 'button',
          class: 'mt-1.5 px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-cyan-300 text-[11px] border border-slate-700',
          on: { click: () => { action.run(); el.remove(); } },
        }, action.label)
      : null,
  );
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), FADE_MS);
  }, action ? SHOW_MS * 2 : SHOW_MS);
}

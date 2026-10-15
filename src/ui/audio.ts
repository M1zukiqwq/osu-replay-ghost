import { state } from '../app/state';

let ctx: AudioContext | null = null;

function ensureContext(): AudioContext | null {
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx ??= new Ctor();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** Creating an AudioContext can take >100 ms; do it on the Play gesture rather than mid-playback. */
export function warmUpAudio(): void {
  if (!state.audioEnabled) return;
  try {
    ensureContext();
  } catch {
    // optional
  }
}

/** Synthesised hitsound: miss = sawtooth 165→85 Hz / 150 ms; hit = triangle 580 (K1) or 680 (K2) → 190 Hz / 60 ms. */
export function playHitsound(isMiss: boolean, isK2: boolean): void {
  if (!state.audioEnabled) return;
  try {
    const ctx = ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    if (isMiss) {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(165, now);
      osc.frequency.exponentialRampToValueAtTime(85, now + 0.14);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
      osc.start(now);
      osc.stop(now + 0.15);
    } else {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(isK2 ? 680 : 580, now);
      osc.frequency.exponentialRampToValueAtTime(190, now + 0.055);
      gain.gain.setValueAtTime(0.11, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
      osc.start(now);
      osc.stop(now + 0.06);
    }
  } catch {
    // Audio before a user gesture may be refused; sound is optional.
  }
}

import { engineOps, type HashedFile, type SynthResult } from '../core/engineOps';
import type { SynthConfig } from '../core/demo/synthetic';
import type { OsuDbIndex } from '../core/formats/osudb';
import type { DecodedReplay } from '../core/replay/decode';
import type { Beatmap, Frame, ReplayAnalysis } from '../core/types';

export interface Engine {
  decodeReplay(bytes: Uint8Array): Promise<DecodedReplay>;
  analyze(beatmap: Beatmap, frames: Frame[], mods: number): Promise<ReplayAnalysis>;
  parseOsuDb(bytes: Uint8Array): Promise<OsuDbIndex>;
  synthesize(beatmap: Beatmap, cfg: SynthConfig): Promise<SynthResult>;
  hashFiles(files: { path: string; file: Blob }[], onProgress?: (done: number, total: number) => void): Promise<HashedFile[]>;
}

/** Runs the operations on the calling thread (tests, or when Workers are unavailable). */
export function createDirectEngine(): Engine {
  return {
    decodeReplay: async (b) => engineOps.decodeReplay(b),
    analyze: async (m, f, mods) => engineOps.analyze(m, f, mods),
    parseOsuDb: async (b) => engineOps.parseOsuDb(b),
    synthesize: async (m, c) => engineOps.synthesize(m, c),
    hashFiles: (files, p) => engineOps.hashFiles(files, p),
  };
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: (done: number, total: number) => void;
}

export function createWorkerEngine(): Engine {
  const worker = new Worker(new URL('../worker/engine.worker.ts', import.meta.url), { type: 'module' });
  const pending = new Map<number, Pending>();
  let seq = 0;
  worker.onmessage = (e: MessageEvent) => {
    const msg = e.data as { id: number; ok?: boolean; result?: unknown; error?: string; progress?: { done: number; total: number } };
    const p = pending.get(msg.id);
    if (!p) return;
    if (msg.progress) {
      p.onProgress?.(msg.progress.done, msg.progress.total);
      return;
    }
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error ?? '后台任务失败'));
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(`后台线程出错：${e.message}`));
    pending.clear();
  };
  const call = <T>(op: string, args: unknown[], onProgress?: Pending['onProgress']): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
      worker.postMessage({ id, op, args });
    });
  return {
    decodeReplay: (b) => call('decodeReplay', [b]),
    analyze: (m, f, mods) => call('analyze', [m, f, mods]),
    parseOsuDb: (b) => call('parseOsuDb', [b]),
    synthesize: (m, c) => call('synthesize', [m, c]),
    hashFiles: (files, p) => call('hashFiles', [files], p),
  };
}

export function createEngine(): Engine {
  try {
    return createWorkerEngine();
  } catch {
    return createDirectEngine();
  }
}

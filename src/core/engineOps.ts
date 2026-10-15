import { analyzeReplay } from './analysis/judge';
import { generateSyntheticFrames, type SynthConfig } from './demo/synthetic';
import { md5Bytes } from './binary/md5';
import { parseOsuDb, type OsuDbIndex } from './formats/osudb';
import { buildFrames } from './replay/frames';
import { decodeReplayFile, type DecodedReplay } from './replay/decode';
import type { Beatmap, Frame, RawFrame, ReplayAnalysis } from './types';

export interface SynthResult { raw: RawFrame[]; frames: Frame[]; analysis: ReplayAnalysis }
export interface HashedFile { path: string; md5: string }

/** Heavy operations; run inside the Web Worker (or directly in tests). */
export const engineOps = {
  decodeReplay(bytes: Uint8Array): DecodedReplay {
    return decodeReplayFile(bytes);
  },
  analyze(beatmap: Beatmap, frames: Frame[], mods: number): ReplayAnalysis {
    return analyzeReplay(beatmap, frames, mods);
  },
  parseOsuDb(bytes: Uint8Array): OsuDbIndex {
    return parseOsuDb(bytes);
  },
  synthesize(beatmap: Beatmap, cfg: SynthConfig): SynthResult {
    const raw = generateSyntheticFrames(beatmap, cfg);
    const frames = buildFrames(raw, cfg.mods);
    return { raw, frames, analysis: analyzeReplay(beatmap, frames, cfg.mods) };
  },
  async hashFiles(files: { path: string; file: Blob }[], onProgress?: (done: number, total: number) => void): Promise<HashedFile[]> {
    const out: HashedFile[] = [];
    for (let i = 0; i < files.length; i++) {
      try {
        out.push({ path: files[i].path, md5: md5Bytes(new Uint8Array(await files[i].file.arrayBuffer())) });
      } catch {
        // unreadable file: skip, it simply won't be matched
      }
      if (onProgress && (i % 50 === 0 || i === files.length - 1)) onProgress(i + 1, files.length);
    }
    return out;
  },
};

export type EngineOps = typeof engineOps;

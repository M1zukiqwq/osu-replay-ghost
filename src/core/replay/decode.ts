import { decodeOsrFrames, parseOsr, type OsrHeader } from '../formats/osr';
import type { Frame, ReplayHeader } from '../types';
import { buildFrames } from './frames';

export interface DecodedReplay { header: OsrHeader; frames: Frame[] | null; decodeError: string | null }

/** Header problems throw (the file is unusable); frame problems are reported via decodeError. */
export function decodeReplayFile(bytes: Uint8Array): DecodedReplay {
  const { header, compressed } = parseOsr(bytes);
  if (header.mode !== 0) return { header, frames: null, decodeError: null };
  try {
    const frames = buildFrames(decodeOsrFrames(compressed), header.mods);
    if (frames.length === 0) return { header, frames: null, decodeError: '没有有效的光标帧' };
    return { header, frames, decodeError: null };
  } catch (e) {
    return { header, frames: null, decodeError: `轨迹解析失败：${(e as Error).message}` };
  }
}

export function headerAccuracy(c300: number, c100: number, c50: number, cMiss: number): number | null {
  const total = c300 + c100 + c50 + cMiss;
  return total > 0 ? ((300 * c300 + 100 * c100 + 50 * c50) / (300 * total)) * 100 : null;
}

export function toReplayHeader(h: OsrHeader): ReplayHeader {
  return {
    count300: h.count300,
    count100: h.count100,
    count50: h.count50,
    countGeki: h.countGeki,
    countKatu: h.countKatu,
    countMiss: h.countMiss,
    totalScore: h.totalScore,
    maxCombo: h.maxCombo,
    perfect: h.perfect,
    accuracy: headerAccuracy(h.count300, h.count100, h.count50, h.countMiss),
  };
}

import type { Beatmap, HitObject } from '../types';

const n = (v: number) => String(Number.isInteger(v) ? v : Math.round(v * 1e6) / 1e6);

function typeBits(o: HitObject): number {
  const base = o.type === 'spinner' ? 8 : o.type === 'slider' ? 2 : 1;
  return base | (o.newCombo ? 4 : 0) | ((o.comboSkip & 7) << 4);
}

function objectLine(o: HitObject): string {
  const head = `${n(o.x)},${n(o.y)},${n(o.time)},${typeBits(o)},0`;
  if (o.type === 'spinner') return `${head},${n(o.endTime)},0:0:0:0:`;
  if (o.type === 'slider' && o.slider) {
    const s = o.slider;
    const pts = s.controlPoints.slice(1).map((p) => `${n(p.x)}:${n(p.y)}`);
    return `${head},${s.curveType}|${pts.join('|')},${s.slides},${n(s.length)}`;
  }
  return `${head},0:0:0:0:`;
}

/** Serialises a beatmap to .osu v14 text with the fields this tool reads. */
export function writeOsu(b: Beatmap): string {
  const lines = [
    'osu file format v14',
    '',
    '[General]',
    'AudioFilename: audio.mp3',
    `Mode: ${b.mode}`,
    `StackLeniency: ${n(b.stackLeniency)}`,
    '',
    '[Metadata]',
    `Title:${b.title}`,
    `TitleUnicode:${b.titleUnicode}`,
    `Artist:${b.artist}`,
    `ArtistUnicode:${b.artistUnicode}`,
    `Creator:${b.creator}`,
    `Version:${b.version}`,
    `BeatmapID:${b.beatmapId ?? 0}`,
    `BeatmapSetID:${b.beatmapSetId ?? -1}`,
    '',
    '[Difficulty]',
    `HPDrainRate:${n(b.hp)}`,
    `CircleSize:${n(b.cs)}`,
    `OverallDifficulty:${n(b.od)}`,
    `ApproachRate:${n(b.ar)}`,
    `SliderMultiplier:${n(b.sliderMultiplier)}`,
    `SliderTickRate:${n(b.sliderTickRate)}`,
    '',
    '[TimingPoints]',
    ...b.timingPoints.map((t) => `${n(t.time)},${String(t.beatLength)},4,1,0,100,${t.uninherited ? 1 : 0},0`),
    '',
    '[HitObjects]',
    ...b.hitObjects.map(objectLine),
    '',
  ];
  return lines.join('\r\n');
}

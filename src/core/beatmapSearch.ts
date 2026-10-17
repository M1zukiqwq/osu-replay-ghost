import type { Beatmap, BeatmapInfo } from './types';

export type SearchQuery =
  | { kind: 'empty' }
  | { kind: 'md5'; md5: string }
  /** `beatmapId` / `beatmapSetId` from links or prefixes; `anyId` for a bare number (matches either). */
  | { kind: 'id'; beatmapId: number | null; beatmapSetId: number | null; anyId: number | null }
  | { kind: 'text'; terms: string[] };

const int = (s: string) => parseInt(s, 10);

/**
 * Accepts: a beatmap MD5; osu! links (/beatmapsets/S#osu/B, /beatmaps/B, /b/B, /s/S);
 * `b:123` / `s:123`; a bare number (Beatmap ID or BeatmapSet ID); otherwise space-separated keywords.
 */
export function parseSearchQuery(raw: string): SearchQuery {
  const q = raw.trim();
  if (!q) return { kind: 'empty' };
  if (/^[0-9a-f]{32}$/i.test(q)) return { kind: 'md5', md5: q.toLowerCase() };
  const set = /beatmapsets\/(\d+)(?:#\w+\/(\d+))?/i.exec(q);
  if (set) return set[2] ? { kind: 'id', beatmapId: int(set[2]), beatmapSetId: null, anyId: null } : { kind: 'id', beatmapId: null, beatmapSetId: int(set[1]), anyId: null };
  const b = /(?:\/beatmaps\/|\/b\/|^b:\s*)(\d+)/i.exec(q);
  if (b) return { kind: 'id', beatmapId: int(b[1]), beatmapSetId: null, anyId: null };
  const s = /(?:\/s\/|^s:\s*)(\d+)/i.exec(q);
  if (s) return { kind: 'id', beatmapId: null, beatmapSetId: int(s[1]), anyId: null };
  if (/^\d+$/.test(q)) return { kind: 'id', beatmapId: null, beatmapSetId: null, anyId: int(q) };
  return { kind: 'text', terms: q.toLowerCase().split(/\s+/).filter(Boolean) };
}

const haystacks = new WeakMap<BeatmapInfo, string>();

function haystack(info: BeatmapInfo): string {
  let h = haystacks.get(info);
  if (h === undefined) {
    h = [info.artist, info.artistUnicode, info.title, info.titleUnicode, info.creator, info.version, info.source, info.tags]
      .join('\n')
      .toLowerCase();
    haystacks.set(info, h);
  }
  return h;
}

export function matchesQuery(info: BeatmapInfo, q: SearchQuery): boolean {
  switch (q.kind) {
    case 'empty':
      return true;
    case 'md5':
      return info.md5 === q.md5;
    case 'id':
      if (q.anyId !== null) return info.beatmapId === q.anyId || info.beatmapSetId === q.anyId;
      if (q.beatmapId !== null) return info.beatmapId === q.beatmapId;
      return info.beatmapSetId === q.beatmapSetId;
    case 'text': {
      const h = haystack(info);
      return q.terms.every((t) => h.includes(t));
    }
  }
}

/** Exact Beatmap ID hits first, then the most recently played, then by name. */
function compare(q: SearchQuery) {
  return (a: BeatmapInfo, b: BeatmapInfo): number => {
    if (q.kind === 'id' && q.anyId !== null) {
      const d = Number(b.beatmapId === q.anyId) - Number(a.beatmapId === q.anyId);
      if (d) return d;
    }
    const pa = a.lastPlayedAt ?? -Infinity;
    const pb = b.lastPlayedAt ?? -Infinity;
    if (pa !== pb) return pb > pa ? 1 : -1;
    return `${a.artist} ${a.title} ${a.version}`.localeCompare(`${b.artist} ${b.title} ${b.version}`);
  };
}

export interface SearchResult { items: BeatmapInfo[]; total: number }

/** Searches osu!standard maps only, since only std replays can be analysed. O(entries). */
export function searchBeatmaps(entries: Iterable<BeatmapInfo>, q: SearchQuery, limit: number): SearchResult {
  if (q.kind === 'empty') return { items: [], total: 0 };
  const hits: BeatmapInfo[] = [];
  for (const e of entries) if (e.mode === 0 && matchesQuery(e, q)) hits.push(e);
  hits.sort(compare(q));
  return { items: hits.slice(0, limit), total: hits.length };
}

/** Browser metadata for a parsed .osu (demo maps, manual imports, maps found by a Songs scan). */
export function beatmapInfoFrom(b: Beatmap): BeatmapInfo {
  let end = 0;
  for (const o of b.hitObjects) end = Math.max(end, o.endTime);
  return {
    md5: b.md5, beatmapId: b.beatmapId, beatmapSetId: b.beatmapSetId,
    artist: b.artist, artistUnicode: b.artistUnicode, title: b.title, titleUnicode: b.titleUnicode,
    creator: b.creator, version: b.version, source: '', tags: '', mode: b.mode,
    rankedStatus: null, cs: b.cs, ar: b.ar, od: b.od, hp: b.hp, stars: null,
    totalTimeMs: b.hitObjects.length ? Math.round(end) : null,
    objectCount: b.hitObjects.length,
    lastPlayedAt: null,
  };
}

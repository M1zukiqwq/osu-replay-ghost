import { beatmapInfoFrom, parseSearchQuery, searchBeatmaps } from '../core/beatmapSearch';
import type { Beatmap, BeatmapInfo } from '../core/types';
import { updateBrowser } from './actions';
import type { Library } from './library';
import type { ReplayIndex } from './replayIndex';
import { state, type BrowserTab, type RecentMap } from './state';

// Beatmap browser: metadata only (osu!.db, Data/r names). Loading replays lives in preview.ts.

export const RECENT_LIMIT = 60;
export const SEARCH_LIMIT = 100;

const parsedInfo = new WeakMap<Beatmap, BeatmapInfo>();

function infoOfLoaded(b: Beatmap): BeatmapInfo {
  let info = parsedInfo.get(b);
  if (!info) parsedInfo.set(b, (info = beatmapInfoFrom(b)));
  return info;
}

/** osu!.db / scanned metadata first, then the parsed .osu of a loaded map. */
export function infoFor(library: Library, md5: string): BeatmapInfo | null {
  const known = library.info(md5);
  if (known) return known;
  const g = state.groups.find((x) => x.key === md5);
  return g ? infoOfLoaded(g.beatmap) : null;
}

export function setBrowserTab(tab: BrowserTab): void {
  updateBrowser({ tab });
}

function* catalog(library: Library): Generator<BeatmapInfo> {
  const seen = new Set<string>();
  for (const info of library.allInfos()) {
    seen.add(info.md5);
    yield info;
  }
  for (const g of state.groups) if (!seen.has(g.key)) yield infoOfLoaded(g.beatmap);
}

/** Searches osu!.db plus loaded maps by Beatmap ID / set ID / link / MD5 / keywords. */
export function searchCatalog(library: Library, query: string): void {
  const { items, total } = searchBeatmaps(catalog(library), parseSearchQuery(query), SEARCH_LIMIT);
  updateBrowser({ query, results: items, resultTotal: total, tab: query.trim() ? 'search' : state.browser.tab });
}

/** Recently played maps from the Data/r index, newest first. */
export function publishRecent(index: ReplayIndex, library: Library, fresh: ReadonlySet<string>): void {
  const recent: RecentMap[] = index.recent(RECENT_LIMIT).map((r) => ({
    ...r,
    isNew: fresh.has(r.md5),
    info: infoFor(library, r.md5),
  }));
  updateBrowser({ recent, recentTotal: index.mapCount });
}

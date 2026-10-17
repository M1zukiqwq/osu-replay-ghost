import { parseDataRName } from '../core/formats/replayFiles';

export interface RecentEntry { md5: string; lastPlayedAt: number | null; count: number }
export interface DataRRef { name: string; playedAt: number | null }

const newestFirst = (a: DataRRef, b: DataRRef) =>
  (b.playedAt ?? -Infinity) - (a.playedAt ?? -Infinity) || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0);

/**
 * What is known about local replay files without opening them:
 * - Data/r names (`<beatmap MD5>-<timestamp>.osr`) grouped by beatmap;
 * - the beatmap MD5 read from each Replays/ file header (cached by name).
 * Pure bookkeeping; the watcher does the file I/O.
 */
export class ReplayIndex {
  private byMd5 = new Map<string, Map<string, number | null>>();
  private md5ByName = new Map<string, string>();
  private exported = new Map<string, string | null>();
  private recentCache: RecentEntry[] | null = null;

  get dataRCount(): number {
    return this.md5ByName.size;
  }

  get mapCount(): number {
    return this.byMd5.size;
  }

  clear(): void {
    this.byMd5.clear();
    this.md5ByName.clear();
    this.exported.clear();
    this.recentCache = null;
  }

  /** Adds a Data/r name; returns its beatmap MD5 when the name is new and follows the pattern. */
  addDataR(name: string): string | null {
    if (this.md5ByName.has(name)) return null;
    const parsed = parseDataRName(name);
    if (!parsed) return null;
    let names = this.byMd5.get(parsed.md5);
    if (!names) this.byMd5.set(parsed.md5, (names = new Map()));
    names.set(name, parsed.playedAt);
    this.md5ByName.set(name, parsed.md5);
    this.recentCache = null;
    return parsed.md5;
  }

  removeDataR(name: string): void {
    const md5 = this.md5ByName.get(name);
    if (!md5) return;
    this.md5ByName.delete(name);
    const names = this.byMd5.get(md5)!;
    names.delete(name);
    if (!names.size) this.byMd5.delete(md5);
    this.recentCache = null;
  }

  /** Replaces the Data/r listing; returns the names that were not known before. */
  syncDataR(names: string[]): string[] {
    this.dropMissing(names);
    return names.filter((n) => this.addDataR(n) !== null);
  }

  /** Drops vanished Data/r names; returns well-formed names not indexed yet, without adding them. */
  diffDataR(names: string[]): string[] {
    this.dropMissing(names);
    return names.filter((n) => !this.md5ByName.has(n) && parseDataRName(n) !== null);
  }

  private dropMissing(names: string[]): void {
    const present = new Set(names);
    for (const name of [...this.md5ByName.keys()]) if (!present.has(name)) this.removeDataR(name);
  }

  /** Data/r replays of a beatmap, newest first (by the timestamp in the name). */
  dataRFor(md5: string): DataRRef[] {
    const names = this.byMd5.get(md5);
    if (!names) return [];
    return [...names].map(([name, playedAt]) => ({ name, playedAt })).sort(newestFirst);
  }

  countFor(md5: string): number {
    return (this.byMd5.get(md5)?.size ?? 0) + this.exportedFor(md5).length;
  }

  /** Beatmaps with Data/r replays, most recently played first. */
  recent(limit: number): RecentEntry[] {
    if (!this.recentCache) {
      const list: RecentEntry[] = [];
      for (const [md5, names] of this.byMd5) {
        let last: number | null = null;
        for (const t of names.values()) if (t !== null && (last === null || t > last)) last = t;
        list.push({ md5, lastPlayedAt: last, count: names.size });
      }
      list.sort((a, b) => (b.lastPlayedAt ?? -Infinity) - (a.lastPlayedAt ?? -Infinity) || (a.md5 < b.md5 ? -1 : 1));
      this.recentCache = list;
    }
    return this.recentCache.slice(0, limit);
  }

  /** Cached Replays/ header: MD5, null = unreadable, undefined = not read yet. */
  exportedMd5(name: string): string | null | undefined {
    return this.exported.get(name);
  }

  setExported(name: string, md5: string | null): void {
    this.exported.set(name, md5);
  }

  removeExported(name: string): void {
    this.exported.delete(name);
  }

  /** Drops vanished Replays/ names; returns the names whose header has not been read yet. */
  syncExportedNames(names: string[]): string[] {
    const present = new Set(names);
    for (const name of [...this.exported.keys()]) if (!present.has(name)) this.exported.delete(name);
    return names.filter((n) => !this.exported.has(n));
  }

  exportedFor(md5: string): string[] {
    const out: string[] = [];
    for (const [name, m] of this.exported) if (m === md5) out.push(name);
    return out.sort();
  }
}

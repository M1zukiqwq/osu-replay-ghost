const DATA_R_NAME = /^([0-9a-f]{32})-(\d{1,20})\.osr$/i;
const FILETIME_AT_UNIX_EPOCH = 116444736000000000n;
const DOTNET_TICKS_AT_UNIX_EPOCH = 621355968000000000n;
const PLAUSIBLE_FROM = Date.UTC(2007, 0, 1);
const PLAUSIBLE_TO = Date.UTC(2100, 0, 1);

/**
 * The number in a Data/r name is a 100 ns timestamp. Windows FILETIME (since 1601) and .NET ticks
 * (since year 1) land decades apart, so whichever gives a plausible date is used; null otherwise.
 */
export function replayStampToUnixMs(digits: string): number | null {
  let v: bigint;
  try {
    v = BigInt(digits);
  } catch {
    return null;
  }
  for (const epoch of [FILETIME_AT_UNIX_EPOCH, DOTNET_TICKS_AT_UNIX_EPOCH]) {
    const ms = Number((v - epoch) / 10000n);
    if (ms >= PLAUSIBLE_FROM && ms < PLAUSIBLE_TO) return ms;
  }
  return null;
}

export interface DataRName { md5: string; playedAt: number | null }

/** stable stores local score replays as Data/r/<beatmap MD5>-<timestamp>.osr. */
export function parseDataRName(name: string): DataRName | null {
  const m = DATA_R_NAME.exec(name);
  if (!m) return null;
  return { md5: m[1].toLowerCase(), playedAt: replayStampToUnixMs(m[2]) };
}

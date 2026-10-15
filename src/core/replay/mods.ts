export const MOD = {
  NF: 1,
  EZ: 2,
  TD: 4,
  HD: 8,
  HR: 16,
  SD: 32,
  DT: 64,
  RX: 128,
  HT: 256,
  NC: 512,
  FL: 1024,
  AT: 2048,
  SO: 4096,
  AP: 8192,
  PF: 16384,
  K4: 32768,
  K5: 65536,
  K6: 131072,
  K7: 262144,
  K8: 524288,
  FI: 1048576,
  RD: 2097152,
  CN: 4194304,
  TP: 8388608,
  K9: 16777216,
  CO: 33554432,
  K1: 67108864,
  K3: 134217728,
  K2: 268435456,
  V2: 536870912,
  MR: 1073741824,
} as const;

const ORDER: (keyof typeof MOD)[] = [
  'EZ', 'NF', 'HT', 'HR', 'SD', 'PF', 'DT', 'NC', 'HD', 'FI', 'FL', 'RX', 'AP', 'SO', 'AT', 'CN', 'TD', 'TP', 'V2', 'MR',
  'RD', 'CO', 'K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7', 'K8', 'K9',
];

/** Decode a mods bitmask; NC hides DT and PF hides SD. Returns [] for no mods. */
export function decodeMods(mask: number): string[] {
  const names: string[] = [];
  for (const name of ORDER) {
    if (!(mask & MOD[name])) continue;
    if (name === 'DT' && mask & MOD.NC) continue;
    if (name === 'SD' && mask & MOD.PF) continue;
    names.push(name);
  }
  return names;
}

export function modsLabel(names: string[]): string {
  return names.length ? '+' + names.join('') : 'NM';
}

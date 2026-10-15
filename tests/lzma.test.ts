import { afterAll, describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lzmaCompress, lzmaDecompress } from '../src/core/lzma';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function replayText(bytes: number, seed: number): Uint8Array {
  const rand = mulberry32(seed);
  const keyStates = [0, 0, 0, 1, 2, 5, 10, 15];
  let x = 256;
  let y = 192;
  let text = '';
  while (text.length < bytes) {
    const w = rand() < 0.9 ? (rand() < 0.5 ? 16 : 17) : Math.floor(rand() * 40) - 5;
    x = Math.min(512, Math.max(0, x + (rand() - 0.5) * 24));
    y = Math.min(384, Math.max(0, y + (rand() - 0.5) * 24));
    const keys = keyStates[Math.floor(rand() * keyStates.length)];
    text += `${w}|${x.toFixed(2)}|${y.toFixed(2)}|${keys},`;
  }
  return new TextEncoder().encode(text.slice(0, bytes));
}

function randomBytes(n: number, seed: number): Uint8Array {
  const rand = mulberry32(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rand() * 256);
  return out;
}

const PY_SCRIPT = `
import sys, lzma
mode, src, dst = sys.argv[1], sys.argv[2], sys.argv[3]
data = open(src, "rb").read()
if mode == "default":
    out = lzma.compress(data, format=lzma.FORMAT_ALONE)
elif mode == "extreme":
    out = lzma.compress(data, format=lzma.FORMAT_ALONE, preset=9 | lzma.PRESET_EXTREME)
elif mode == "lc0lp2pb0":
    out = lzma.compress(data, format=lzma.FORMAT_ALONE, filters=[{"id": lzma.FILTER_LZMA1, "lc": 0, "lp": 2, "pb": 0, "dict_size": 1 << 16}])
elif mode == "decompress":
    out = lzma.decompress(data, format=lzma.FORMAT_ALONE)
else:
    raise SystemExit("unknown mode " + mode)
open(dst, "wb").write(out)
`;

type PyMode = 'default' | 'extreme' | 'lc0lp2pb0' | 'decompress';

const tmp = mkdtempSync(join(tmpdir(), 'lzma-test-'));
let tmpSeq = 0;

// Data goes through temp files: piping >64 KB through stdin with execFileSync intermittently stalls on macOS.
function python(mode: PyMode, data: Uint8Array): Uint8Array {
  const src = join(tmp, `in-${++tmpSeq}`);
  const dst = join(tmp, `out-${tmpSeq}`);
  writeFileSync(src, data);
  execFileSync('python3', ['-c', PY_SCRIPT, mode, src, dst], { timeout: 30_000, stdio: ['ignore', 'ignore', 'pipe'] });
  return new Uint8Array(readFileSync(dst));
}

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function expectSameBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length).toBe(expected.length);
  expect(Buffer.compare(actual, expected)).toBe(0);
}

function withSize(stream: Uint8Array, size: number): Uint8Array {
  const copy = stream.slice();
  const view = new DataView(copy.buffer);
  view.setUint32(5, size >>> 0, true);
  view.setUint32(9, Math.floor(size / 2 ** 32), true);
  return copy;
}

const samples: Array<[string, Uint8Array]> = [
  ['empty', new Uint8Array(0)],
  ['1 byte', new Uint8Array([0x42])],
  ['short ASCII', new TextEncoder().encode('Hello, osu! 16|256|192|0,16|256.5|192.25|1,')],
  ['200 KB replay text', replayText(200 * 1024, 1)],
  ['50 KB random', randomBytes(50 * 1024, 2)],
  ['100 KB zeros', new Uint8Array(100 * 1024)],
];

describe('lzma roundtrip', () => {
  for (const [name, data] of samples) {
    it(`roundtrips ${name}`, () => {
      const compressed = lzmaCompress(data);
      expect(compressed[0]).toBe(0x5d);
      expectSameBytes(lzmaDecompress(compressed), data);
    }, 30_000);
  }

  it('compresses replay-like text well', () => {
    const data = samples[3][1];
    const compressed = lzmaCompress(data);
    const ratio = compressed.length / data.length;
    console.log(
      `[lzma] replay text ${data.length} -> ${compressed.length} bytes (ratio ${(ratio * 100).toFixed(1)}%, python default ${python('default', data).length})`,
    );
    expect(ratio).toBeLessThan(0.4);
    expect(lzmaCompress(new Uint8Array(100 * 1024)).length).toBeLessThan(200);
  }, 30_000);
});

describe('lzma cross-validation with python', () => {
  for (const [name, data] of samples) {
    for (const mode of ['default', 'extreme', 'lc0lp2pb0'] as const) {
      it(`decodes python ${mode} output: ${name}`, () => {
        expectSameBytes(lzmaDecompress(python(mode, data)), data);
      }, 60_000);
    }

    it(`python decodes our output: ${name}`, () => {
      expectSameBytes(python('decompress', lzmaCompress(data)), data);
    }, 60_000);
  }

  it('accepts a known size together with an end marker', () => {
    const data = replayText(30_000, 3);
    const stream = withSize(python('default', data), data.length);
    expectSameBytes(lzmaDecompress(stream), data);
  }, 30_000);
});

describe('lzma error handling', () => {
  const data = replayText(20_000, 7);
  const ours = lzmaCompress(data);
  const theirs = python('default', data);

  it('rejects truncated streams', () => {
    for (const stream of [ours, theirs]) {
      expect(() => lzmaDecompress(stream.subarray(0, stream.length >> 1))).toThrow(/LZMA 数据被截断/);
      expect(() => lzmaDecompress(stream.subarray(0, stream.length - 1))).toThrow(/LZMA 数据被截断/);
      expect(() => lzmaDecompress(stream.subarray(0, 13))).toThrow(/LZMA 数据被截断/);
      expect(() => lzmaDecompress(stream.subarray(0, 7))).toThrow(/LZMA 数据头不完整/);
    }
  });

  it('rejects invalid properties', () => {
    for (const props of [225, 0xff]) {
      const bad = ours.slice();
      bad[0] = props;
      expect(() => lzmaDecompress(bad)).toThrow(/属性字节无效/);
    }
  });

  it('rejects a declared size larger than the real data', () => {
    expect(() => lzmaDecompress(withSize(ours, data.length + 1000))).toThrow(/LZMA/);
    expect(() => lzmaDecompress(withSize(ours, 100 * 1024 * 1024))).toThrow(/LZMA/);
    expect(() => lzmaDecompress(withSize(theirs, data.length + 1000))).toThrow(/LZMA 数据被截断/);
  });

  it('rejects a declared size smaller than the real data', () => {
    expect(() => lzmaDecompress(withSize(ours, data.length - 10))).toThrow(/LZMA/);
    expect(() => lzmaDecompress(withSize(theirs, data.length - 10))).toThrow(/LZMA/);
  });

  it('rejects absurd declared sizes', () => {
    expect(() => lzmaDecompress(withSize(ours, 600 * 1024 * 1024))).toThrow(/512 MiB/);
    expect(() => lzmaDecompress(withSize(ours, 2 ** 40))).toThrow(/512 MiB/);
  });

  it('never hangs or throws non-Error values on corrupted data', () => {
    const rand = mulberry32(99);
    for (const stream of [ours, theirs]) {
      for (let i = 0; i < 200; i++) {
        const bad = stream.slice();
        const at = 13 + Math.floor(rand() * (bad.length - 13));
        bad[at] ^= 1 + Math.floor(rand() * 255);
        try {
          const out = lzmaDecompress(bad);
          expect(out).toBeInstanceOf(Uint8Array);
        } catch (e) {
          expect(e).toBeInstanceOf(Error);
          expect((e as Error).message).toMatch(/^LZMA /);
        }
      }
    }
  }, 30_000);
});

describe('lzma performance', () => {
  it('decompresses ~1 MB of replay-like text in under 2 s', () => {
    const data = replayText(1024 * 1024, 5);
    const compressed = lzmaCompress(data);
    const start = performance.now();
    const out = lzmaDecompress(compressed);
    const elapsed = performance.now() - start;
    console.log(`[lzma] decoded ${out.length} bytes in ${elapsed.toFixed(1)} ms`);
    expectSameBytes(out, data);
    expect(elapsed).toBeLessThan(2000);
  }, 60_000);
});

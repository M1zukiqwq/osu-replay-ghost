const HEADER_SIZE = 13;
const MAX_OUTPUT = 512 * 1024 * 1024;
const MIN_DICT_SIZE = 1 << 12;
const TOP = 0x1000000;
const PROB_INIT = 1024;
const END_MARKER = 0xffffffff;

function probs(n: number): Uint16Array {
  return new Uint16Array(n).fill(PROB_INIT);
}

function readU32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function corrupt(detail: string): Error {
  return new Error(`LZMA 数据损坏：${detail}`);
}

/**
 * Decodes an "LZMA-alone" (.lzma) stream: 5-byte properties, UInt64 LE
 * uncompressed size (all ones = unknown, end marker required), then the
 * range-coded data.
 */
export function lzmaDecompress(input: Uint8Array): Uint8Array {
  if (input.length < HEADER_SIZE) {
    throw new Error(`LZMA 数据头不完整：至少需要 ${HEADER_SIZE} 字节，实际只有 ${input.length} 字节`);
  }
  const propsByte = input[0];
  if (propsByte >= 9 * 5 * 5) {
    throw corrupt(`属性字节无效（0x${propsByte.toString(16).padStart(2, '0')}）`);
  }
  const lc = propsByte % 9;
  const lp = Math.floor(propsByte / 9) % 5;
  const pb = Math.floor(propsByte / 45);
  const dictSize = Math.max(readU32(input, 1), MIN_DICT_SIZE);

  const sizeLo = readU32(input, 5);
  const sizeHi = readU32(input, 9);
  let size = -1;
  if (sizeLo !== 0xffffffff || sizeHi !== 0xffffffff) {
    if (sizeHi !== 0 || sizeLo > MAX_OUTPUT) {
      throw new Error(`LZMA 声明的解压大小（${sizeHi * 2 ** 32 + sizeLo} 字节）超过 512 MiB 上限`);
    }
    size = sizeLo;
  }
  return new Decoder(input, lc, lp, pb, dictSize, size).run();
}

class Decoder {
  private readonly input: Uint8Array;
  private inPos = HEADER_SIZE;
  private range = 0xffffffff;
  private code = 0;

  private out: Uint8Array;
  private outPos = 0;
  /** Declared size, or -1 when unknown. */
  private readonly size: number;
  private readonly limit: number;

  private readonly lc: number;
  private readonly lpMask: number;
  private readonly pbMask: number;
  private readonly dictSize: number;

  private readonly literal: Uint16Array;
  private readonly isMatch = probs(12 << 4);
  private readonly isRep = probs(12);
  private readonly isRepG0 = probs(12);
  private readonly isRepG1 = probs(12);
  private readonly isRepG2 = probs(12);
  private readonly isRep0Long = probs(12 << 4);
  private readonly posSlot = probs(4 << 6);
  private readonly posSpecial = probs(1 + 128 - 14);
  private readonly align = probs(16);
  // Length coder layout: choice, choice2, low[16][8], mid[16][8], high[256].
  private readonly matchLen = probs(514);
  private readonly repLen = probs(514);

  constructor(input: Uint8Array, lc: number, lp: number, pb: number, dictSize: number, size: number) {
    this.input = input;
    this.lc = lc;
    this.lpMask = (1 << lp) - 1;
    this.pbMask = (1 << pb) - 1;
    this.dictSize = dictSize;
    this.size = size;
    this.limit = size >= 0 ? size : MAX_OUTPUT;
    this.literal = probs(0x300 << (lc + lp));
    // Allocate lazily so a bogus header cannot force a huge allocation up front.
    this.out = new Uint8Array(Math.min(this.limit, Math.max(1 << 20, input.length * 16)));
  }

  run(): Uint8Array {
    if (this.readByte() !== 0) throw corrupt('区间编码流的首字节必须为 0');
    for (let i = 0; i < 4; i++) this.code = this.code * 256 + this.readByte();
    if (this.code === this.range) throw corrupt('区间解码器初始状态无效');

    const { lc, lpMask, pbMask, size, dictSize, literal } = this;
    let state = 0;
    let rep0 = 0;
    let rep1 = 0;
    let rep2 = 0;
    let rep3 = 0;

    for (;;) {
      const outPos = this.outPos;
      // Like the 7-Zip SDK decoder osu! uses: with a known size, stop once it is reached.
      if (outPos === size) break;
      const posState = outPos & pbMask;

      if (this.bit(this.isMatch, (state << 4) + posState) === 0) {
        if (outPos >= this.out.length) this.grow(1);
        const out = this.out;
        const prevByte = outPos > 0 ? out[outPos - 1] : 0;
        const base = 0x300 * (((outPos & lpMask) << lc) + (prevByte >>> (8 - lc)));
        let sym = 1;
        if (state >= 7) {
          let matchByte = out[outPos - rep0 - 1];
          do {
            const matchBit = (matchByte >>> 7) & 1;
            matchByte <<= 1;
            const b = this.bit(literal, base + ((1 + matchBit) << 8) + sym);
            sym = (sym << 1) | b;
            if (matchBit !== b) break;
          } while (sym < 0x100);
        }
        while (sym < 0x100) sym = (sym << 1) | this.bit(literal, base + sym);
        out[outPos] = sym - 0x100;
        this.outPos = outPos + 1;
        state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
        continue;
      }

      let len: number;
      if (this.bit(this.isRep, state) !== 0) {
        if (outPos === 0) throw corrupt('数据开头出现重复匹配');
        if (this.bit(this.isRepG0, state) === 0) {
          if (this.bit(this.isRep0Long, (state << 4) + posState) === 0) {
            if (outPos >= this.out.length) this.grow(1);
            const out = this.out;
            out[outPos] = out[outPos - rep0 - 1];
            this.outPos = outPos + 1;
            state = state < 7 ? 9 : 11;
            continue;
          }
        } else {
          let dist: number;
          if (this.bit(this.isRepG1, state) === 0) {
            dist = rep1;
          } else {
            if (this.bit(this.isRepG2, state) === 0) {
              dist = rep2;
            } else {
              dist = rep3;
              rep3 = rep2;
            }
            rep2 = rep1;
          }
          rep1 = rep0;
          rep0 = dist;
        }
        len = this.decodeLen(this.repLen, posState);
        state = state < 7 ? 8 : 11;
      } else {
        rep3 = rep2;
        rep2 = rep1;
        rep1 = rep0;
        len = this.decodeLen(this.matchLen, posState);
        state = state < 7 ? 7 : 10;
        rep0 = this.decodeDistance(len);
        if (rep0 === END_MARKER) {
          if (this.code !== 0) throw corrupt('结束标记处区间解码器状态异常');
          if (size >= 0 && outPos !== size) {
            throw new Error(`LZMA 数据被截断：在 ${outPos} 字节处遇到结束标记，但声明大小为 ${size} 字节`);
          }
          break;
        }
        if (rep0 >= outPos) throw corrupt(`匹配距离超出已解码数据（距离 ${rep0 + 1}，已解出 ${outPos} 字节）`);
        if (rep0 >= dictSize) throw corrupt(`匹配距离超出字典大小（距离 ${rep0 + 1}，字典 ${dictSize} 字节）`);
      }

      len += 2;
      if (outPos + len > this.out.length) this.grow(len);
      const out = this.out;
      let src = outPos - rep0 - 1;
      const end = outPos + len;
      for (let p = outPos; p < end; ) out[p++] = out[src++];
      this.outPos = end;
    }

    const out = this.out;
    return out.length === this.outPos ? out : out.slice(0, this.outPos);
  }

  private grow(n: number): void {
    const need = this.outPos + n;
    if (need > this.limit) {
      if (this.size >= 0) throw corrupt(`解码数据超出声明的大小（${this.size} 字节）`);
      throw new Error(`LZMA 解压结果超过 512 MiB 上限`);
    }
    const next = new Uint8Array(Math.min(this.limit, Math.max(need, this.out.length * 2)));
    next.set(this.out.subarray(0, this.outPos));
    this.out = next;
  }

  private readByte(): number {
    if (this.inPos >= this.input.length) {
      throw new Error(`LZMA 数据被截断（已解出 ${this.outPos} 字节）`);
    }
    return this.input[this.inPos++];
  }

  private bit(p: Uint16Array, i: number): number {
    const prob = p[i];
    const bound = (this.range >>> 11) * prob;
    let b: number;
    if (this.code < bound) {
      this.range = bound;
      p[i] = prob + ((2048 - prob) >>> 5);
      b = 0;
    } else {
      this.range -= bound;
      this.code -= bound;
      p[i] = prob - (prob >>> 5);
      b = 1;
    }
    if (this.range < TOP) {
      this.range *= 256;
      this.code = this.code * 256 + this.readByte();
    }
    return b;
  }

  private bitTree(p: Uint16Array, offset: number, numBits: number): number {
    let m = 1;
    for (let i = 0; i < numBits; i++) m = (m << 1) | this.bit(p, offset + m);
    return m - (1 << numBits);
  }

  private reverseBitTree(p: Uint16Array, offset: number, numBits: number): number {
    let m = 1;
    let sym = 0;
    for (let i = 0; i < numBits; i++) {
      const b = this.bit(p, offset + m);
      m = (m << 1) | b;
      sym |= b << i;
    }
    return sym;
  }

  private directBits(numBits: number): number {
    let res = 0;
    for (; numBits > 0; numBits--) {
      this.range = this.range >>> 1;
      let b = 0;
      if (this.code >= this.range) {
        this.code -= this.range;
        b = 1;
      }
      if (this.code >= this.range) throw corrupt('区间解码器状态异常');
      res = (res << 1) | b;
      if (this.range < TOP) {
        this.range *= 256;
        this.code = this.code * 256 + this.readByte();
      }
    }
    return res;
  }

  private decodeLen(p: Uint16Array, posState: number): number {
    if (this.bit(p, 0) === 0) return this.bitTree(p, 2 + (posState << 3), 3);
    if (this.bit(p, 1) === 0) return 8 + this.bitTree(p, 130 + (posState << 3), 3);
    return 16 + this.bitTree(p, 258, 8);
  }

  private decodeDistance(len: number): number {
    const slot = this.bitTree(this.posSlot, (len < 3 ? len : 3) << 6, 6);
    if (slot < 4) return slot;
    const numDirectBits = (slot >>> 1) - 1;
    const dist = ((2 | (slot & 1)) << numDirectBits) >>> 0;
    if (slot < 14) return dist + this.reverseBitTree(this.posSpecial, dist - slot, numDirectBits);
    return dist + this.directBits(numDirectBits - 4) * 16 + this.reverseBitTree(this.align, 0, 4);
  }
}

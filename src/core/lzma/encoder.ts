const HEADER_SIZE = 13;
const TOP = 0x1000000;
const PROB_INIT = 1024;
const LC = 3;
const LP = 0;
const PB = 2;
const PB_MASK = (1 << PB) - 1;
const LP_MASK = (1 << LP) - 1;
const MATCH_MAX = 273;
const HASH_BITS = 16;
const CHAIN_DEPTH = 48;

function probs(n: number): Uint16Array {
  return new Uint16Array(n).fill(PROB_INIT);
}

function writeU32(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff;
  b[o + 3] = (v >>> 24) & 0xff;
}

class RangeEncoder {
  private low = 0;
  private range = 0xffffffff;
  private cache = 0;
  private cacheSize = 1;
  private buf: Uint8Array;
  private pos: number;

  constructor(buf: Uint8Array, start: number) {
    this.buf = buf;
    this.pos = start;
  }

  bit(p: Uint16Array, i: number, b: number): void {
    const prob = p[i];
    const bound = (this.range >>> 11) * prob;
    if (b === 0) {
      this.range = bound;
      p[i] = prob + ((2048 - prob) >>> 5);
    } else {
      this.low += bound;
      this.range -= bound;
      p[i] = prob - (prob >>> 5);
    }
    if (this.range < TOP) {
      this.range *= 256;
      this.shiftLow();
    }
  }

  direct(value: number, numBits: number): void {
    for (let i = numBits - 1; i >= 0; i--) {
      this.range = this.range >>> 1;
      if ((value >>> i) & 1) this.low += this.range;
      if (this.range < TOP) {
        this.range *= 256;
        this.shiftLow();
      }
    }
  }

  bitTree(p: Uint16Array, offset: number, numBits: number, sym: number): void {
    let m = 1;
    for (let i = numBits - 1; i >= 0; i--) {
      const b = (sym >>> i) & 1;
      this.bit(p, offset + m, b);
      m = (m << 1) | b;
    }
  }

  reverseBitTree(p: Uint16Array, offset: number, numBits: number, sym: number): void {
    let m = 1;
    for (let i = 0; i < numBits; i++) {
      const b = sym & 1;
      sym >>>= 1;
      this.bit(p, offset + m, b);
      m = (m << 1) | b;
    }
  }

  finish(): Uint8Array {
    for (let i = 0; i < 5; i++) this.shiftLow();
    return this.buf.slice(0, this.pos);
  }

  // `low` holds up to 33 bits; bit 32 is a carry into the pending 0xFF run.
  private shiftLow(): void {
    const low = this.low;
    if (low < 0xff000000 || low >= 0x100000000) {
      const carry = low >= 0x100000000 ? 1 : 0;
      let temp = this.cache;
      do {
        this.writeByte((temp + carry) & 0xff);
        temp = 0xff;
      } while (--this.cacheSize !== 0);
      this.cache = (low >>> 24) & 0xff;
    }
    this.cacheSize++;
    this.low = (low & 0xffffff) * 256;
  }

  private writeByte(b: number): void {
    if (this.pos === this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.pos++] = b;
  }
}

class Encoder {
  private readonly data: Uint8Array;
  private readonly rc: RangeEncoder;
  private state = 0;
  private readonly reps = [0, 0, 0, 0];

  private readonly literal = probs(0x300 << (LC + LP));
  private readonly isMatch = probs(12 << 4);
  private readonly isRep = probs(12);
  private readonly isRepG0 = probs(12);
  private readonly isRepG1 = probs(12);
  private readonly isRepG2 = probs(12);
  private readonly isRep0Long = probs(12 << 4);
  private readonly posSlot = probs(4 << 6);
  private readonly posSpecial = probs(1 + 128 - 14);
  private readonly align = probs(16);
  private readonly matchLen = probs(514);
  private readonly repLen = probs(514);

  private readonly head = new Int32Array(1 << HASH_BITS).fill(-1);
  private readonly chain: Int32Array;
  private inserted = 0;
  private matchDist = 0;

  constructor(data: Uint8Array, rc: RangeEncoder) {
    this.data = data;
    this.rc = rc;
    this.chain = new Int32Array(data.length);
  }

  run(): void {
    const n = this.data.length;
    let pos = 0;
    let mainLen = this.findMatch(0);
    let mainDist = this.matchDist;

    while (pos < n) {
      let repLen = 0;
      let repIdx = 0;
      for (let i = 0; i < 4; i++) {
        const len = this.matchLength(pos, this.reps[i]);
        if (len > repLen) {
          repLen = len;
          repIdx = i;
        }
      }

      if (
        repLen >= 2 &&
        (repLen + 1 >= mainLen ||
          (repLen + 2 >= mainLen && mainDist >= 1 << 9) ||
          (repLen + 3 >= mainLen && mainDist >= 1 << 15))
      ) {
        this.encodeRep(pos, repIdx, repLen);
        pos += repLen;
      } else if (mainLen >= 3) {
        if (pos + 1 < n) {
          // Lazy evaluation (same heuristics as the LZMA SDK fast mode).
          const nextLen = this.findMatch(pos + 1);
          const nextDist = this.matchDist;
          if (
            (nextLen >= mainLen && nextDist < mainDist) ||
            (nextLen === mainLen + 1 && !(nextDist >>> 7 > mainDist)) ||
            nextLen > mainLen + 1 ||
            (nextLen + 1 >= mainLen && mainDist >>> 7 > nextDist)
          ) {
            this.encodeLiteral(pos);
            pos++;
            mainLen = nextLen;
            mainDist = nextDist;
            continue;
          }
        }
        this.encodeMatch(pos, mainLen, mainDist);
        pos += mainLen;
      } else {
        this.encodeLiteral(pos);
        pos++;
      }
      mainLen = this.findMatch(pos);
      mainDist = this.matchDist;
    }
  }

  private hash(p: number): number {
    const d = this.data;
    return Math.imul(d[p] | (d[p + 1] << 8) | (d[p + 2] << 16), 0x9e3779b1) >>> (32 - HASH_BITS);
  }

  private insertUpTo(end: number): void {
    const last = Math.min(end, this.data.length - 2);
    for (let p = this.inserted; p < last; p++) {
      const h = this.hash(p);
      this.chain[p] = this.head[h];
      this.head[h] = p;
    }
    if (end > this.inserted) this.inserted = end;
  }

  /** Longest match (>= 3) at `pos` from the hash chain; distance goes to `matchDist`. */
  private findMatch(pos: number): number {
    const data = this.data;
    const n = data.length;
    this.insertUpTo(pos);
    if (pos + 3 > n) return 0;

    const maxLen = Math.min(MATCH_MAX, n - pos);
    let bestLen = 2;
    let bestDist = 0;
    let cand = this.head[this.hash(pos)];
    for (let depth = CHAIN_DEPTH; cand >= 0 && depth > 0; depth--) {
      if (data[cand + bestLen] === data[pos + bestLen]) {
        let len = 0;
        while (len < maxLen && data[cand + len] === data[pos + len]) len++;
        if (len > bestLen) {
          bestLen = len;
          bestDist = pos - cand - 1;
          if (len === maxLen) break;
        }
      }
      cand = this.chain[cand];
    }
    this.insertUpTo(pos + 1);

    this.matchDist = bestDist;
    if (bestLen < 3 || (bestLen === 3 && bestDist >= 1 << 14)) return 0;
    return bestLen;
  }

  private matchLength(pos: number, dist: number): number {
    if (dist >= pos) return 0;
    const data = this.data;
    const maxLen = Math.min(MATCH_MAX, data.length - pos);
    const src = pos - dist - 1;
    let len = 0;
    while (len < maxLen && data[src + len] === data[pos + len]) len++;
    return len;
  }

  private encodeLiteral(pos: number): void {
    const { rc, data, state } = this;
    rc.bit(this.isMatch, (state << 4) + (pos & PB_MASK), 0);
    const prevByte = pos > 0 ? data[pos - 1] : 0;
    const base = 0x300 * (((pos & LP_MASK) << LC) + (prevByte >>> (8 - LC)));
    const byte = data[pos];
    let matched = state >= 7;
    const matchByte = matched ? data[pos - this.reps[0] - 1] : 0;
    let sym = 1;
    for (let i = 7; i >= 0; i--) {
      const b = (byte >>> i) & 1;
      if (matched) {
        const mb = (matchByte >>> i) & 1;
        rc.bit(this.literal, base + ((1 + mb) << 8) + sym, b);
        matched = mb === b;
      } else {
        rc.bit(this.literal, base + sym, b);
      }
      sym = (sym << 1) | b;
    }
    this.state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
  }

  private encodeMatch(pos: number, len: number, dist: number): void {
    const { rc, state, reps } = this;
    const posState = pos & PB_MASK;
    rc.bit(this.isMatch, (state << 4) + posState, 1);
    rc.bit(this.isRep, state, 0);
    this.encodeLen(this.matchLen, len - 2, posState);
    this.encodeDistance(dist, len - 2);
    reps[3] = reps[2];
    reps[2] = reps[1];
    reps[1] = reps[0];
    reps[0] = dist;
    this.state = state < 7 ? 7 : 10;
  }

  private encodeRep(pos: number, idx: number, len: number): void {
    const { rc, state, reps } = this;
    const posState = pos & PB_MASK;
    rc.bit(this.isMatch, (state << 4) + posState, 1);
    rc.bit(this.isRep, state, 1);
    if (idx === 0) {
      rc.bit(this.isRepG0, state, 0);
      rc.bit(this.isRep0Long, (state << 4) + posState, 1);
    } else {
      rc.bit(this.isRepG0, state, 1);
      if (idx === 1) {
        rc.bit(this.isRepG1, state, 0);
      } else {
        rc.bit(this.isRepG1, state, 1);
        rc.bit(this.isRepG2, state, idx - 2);
      }
      const dist = reps[idx];
      for (let i = idx; i > 0; i--) reps[i] = reps[i - 1];
      reps[0] = dist;
    }
    this.encodeLen(this.repLen, len - 2, posState);
    this.state = state < 7 ? 8 : 11;
  }

  private encodeLen(p: Uint16Array, len: number, posState: number): void {
    const rc = this.rc;
    if (len < 8) {
      rc.bit(p, 0, 0);
      rc.bitTree(p, 2 + (posState << 3), 3, len);
    } else if (len < 16) {
      rc.bit(p, 0, 1);
      rc.bit(p, 1, 0);
      rc.bitTree(p, 130 + (posState << 3), 3, len - 8);
    } else {
      rc.bit(p, 0, 1);
      rc.bit(p, 1, 1);
      rc.bitTree(p, 258, 8, len - 16);
    }
  }

  private encodeDistance(dist: number, len: number): void {
    const rc = this.rc;
    let slot = dist;
    if (dist >= 4) {
      const top = 31 - Math.clz32(dist);
      slot = (top << 1) | ((dist >>> (top - 1)) & 1);
    }
    rc.bitTree(this.posSlot, (len < 3 ? len : 3) << 6, 6, slot);
    if (slot < 4) return;
    const numDirectBits = (slot >>> 1) - 1;
    const base = ((2 | (slot & 1)) << numDirectBits) >>> 0;
    const reduced = dist - base;
    if (slot < 14) {
      rc.reverseBitTree(this.posSpecial, base - slot, numDirectBits, reduced);
    } else {
      rc.direct(reduced >>> 4, numDirectBits - 4);
      rc.reverseBitTree(this.align, 0, 4, reduced & 15);
    }
  }
}

/**
 * Encodes `input` as an "LZMA-alone" (.lzma) stream (lc=3, lp=0, pb=2) with the
 * exact uncompressed size in the header and no end marker.
 */
export function lzmaCompress(input: Uint8Array): Uint8Array {
  const n = input.length;
  let dictSize = 1 << 20;
  while (dictSize < n) dictSize *= 2;

  const buf = new Uint8Array(HEADER_SIZE + n + (n >>> 3) + 64);
  buf[0] = (PB * 5 + LP) * 9 + LC;
  writeU32(buf, 1, dictSize);
  writeU32(buf, 5, n);
  writeU32(buf, 9, Math.floor(n / 2 ** 32));

  const rc = new RangeEncoder(buf, HEADER_SIZE);
  new Encoder(input, rc).run();
  return rc.finish();
}

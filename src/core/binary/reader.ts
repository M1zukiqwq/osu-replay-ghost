export class BinaryReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BinaryReadError';
  }
}

const utf8 = new TextDecoder('utf-8');

/** Little-endian reader for osu! binary formats. Every read is bounds-checked. */
export class BinaryReader {
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  offset = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  private need(n: number, what: string): void {
    if (n < 0 || this.offset + n > this.bytes.length) {
      throw new BinaryReadError(
        `读取「${what}」越界：偏移 ${this.offset}，需要 ${n} 字节，剩余 ${Math.max(0, this.remaining)} 字节（文件可能被截断或已损坏）`,
      );
    }
  }

  u8(what = 'Byte'): number {
    this.need(1, what);
    return this.bytes[this.offset++];
  }

  bool(what = 'Bool'): boolean {
    return this.u8(what) !== 0;
  }

  u16(what = 'Short'): number {
    this.need(2, what);
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  i16(what = 'Short'): number {
    this.need(2, what);
    const v = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return v;
  }

  i32(what = 'Int'): number {
    this.need(4, what);
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }

  u32(what = 'Int'): number {
    this.need(4, what);
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  i64(what = 'Long'): bigint {
    this.need(8, what);
    const v = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return v;
  }

  f32(what = 'Single'): number {
    this.need(4, what);
    const v = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return v;
  }

  f64(what = 'Double'): number {
    this.need(8, what);
    const v = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return v;
  }

  uleb128(what = 'ULEB128'): number {
    let result = 0;
    let mul = 1;
    for (let i = 0; i < 5; i++) {
      const byte = this.u8(what);
      result += (byte & 0x7f) * mul;
      if ((byte & 0x80) === 0) return result;
      mul *= 128;
    }
    throw new BinaryReadError(`「${what}」的 ULEB128 长度编码无效（偏移 ${this.offset}）`);
  }

  private stringLength(what: string): number {
    const marker = this.u8(what);
    if (marker === 0x00) return -1;
    if (marker !== 0x0b) {
      throw new BinaryReadError(`「${what}」的字符串标记无效：0x${marker.toString(16)}（偏移 ${this.offset - 1}）`);
    }
    const len = this.uleb128(what);
    this.need(len, what);
    return len;
  }

  string(what = 'String'): string {
    const len = this.stringLength(what);
    if (len < 0) return '';
    const s = utf8.decode(this.bytes.subarray(this.offset, this.offset + len));
    this.offset += len;
    return s;
  }

  skipString(what = 'String'): void {
    const len = this.stringLength(what);
    if (len > 0) this.offset += len;
  }

  take(n: number, what = 'Byte[]'): Uint8Array {
    this.need(n, what);
    const out = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  skip(n: number, what = '数据'): void {
    this.need(n, what);
    this.offset += n;
  }
}

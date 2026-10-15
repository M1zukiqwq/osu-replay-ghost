const utf8 = new TextEncoder();

/** Little-endian writer mirroring BinaryReader, used for sample export and tests. */
export class BinaryWriter {
  private buf = new Uint8Array(256);
  private view = new DataView(this.buf.buffer);
  private len = 0;

  private grow(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): this {
    this.grow(1);
    this.buf[this.len++] = v & 0xff;
    return this;
  }

  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }

  u16(v: number): this {
    this.grow(2);
    this.view.setUint16(this.len, v, true);
    this.len += 2;
    return this;
  }

  i32(v: number): this {
    this.grow(4);
    this.view.setInt32(this.len, v, true);
    this.len += 4;
    return this;
  }

  i64(v: bigint): this {
    this.grow(8);
    this.view.setBigInt64(this.len, v, true);
    this.len += 8;
    return this;
  }

  f32(v: number): this {
    this.grow(4);
    this.view.setFloat32(this.len, v, true);
    this.len += 4;
    return this;
  }

  f64(v: number): this {
    this.grow(8);
    this.view.setFloat64(this.len, v, true);
    this.len += 8;
    return this;
  }

  uleb128(v: number): this {
    let n = v;
    do {
      let byte = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) byte |= 0x80;
      this.u8(byte);
    } while (n > 0);
    return this;
  }

  string(s: string | null): this {
    if (!s) return this.u8(0x00);
    const bytes = utf8.encode(s);
    this.u8(0x0b).uleb128(bytes.length);
    return this.bytes(bytes);
  }

  bytes(b: Uint8Array): this {
    this.grow(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
    return this;
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

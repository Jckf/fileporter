// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// Framing over a tailcat stream (relay path and all control traffic):
//
//   [u8 type][u32 big-endian length][payload]
//
//   type 0: control message, UTF-8 JSON
//   type 1: data: [u32 chunk index][chunk bytes]
//
// One stream carries both, so the relay fallback needs no second
// connection.

export const T_CONTROL = 0;
export const T_DATA = 1;
const HDR = 5;
const MAX_FRAME = 4 << 20;

const enc = new TextEncoder();
const dec = new TextDecoder();

export class FramedConn {
  constructor(conn) {
    this.conn = conn;
    this.pieces = []; // unread bytes, as received
    this.avail = 0;
    this.eof = false;
    this.writeChain = Promise.resolve();
    this.onBytes = null; // called whenever bytes arrive (liveness)
  }

  /**
   * Sends one frame. Writes are serialized so frames never
   * interleave; the returned promise settles when this frame has been
   * handed to the tunnel (TCP backpressure applies).
   */
  writeFrame(type, payload, prefix) {
    const extra = prefix ? prefix.length : 0;
    const f = new Uint8Array(HDR + extra + payload.length);
    f[0] = type;
    new DataView(f.buffer).setUint32(1, extra + payload.length);
    if (prefix) f.set(prefix, HDR);
    f.set(payload, HDR + extra);
    this.writeChain = this.writeChain.then(() => this.conn.write(f, { owned: true }));
    return this.writeChain;
  }

  send(msg) {
    return this.writeFrame(T_CONTROL, enc.encode(JSON.stringify(msg)));
  }

  sendChunk(idx, bytes) {
    const prefix = new Uint8Array(4);
    new DataView(prefix.buffer).setUint32(0, idx);
    return this.writeFrame(T_DATA, bytes, prefix);
  }

  async fill(n) {
    while (this.avail < n) {
      if (this.eof) return false;
      const chunk = await this.conn.read();
      if (chunk === null) { this.eof = true; return false; }
      this.onBytes?.();
      this.pieces.push(chunk);
      this.avail += chunk.length;
    }
    return true;
  }

  /** Consumes exactly n buffered bytes (fill(n) must have succeeded). */
  take(n) {
    this.avail -= n;
    const first = this.pieces[0];
    if (first.length >= n) {
      const out = first.subarray(0, n);
      if (first.length === n) this.pieces.shift();
      else this.pieces[0] = first.subarray(n);
      return out;
    }
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      const p = this.pieces[0];
      const k = Math.min(p.length, n - off);
      out.set(p.subarray(0, k), off);
      off += k;
      if (k === p.length) this.pieces.shift();
      else this.pieces[0] = p.subarray(k);
    }
    return out;
  }

  /** Returns {type, payload} or null on clean EOF. */
  async readFrame() {
    if (!(await this.fill(HDR))) {
      if (this.avail) throw new Error("truncated frame header");
      return null;
    }
    const hdr = this.take(HDR);
    const type = hdr[0];
    const len = new DataView(hdr.buffer, hdr.byteOffset, HDR).getUint32(1);
    if (len > MAX_FRAME) throw new Error(`frame too large: ${len}`);
    if (!(await this.fill(len))) throw new Error("truncated frame");
    return { type, payload: len ? this.take(len) : new Uint8Array(0) };
  }

  static decodeControl(payload) {
    return JSON.parse(dec.decode(payload));
  }

  close() { this.conn.close(); }
}

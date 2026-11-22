// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// Two transports with one interface:
//
//   send(msg)              control message (JSON)
//   sendChunk(idx, bytes)  one whole chunk; resolves when the transport
//                          accepted it (backpressure)
//   next(t)                next control message of type t
//   nextOf(t1, t2, …)      next control message of any of these types
//   nextEvent()            next {kind:"control", msg} | {kind:"chunk", idx, bytes}
//   finish()               flush, let the peer see the end, then shut down
//   shutdown()             tear down immediately
//   via                    "relay" | "rtc"
//
// Liveness: a peer that vanishes (closed tab, lost network) sends no
// TCP reset through the tunnel, so reads would block forever. Both
// transports send {t:"ping"} every KEEPALIVE_MS and close themselves
// after PEER_TIMEOUT_MS without receiving anything. Any received byte
// counts, not just whole messages: a 1 MiB chunk on a slow relay can
// take longer than the timeout, and pings queue behind chunks.
// A page that is going away sends {t:"bye"} (bye()), so the peer can
// reconnect at once instead of waiting for the timeout. Best effort:
// on the relay it queues behind data already in the TCP send buffer,
// so mid-transfer it rarely gets out before the page is torn down; it
// helps when the link is idle. (A direct connection's close is seen
// immediately anyway.) Pings and byes never reach consumers.
//
// Link runs over the framed tailcat stream (always present: handshake,
// WebRTC signaling, and the data path in privacy mode or when no direct
// path exists). RtcTransport runs over an RTCDataChannel.

import { FramedConn, T_CONTROL, T_DATA } from "./framing.js";

const KEEPALIVE_MS = 3000;
const PEER_TIMEOUT_MS = 12000;
// How often the watchdog checks for PEER_TIMEOUT_MS of silence.
const WATCHDOG_MS = 1000;
const FINISH_TIMEOUT_MS = 3000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isSignaling = (it) => it.kind === "control" && (it.msg.t === "rtc" || it.msg.t === "ice");

/** Ordered event queue with typed waits. */
class EventQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.err = null;
    this.signalingHandler = null;
    this.lastRx = Date.now();
    this.timers = [];
  }
  /** Starts keepalive pings (via sendPing) and the peer-timeout watchdog. */
  startLiveness(sendPing) {
    this.timers.push(setInterval(() => { if (!this.err) sendPing(); }, KEEPALIVE_MS));
    this.timers.push(setInterval(() => {
      if (Date.now() - this.lastRx > PEER_TIMEOUT_MS) this.timedOut();
    }, WATCHDOG_MS));
  }
  timedOut() {
    this.close(new Error("peer timed out"));
    this.shutdown();
  }
  /** Tears down at once; subclasses also close what they run over. */
  shutdown() { this.close(); }
  push(item) {
    this.lastRx = Date.now();
    if (item.kind === "control" && item.msg.t === "ping") return;
    if (item.kind === "control" && item.msg.t === "bye") { this.close(new Error("peer left")); this.shutdown(); return; }
    if (this.signalingHandler && isSignaling(item)) { this.signalingHandler(item.msg); return; }
    const i = this.waiters.findIndex((w) => w.match(item));
    if (i >= 0) { this.waiters.splice(i, 1)[0].resolve(item); return; }
    this.items.push(item);
  }
  close(err) {
    if (this.err) return;
    this.err = err || new Error("connection closed");
    for (const t of this.timers.splice(0)) clearInterval(t);
    for (const w of this.waiters.splice(0)) w.reject(this.err);
  }
  get closed() { return !!this.err; }
  take(match) {
    const i = this.items.findIndex(match);
    if (i >= 0) return Promise.resolve(this.items.splice(i, 1)[0]);
    if (this.err) return Promise.reject(this.err);
    return new Promise((resolve, reject) => this.waiters.push({ match, resolve, reject }));
  }
  next(t) { return this.nextOf(t); }
  /** Next control message whose type is any of ts. */
  nextOf(...ts) { return this.take((it) => it.kind === "control" && ts.includes(it.msg.t)).then((it) => it.msg); }
  nextEvent() { return this.take(() => true); }
  setSignalingHandler(fn) {
    this.signalingHandler = fn;
    const keep = [];
    for (const it of this.items.splice(0)) (isSignaling(it) ? fn(it.msg) : keep.push(it));
    this.items.push(...keep);
  }
}

export class Link extends EventQueue {
  constructor(conn) {
    super();
    this.via = "relay";
    this.conn = conn;
    this.fc = new FramedConn(conn);
    this.fc.onBytes = () => { this.lastRx = Date.now(); };
    this.done = this.readLoop();
    this.startLiveness(() => this.fc.send({ t: "ping" }).catch(() => {}));
  }
  async readLoop() {
    try {
      for (let f; (f = await this.fc.readFrame()) !== null; ) {
        if (f.type === T_CONTROL) {
          this.push({ kind: "control", msg: FramedConn.decodeControl(f.payload) });
        } else if (f.type === T_DATA) {
          if (f.payload.length < 4) throw new Error("short data frame");
          const idx = new DataView(f.payload.buffer, f.payload.byteOffset, 4).getUint32(0);
          this.push({ kind: "chunk", idx, bytes: f.payload.slice(4) });
        }
      }
      this.close();
    } catch (err) {
      this.close(err);
    }
  }
  send(msg) { return this.fc.send(msg); }
  bye() { if (!this.err) this.fc.send({ t: "bye" }).catch(() => {}); }
  sendChunk(idx, bytes) {
    if (this.err) return Promise.reject(this.err);
    return this.fc.sendChunk(idx, bytes);
  }
  /** Signaling adapter for rtc.connect. */
  signal() {
    const link = this;
    return { send: (m) => link.send(m).catch(() => {}), set onMessage(fn) { link.setSignalingHandler(fn); } };
  }
  /**
   * Graceful end: wait until everything we wrote is handed over,
   * half-close, and give the peer a moment to read it and close its
   * side. Tearing the tunnel down right after write() would drop data
   * still in flight (write() resolving only means "buffered").
   */
  async finish() {
    try {
      await this.fc.writeChain;
      await this.conn.closeWrite();
      await Promise.race([this.done, sleep(FINISH_TIMEOUT_MS)]);
    } catch {}
    this.shutdown();
  }
  shutdown() {
    this.fc.close();
    this.close();
  }
}
// Data channel messages: string = control JSON; binary =
// [u32 chunk index][u32 offset in chunk][bytes]. 64 KiB per message is
// the size every engine accepts.
//
// Lanes: a transport can run over several peer connections at once
// (addLane), each with one data channel. Through a TURN relay one
// connection's data channel manages only ~10–20 Mbit/s: it sends little
// before waiting for acknowledgements, and the relay adds latency.
// Connections don't share that limit, so more lanes add up. Each chunk
// travels whole on one lane (the least busy); the receiver reassembles
// per lane and puts chunks back in order (session.js). Control messages
// go on the first lane. Losing any lane closes the transport: chunks in
// flight on it are gone, and the session resumes where it left off.
const PIECE = 65536 - 8;
const HIGH_WATER = 4 << 20;
const LOW_WATER = 1 << 20;

export class RtcTransport extends EventQueue {
  constructor(pc, dc, chunkLen) {
    super();
    this.via = "rtc";
    this.chunkLen = chunkLen;
    this.lanes = [];
    // Senders waiting in drained(): woken when a lane drains, a lane is
    // added (it starts out empty) or the transport closes.
    this.drainWaiters = new Set();
    this.addLane(pc, dc);
    this.startLiveness(() => { try { this.dc.send('{"t":"ping"}'); } catch {} });
  }
  /** The first lane, which carries control messages. */
  get pc() { return this.lanes[0].pc; }
  get dc() { return this.lanes[0].dc; }
  /** Adds a connected peer connection and its open data channel. */
  addLane(pc, dc) {
    if (this.err) {
      try { pc.close(); } catch {}
      return;
    }
    const lane = { pc, dc, asm: null };
    this.lanes.push(lane);
    dc.bufferedAmountLowThreshold = LOW_WATER;
    dc.onclose = () => this.close(new Error("direct connection closed"));
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") this.close(new Error("direct connection lost"));
    });
    dc.takeOver((d) => this.onData(lane, d));
    this.wakeDrainWaiters();
  }
  close(err) {
    if (this.err) return;
    super.close(err);
    this.wakeDrainWaiters();
  }
  wakeDrainWaiters() {
    for (const wake of [...this.drainWaiters]) wake();
  }
  onData(lane, d) {
    this.lastRx = Date.now();
    try {
      if (typeof d === "string") { this.push({ kind: "control", msg: JSON.parse(d) }); return; }
      const dv = new DataView(d);
      const idx = dv.getUint32(0);
      const off = dv.getUint32(4);
      const payload = new Uint8Array(d, 8);
      if (!lane.asm) {
        if (off !== 0) throw new Error(`chunk ${idx} started at offset ${off}`);
        lane.asm = { idx, buf: new Uint8Array(this.chunkLen(idx)), got: 0 };
      } else if (lane.asm.idx !== idx) {
        // A lane carries one whole chunk at a time: anything else would
        // lose the rest of the first one, and the transfer would wait
        // for it forever instead of failing and resuming.
        throw new Error(`chunk ${lane.asm.idx} cut short by chunk ${idx}`);
      }
      const asm = lane.asm;
      if (off !== asm.got || off + payload.length > asm.buf.length) throw new Error(`chunk ${idx}: bad piece at ${off}`);
      asm.buf.set(payload, off);
      asm.got += payload.length;
      if (asm.got === asm.buf.length) {
        this.push({ kind: "chunk", idx, bytes: asm.buf });
        lane.asm = null;
      }
    } catch (err) {
      this.close(err);
      this.shutdown();
    }
  }
  // async: a closed channel makes dc.send throw, and callers handle
  // that as a rejection (send(…).catch()), like Link's.
  async send(msg) {
    if (this.err) throw this.err;
    this.dc.send(JSON.stringify(msg));
  }
  bye() { if (!this.err) try { this.dc.send('{"t":"bye"}'); } catch {} }
  /**
   * Queues the whole chunk on the least busy lane, first waiting while
   * even that one has more than HIGH_WATER queued.
   */
  async sendChunk(idx, bytes) {
    if (this.err) throw this.err;
    const least = () => this.lanes.reduce((a, b) => (b.dc.bufferedAmount < a.dc.bufferedAmount ? b : a));
    let lane = least();
    while (lane.dc.bufferedAmount > HIGH_WATER) {
      await this.drained();
      if (this.err) throw this.err;
      lane = least();
    }
    for (let off = 0; off < bytes.length; off += PIECE) {
      const n = Math.min(PIECE, bytes.length - off);
      const m = new Uint8Array(8 + n);
      const dv = new DataView(m.buffer);
      dv.setUint32(0, idx);
      dv.setUint32(4, off);
      m.set(bytes.subarray(off, off + n), 8);
      lane.dc.send(m.buffer);
    }
  }
  /**
   * Resolves when any lane's queue drops below LOW_WATER, a lane joins,
   * or the transport closes (the caller checks this.err). Doesn't rely
   * on the data channels' close events: pc.close() may skip them.
   */
  drained() {
    return new Promise((resolve) => {
      const lanes = [...this.lanes];
      const wake = () => {
        this.drainWaiters.delete(wake);
        for (const { dc } of lanes) {
          dc.removeEventListener("bufferedamountlow", wake);
          dc.removeEventListener("close", wake);
        }
        resolve();
      };
      this.drainWaiters.add(wake);
      for (const { dc } of lanes) {
        dc.addEventListener("bufferedamountlow", wake);
        dc.addEventListener("close", wake);
      }
    });
  }
  /** Graceful end: let queued messages drain before closing. */
  async finish() {
    const end = Date.now() + FINISH_TIMEOUT_MS;
    const busy = () => this.lanes.some(({ dc }) => dc.readyState === "open" && dc.bufferedAmount > 0);
    while (busy() && Date.now() < end) await sleep(50);
    this.shutdown();
  }
  shutdown() {
    for (const { pc, dc } of this.lanes) {
      try { dc.close(); } catch {}
      try { pc.close(); } catch {}
    }
    this.close();
  }
}

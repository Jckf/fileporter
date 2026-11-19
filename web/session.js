// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// Transfer protocol. All messages before the transport is chosen go
// over the tailcat Link (relay); after that, over the chosen transport.
//
//   S→R {t:"hello", v, id, mode, name, size, type, chunkSize}
//   R→S {t:"resume", id, mode, fromChunk, prevHash}
//         prevHash = SHA-256 of chunk fromChunk-1 as the receiver stored it
//   S→R {t:"start", fromChunk}
//         the sender's answer: fromChunk, or 0 if prevHash doesn't match
//         its file (the file changed between sessions)
//   … mode negotiation: privacy if either side chose privacy; only in
//     performance mode: {t:"rtc"/"ice"} signaling over the Link …
//   S→R {t:"transport", via:"rtc"|"relay"}               (sender decides)
//   S→R chunk i … (at most WINDOW unacknowledged)
//   R→S {t:"ack", idx}       after chunk idx is durably stored
//   S→R {t:"done", root}     root = SHA-256(H0 ‖ H1 ‖ … ‖ Hn-1)
//   R→S {t:"complete", ok, root}
//   either way {t:"cancel"}  the other side gave up; forget the session
//   R→S {t:"nospace"}        the receiver's storage is full (instead of
//         "resume" when the up-front check fails, or at any point while
//         storing). Not final: freeing space and reloading resumes. It
//         deliberately carries no numbers about the receiver's storage.
//
// A dropped connection at any point is resumable: the receiver redials
// and the handshake picks up at the first chunk it doesn't have.

import { Link, RtcTransport } from "./transport.js";
import * as rtc from "./rtc.js";
import * as storage from "./storage.js";

export const PROTOCOL_VERSION = 1;
export const CHUNK = 1 << 20;
const WINDOW = 8;

export const chunkCount = (size) => Math.ceil(size / CHUNK);
const chunkLenFor = (size) => (idx) => Math.min(CHUNK, size - idx * CHUNK);
export const effectiveMode = (a, b) => (a === "privacy" || b === "privacy" ? "privacy" : "performance");

/** Errors that retrying won't fix. */
export class FatalError extends Error {}
/** The other side cancelled the transfer. */
export class CancelledError extends FatalError {}
/** The receiver's storage is full. Freeing space and retrying resumes. */
export class NoSpaceError extends FatalError {}

const NOSPACE_SENDER = "The recipient's device doesn't have enough storage space for this file. The transfer continues once they free up some space and try again.";
const isQuotaError = (err) => err?.name === "QuotaExceededError";

const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));

async function readChunk(file, idx) {
  return new Uint8Array(await file.slice(idx * CHUNK, Math.min(file.size, (idx + 1) * CHUNK)).arrayBuffer());
}

/** Sender-side per-chunk hashes, cached for the page's lifetime. */
export class ChunkHashes {
  constructor(file) { this.file = file; this.h = []; }
  async get(idx) {
    if (!this.h[idx]) this.h[idx] = await sha256(await readChunk(this.file, idx));
    return this.h[idx];
  }
  set(idx, hash) { this.h[idx] = hash; }
  async root(n) {
    const all = new Uint8Array(n * 32);
    for (let i = 0; i < n; i++) all.set(await this.get(i), i * 32);
    return hex(await sha256(all));
  }
}

/**
 * Sender side of one connection from the receiver. Resolves when the
 * receiver confirmed the complete file; rejects if the connection
 * drops (the receiver will redial) or with FatalError.
 *
 * callbacks: onStatus({phase, ...}), onProgress(bytesConfirmed)
 * ctl: {} that this function fills with stop() and cancel()
 */
export async function senderSession(conn, { state, file, hashes, iceServers, iceTimeoutMs, onStatus, onProgress, ctl }) {
  const link = new Link(conn);
  let transport = link;
  // ctl lets the page stop this session, or cancel it (telling the peer).
  ctl.stop = () => { transport.shutdown(); link.shutdown(); };
  // Best effort, from pagehide: tell the peer we're leaving.
  ctl.bye = () => { if (transport !== link) transport.bye(); link.bye(); };
  ctl.cancel = async () => {
    try { await transport.send({ t: "cancel" }); } catch {}
    await end();
  };
  // Graceful end: the last message we sent must reach the peer before
  // the tunnel goes away.
  const end = async () => {
    if (transport !== link) await transport.finish();
    await link.finish();
  };
  const n = chunkCount(file.size);
  try {
    await link.send({
      t: "hello", v: PROTOCOL_VERSION, id: state.id, mode: state.m,
      name: file.name, size: file.size, type: file.type, chunkSize: CHUNK,
    });
    const resume = await link.nextOf("resume", "nospace");
    if (resume.t === "nospace") throw new NoSpaceError(NOSPACE_SENDER);
    if (resume.id !== state.id) throw new FatalError("receiver is on a different transfer");
    let from = Number.isInteger(resume.fromChunk) && resume.fromChunk >= 0 && resume.fromChunk <= n ? resume.fromChunk : 0;
    if (from > 0 && hex(await hashes.get(from - 1)) !== resume.prevHash) from = 0;
    await link.send({ t: "start", fromChunk: from });

    const effective = effectiveMode(state.m, resume.mode);
    onStatus({ phase: "negotiated", effective, peerMode: resume.mode, fromChunk: from });

    if (effective === "performance") {
      try {
        const { pc, dc } = await rtc.connect({
          localMode: state.m, effectiveMode: effective, offerer: true,
          signal: link.signal(), iceServers, timeoutMs: iceTimeoutMs,
        });
        transport = new RtcTransport(pc, dc, chunkLenFor(file.size));
      } catch (err) {
        console.info("direct connection failed, using relay:", err.message);
      }
    }
    await link.send({ t: "transport", via: transport.via });
    onStatus({ phase: "transport", via: transport.via });

    // Acks, completion and cancellation arrive on the transport while
    // we send; a small state machine shared with the send loop.
    let acked = from;
    let complete = null;
    let failure = null;
    let wake = null;
    const notify = () => { const w = wake; wake = null; w?.(); };
    (async () => {
      try {
        while (!complete) {
          const ev = await transport.nextEvent();
          if (ev.kind !== "control") throw new Error("unexpected data from receiver");
          const m = ev.msg;
          if (m.t === "ack" && Number.isInteger(m.idx)) {
            acked = Math.max(acked, m.idx + 1);
            onProgress(Math.min(file.size, acked * CHUNK));
          } else if (m.t === "complete") {
            complete = m;
          } else if (m.t === "cancel") {
            throw new CancelledError("The recipient cancelled the transfer.");
          } else if (m.t === "nospace") {
            throw new NoSpaceError(NOSPACE_SENDER);
          }
          notify();
        }
      } catch (err) {
        failure = err;
        notify();
        // The send loop may be blocked in a write the peer will never
        // read (it stopped after cancelling). Tear down to unblock it.
        if (err instanceof FatalError) ctl.stop?.();
      }
    })();
    const until = async (cond) => {
      while (!cond()) {
        if (failure) throw failure;
        await new Promise((r) => { wake = r; });
      }
    };

    onProgress(Math.min(file.size, from * CHUNK));
    try {
      for (let i = from; i < n; i++) {
        await until(() => i - acked < WINDOW);
        const bytes = await readChunk(file, i);
        hashes.set(i, await sha256(bytes));
        await transport.sendChunk(i, bytes);
      }
      await until(() => acked >= n);
    } catch (err) {
      // A peer that cancels then closes makes our writes fail, possibly
      // before the reader got to the queued cancel. Its reason wins.
      await new Promise((r) => setTimeout(r, 100));
      if (failure instanceof FatalError) throw failure;
      throw err;
    }
    onStatus({ phase: "verifying" });
    await transport.send({ t: "done", root: await hashes.root(n) });
    await until(() => complete);
    if (!complete.ok) throw new FatalError("The file didn't reach the recipient intact, so it was discarded. Ask them to try again.");
    return { via: transport.via };
  } finally {
    ctl.stop = ctl.cancel = null;
    if (transport !== link) transport.shutdown();
    link.shutdown();
  }
}

/**
 * Receiver side of one dialed connection. Resolves with {hello, via}
 * once the file is complete and verified in storage; rejects on a
 * dropped connection (caller redials) or with FatalError.
 */
export async function receiverSession(conn, { state, iceServers, iceTimeoutMs, onStatus, onProgress, ctl }) {
  const link = new Link(conn);
  let transport = link;
  // ctl lets the page stop this session, or cancel it (telling the peer).
  ctl.stop = () => { transport.shutdown(); link.shutdown(); };
  // Best effort, from pagehide: tell the peer we're leaving.
  ctl.bye = () => { if (transport !== link) transport.bye(); link.bye(); };
  ctl.cancel = async () => {
    try { await transport.send({ t: "cancel" }); } catch {}
    await end();
  };
  // Graceful end: the last message we sent must reach the peer before
  // the tunnel goes away.
  const end = async () => {
    if (transport !== link) await transport.finish();
    await link.finish();
  };
  try {
    const hello = await link.next("hello");
    if (hello.v !== PROTOCOL_VERSION) throw new FatalError("The sender is using a different version of fileporter. Ask them to open fileporter again and send you a new link.");
    if (hello.id !== state.id) throw new FatalError("This link is for a different transfer. Ask the sender for a new link.");
    if (hello.chunkSize !== CHUNK || !Number.isSafeInteger(hello.size) || hello.size < 0) throw new FatalError("Something went wrong with the sender's file details. Ask them for a new link.");

    const info = { name: String(hello.name || "download"), size: hello.size, type: String(hello.type || ""), chunkSize: CHUNK };
    const st = await storage.open(state.id, info);
    const n = chunkCount(hello.size);
    const { usage, quota } = await storage.estimate();
    const need = hello.size - st.chunks * CHUNK;
    if (quota && quota - usage < need) {
      throw new NoSpaceError(`This device doesn't have enough storage space for this file (it needs ${fmtBytes(need)}; ${fmtBytes(quota - usage)} is available). Free up some space, then try again.`);
    }
    onStatus({ phase: "hello", hello });

    // Our fragment is authoritative for the mode we agreed to; a sender
    // claiming something weaker now doesn't change it.
    const senderMode = effectiveMode(state.sm, hello.mode);
    await link.send({ t: "resume", id: state.id, mode: state.rm, fromChunk: st.chunks, prevHash: st.lastHash });
    const { fromChunk } = await link.next("start");
    if (!Number.isInteger(fromChunk) || fromChunk < 0 || fromChunk > st.chunks) throw new Error("bad start");
    if (fromChunk !== st.chunks) await storage.truncate(state.id, fromChunk);

    const effective = effectiveMode(senderMode, state.rm);
    onStatus({ phase: "negotiated", effective, peerMode: senderMode, fromChunk });

    let attempt = null;
    if (effective === "performance") {
      attempt = rtc.connect({
        localMode: state.rm, effectiveMode: effective, offerer: false,
        signal: link.signal(), iceServers, timeoutMs: iceTimeoutMs + 5000,
      });
      attempt.catch(() => {}); // the sender's transport decision is what counts
    }
    const { via } = await link.next("transport");
    if (via === "rtc") {
      if (!attempt) throw new FatalError("The sender tried to connect directly, but you chose Private. The transfer was stopped to keep your IP address hidden.");
      const { pc, dc } = await attempt;
      transport = new RtcTransport(pc, dc, chunkLenFor(hello.size));
    } else {
      attempt?.then(({ pc }) => pc.close(), () => {});
    }
    onStatus({ phase: "transport", via });

    let have = fromChunk;
    onProgress(Math.min(hello.size, have * CHUNK));
    while (have < n) {
      const ev = await transport.nextEvent();
      if (ev.kind === "control") {
        if (ev.msg.t === "cancel") throw new CancelledError("The sender cancelled the transfer.");
        continue;
      }
      if (ev.idx !== have) throw new Error(`chunk ${ev.idx} out of order (want ${have})`);
      await storage.write(state.id, ev.idx, ev.bytes);
      have++;
      await transport.send({ t: "ack", idx: ev.idx });
      onProgress(Math.min(hello.size, have * CHUNK));
    }

    onStatus({ phase: "verifying" });
    const done = await transport.next("done");
    const root = await storage.root(state.id);
    const ok = root === done.root;
    if (!ok) {
      await storage.reset(state.id);
      await transport.send({ t: "complete", ok, root }).catch(() => {});
      await end();
      throw new FatalError("The file didn't arrive intact, so it was discarded. Try again to receive it once more.");
    }
    // Mark complete before telling the sender, so a crash in between
    // can't leave us without the file while the sender thinks it's done.
    await storage.complete(state.id);
    await transport.send({ t: "complete", ok, root });
    await end();
    return { hello, via };
  } catch (err) {
    // Storage full, whether caught up front or by a failing write:
    // final for this session (redialing would just fail again), but
    // what's stored is kept so freeing space and retrying resumes.
    if (!(err instanceof NoSpaceError) && !isQuotaError(err)) throw err;
    try {
      await transport.send({ t: "nospace" });
      await end();
    } catch {}
    throw err instanceof NoSpaceError ? err
      : new NoSpaceError("This device ran out of storage space. Free up some space, then try again to continue where you left off.");
  } finally {
    ctl.stop = ctl.cancel = null;
    if (transport !== link) transport.shutdown();
    link.shutdown();
  }
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let u = -1;
  do { n /= 1024; u++; } while (n >= 1024 && u < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[u]}`;
}

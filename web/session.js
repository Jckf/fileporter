// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// Transfer protocol. All messages before the transport is chosen go
// over the tailcat Link (relay); after that, over the chosen transport.
//
//   S→R {t:"hello", v, id, mode, name, size, type, chunkSize}
//   R→S {t:"resume", id, mode, fromChunk, prevHash, lanes?}
//         prevHash = SHA-256 of chunk fromChunk-1 as the receiver stored it
//         lanes: how many peer connections the receiver accepts (absent
//         from receivers that predate lanes: then just one)
//   S→R {t:"start", fromChunk, turn?}
//         the sender's answer: fromChunk, or 0 if prevHash doesn't match
//         its file (the file changed between sessions). turn: the
//         sender's own TURN servers (turn.js), only when both sides
//         chose performance; the receiver ignores it otherwise
//   … mode negotiation: privacy if either side chose privacy; only in
//     performance mode: {t:"rtc"/"ice"} signaling over the Link …
//   S→R {t:"transport", via:"rtc"|"relay"}               (sender decides)
//   … if the direct connection goes through a TURN relay: the sender
//     opens more peer connections ("lanes", transport.js), signaled
//     like the first but marked {l} (rtc.signalLanes), and uses each
//     as it comes up. Chunks may then arrive out of order …
//   S→R chunk i … (at most windowFor(transport) unacknowledged)
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
import * as turn from "./turn.js";

export const PROTOCOL_VERSION = 1;
export const CHUNK = 1 << 20;
const WINDOW = 8;
// Peer connections for a relayed direct connection (see transport.js:
// one manages ~10 Mbit/s through a relay; eight, ~80), and the
// unacknowledged chunks allowed per lane, so each keeps one in flight
// while the others' acks come back.
const LANES = 8;
const WINDOW_PER_LANE = 3;
const windowFor = (transport) => Math.max(WINDOW, WINDOW_PER_LANE * (transport.lanes?.length || 1));
// How far ahead of the next chunk it needs the receiver holds chunks
// that arrived early on another lane.
const MAX_AHEAD = WINDOW_PER_LANE * LANES * 2;
// The receiver keeps trying to connect directly this much longer than
// the sender, so its attempt is still alive when the sender's decision
// (the "transport" message, sent once the sender's own attempt ended)
// arrives.
const RECEIVER_ICE_GRACE_MS = 5000;
// When sending fails, how long to let the reader catch up first: a peer
// that cancels and then closes makes our writes fail, possibly before
// the reader got to the cancel, and that reason should win.
const READER_GRACE_MS = 100;

export const chunkCount = (size) => Math.ceil(size / CHUNK);
const chunkLenFor = (size) => (idx) => Math.min(CHUNK, size - idx * CHUNK);
export const effectiveMode = (a, b) => (a === "privacy" || b === "privacy" ? "privacy" : "performance");

/** Errors that retrying won't fix. */
export class FatalError extends Error {}
/** The other side cancelled the transfer. */
export class CancelledError extends FatalError {}
/** The receiver's storage is full. Freeing space and retrying resumes. */
export class NoSpaceError extends FatalError {}
/**
 * The file won't fit in the browser's storage, but the user can make
 * room: pick a file to receive it into (see savetarget.js), or allow
 * persistent storage, which raises the limit in Firefox. Not sent to
 * the sender: to it, this is a dropped connection, and the receiver
 * redials once the user has acted.
 */
export class NeedsRoomError extends Error {
  constructor(hello) { super("needs more room"); this.hello = hello; }
}

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
 * What both sides need to end a session: fills ctl with the page's
 * handles (stop, bye, cancel) and returns end() (graceful), the abort
 * signal for peer connections still being set up, and teardown() for
 * the session's finally. current() is the transport in use: the link
 * until a direct connection takes over.
 */
function sessionControl(ctl, link, current) {
  const connecting = new AbortController();
  // Graceful end: the last message we sent must reach the peer before
  // the tunnel goes away.
  const end = async () => {
    const transport = current();
    if (transport !== link) await transport.finish();
    await link.finish();
  };
  // ctl lets the page stop this session, or cancel it (telling the peer).
  // (Also gives up on peer connections still being set up: a session
  // stopped while connecting would otherwise linger until ICE times out.)
  ctl.stop = () => { connecting.abort(); current().shutdown(); link.shutdown(); };
  // Best effort, from pagehide: tell the peer we're leaving.
  ctl.bye = () => {
    const transport = current();
    if (transport !== link) transport.bye();
    link.bye();
  };
  ctl.cancel = async () => {
    try { await current().send({ t: "cancel" }); } catch {}
    await end();
  };
  const teardown = () => {
    ctl.stop = ctl.bye = ctl.cancel = null;
    connecting.abort();
    const transport = current();
    if (transport !== link) transport.shutdown();
    link.shutdown();
  };
  return { end, connecting: connecting.signal, teardown };
}

/** Opens extra lane l; once it's up, the transport spreads chunks onto it. */
function openLane(transport, options, l) {
  rtc.connect(options).then(({ pc, dc }) => transport.addLane(pc, dc), (err) => console.info(`extra lane ${l} failed:`, err.message));
}

/**
 * Sender side of one connection from the receiver. Resolves when the
 * receiver confirmed the complete file; rejects if the connection
 * drops (the receiver will redial) or with FatalError.
 *
 * callbacks: onStatus({phase, ...}), onProgress(bytesConfirmed)
 * ctl: {} that this function fills with stop() and cancel()
 */
export async function senderSession(conn, { state, file, hashes, iceServers, turnServers = [], iceTimeoutMs, onStatus, onProgress, ctl }) {
  const link = new Link(conn);
  let transport = link;
  const { connecting, teardown } = sessionControl(ctl, link, () => transport);
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
    const effective = effectiveMode(state.m, resume.mode);
    // Our TURN servers, only where both chose performance: in privacy
    // mode only the public relays may see either side.
    const ownTurn = effective === "performance" ? turn.sanitize(turnServers) : [];
    await link.send({ t: "start", fromChunk: from, ...(ownTurn.length ? { turn: ownTurn } : {}) });

    onStatus({ phase: "negotiated", effective, peerMode: resume.mode, fromChunk: from });

    let relayed = false;
    let lanes = null;
    const rtcOptions = (l) => ({
      localMode: state.m, effectiveMode: effective, offerer: true,
      signal: lanes.lane(l), iceServers: [...iceServers, ...ownTurn], timeoutMs: iceTimeoutMs,
      abort: connecting,
    });
    if (effective === "performance") {
      lanes = rtc.signalLanes(link.signal(), LANES);
      try {
        const { pc, dc } = await rtc.connect(rtcOptions(0));
        transport = new RtcTransport(pc, dc, chunkLenFor(file.size));
        relayed = ownTurn.length > 0 && (await rtc.usesRelay(pc));
      } catch (err) {
        console.info("direct connection failed, using relay:", err.message);
      }
    }
    await link.send({ t: "transport", via: transport.via });
    onStatus({ phase: "transport", via: transport.via, turn: relayed });

    // Through a TURN relay, more lanes; the transfer starts on the
    // first and spreads out as the others come up.
    if (relayed) {
      const want = Math.min(LANES, Number.isInteger(resume.lanes) ? resume.lanes : 1);
      for (let l = 1; l < want; l++) openLane(transport, rtcOptions(l), l);
    }

    // Acks, completion and cancellation arrive on the transport while
    // we send; a small state machine shared with the send loop.
    let acked = from;
    let complete = null;
    let failure = null;
    let wake = null;
    const notify = () => { const w = wake; wake = null; w?.(); };
    const reading = (async () => {
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
        await until(() => i - acked < windowFor(transport));
        const bytes = await readChunk(file, i);
        hashes.set(i, await sha256(bytes));
        await transport.sendChunk(i, bytes);
      }
      await until(() => acked >= n);
    } catch (err) {
      await Promise.race([reading, new Promise((r) => setTimeout(r, READER_GRACE_MS))]);
      if (failure instanceof FatalError) throw failure;
      throw err;
    }
    onStatus({ phase: "verifying" });
    await transport.send({ t: "done", root: await hashes.root(n) });
    await until(() => complete);
    if (!complete.ok) throw new FatalError("The file didn't reach the recipient intact, so it was discarded. Ask them to try again.");
    return { via: transport.via };
  } finally {
    teardown();
  }
}

/**
 * Receiver side of one dialed connection. Resolves with {hello, via}
 * once the file is complete and verified in storage; rejects on a
 * dropped connection (caller redials), with NeedsRoomError, or with
 * FatalError.
 *
 * target: a picked file to receive into, or null for the browser's
 * storage. canMakeRoom: whether the user can be asked to make room
 * (NeedsRoomError) when the file doesn't fit.
 */
export async function receiverSession(conn, { state, target, canMakeRoom, iceServers, iceTimeoutMs, onStatus, onProgress, ctl }) {
  const link = new Link(conn);
  let transport = link;
  const { end, connecting, teardown } = sessionControl(ctl, link, () => transport);
  try {
    const hello = await link.next("hello");
    if (hello.v !== PROTOCOL_VERSION) throw new FatalError("The sender is using a different version of fileporter. Ask them to open fileporter again and send you a new link.");
    if (hello.id !== state.id) throw new FatalError("This link is for a different transfer. Ask the sender for a new link.");
    if (hello.chunkSize !== CHUNK || !Number.isSafeInteger(hello.size) || hello.size < 0) throw new FatalError("Something went wrong with the sender's file details. Ask them for a new link.");

    const info = { name: String(hello.name || "download"), size: hello.size, type: String(hello.type || ""), chunkSize: CHUNK };
    onStatus({ phase: "hello", hello });
    const st = await storage.open(state.id, info, target);
    const n = chunkCount(hello.size);
    const { usage, quota } = await storage.estimate();
    const need = hello.size - st.chunks * CHUNK;
    if (!target && quota && quota - usage < need) {
      if (canMakeRoom) throw new NeedsRoomError(hello);
      throw new NoSpaceError(`This device doesn't have enough storage space for this file (it needs ${fmtBytes(need)}; ${fmtBytes(quota - usage)} is available). Free up some space, then try again.`);
    }

    // Our fragment is authoritative for the mode we agreed to; a sender
    // claiming something weaker now doesn't change it.
    const senderMode = effectiveMode(state.sm, hello.mode);
    await link.send({
      t: "resume", id: state.id, mode: state.rm, fromChunk: st.chunks, prevHash: st.lastHash,
      ...(state.rm === "performance" ? { lanes: LANES } : {}),
    });
    const { fromChunk, turn: senderTurn } = await link.next("start");
    if (!Number.isInteger(fromChunk) || fromChunk < 0 || fromChunk > st.chunks) throw new Error("bad start");
    // A file we already have in full is only ever finished, not received
    // again: the sender starting over means its file changed.
    if (st.status === "complete" && fromChunk !== st.chunks) throw new FatalError("The sender's file has changed since you received it. Ask them for a new link.");
    if (fromChunk !== st.chunks) await storage.truncate(state.id, fromChunk);

    const effective = effectiveMode(senderMode, state.rm);
    onStatus({ phase: "negotiated", effective, peerMode: senderMode, fromChunk });

    let attempt = null;
    let lanes = null;
    // The sender's TURN servers, if any: only ever used here, where both
    // chose performance (and WebRTC is locked out otherwise anyway).
    const theirTurn = turn.sanitize(senderTurn);
    const rtcOptions = (l) => ({
      localMode: state.rm, effectiveMode: effective, offerer: false,
      signal: lanes.lane(l), iceServers: [...iceServers, ...theirTurn], timeoutMs: iceTimeoutMs + RECEIVER_ICE_GRACE_MS,
      abort: connecting,
    });
    if (effective === "performance") {
      lanes = rtc.signalLanes(link.signal(), LANES);
      attempt = rtc.connect(rtcOptions(0));
      attempt.catch(() => {}); // the sender's transport decision is what counts
    }
    const { via } = await link.next("transport");
    if (via !== "rtc" && via !== "relay") throw new Error(`unknown transport ${via}`);
    let relayed = false;
    if (via === "rtc") {
      if (!attempt) throw new FatalError("The sender tried to connect directly, but you chose Private. The transfer was stopped to keep your IP address hidden.");
      const { pc, dc } = await attempt;
      const rtcTransport = new RtcTransport(pc, dc, chunkLenFor(hello.size));
      transport = rtcTransport;
      relayed = theirTurn.length > 0 && (await rtc.usesRelay(pc));
      // More lanes, as the sender opens them (see senderSession).
      lanes.onNewLane = (l) => openLane(rtcTransport, rtcOptions(l), l);
    } else {
      attempt?.then(({ pc }) => pc.close(), () => {});
    }
    onStatus({ phase: "transport", via, turn: relayed });

    let have = fromChunk;
    // Chunks that arrived ahead of `have` on another lane.
    const early = new Map();
    onProgress(Math.min(hello.size, have * CHUNK));
    while (have < n) {
      const ev = await transport.nextEvent();
      if (ev.kind === "control") {
        if (ev.msg.t === "cancel") throw new CancelledError("The sender cancelled the transfer.");
        continue;
      }
      if (ev.idx < have || ev.idx >= Math.min(n, have + MAX_AHEAD) || early.has(ev.idx)) {
        throw new Error(`chunk ${ev.idx} out of order (want ${have})`);
      }
      early.set(ev.idx, ev.bytes);
      for (let bytes; (bytes = early.get(have)); ) {
        early.delete(have);
        await storage.write(state.id, have, bytes);
        await transport.send({ t: "ack", idx: have });
        have++;
        onProgress(Math.min(hello.size, have * CHUNK));
      }
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
    teardown();
  }
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let u = -1;
  do { n /= 1024; u++; } while (n >= 1024 && u < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[u]}`;
}

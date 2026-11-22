// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// Receiver-side storage in the Origin Private File System (OPFS).
//
// Layout: /fileporter/<transferId>/
//   data        received bytes, chunk i at offset i*CHUNK
//   hashes.bin  SHA-256 of each persisted chunk, 32 bytes per chunk
//   meta.json   {v, id, name, size, type, chunkSize, status, createdAt, lastActive}
//
// Durability: FileSystemSyncAccessHandle (worker-only) writes in place;
// flush() makes them durable. Each chunk is written data → flush →
// hash → flush, so hashes.bin never claims a chunk whose bytes aren't
// on disk. The resume point is min(chunks in hashes.bin, whole chunks
// in data); anything past it is truncated on open.
//
// Older Safari versions return promises from sync-handle methods, so
// every call is awaited.
//
// Direct mode (see savetarget.js): the data goes to a file the user
// picked instead, and only hashes.bin and meta.json live here. Writes
// to such a file go through a FileSystemWritableFileStream, which in
// Chromium writes to a temporary copy and only replaces the file on
// close(). So "on disk" there means committed: hashes.bin can run ahead
// of the file, and settle() takes the smaller of the two as usual.
// Reopening a stream copies the file first, so commits are spaced out
// (see COMMIT_MIN); a crash loses at most the uncommitted part.
//
// Cleanup is driven by the page (cancel, confirmed save) and by
// sweep(): a directory is deleted only when no tab holds its Web Lock
// AND its lastActive heartbeat is older than the grace period, so a
// reload, a second tab or a crash-and-reopen never loses data that is
// still needed for a resume.
"use strict";

const ROOT = "fileporter";
const HEARTBEAT_MS = 30_000;
const COMMIT_MIN = 512 * 1024 * 1024; // commit when this, and as much as is committed, is pending
const transfers = new Map(); // open transfers: id → {dir, data, hashes, meta: handle, metaObj, target, w, wSize, committed}
let writeLimit = 0; // testing only (?writelimit): simulated full disk
let commitEvery = 0; // testing only (?commit): commit this often instead

async function rootDir() {
  return (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT, { create: true });
}

const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
const enc = new TextEncoder();

// Rewrites meta.json in place without ever leaving it unparseable: an
// empty or cut-off meta.json reads as "no transfer here", which would
// throw away the partial download (open) or its folder (sweep). So no
// truncating first: a shorter new text is padded with spaces to the old
// length (JSON.parse ignores trailing whitespace), and trimmed only
// once it's safely written.
async function writeMeta(st) {
  st.metaObj.lastActive = Date.now();
  const json = enc.encode(JSON.stringify(st.metaObj));
  const old = await st.meta.getSize();
  let bytes = json;
  if (old > json.length) {
    bytes = new Uint8Array(old).fill(0x20);
    bytes.set(json);
  }
  await st.meta.write(bytes, { at: 0 });
  await st.meta.flush();
  if (old > json.length) {
    await st.meta.truncate(json.length);
    await st.meta.flush();
  }
}

async function readMetaHandle(h) {
  const size = await h.getSize();
  if (!size) return null;
  const buf = new Uint8Array(size);
  await h.read(buf, { at: 0 });
  try { return JSON.parse(new TextDecoder().decode(buf)); } catch { return null; }
}

async function closeHandles(st, which = ["data", "hashes", "meta"]) {
  if (st.w && which.includes("data")) {
    try { await st.w.abort(); } catch {}
    st.w = null;
  }
  for (const k of which) {
    if (st[k]) {
      try { await st[k].close(); } catch {}
      st[k] = null;
    }
  }
}

async function syncHandle(dir, name) {
  const fh = await dir.getFileHandle(name, { create: true });
  return fh.createSyncAccessHandle();
}

// The data file, in OPFS (a sync handle in st.data) or the picked file
// (st.target, written through st.w while open).

async function dataSize(st) {
  if (!st.target) return st.data.getSize();
  if (st.w) return st.wSize;
  return (await st.target.getFile()).size;
}

async function writable(st) {
  if (!st.w) {
    st.committed = (await st.target.getFile()).size;
    st.w = await st.target.createWritable({ keepExistingData: true });
    st.wSize = st.committed;
  }
  return st.w;
}

async function dataWrite(st, bytes, at) {
  if (!st.target) {
    await st.data.write(bytes, { at });
    await st.data.flush();
    return;
  }
  const w = await writable(st);
  await w.write({ type: "write", position: at, data: bytes });
  st.wSize = Math.max(st.wSize, at + bytes.length);
  const pending = st.wSize - st.committed;
  if (commitEvery ? pending >= commitEvery : pending >= COMMIT_MIN && pending >= st.committed) await commit(st);
}

async function dataTruncate(st, size) {
  if (!st.target) {
    await st.data.truncate(size);
    await st.data.flush();
    return;
  }
  if ((await dataSize(st)) === size) return;
  await (await writable(st)).truncate(size);
  st.wSize = size;
}

/** Puts what was written into the picked file. */
async function commit(st) {
  if (!st.w) return;
  const w = st.w;
  st.w = null;
  await w.close();
  st.committed = st.wSize;
}

/** Number of chunks safely on disk; truncates any partial tail. */
async function settle(st) {
  const { size, chunkSize } = st.metaObj;
  const total = Math.ceil(size / chunkSize);
  const bytes = await dataSize(st);
  const hashCount = Math.floor((await st.hashes.getSize()) / 32);
  const dataChunks = bytes >= size ? total : Math.floor(bytes / chunkSize);
  const n = Math.min(hashCount, dataChunks, total);
  await truncateTo(st, n);
  return n;
}

async function truncateTo(st, n) {
  const { size, chunkSize } = st.metaObj;
  await dataTruncate(st, Math.min(size, n * chunkSize));
  await st.hashes.truncate(n * 32);
  await st.hashes.flush();
}

async function lastHash(st, n) {
  if (n === 0) return null;
  const h = new Uint8Array(32);
  await st.hashes.read(h, { at: (n - 1) * 32 });
  return hex(h);
}

function requireOpen(id) {
  const st = transfers.get(id);
  if (!st) throw new Error(`transfer ${id} is not open`);
  return st;
}

const ops = {
  /**
   * Whether OPFS is actually usable here, not just present: private
   * windows may expose the API but throw on use (WebKit, for one, throws
   * UnknownError). Opens
   * a sync access handle on a uniquely named file (so concurrent tabs
   * don't contend for the same exclusive handle) and removes it.
   */
  async probe() {
    let dir = null;
    const name = `.probe-${crypto.randomUUID()}`;
    try {
      dir = await rootDir();
      const fh = await dir.getFileHandle(name, { create: true });
      const h = await fh.createSyncAccessHandle();
      await h.write(new Uint8Array(1), { at: 0 });
      await h.flush();
      await h.close();
      return true;
    } catch (err) {
      console.warn(`storage probe failed: ${err?.name}: ${err?.message}`);
      return false;
    } finally {
      if (dir) try { await dir.removeEntry(name); } catch {}
    }
  },

  /** Probe without creating: {exists, meta|null}. */
  async peek({ id }) {
    try {
      const dir = await (await rootDir()).getDirectoryHandle(id);
      const f = await (await dir.getFileHandle("meta.json")).getFile();
      return { exists: true, meta: JSON.parse(await f.text()) };
    } catch {
      return { exists: false, meta: null };
    }
  },

  /**
   * Opens (creating if needed) the transfer for {name, size, type,
   * chunkSize}, writing the data to `target` (a picked file) if given.
   * If stored metadata describes a different file, or the data was
   * going elsewhere, the partial data is discarded. Returns {chunks,
   * lastHash, status}.
   */
  async open({ id, info, target = null }) {
    let st = transfers.get(id);
    if (!st) {
      const dir = await (await rootDir()).getDirectoryHandle(id, { create: true });
      st = { dir, data: null, hashes: null, meta: null, metaObj: null };
      st.meta = await syncHandle(dir, "meta.json");
      st.metaObj = await readMetaHandle(st.meta);
      transfers.set(id, st);
    }
    if (target && !(st.target && (await st.target.isSameEntry(target)))) {
      await closeHandles(st, ["data"]);
      st.target = target;
    }
    const m = st.metaObj;
    const same = m && m.size === info.size && m.name === info.name && m.chunkSize === info.chunkSize &&
      !!m.direct === !!target;
    if (!same) {
      st.metaObj = { v: 1, id, ...info, direct: !!target, status: "receiving", createdAt: Date.now(), lastActive: Date.now() };
    }
    if (st.metaObj.status === "complete") {
      // Data is final; its handle stays closed so the page can read it.
      // The hashes stay readable: a sender that never heard "complete"
      // (the connection dropped just then) resumes at the end, which
      // needs the last chunk's hash, and checks the root again.
      await closeHandles(st, ["data"]);
      if (!st.hashes) st.hashes = await syncHandle(st.dir, "hashes.bin");
      await writeMeta(st);
      const n = Math.ceil(st.metaObj.size / st.metaObj.chunkSize);
      return { chunks: n, lastHash: await lastHash(st, n), status: "complete" };
    }
    if (!st.data && !st.target) st.data = await syncHandle(st.dir, "data");
    if (!st.hashes) st.hashes = await syncHandle(st.dir, "hashes.bin");
    if (!same) await truncateTo(st, 0);
    await writeMeta(st);
    const n = await settle(st);
    return { chunks: n, lastHash: await lastHash(st, n), status: st.metaObj.status };
  },

  async truncate({ id, chunks }) {
    const st = requireOpen(id);
    await truncateTo(st, chunks);
  },

  /** Persists chunk idx, which must be the next one. */
  async write({ id, idx, data }) {
    const st = requireOpen(id);
    const bytes = new Uint8Array(data);
    const { size, chunkSize } = st.metaObj;
    const expectLen = Math.min(chunkSize, size - idx * chunkSize);
    if (bytes.length !== expectLen) throw new Error(`chunk ${idx}: got ${bytes.length} bytes, want ${expectLen}`);
    const have = Math.floor((await st.hashes.getSize()) / 32);
    if (idx !== have) throw new Error(`chunk ${idx} out of order (have ${have})`);
    if (writeLimit && idx * chunkSize + bytes.length > writeLimit) {
      throw new DOMException("Simulated full storage (?writelimit)", "QuotaExceededError");
    }
    const hash = await sha256(bytes);
    await dataWrite(st, bytes, idx * chunkSize);
    await st.hashes.write(hash, { at: idx * 32 });
    await st.hashes.flush();
  },

  /** SHA-256 over the concatenated chunk hashes, hex. */
  async root({ id }) {
    const st = requireOpen(id);
    const n = Math.floor((await st.hashes.getSize()) / 32);
    const all = new Uint8Array(n * 32);
    if (n) await st.hashes.read(all, { at: 0 });
    return hex(await sha256(all));
  },

  /** Marks the transfer complete and releases the data for reading. */
  async complete({ id }) {
    const st = requireOpen(id);
    if (st.target) await commit(st);
    st.metaObj.status = "complete";
    await writeMeta(st);
    await closeHandles(st, ["data", "hashes"]);
  },

  /** Discards partial data (e.g. checksum mismatch), keeping the transfer. */
  async reset({ id }) {
    const st = requireOpen(id);
    st.metaObj.status = "receiving";
    await truncateTo(st, 0);
    await writeMeta(st);
  },

  async remove({ id }) {
    const st = transfers.get(id);
    if (st) {
      await closeHandles(st);
      transfers.delete(id);
    }
    try {
      await (await rootDir()).removeEntry(id, { recursive: true });
    } catch (err) {
      if (err.name !== "NotFoundError") throw err;
    }
  },

  /**
   * Deletes abandoned transfers: not `keep`, no tab holds their lock,
   * and lastActive older than graceMs. Returns the removed ids.
   */
  async sweep({ keep, graceMs }) {
    const root = await rootDir();
    const held = new Set(((await navigator.locks.query()).held || []).map((l) => l.name));
    const removed = [];
    for await (const [name, handle] of root.entries()) {
      if (handle.kind !== "directory" || name === keep || transfers.has(name)) continue;
      if (held.has(`fileporter:${name}`)) continue;
      let lastActive = 0;
      try {
        const f = await (await handle.getFileHandle("meta.json")).getFile();
        lastActive = JSON.parse(await f.text()).lastActive || 0;
      } catch (err) {
        // No readable meta: either half-created long ago, or another
        // tab has it open right now. Only delete if it isn't busy.
        if (err.name === "NoModificationAllowedError" || err.name === "InvalidStateError") continue;
      }
      if (Date.now() - lastActive < graceMs) continue;
      try {
        await root.removeEntry(name, { recursive: true });
        removed.push(name);
      } catch {
        // Busy (open in another tab) or already gone: try next sweep.
      }
    }
    return removed;
  },

  /** Testing only. */
  async configure(args) {
    writeLimit = args.writeLimit || 0;
    commitEvery = args.commitEvery || 0;
  },

  async estimate() {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota };
  },
};

// Calls (and heartbeats) are processed one at a time, in order: sync
// access handles must not be used concurrently.
let chain = Promise.resolve();

setInterval(() => {
  chain = chain.then(async () => {
    for (const st of transfers.values()) {
      try { if (st.meta) await writeMeta(st); } catch {}
    }
  });
}, HEARTBEAT_MS);

self.onmessage = ({ data: m }) => {
  chain = chain.then(async () => {
    try {
      const f = ops[m.op];
      if (!f) throw new Error(`unknown op ${m.op}`);
      self.postMessage({ id: m.id, ok: true, value: await f(m.args || {}) });
    } catch (err) {
      self.postMessage({ id: m.id, ok: false, error: String(err && err.message || err), name: err && err.name });
    }
  });
};

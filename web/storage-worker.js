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
// Cleanup is driven by the page (cancel, confirmed save) and by
// sweep(): a directory is deleted only when no tab holds its Web Lock
// AND its lastActive heartbeat is older than the grace period, so a
// reload, a second tab or a crash-and-reopen never loses data that is
// still needed for a resume.
"use strict";

const ROOT = "fileporter";
const HEARTBEAT_MS = 30_000;
const open = new Map(); // id → {dir, data, hashes, meta: handle, metaObj, chunkSize}

async function rootDir() {
  return (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT, { create: true });
}

const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
const enc = new TextEncoder();

async function writeMeta(st) {
  st.metaObj.lastActive = Date.now();
  const bytes = enc.encode(JSON.stringify(st.metaObj));
  await st.meta.truncate(0);
  await st.meta.write(bytes, { at: 0 });
  await st.meta.flush();
}

async function readMetaHandle(h) {
  const size = await h.getSize();
  if (!size) return null;
  const buf = new Uint8Array(size);
  await h.read(buf, { at: 0 });
  try { return JSON.parse(new TextDecoder().decode(buf)); } catch { return null; }
}

async function closeHandles(st, which = ["data", "hashes", "meta"]) {
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

/** Number of chunks safely on disk; truncates any partial tail. */
async function settle(st) {
  const { size, chunkSize } = st.metaObj;
  const total = Math.ceil(size / chunkSize);
  const dataSize = await st.data.getSize();
  const hashCount = Math.floor((await st.hashes.getSize()) / 32);
  const dataChunks = dataSize >= size ? total : Math.floor(dataSize / chunkSize);
  const n = Math.min(hashCount, dataChunks, total);
  await truncateTo(st, n);
  return n;
}

async function truncateTo(st, n) {
  const { size, chunkSize } = st.metaObj;
  await st.data.truncate(Math.min(size, n * chunkSize));
  await st.data.flush();
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
  const st = open.get(id);
  if (!st) throw new Error(`transfer ${id} is not open`);
  return st;
}

const ops = {
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
   * chunkSize}. If stored metadata describes a different file, the
   * partial data is discarded. Returns {chunks, lastHash, status}.
   */
  async open({ id, info }) {
    let st = open.get(id);
    if (!st) {
      const dir = await (await rootDir()).getDirectoryHandle(id, { create: true });
      st = { dir, data: null, hashes: null, meta: null, metaObj: null };
      st.meta = await syncHandle(dir, "meta.json");
      st.metaObj = await readMetaHandle(st.meta);
      open.set(id, st);
    }
    const m = st.metaObj;
    const same = m && m.size === info.size && m.name === info.name && m.chunkSize === info.chunkSize;
    if (!same) {
      st.metaObj = { v: 1, id, ...info, status: "receiving", createdAt: Date.now(), lastActive: Date.now() };
    }
    if (st.metaObj.status === "complete") {
      // Data is final; keep handles closed so the page can read it.
      await closeHandles(st, ["data", "hashes"]);
      await writeMeta(st);
      return { chunks: Math.ceil(st.metaObj.size / st.metaObj.chunkSize), lastHash: null, status: "complete" };
    }
    if (!st.data) st.data = await syncHandle(st.dir, "data");
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
    const hash = await sha256(bytes);
    await st.data.write(bytes, { at: idx * chunkSize });
    await st.data.flush();
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
    const st = open.get(id);
    if (st) {
      await closeHandles(st);
      open.delete(id);
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
      if (handle.kind !== "directory" || name === keep || open.has(name)) continue;
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

  async estimate() {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota };
  },
};

setInterval(async () => {
  for (const st of open.values()) {
    try { if (st.meta) await writeMeta(st); } catch {}
  }
}, HEARTBEAT_MS);

// Calls are processed one at a time, in order: sync access handles
// must not be used concurrently.
let chain = Promise.resolve();
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

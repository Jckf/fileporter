// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page-side proxy for the engine worker. Importing this module starts
// the engine download immediately in the background; nothing else on
// the page depends on it until a session starts.

// Resolved against this module, not the page: the build puts all
// assets in a versioned directory (see cmd/build).
const worker = new Worker(new URL("engine-worker.js", import.meta.url));
const pending = new Map();
const incomingHandlers = new Map(); // listenerId → (Conn) => void
const progressHandlers = new Set();
let nextId = 1;

let resolveReady, rejectReady;
export const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
// Keep an unobserved rejection from being reported as unhandled; the
// UI observes failures through onProgress.
ready.catch(() => {});

/** Subscribe to load state: {state:"loading"|"retrying"|"ready"|"error", loaded?, total?, error?} */
export function onProgress(fn) {
  progressHandlers.add(fn);
  return () => progressHandlers.delete(fn);
}
const emit = (s) => progressHandlers.forEach((fn) => fn(s));

worker.onmessage = ({ data: m }) => {
  switch (m.op) {
    case "progress": emit({ state: "loading", loaded: m.loaded, total: m.total }); break;
    case "retrying": emit({ state: "retrying", error: m.error, attempt: m.attempt }); break;
    case "ready": emit({ state: "ready" }); resolveReady(); break;
    case "loadError": emit({ state: "error", error: m.error }); rejectReady(new Error(m.error)); break;
    case "incoming": incomingHandlers.get(m.listenerId)?.(new Conn(m.connId, m.port)); break;
    case "result": {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (!p) return;
      m.ok ? p.resolve(m.value) : p.reject(new Error(m.error));
      break;
    }
  }
};
worker.onerror = (e) => {
  emit({ state: "error", error: e.message });
  rejectReady(new Error(e.message));
};

function rpc(msg, transfer) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id }, transfer || []);
  });
}

// Start the download as soon as the module is evaluated.
worker.postMessage({ op: "load", manifestURL: new URL("engine-manifest.json", import.meta.url).href });

/** A tunneled TCP stream living in the worker. Same shape as tailcat's JS conn. */
export class Conn {
  constructor(connId, port) { this.connId = connId; this.port = port; this.closed = false; }
  read() { return rpc({ op: "conn", connId: this.connId, method: "read" }); }
  /**
   * Writes u8. The bytes are transferred to the worker: by default a
   * copy, so the caller keeps its buffer; with {owned: true} the
   * caller gives up u8's whole buffer and no copy is made.
   */
  write(u8, { owned = false } = {}) {
    const whole = u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength;
    const buf = owned && whole ? u8.buffer : u8.slice().buffer;
    return rpc({ op: "conn", connId: this.connId, method: "write", data: buf }, [buf]);
  }
  closeWrite() { return rpc({ op: "conn", connId: this.connId, method: "closeWrite" }); }
  close() {
    if (this.closed) return;
    this.closed = true;
    rpc({ op: "conn", connId: this.connId, method: "close" }).catch(() => {});
  }
}

const call = async (fn, args) => { await ready; return rpc({ op: "call", fn, args }); };

export const newSession = (args) => call("newSession", args);

/** Returns {addr, close()}; onConnection receives Conn objects. */
export async function listen(args, onConnection) {
  const { listenerId, addr, region } = await call("listen", args);
  incomingHandlers.set(listenerId, onConnection);
  return {
    addr,
    region, // the relay's code, e.g. "fra" (diagnostics)
    close() {
      incomingHandlers.delete(listenerId);
      call("closeListener", { listenerId }).catch(() => {});
    },
  };
}

export async function dial(args) {
  const { connId, port, region } = await call("dial", args);
  const c = new Conn(connId, port);
  c.region = region; // the relay's code, e.g. "fra" (diagnostics)
  return c;
}

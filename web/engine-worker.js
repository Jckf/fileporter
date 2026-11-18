// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// Dedicated worker hosting the Go/WASM engine (cmd/engine).
//
// Protocol (all messages are plain objects):
//   page → worker
//     {op:"load", manifestURL}
//     {op:"call", id, fn:"newSession"|"listen"|"dial"|"closeListener", args}
//     {op:"conn", id, connId, method:"read"|"write"|"closeWrite"|"close", data?}
//   worker → page
//     {op:"progress", loaded, total}
//     {op:"retrying", attempt, error}
//     {op:"ready"} | {op:"loadError", error}
//     {op:"result", id, ok, value?, error?}
//     {op:"incoming", listenerId, connId, port}
//
// Byte payloads cross the boundary as transferred ArrayBuffers.
"use strict";

importScripts("wasm_exec.js");

const conns = new Map();     // connId → Go conn object
const listeners = new Map(); // listenerId → Go listener object
let nextId = 1;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

// --- Loading -------------------------------------------------------------

async function fetchVerified(manifest) {
  // fetch() with an `integrity` option only resolves after the whole
  // body is downloaded, which defeats the progress bar. So we stream
  // the body ourselves, then check SHA-384 against the manifest before
  // touching the bytes.
  const resp = await fetch(manifest.url, { cache: "default" });
  if (!resp.ok) throw new Error(`fetching ${manifest.url}: HTTP ${resp.status}`);
  const total = manifest.size || Number(resp.headers.get("Content-Length")) || 0;
  const reader = resp.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    post({ op: "progress", loaded, total });
  }
  const gz = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { gz.set(c, off); off += c.byteLength; }

  const [alg, want] = manifest.integrity.split("-", 2);
  if (alg !== "sha384") throw new Error(`unsupported integrity algorithm ${alg}`);
  const got = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-384", gz))));
  if (got !== want) throw new Error("engine integrity check failed");

  const wasm = new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip")));
  return wasm.arrayBuffer();
}

async function load(manifestURL) {
  const manifest = await (await fetch(manifestURL, { cache: "no-cache" })).json();
  let bytes;
  for (let attempt = 1; ; attempt++) {
    try {
      bytes = await fetchVerified(manifest);
      break;
    } catch (err) {
      if (attempt >= 5) throw err;
      post({ op: "retrying", attempt, error: String(err.message || err) });
      await new Promise((r) => setTimeout(r, Math.min(30000, 1000 * 2 ** attempt)));
    }
  }
  const ready = new Promise((resolve) => { self.onEngineReady = resolve; });
  const go = new Go();
  const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
  go.run(instance); // resolves only when the Go program exits; never awaited
  await ready;
}

// --- Calls ---------------------------------------------------------------

function registerConn(c) {
  const connId = nextId++;
  conns.set(connId, c);
  return connId;
}

const calls = {
  async newSession(args) {
    const s = await self.tsNewSession(args);
    return { senderKey: s.senderKey, addr: s.addr, receiverKey: s.receiverKey, receiverPub: s.receiverPub };
  },
  async listen(args) {
    const listenerId = nextId++;
    const ln = await self.tsListen({
      ...args,
      onConnection: (c) => post({ op: "incoming", listenerId, connId: registerConn(c), port: c.port }),
    });
    listeners.set(listenerId, ln);
    return { listenerId, addr: ln.addr };
  },
  async dial(args) {
    const c = await self.tsDial(args);
    return { connId: registerConn(c), port: c.port };
  },
  async closeListener({ listenerId }) {
    listeners.get(listenerId)?.close();
    listeners.delete(listenerId);
  },
};

async function connOp(connId, method, data) {
  const c = conns.get(connId);
  if (!c) throw new Error("connection closed");
  switch (method) {
    case "read": {
      const u8 = await c.read();
      return u8; // Uint8Array or null
    }
    case "write":
      await c.write(new Uint8Array(data));
      return undefined;
    case "closeWrite":
      await c.closeWrite();
      return undefined;
    case "close":
      c.close();
      conns.delete(connId);
      return undefined;
  }
  throw new Error(`unknown conn method ${method}`);
}

function reply(id, p) {
  p.then(
    (value) => {
      const transfer = value instanceof Uint8Array ? [value.buffer] : [];
      post({ op: "result", id, ok: true, value }, transfer);
    },
    (err) => post({ op: "result", id, ok: false, error: String(err && err.message || err) }),
  );
}

self.onmessage = ({ data: m }) => {
  switch (m.op) {
    case "load":
      load(m.manifestURL).then(
        () => post({ op: "ready" }),
        (err) => post({ op: "loadError", error: String(err.message || err) }),
      );
      break;
    case "call":
      reply(m.id, Promise.resolve().then(() => {
        const f = calls[m.fn];
        if (!f) throw new Error(`unknown call ${m.fn}`);
        return f(m.args || {});
      }));
      break;
    case "conn":
      reply(m.id, Promise.resolve().then(() => connOp(m.connId, m.method, m.data)));
      break;
  }
};

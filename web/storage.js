// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page-side proxy for storage-worker.js, plus the pieces of storage
// that must run on the page (reading the finished file, Web Locks).

import { config } from "./config.js";

let worker = null;
let failed = null; // set if the worker couldn't start; every call rejects
const pending = new Map();
let nextId = 1;

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL("storage-worker.js", import.meta.url));
    worker.onmessage = ({ data: m }) => {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (!p) return;
      if (m.ok) p.resolve(m.value);
      else {
        const err = new Error(m.error);
        err.name = m.name || "Error";
        p.reject(err);
      }
    };
    // Ops catch their own errors, so this means the worker itself
    // failed (didn't load). Fail every call rather than leave it hanging.
    worker.onerror = (e) => {
      failed = new Error(`storage worker failed: ${e.message || "could not load"}`);
      for (const p of pending.values()) p.reject(failed);
      pending.clear();
    };
  }
  return worker;
}

// Started right away, not on first use: assets are versioned and a
// deploy removes the old version, so a tab that stays open across a
// deploy must not fetch any of its files later.
getWorker();
if (config.simWriteLimit || config.commitEvery) {
  call("configure", { writeLimit: config.simWriteLimit, commitEvery: config.commitEvery }).catch(() => {});
}

function call(op, args, transfer) {
  if (failed) return Promise.reject(failed);
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, op, args }, transfer || []);
  });
}

const apisPresent = () =>
  !!(navigator.storage && navigator.storage.getDirectory && navigator.locks && globalThis.FileSystemFileHandle);

let supportedP = null;

/**
 * Resolves true if receiving can work here. Beyond checking that the
 * APIs exist, it uses OPFS for real (in the worker, where receiving
 * happens): private windows can expose the API yet refuse to use it.
 * Memoized.
 */
export function supported() {
  if (!supportedP) {
    supportedP = apisPresent() ? call("probe", {}).catch(() => false) : Promise.resolve(false);
  }
  return supportedP;
}

export const peek = (id) => call("peek", { id });
/** target: a picked file to write the data to (see savetarget.js), or null for OPFS. */
export const open = (id, info, target = null) => call("open", { id, info, target });
export const truncate = (id, chunks) => call("truncate", { id, chunks });
export const root = (id) => call("root", { id });
export const complete = (id) => call("complete", { id });
export const reset = (id) => call("reset", { id });
export const remove = (id) => call("remove", { id });
export const sweep = (keep, graceMs) => call("sweep", { keep, graceMs });
export async function estimate() {
  const e = await call("estimate", {});
  // The simulated limit stands for the one browsers lift for persistent storage.
  if (config.simQuota && !(await navigator.storage.persisted?.())) e.quota = Math.min(e.quota || Infinity, e.usage + config.simQuota);
  return e;
}

/** Persists chunk idx. Transfers (and so detaches) bytes' buffer when it owns all of it. */
export function write(id, idx, bytes) {
  const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
  const buf = whole ? bytes.buffer : bytes.slice().buffer;
  return call("write", { id, idx, data: buf }, [buf]);
}

/** The finished file (after complete()). */
export async function getFile(id) {
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("fileporter");
  const dir = await root.getDirectoryHandle(id);
  return (await dir.getFileHandle("data")).getFile();
}

/**
 * Takes this transfer's Web Lock for the lifetime of the page.
 * Resolves true if acquired, false if another tab already holds it.
 * The browser releases it automatically when the page goes away
 * (reload, close, navigation), which is what lets sweep() tell live
 * transfers from abandoned ones.
 */
export function lock(id) {
  return new Promise((resolve) => {
    navigator.locks.request(`fileporter:${id}`, { ifAvailable: true }, (l) => {
      if (!l) { resolve(false); return null; }
      resolve(true);
      return new Promise(() => {}); // hold until the page goes away
    });
  });
}

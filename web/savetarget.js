// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// Receiving straight into a file the user picks, for files too big for
// the browser's own storage. Chromium gives each site at most 10 GiB of
// it (unless it grants persistent storage, which it rarely does), and
// the Origin Private File System counts against that; a file picked with
// showSaveFilePicker doesn't. Chunk hashes and metadata stay in OPFS.
//
// The picked file's handle is kept in IndexedDB, keyed by transfer id,
// so a reload can carry on writing to it (after asking for permission
// again, which needs a click).

const DB = "fileporter";
const STORE = "save-targets";

export const available = () => typeof window.showSaveFilePicker === "function";

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const d = await db();
  try {
    return await new Promise((resolve, reject) => {
      const t = d.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req.result);
      t.onerror = t.onabort = () => reject(t.error);
    });
  } finally {
    d.close();
  }
}

/** The handle picked for this transfer, or null. */
export async function get(id) {
  try {
    return (await tx("readonly", (s) => s.get(id))) || null;
  } catch {
    return null;
  }
}

export const set = (id, handle) => tx("readwrite", (s) => s.put(handle, id));

/** Forgets the handle (the file itself stays). */
export async function forget(id) {
  try { await tx("readwrite", (s) => s.delete(id)); } catch {}
}

/** Deletes the partly written file too, where the browser allows it. */
export async function discard(id) {
  const h = await get(id);
  if (h?.remove) try { await h.remove(); } catch {}
  await forget(id);
}

/** Asks where to save; null if the user closed the picker. */
export async function pick(name) {
  try {
    return await window.showSaveFilePicker({ suggestedName: name });
  } catch (err) {
    if (err.name === "AbortError") return null;
    throw err;
  }
}

export async function permitted(handle) {
  try {
    return (await handle.queryPermission({ mode: "readwrite" })) === "granted";
  } catch {
    return false;
  }
}

/** Needs a user gesture. */
export async function requestPermission(handle) {
  try {
    return (await handle.requestPermission({ mode: "readwrite" })) === "granted";
  } catch {
    return false;
  }
}

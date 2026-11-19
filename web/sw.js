// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// Download service worker, registered with scope dl/ only: it never
// sees the app's own pages or assets, so it can't get in the way of
// versioned deploys, and it caches nothing.
//
// Browsers without showSaveFilePicker (Firefox, Safari) save a received
// file as a regular download, and a page can't tell when a download has
// finished, so it can't know when the temporary copy in OPFS may go.
// This worker serves dl/<transferId>/<name> as a download, streamed
// from that copy, and pulls from the file only as the browser reads.
// When the browser asks for more after the last byte, it has every
// byte, and the worker announces it on BroadcastChannel "fileporter-dl":
//
//   {t:"started", id}    the download request reached this worker
//   {t:"done", id}       the browser has read the whole file
//   {t:"cancelled", id}  the download was cancelled or failed
//
// The page deletes the copy on "done" (it holds the storage handles).
// Like boot.js, this file is NOT versioned and must stay compatible
// with every deployed page.
"use strict";

const channel = new BroadcastChannel("fileporter-dl");

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const scope = self.registration.scope;
  if (!e.request.url.startsWith(scope)) return;
  const url = new URL(e.request.url);
  const m = /^([0-9a-f]{24})\/([^/]+)$/.exec(url.href.slice(scope.length).split(/[?#]/)[0]);
  if (!m) return;
  let name;
  try { name = decodeURIComponent(m[2]); } catch { return; }
  e.respondWith(serve(m[1], name, url.searchParams.get("type") || ""));
});

async function serve(id, name, type) {
  let file;
  try {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("fileporter");
    const dir = await root.getDirectoryHandle(id);
    file = await (await dir.getFileHandle("data")).getFile();
  } catch {
    channel.postMessage({ t: "cancelled", id });
    return new Response("This file is no longer stored in this browser.", { status: 404 });
  }
  channel.postMessage({ t: "started", id });
  const reader = file.stream().getReader();
  // highWaterMark 0: pull() runs only when the browser reads, so the
  // final pull (done) means it has taken every byte.
  const body = new ReadableStream({
    async pull(c) {
      let r;
      try {
        r = await reader.read();
      } catch (err) {
        channel.postMessage({ t: "cancelled", id });
        throw err;
      }
      if (r.done) {
        c.close();
        channel.postMessage({ t: "done", id });
      } else {
        c.enqueue(r.value);
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
      channel.postMessage({ t: "cancelled", id });
    },
  }, { highWaterMark: 0 });
  // Only safe characters in the plain filename=; the real name in filename*.
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return new Response(body, {
    headers: {
      "Content-Type": /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : "application/octet-stream",
      "Content-Length": String(file.size),
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

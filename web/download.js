// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// Saving a received file as a regular download (Firefox, Safari)
// through sw.js, which reports when the browser has read all of it, so
// the temporary copy can be removed without asking the user.

const STARTED_TIMEOUT_MS = 5000;

let registration = null;

/**
 * Registers the download worker (scope dl/). Call early on the
 * receiving side so it is active by the time the file is saved.
 * Resolves to true once active, false where unavailable.
 */
export function prepare() {
  registration ??= register().catch((err) => {
    console.info("download worker unavailable:", err?.message || err);
    return false;
  });
  return registration;
}

async function register() {
  if (!("serviceWorker" in navigator) || !("BroadcastChannel" in window)) return false;
  // Relative to the page, not this (versioned) module: sw.js lives next
  // to index.html.
  const reg = await navigator.serviceWorker.register(new URL("sw.js", location.href), {
    scope: new URL("dl/", location.href).href,
  });
  if (reg.active) return true;
  const w = reg.installing || reg.waiting;
  if (!w) return false;
  return new Promise((resolve) => {
    w.addEventListener("statechange", () => {
      if (w.state === "activated") resolve(true);
      if (w.state === "redundant") resolve(false);
    });
  });
}

/**
 * Downloads transfer `id` via the worker. Resolves to "done" when the
 * browser has read every byte, "cancelled" if the download stopped, or
 * "unavailable" if the worker isn't handling downloads here (the
 * caller falls back to a plain download).
 */
export async function download(id, { name, type }) {
  if (!(await prepare())) return "unavailable";
  const channel = new BroadcastChannel("fileporter-dl");
  const frame = document.createElement("iframe");
  frame.hidden = true;
  const url = new URL(`dl/${id}/${encodeURIComponent(name)}`, location.href);
  if (type) url.searchParams.set("type", type);
  try {
    return await new Promise((resolve) => {
      // The request never reaching the worker (it was bypassed, or
      // isn't controlling dl/ after all) shows as no "started".
      const timer = setTimeout(() => resolve("unavailable"), STARTED_TIMEOUT_MS);
      channel.onmessage = ({ data: m }) => {
        if (m?.id !== id) return;
        if (m.t === "started") clearTimeout(timer);
        if (m.t === "done" || m.t === "cancelled") { clearTimeout(timer); resolve(m.t); }
      };
      // A navigation, so the worker for dl/ handles it; Content-
      // Disposition turns it into a download.
      frame.src = url.href;
      document.body.append(frame);
    });
  } finally {
    channel.close();
    // Not straight away: some engines cancel a download whose frame is
    // removed while it starts.
    setTimeout(() => frame.remove(), 60_000);
  }
}

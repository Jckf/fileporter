// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// What the sender and receiver screens share: switching screens,
// announcements, the leave guard, the engine's status and a few
// helpers. (app.js routes; sender.js and receiver.js run the two sides.)

import { config } from "./config.js";
import * as engine from "./engine.js";
import * as platform from "./platform.js";
import * as relay from "./relay.js";
import * as savetarget from "./savetarget.js";
import * as storage from "./storage.js";
import * as notify from "./notify.js";
import { keepAwake } from "./wakelock.js";

export const $ = (id) => document.getElementById(id);
let screens = 0;
/**
 * Shows one screen. After the first, focus moves to its heading (or,
 * without a visible one, its status line), so keyboard and screen
 * reader users land on the new screen instead of a button it hid.
 */
export const show = (id) => {
  let section = null;
  for (const s of document.querySelectorAll("main > section")) {
    s.hidden = s.id !== id;
    if (!s.hidden) section = s;
  }
  window.scrollTo(0, 0);
  if (screens++ === 0 || !section) return;
  const target = [...section.querySelectorAll("h1, h2")].find((h) => h.offsetParent) ?? section.querySelector(".status");
  if (!target) return;
  target.tabIndex = -1;
  target.focus({ preventScroll: true });
};
/** Says text to screen readers once (#announce), without showing it. */
export function announce(text) {
  const el = $("announce");
  el.textContent = "";
  // A separate change, so the same text twice is still announced.
  requestAnimationFrame(() => { el.textContent = text; });
}
export const setText = (id, t) => { $(id).textContent = t; };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Leaving the page --------------------------------------------------------

// While a transfer can still be resumed, warn before leaving: reloading
// resumes, but navigating away loses the session.
let guardLeave = false;
// The same span also keeps the screen awake: a phone locking itself
// would suspend the page and drop the transfer.
/** Whether leaving now would lose a transfer (setGuard). */
export const isGuarding = () => guardLeave;
export function setGuard(on) {
  guardLeave = on;
  keepAwake(on);
  notify.transferring(on); // the app: "Transfer paused" if put in the background
}
window.addEventListener("beforeunload", (e) => {
  if (guardLeave) { e.preventDefault(); e.returnValue = ""; }
});

// --- Engine status -----------------------------------------------------------

const ENGINE_FAILED = "Couldn't get ready. Check your connection, then reopen fileporter.";
const ENGINE_STOPPED = "fileporter stopped working. Reopen it to carry on where you left off.";

export let engineReady = false;
export let engineError = null;
const readyCallbacks = new Set();
const failedCallbacks = new Set();
engine.onProgress((s) => {
  const bar = $("engine-progress");
  const label = $("engine-label");
  const status = $("engine-status");
  switch (s.state) {
    case "loading":
      if (s.total) bar.value = s.loaded / s.total;
      label.textContent = !s.total
        ? "Preparing secure connection…"
        : s.loaded >= s.total
          ? "Almost ready…"
          : `Preparing secure connection… ${Math.floor((100 * s.loaded) / s.total)}%`;
      break;
    case "retrying":
      label.textContent = "Still getting ready. Trying again…";
      break;
    case "ready":
      status.dataset.state = "ready";
      engineReady = true;
      readyCallbacks.forEach((fn) => fn());
      break;
    case "error":
      status.dataset.state = "error";
      engineError = s.error;
      console.warn("engine failed:", s.error);
      label.textContent = ENGINE_FAILED;
      failedCallbacks.forEach((fn) => fn());
      break;
  }
});
export const whenReady = (fn) => (engineReady ? fn() : readyCallbacks.add(fn));
/** Calls fn() if the engine fails, whether loading or later (it stopped). */
export const whenFailed = (fn) => (engineError ? fn() : failedCallbacks.add(fn));
/** What to tell the user once the engine has failed. */
export const engineFailedText = () => (engineReady ? ENGINE_STOPPED : ENGINE_FAILED);

// --- Shared helpers ----------------------------------------------------------

/** err's message for the middle of a sentence: no final period. */
export const errText = (err) => String(err?.message || err).replace(/[.\s]+$/, "");
export const pickedMode = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value ?? null;
export const modeName = (m) => (m === "privacy" ? "Private" : "Fast");

/** peerRole: what the other side is called on this page ("the sender", "the recipient"). */
export function describeEffective(effective, mine, peer, peerRole) {
  if (effective === "performance") return "Fast: you both chose a direct connection.";
  const who = mine === "privacy" && peer === "privacy" ? "you both" : mine === "privacy" ? "you" : peerRole;
  return `Private, because ${who} chose it: neither of you can see the other's IP address.`;
}

export async function startSweeping(keep) {
  if (!(await storage.supported())) return;
  const run = () => storage.sweep(keep, config.sweepGraceMs)
    .then((ids) => Promise.all(ids.map(savetarget.forget)))
    .catch((err) => console.warn("sweep failed", err))
    .then(() => console.debug("sweep finished")); // (the tests wait for it)
  await run();
  setInterval(run, 5 * 60 * 1000);
}

export function showCancelled(text) {
  setText("cancelled-text", text);
  show("cancelled");
}

/**
 * Makes btn (icon + <span> label) copy text, confirming with
 * "Copied" for 2 s. onFail runs if the clipboard refuses.
 */
export function copyButton(btn, text, onFail) {
  const label = btn.querySelector("span").textContent;
  btn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      onFail();
      return;
    }
    btn.classList.add("copied");
    btn.querySelector("span").textContent = "Copied";
    announce("Copied");
    btn.querySelector("use").setAttribute("href", "#i-check");
    setTimeout(() => {
      btn.classList.remove("copied");
      btn.querySelector("span").textContent = label;
      btn.querySelector("use").setAttribute("href", "#i-copy");
    }, 2000);
  };
}

// --- Stalled transfers ------------------------------------------------------

const VERSION = new URL(import.meta.url).pathname.split("/").at(-2) || "dev";

// "fra" or, where this page measured it (relay.js), "fra 31ms".
export function relayName(code) {
  if (!code) return "";
  const p = relay.picked;
  return p && p.code === code ? `${code} ${Math.round(p.ms)}ms` : code;
}

// No bytes moving for config.stallMs while connected: say so, offer
// to reconnect, and show a line to include in a report.
export function stallWatch(side, total, onRetry) {
  const note = $(`${side}-stall`);
  let bytes = 0, since = 0, via = "", region = "", timer = null;
  const hide = () => { note.hidden = true; };
  $(`${side}-stall-retry`).onclick = () => { hide(); since = Date.now(); onRetry(); };
  const check = () => {
    const s = Math.round((Date.now() - since) / 1000);
    if (Date.now() - since < config.stallMs) return;
    setText(`${side}-stall-text`, bytes ? `Nothing has come through for ${s} seconds.` : `No data has arrived after ${s} seconds.`);
    setText(`${side}-stall-code`, [
      VERSION, side, via || "?", region || "relay ?",
      `${bytes}/${total}`, `${s}s`, platform.isApp ? platform.os : "web",
    ].join(" · "));
    // Said once when it appears; the seconds it shows tick silently.
    if (note.hidden) announce("Nothing is getting through. The connection may be blocked or very slow. Reconnecting can help.");
    note.hidden = false;
  };
  return {
    /** Data is meant to be flowing now: over via, relayed by region. */
    start(v, r) {
      via = v || via;
      region = r || region;
      since = Date.now();
      hide();
      clearInterval(timer);
      timer = setInterval(check, 1000);
    },
    progress(b) { if (b !== bytes) { bytes = b; since = Date.now(); hide(); } },
    stop() { clearInterval(timer); timer = null; hide(); },
  };
}


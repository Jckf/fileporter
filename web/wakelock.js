// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// Keeps the screen on while a transfer needs this page (Screen Wake
// Lock API). Mobile browsers suspend a page once the phone locks
// itself, which drops the connection; this stops the automatic lock,
// nothing more: the power button or switching apps still hides the
// page (resume covers that). Optional: unsupported browsers or a
// refused request (e.g. battery saver) just mean no wake lock.
//
// The browser releases the lock whenever the page is hidden, so it is
// requested again each time the page becomes visible while wanted.

let wanted = false;
let sentinel = null;
let pending = null;

const supported = () => "wakeLock" in navigator && typeof navigator.wakeLock?.request === "function";

async function acquire() {
  if (!wanted || sentinel || pending || document.visibilityState !== "visible" || !supported()) return;
  pending = navigator.wakeLock.request("screen")
    .then((s) => {
      if (!wanted) { s.release().catch(() => {}); return; }
      sentinel = s;
      s.addEventListener("release", () => { if (sentinel === s) sentinel = null; });
    })
    .catch((err) => console.info("wake lock not available:", err.message))
    .finally(() => { pending = null; });
  await pending;
}

function release() {
  const s = sentinel;
  sentinel = null;
  s?.release().catch(() => {});
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") acquire();
});

/** Keep the screen awake (true) or let it sleep again (false). */
export function keepAwake(on) {
  if (wanted === on) return;
  wanted = on;
  if (on) acquire();
  else release();
}

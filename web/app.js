// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// fileporter UI. Plain ES modules, no build step.
//
// The page is fully usable while the engine downloads in the
// background; only starting a session waits for it. This module routes
// (by the URL fragment) to the sending side (sender.js) or the
// receiving side (receiver.js); shell.js holds what both use.

import * as frag from "./fragment.js";
import * as nativefile from "./nativefile.js";
import * as platform from "./platform.js";
import * as scan from "./scan.js";
import * as ui from "./ui.js";
import "./edgefade.js";
import { $, show, setText, setGuard, isGuarding, startSweeping } from "./shell.js";
import { initSendPage, senderResume } from "./sender.js";
import { receiver } from "./receiver.js";

ui.renderSteps();

// The fragment is the only session state, so a different fragment
// means a different session: start over cleanly.
window.addEventListener("hashchange", () => location.reload());

// --- Offline warning ---------------------------------------------------------

// navigator.onLine === false is reliable ("no network at all"); true only
// means a network exists, so this warns about the clear case and leaves
// flaky connections to the transfer's own retry messages.
function watchConnectivity() {
  const update = () => { $("offline").hidden = navigator.onLine !== false; };
  addEventListener("online", update);
  addEventListener("offline", update);
  update();
}
watchConnectivity();

// --- Routing -----------------------------------------------------------------

// In the app, a tapped fileporter link arrives as a launch URL, or as an
// event while the app runs; either way its fragment becomes ours.
// A file shared to the app from another app starts a new send (and a
// shared fileporter link opens).
let shared = null;
/**
 * Whether to leave this page for something opened or shared to the app
 * ("open the new link instead"): asked while a transfer can still be
 * resumed, or while a received file waits to be saved (leaving forgets
 * it, though nothing's guarded then).
 */
function mayLeave(instead) {
  if (!$("recv-save").hidden) return confirm(`The received file isn't saved yet. Leave it and ${instead}?`);
  if (isGuarding()) return confirm(`Stop this transfer and ${instead}?`);
  return true;
}
if (platform.isApp) {
  platform.onLinkOpened((hash) => {
    if (!mayLeave("open the new link instead")) return;
    setGuard(false);
    location.hash = hash; // hashchange reloads
  });
  nativefile.onShared(() => {
    if (!mayLeave("send the shared file instead")) {
      nativefile.takeShared(); // declined: don't pick it up later
      return;
    }
    setGuard(false);
    location.href = "./"; // picked up below, on the start page
  });
  const fresh = frag.freshStart();
  // (Failing, it must not stop the page from loading: nothing was shared.)
  shared = await nativefile.takeShared().catch((err) => { console.warn("takeShared failed:", err); return null; });
  if (shared?.link) {
    history.replaceState(null, "", shared.link);
  } else if (shared) {
    history.replaceState(null, "", location.pathname + location.search);
  } else if (fresh && !location.hash) {
    // Only when the app starts: opened on a link, else carrying on where
    // it was closed. (Later loads at the start page mean "start over".)
    const hash = (await platform.launchFragment()) || frag.remembered();
    if (hash) history.replaceState(null, "", hash);
  }
}

const f = frag.decode();
frag.remember(f ? location.hash : "");
if (!location.hash) {
  show("send-new");
  // The app only: in a browser the phone's camera app scans the code.
  if (platform.isApp && scan.available()) {
    $("receive-card").hidden = false;
    $("scan-qr").onclick = async () => {
      setText("scan-error", "");
      try {
        const hash = await scan.scanLink();
        if (hash) location.hash = hash; // hashchange reloads into receiving
      } catch (err) {
        setText("scan-error", err.message);
      }
    };
  }
  initSendPage(shared?.file ?? null);
  if (shared?.error) setText("drop-error", shared.error);
  startSweeping(null);
} else if (!f) {
  show("bad-link");
  startSweeping(null);
} else if (f.role === "s") {
  senderResume(f.state);
  startSweeping(null);
} else {
  receiver(f.state);
}

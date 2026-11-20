// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// In the Android and iOS apps: a notification when the app is put in
// the background during a transfer, which then pauses (the system
// suspends the app), so the user knows to come back. Removed when the
// app is in front again. Nothing in a browser: a tab can't do this
// reliably, and the page asks to be kept open instead.

import { plugin } from "./platform.js";

const ID = 1;
let active = false;
let asked = false;

const notifications = () => plugin("LocalNotifications");

/** Whether a transfer is under way (between setGuard(true) and (false)). */
export function transferring(on) {
  active = on;
  const n = notifications();
  if (!n) return;
  if (!on) {
    remove();
    return;
  }
  // Asked when it's first useful, not at startup.
  if (!asked) {
    asked = true;
    n.checkPermissions()
      .then((p) => (p.display === "prompt" || p.display === "prompt-with-rationale" ? n.requestPermissions() : p))
      .catch(() => {});
  }
}

function paused() {
  if (!active) return;
  notifications()?.schedule({
    notifications: [{
      id: ID,
      title: "Transfer paused",
      body: "Open fileporter to continue.",
      smallIcon: "ic_stat_fileporter",
      autoCancel: true,
      // Shown now: no exact alarm (Android would ask for that permission).
      isExactNotification: false,
    }],
  }).catch(() => {});
}

// (cancel() only cancels pending ones; this one has been shown.)
function remove() {
  notifications()?.removeDeliveredNotifications({ notifications: [{ id: ID, title: "", body: "" }] }).catch(() => {});
}

const app = plugin("App");
if (app && notifications()) {
  app.addListener("pause", paused);
  app.addListener("resume", remove);
  // Left behind if the system closed the app while it was paused.
  remove();
}

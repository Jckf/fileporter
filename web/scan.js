// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// Receiving by scanning the sender's QR code with the camera, in the
// page itself (getUserMedia, decoded with the vendored jsQR, loaded
// when first needed). Offered in the Android and iOS apps; in a
// browser the phone's camera app does this and opens the link. No
// native scanner plugin: the ones available bundle Google's ML Kit,
// which is proprietary and reports usage to Google.

import { decode } from "./fragment.js";

const $ = (id) => document.getElementById(id);

/** True where the page can use a camera. */
export const available = () => !!navigator.mediaDevices?.getUserMedia;

// Decoded at most this often, from frames scaled to at most MAX_SIDE.
const INTERVAL_MS = 150;
const MAX_SIDE = 720;

/**
 * Shows the camera (#scanner) until it sees a fileporter link's QR code.
 * Resolves to the link's fragment ("#R…"), or null if the user closed
 * it. Rejects if the camera can't be used.
 */
export async function scanLink() {
  const { default: jsQR } = await import("./vendor/jsqr.mjs");
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (err) {
    if (err?.name === "NotAllowedError") throw new Error("fileporter isn't allowed to use the camera. Allow it in your device's settings, then try again.", { cause: err });
    if (err?.name === "NotFoundError" || err?.name === "OverconstrainedError") throw new Error("No camera found.", { cause: err });
    throw new Error(`Couldn't start the camera: ${err?.message || err}`, { cause: err });
  }

  const overlay = $("scanner");
  const video = $("scanner-video");
  const status = $("scanner-status");
  status.textContent = "Point the camera at the QR code on the sender's screen.";
  overlay.hidden = false;
  video.srcObject = stream;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let timer = null;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const onKey = (e) => { if (e.key === "Escape") finish(null); };
  $("scanner-close").onclick = () => finish(null);
  document.addEventListener("keydown", onKey);

  const tick = () => {
    if (video.readyState >= video.HAVE_CURRENT_DATA && video.videoWidth) {
      const k = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * k);
      canvas.height = Math.round(video.videoHeight * k);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
      if (code?.data) {
        let hash = "";
        try {
          hash = new URL(code.data).hash;
        } catch {}
        // Any copy of fileporter (the sender may use another address);
        // what matters is a valid receiver fragment.
        if (decode(hash)?.role === "r") {
          finish(hash);
          return;
        }
        status.textContent = "That QR code isn't a fileporter link.";
      }
    }
    timer = setTimeout(tick, INTERVAL_MS);
  };

  try {
    await video.play();
    tick();
    return await done;
  } finally {
    clearTimeout(timer);
    document.removeEventListener("keydown", onKey);
    for (const t of stream.getTracks()) t.stop();
    video.srcObject = null;
    overlay.hidden = true;
  }
}

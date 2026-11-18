// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// fileporter UI. Plain ES modules, no build step.
//
// The page is fully usable while the engine downloads in the
// background; only starting a session waits for it.

import { config } from "./config.js";
import * as engine from "./engine.js";
import * as frag from "./fragment.js";
import * as rtc from "./rtc.js";
import * as storage from "./storage.js";
import { senderSession, receiverSession, ChunkHashes, FatalError, CancelledError, fmtBytes } from "./session.js";

const $ = (id) => document.getElementById(id);
const show = (id) => {
  for (const s of document.querySelectorAll("main > section")) s.hidden = s.id !== id;
};
const setText = (id, t) => { $(id).textContent = t; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Leaving the page --------------------------------------------------------

// While a transfer can still be resumed, warn before leaving: reloading
// resumes, but navigating away loses the session.
let guardLeave = false;
window.addEventListener("beforeunload", (e) => {
  if (guardLeave) { e.preventDefault(); e.returnValue = ""; }
});

// The fragment is the only session state, so a different fragment
// means a different session: start over cleanly.
window.addEventListener("hashchange", () => location.reload());

// --- Engine status -----------------------------------------------------------

let engineReady = false;
const readyCallbacks = new Set();
engine.onProgress((s) => {
  const bar = $("engine-progress");
  const label = $("engine-label");
  switch (s.state) {
    case "loading":
      bar.hidden = false;
      if (s.total) bar.value = s.loaded / s.total;
      label.textContent = s.total
        ? `Preparing secure engine… ${Math.floor((100 * s.loaded) / s.total)}%`
        : "Preparing secure engine…";
      break;
    case "retrying":
      label.textContent = `Engine download failed, retrying (${s.attempt})…`;
      break;
    case "ready":
      bar.hidden = true;
      label.textContent = "Secure engine ready";
      $("engine-status").dataset.state = "ready";
      engineReady = true;
      readyCallbacks.forEach((fn) => fn());
      break;
    case "error":
      bar.hidden = true;
      label.textContent = `Engine failed to load: ${s.error}. Reload to try again.`;
      $("engine-status").dataset.state = "error";
      break;
  }
});
const whenReady = (fn) => (engineReady ? fn() : readyCallbacks.add(fn));

// --- Shared helpers ----------------------------------------------------------

const pickedMode = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value ?? null;
const modeLabel = (m) => (m === "privacy" ? "Privacy (relayed)" : "Performance (direct when possible)");

function describeEffective(effective, mine, peer) {
  if (effective === "performance") return "Performance mode: both sides allowed a direct connection.";
  const who = mine === "privacy" && peer === "privacy" ? "both of you" : mine === "privacy" ? "you" : "the other side";
  return `Privacy mode (chosen by ${who}): all traffic is relayed and neither side sees the other's IP address.`;
}

/** Progress bar + "x of y · speed" text, with a speed estimate over the last few seconds. */
function progressView(barId, textId, total) {
  const samples = [];
  return (bytes) => {
    const now = performance.now();
    samples.push([now, bytes]);
    while (samples.length > 2 && now - samples[0][0] > 5000) samples.shift();
    const [t0, b0] = samples[0];
    const rate = now > t0 ? ((bytes - b0) * 1000) / (now - t0) : 0;
    const bar = $(barId);
    bar.max = total || 1;
    bar.value = total ? bytes : 1;
    setText(textId, `${fmtBytes(bytes)} of ${fmtBytes(total)}${rate > 0 && bytes < total ? ` · ${fmtBytes(rate)}/s` : ""}`);
  };
}

async function startSweeping(keep) {
  if (!storage.supported()) return;
  const run = () => storage.sweep(keep, config.sweepGraceMs).catch((err) => console.warn("sweep failed", err));
  await run();
  setInterval(run, 5 * 60 * 1000);
}

// --- Sender ------------------------------------------------------------------

let listener = null;
let currentCtl = null;
let delivered = false;

function updateStartButton() {
  const file = $("send-file").files[0];
  const mode = pickedMode("send-mode");
  const btn = $("send-start");
  btn.disabled = !(file && mode && engineReady);
  btn.textContent = engineReady ? "Create link" : "Waiting for secure engine…";
}

async function startSender(state, file) {
  // Enforce privacy before ANY engine call: from here on this page
  // can't create an RTCPeerConnection at all.
  if (state.m === "privacy") rtc.lockOutWebRTC();
  if (!(await storage.lock(state.id))) { show("busy"); return; }
  guardLeave = true;
  show("send-active");
  setText("send-active-mode", modeLabel(state.m));
  setText("send-active-file", `${file.name} (${fmtBytes(file.size)})`);
  setText("send-active-status", "Starting relay connection…");
  const progress = progressView("send-progress", "send-progress-text", file.size);
  progress(0);

  const hashes = new ChunkHashes(file);
  const iceServers = state.m === "performance" ? await rtc.stunServers(config.derpMapURL) : [];
  listener = await engine.listen(
    { derpMapURL: config.derpMapURL, senderKey: state.sk, allowClient: state.rp, verbose: config.verbose },
    async (conn) => {
      if (delivered) { conn.close(); return; }
      // One receiver key, one session at a time: a reconnect replaces
      // the previous session.
      currentCtl?.stop?.();
      const ctl = {};
      currentCtl = ctl;
      setText("send-active-status", "Receiver connected, negotiating…");
      try {
        await senderSession(conn, {
          state, file, hashes, iceServers, iceTimeoutMs: config.iceTimeoutMs, ctl,
          onProgress: progress,
          onStatus: (s) => {
            if (s.phase === "negotiated") {
              setText("send-active-effective", describeEffective(s.effective, state.m, s.peerMode));
              setText("send-active-status", s.fromChunk ? "Resuming…" : "Starting…");
            }
            if (s.phase === "transport") setText("send-active-status", s.via === "rtc" ? "Sending over a direct connection…" : "Sending through the relay…");
            if (s.phase === "verifying") setText("send-active-status", "Verifying…");
          },
        });
        delivered = true;
        guardLeave = false;
        listener.close();
        frag.scrub();
        setText("send-done-file", `${file.name} (${fmtBytes(file.size)})`);
        show("send-done");
      } catch (err) {
        if (currentCtl !== ctl) return; // replaced by a newer connection
        if (err instanceof CancelledError) {
          guardLeave = false;
          listener.close();
          frag.scrub();
          setText("cancelled-text", err.message);
          show("cancelled");
        } else if (err instanceof FatalError) {
          setText("send-active-status", err.message);
        } else {
          setText("send-active-status", "Connection lost. Waiting for the receiver to reconnect…");
        }
      }
    },
  );
  $("share-link").value = frag.shareLink(state);
  setText("send-active-status", "Waiting for the receiver to open the link…");
}

$("send-file").onchange = updateStartButton;
for (const r of document.querySelectorAll('input[name="send-mode"]')) r.onchange = updateStartButton;
whenReady(updateStartButton);

$("send-start").onclick = async () => {
  const file = $("send-file").files[0];
  const mode = pickedMode("send-mode");
  if (!file || !mode) return;
  $("send-start").disabled = true;
  try {
    if (mode === "privacy") rtc.lockOutWebRTC();
    const s = await engine.newSession({ derpMapURL: config.derpMapURL });
    const state = {
      id: frag.newTransferId(),
      sk: s.senderKey, a: s.addr, rk: s.receiverKey, rp: s.receiverPub,
      m: mode, f: await frag.fileFingerprint(file),
    };
    frag.set("s", state);
    await startSender(state, file);
  } catch (err) {
    setText("send-error", `Could not start: ${err.message}`);
    updateStartButton();
  }
};

$("copy-link").onclick = () => navigator.clipboard.writeText($("share-link").value);

$("send-cancel").onclick = async () => {
  $("send-cancel").disabled = true;
  await currentCtl?.cancel?.();
  listener?.close();
  guardLeave = false;
  frag.scrub();
  setText("cancelled-text", "You cancelled the transfer.");
  show("cancelled");
};

function senderResume(state) {
  if (state.m === "privacy") rtc.lockOutWebRTC();
  show("send-resume");
  setText("send-resume-mode", modeLabel(state.m));
  $("send-resume-file").onchange = async () => {
    const file = $("send-resume-file").files[0];
    if (!file) return;
    if (!frag.sameFile(state.f, await frag.fileFingerprint(file))) {
      setText("send-resume-error", "That's not the same file (name, size or modification time differ).");
      return;
    }
    setText("send-resume-error", engineReady ? "" : "Waiting for secure engine…");
    whenReady(() => startSender(state, file).catch((err) => setText("send-resume-error", err.message)));
  };
}

// --- Receiver ----------------------------------------------------------------

let recvCtl = null;
let recvStopped = false;

async function receiverLoop(state) {
  if (state.rm === "privacy" || state.sm === "privacy") rtc.lockOutWebRTC();
  show("recv-active");
  guardLeave = true;
  let progress = null;
  setText("recv-active-status", engineReady ? "Connecting through the relay…" : "Waiting for secure engine…");
  await engine.ready;
  const iceServers = state.rm === "performance" && state.sm === "performance" ? await rtc.stunServers(config.derpMapURL) : [];

  for (let attempt = 0; !recvStopped; attempt++) {
    if (attempt) {
      const wait = Math.min(30, 2 ** Math.min(attempt, 5));
      for (let s = wait; s > 0 && !recvStopped; s--) {
        setText("recv-active-status", `Connection lost. Reconnecting in ${s} s… (keep the sender's page open)`);
        await sleep(1000);
      }
      if (recvStopped) return;
    }
    setText("recv-active-status", "Connecting through the relay…");
    let conn;
    try {
      conn = await engine.dial({ addr: state.a, derpMapURL: config.derpMapURL, clientKey: state.k, verbose: config.verbose });
    } catch (err) {
      console.info("dial failed:", err.message);
      continue;
    }
    if (recvStopped) { conn.close(); return; }
    const ctl = {};
    recvCtl = ctl;
    try {
      const res = await receiverSession(conn, {
        state, iceServers, iceTimeoutMs: config.iceTimeoutMs, ctl,
        onProgress: (b) => progress?.(b),
        onStatus: (s) => {
          if (s.phase === "hello") {
            setText("recv-active-file", `${s.hello.name} (${fmtBytes(s.hello.size)})`);
            progress = progressView("recv-progress", "recv-progress-text", s.hello.size);
          }
          if (s.phase === "negotiated") {
            setText("recv-active-effective", describeEffective(s.effective, state.rm, s.peerMode));
            setText("recv-active-status", s.fromChunk ? "Resuming…" : "Starting…");
          }
          if (s.phase === "transport") setText("recv-active-status", s.via === "rtc" ? "Receiving over a direct connection…" : "Receiving through the relay…");
          if (s.phase === "verifying") setText("recv-active-status", "Verifying…");
        },
      });
      recvCtl = null;
      showSave(state, { name: res.hello.name, size: res.hello.size, type: res.hello.type });
      return;
    } catch (err) {
      recvCtl = null;
      if (recvStopped) return;
      if (err instanceof CancelledError) {
        await storage.remove(state.id).catch(() => {});
        guardLeave = false;
        frag.scrub();
        setText("cancelled-text", err.message);
        show("cancelled");
        return;
      }
      if (err instanceof FatalError) {
        guardLeave = false;
        setText("recv-active-status", err.message);
        $("recv-retry").hidden = false;
        return;
      }
      console.info("session dropped:", err.message);
      attempt = Math.min(attempt, 1); // made progress: retry soon
    }
  }
}

$("recv-retry").onclick = () => location.reload();

$("recv-cancel").onclick = async () => {
  $("recv-cancel").disabled = true;
  recvStopped = true;
  await recvCtl?.cancel?.();
  const f = frag.decode();
  if (f) await storage.remove(f.state.id).catch(() => {});
  guardLeave = false;
  frag.scrub();
  setText("cancelled-text", "You cancelled the transfer. Temporary data was removed.");
  show("cancelled");
};

let downloadURL = null;

function showSave(state, meta) {
  guardLeave = false; // the data is safe in storage; a reload comes back here
  show("recv-save");
  setText("recv-save-file", `${meta.name} (${fmtBytes(meta.size)})`);
  $("recv-save-btn").onclick = async () => {
    const data = await storage.getFile(state.id);
    if ("showSaveFilePicker" in window) {
      // Chromium (incl. Edge, Opera): stream straight to the chosen file,
      // then the temporary copy can go at once.
      let handle;
      try {
        handle = await window.showSaveFilePicker({ suggestedName: meta.name });
      } catch (err) {
        if (err.name === "AbortError") return;
        throw err;
      }
      setText("recv-save-status", "Saving…");
      const w = await handle.createWritable();
      await data.stream().pipeTo(w);
      await clearReceived(state, "Saved. The temporary copy was removed from this browser.");
    } else {
      // Firefox, Safari: a regular download from the stored file. We
      // can't observe when the browser has finished copying it, so the
      // user confirms before we delete the source.
      downloadURL ??= URL.createObjectURL(new File([data], meta.name, { type: meta.type || "application/octet-stream" }));
      const a = document.createElement("a");
      a.href = downloadURL;
      a.download = meta.name;
      document.body.append(a);
      a.click();
      a.remove();
      $("recv-clear").hidden = false;
      setText("recv-save-status", "When the download has finished, remove the temporary copy.");
    }
  };
  $("recv-clear").onclick = () => clearReceived(state, "The temporary copy was removed from this browser.");
}

async function clearReceived(state, message) {
  if (downloadURL) { URL.revokeObjectURL(downloadURL); downloadURL = null; }
  await storage.remove(state.id);
  frag.scrub();
  setText("recv-cleared-text", message);
  show("recv-cleared");
}

async function receiver(state) {
  if (!storage.supported()) { show("unsupported"); return; }
  if (!(await storage.lock(state.id))) { show("busy"); return; }
  startSweeping(state.id);

  // Already received in an earlier visit (reload on the save step):
  // straight to saving, no network needed.
  const existing = await storage.peek(state.id);
  if (existing.exists && existing.meta?.status === "complete") {
    showSave(state, existing.meta);
    return;
  }

  if (state.sm === "privacy") {
    // Sender already forces privacy: no choice to make, and WebRTC is
    // locked out before anything else happens.
    rtc.lockOutWebRTC();
    if (!state.rm) frag.set("r", (state = { ...state, rm: "privacy" }));
  }
  if (state.rm) {
    // Mode already chosen in this session (reopened URL): resume
    // without asking again.
    receiverLoop(state);
    return;
  }
  show("recv-choose");
  const btn = $("recv-continue");
  const update = () => { btn.disabled = !pickedMode("recv-mode"); };
  for (const r of document.querySelectorAll('input[name="recv-mode"]')) r.onchange = update;
  btn.onclick = () => {
    const rm = pickedMode("recv-mode");
    if (!rm) return;
    state = { ...state, rm };
    frag.set("r", state);
    receiverLoop(state);
  };
}

// --- Routing -----------------------------------------------------------------

const f = frag.decode();
if (!location.hash) {
  show("send-new");
  updateStartButton();
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

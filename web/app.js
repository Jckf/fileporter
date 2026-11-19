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
import * as ui from "./ui.js";

const $ = (id) => document.getElementById(id);
const show = (id) => {
  for (const s of document.querySelectorAll("main > section")) s.hidden = s.id !== id;
  window.scrollTo(0, 0);
};
const setText = (id, t) => { $(id).textContent = t; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ui.renderSteps();

// --- Leaving the page --------------------------------------------------------

// While a transfer can still be resumed, warn before leaving: reloading
// resumes, but navigating away loses the session.
let guardLeave = false;
window.addEventListener("beforeunload", (e) => {
  if (guardLeave) { e.preventDefault(); e.returnValue = ""; }
});
// Leaving (or reloading): tell the peer, so it can reconnect right away
// instead of waiting for the keepalive timeout. Best effort, see bye()
// in transport.js. (Not from beforeunload: the user may still cancel.)
window.addEventListener("pagehide", () => { currentCtl?.bye?.(); recvCtl?.bye?.(); });

// The fragment is the only session state, so a different fragment
// means a different session: start over cleanly.
window.addEventListener("hashchange", () => location.reload());

// --- Engine status -----------------------------------------------------------

let engineReady = false;
const readyCallbacks = new Set();
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
      label.textContent = `Download failed. Retrying (attempt ${s.attempt})…`;
      break;
    case "ready":
      status.dataset.state = "ready";
      engineReady = true;
      readyCallbacks.forEach((fn) => fn());
      break;
    case "error":
      status.dataset.state = "error";
      label.textContent = `Couldn't load: ${s.error}. Reload the page to try again.`;
      break;
  }
});
const whenReady = (fn) => (engineReady ? fn() : readyCallbacks.add(fn));

// --- Shared helpers ----------------------------------------------------------

const pickedMode = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value ?? null;
const modeName = (m) => (m === "privacy" ? "Private" : "Fast");

/** peerRole: what the other side is called on this page ("the sender", "the recipient"). */
function describeEffective(effective, mine, peer, peerRole) {
  if (effective === "performance") return "Fast: you both chose a direct connection.";
  const who = mine === "privacy" && peer === "privacy" ? "you both" : mine === "privacy" ? "you" : peerRole;
  return `Private, because ${who} chose it: neither of you can see the other's IP address.`;
}

async function startSweeping(keep) {
  if (!(await storage.supported())) return;
  const run = () => storage.sweep(keep, config.sweepGraceMs).catch((err) => console.warn("sweep failed", err));
  await run();
  setInterval(run, 5 * 60 * 1000);
}

// --- Sender: picking a file ----------------------------------------------------

let listener = null;
let currentCtl = null;
let delivered = false;

function updateStartButton() {
  const file = $("send-file").files[0];
  const mode = pickedMode("send-mode");
  const btn = $("send-start");
  btn.disabled = !(file && mode && engineReady);
  btn.textContent = !engineReady ? "Getting ready…" : !file ? "Choose a file first" : !mode ? "Choose how to connect" : "Create link";
}

function showPickedFile() {
  const file = $("send-file").files[0];
  setText("drop-error", "");
  $("dropzone").hidden = !!file;
  $("send-file-card").hidden = !file;
  if (file) ui.fillFileCard($("send-file-card"), file);
  updateStartButton();
}

$("send-file").onchange = showPickedFile;
$("send-file-clear").onclick = () => {
  $("send-file").value = "";
  showPickedFile();
  $("send-file").focus();
};
for (const r of document.querySelectorAll('input[name="send-mode"]')) r.onchange = updateStartButton;
whenReady(updateStartButton);

ui.setupDrop({
  zone: $("dropzone"),
  active: () => !$("send-new").hidden,
  onFile: (file) => ui.setInputFile($("send-file"), file),
  onError: (msg) => setText("drop-error", msg),
});

// --- Sender: sharing and sending ---------------------------------------------------

function setupShare(link) {
  $("share-link").value = link;
  $("share-link").onfocus = (e) => e.target.select();
  const copyBtn = $("copy-link");
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      $("share-link").select(); // let the user copy manually
      return;
    }
    copyBtn.classList.add("copied");
    copyBtn.querySelector("span").textContent = "Copied";
    copyBtn.querySelector("use").setAttribute("href", "#i-check");
    setTimeout(() => {
      copyBtn.classList.remove("copied");
      copyBtn.querySelector("span").textContent = "Copy";
      copyBtn.querySelector("use").setAttribute("href", "#i-copy");
    }, 2000);
  };
  const qrBtn = $("toggle-qr");
  qrBtn.onclick = () => {
    const open = $("qr-panel").hidden;
    if (open && !$("qr").firstChild) ui.renderQR($("qr"), link);
    $("qr-panel").hidden = !open;
    qrBtn.setAttribute("aria-expanded", String(open));
  };
  // The share sheet hands the link (and with it the keys) to an app the
  // user picks, which is what they asked for; offer it only where it
  // exists (mostly mobile).
  if (navigator.share && navigator.canShare?.({ url: link })) {
    $("native-share").hidden = false;
    $("native-share").onclick = () => navigator.share({ title: "fileporter", text: "A file for you:", url: link }).catch(() => {});
  }
}

async function startSender(state, file) {
  // Enforce privacy before ANY engine call: from here on this page
  // can't create an RTCPeerConnection at all.
  if (state.m === "privacy") rtc.lockOutWebRTC();
  if (!(await storage.lock(state.id))) { show("busy"); return; }
  guardLeave = true;
  show("send-active");
  ui.setStep("send-active", 1);
  setText("send-active-effective", state.m === "performance"
    ? "You chose Fast. It's only used if the recipient also chooses Fast."
    : "You chose Private. The recipient won't see your IP address.");
  setText("send-active-file", file.name);
  setText("send-active-size", fmtBytes(file.size));
  setText("send-active-ext", ui.fileExt(file.name));
  setText("send-active-status", "Starting…");
  const progress = ui.progressView("send-progress", "send-progress-text", file.size);
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
      $("share-block").hidden = true;
      ui.setStep("send-active", 2);
      setText("send-active-status", "Recipient connected…");
      try {
        await senderSession(conn, {
          state, file, hashes, iceServers, iceTimeoutMs: config.iceTimeoutMs, ctl,
          onProgress: progress,
          onStatus: (s) => {
            if (s.phase === "negotiated") {
              setText("send-active-effective", describeEffective(s.effective, state.m, s.peerMode, "the recipient"));
              setText("send-active-status", s.fromChunk ? "Resuming…" : "Connecting…");
            }
            if (s.phase === "transport") {
              $("send-transfer").dataset.phase = "active";
              ui.setBadge($("send-badge"), s.via);
              setText("send-active-status", "Sending");
            }
            if (s.phase === "verifying") setText("send-active-status", "Verifying…");
          },
        });
        delivered = true;
        guardLeave = false;
        listener.close();
        frag.scrub();
        setText("send-done-file", `${file.name} (${fmtBytes(file.size)})`);
        show("send-done");
        ui.setStep("send-done", 3);
      } catch (err) {
        if (currentCtl !== ctl) return; // replaced by a newer connection
        $("send-transfer").dataset.phase = "waiting";
        if (err instanceof CancelledError) {
          guardLeave = false;
          listener.close();
          frag.scrub();
          setText("cancelled-text", err.message);
          show("cancelled");
        } else if (err instanceof FatalError) {
          setText("send-active-status", err.message);
        } else {
          setText("send-active-status", "Connection lost. Waiting for the recipient to reconnect…");
        }
      }
    },
  );
  setupShare(frag.shareLink(state));
  setText("send-active-status", "Waiting for the recipient to open the link…");
}

/**
 * Reports a failed startSender. Before it shows the transfer screen,
 * the error goes next to the control that started it (errorId); after,
 * that control is hidden, so it goes in the transfer's status line.
 */
function senderStartFailed(err, errorId) {
  if ($("send-active").hidden) { setText(errorId, err.message); return false; }
  guardLeave = false;
  setText("send-active-status", `Couldn't start sending: ${err.message}. Reload the page to try again.`);
  return true;
}

$("send-start").onclick = async () => {
  const file = $("send-file").files[0];
  const mode = pickedMode("send-mode");
  if (!file || !mode) return;
  $("send-start").disabled = true;
  $("send-start").textContent = "Creating link…";
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
    if (!senderStartFailed(err, "send-error")) {
      setText("send-error", `Couldn't create the link: ${err.message}`);
      updateStartButton();
    }
  }
};

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
  setText("send-resume-mode", modeName(state.m));
  $("send-resume-file").onchange = async () => {
    const file = $("send-resume-file").files[0];
    if (!file) return;
    if (!frag.sameFile(state.f, await frag.fileFingerprint(file))) {
      setText("send-resume-error", "That's not the same file. Its name, size or last-modified date is different.");
      return;
    }
    setText("send-resume-error", engineReady ? "" : "Getting ready…");
    whenReady(() => startSender(state, file).catch((err) => senderStartFailed(err, "send-resume-error")));
  };
}

// --- Receiver ----------------------------------------------------------------

let recvCtl = null;
let recvStopped = false;

// A fresh dial per attempt: each one sets up a new tunnel client, a
// clean slate if the sender's side changed (reloaded page).
const DIAL_TIMEOUT_MS = 20000;

async function receiverLoop(state) {
  if (state.rm === "privacy" || state.sm === "privacy") rtc.lockOutWebRTC();
  show("recv-active");
  ui.setStep("recv-active", 1);
  guardLeave = true;
  let progress = null;
  setText("recv-active-status", engineReady ? "Connecting…" : "Getting ready…");
  await engine.ready;
  const iceServers = state.rm === "performance" && state.sm === "performance" ? await rtc.stunServers(config.derpMapURL) : [];

  // attempt counts failures since the last session that got going. A
  // session that drops is redialed at once (the usual cause is the
  // sender reloading, and it's back within seconds); failed dials back
  // off, but briefly, so we notice soon once the sender returns.
  for (let attempt = 0; !recvStopped; attempt++) {
    if (attempt) {
      const wait = Math.min(5, attempt);
      for (let s = wait; s > 0 && !recvStopped; s--) {
        setText("recv-active-status", `Connection lost. Trying again in ${s} s. The sender needs to keep their page open.`);
        await sleep(1000);
      }
      if (recvStopped) return;
    }
    setText("recv-active-status", "Connecting…");
    let conn;
    try {
      conn = await engine.dial({ addr: state.a, derpMapURL: config.derpMapURL, clientKey: state.k, timeoutMs: DIAL_TIMEOUT_MS, verbose: config.verbose });
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
            attempt = -1; // got going: redial at once if this drops
            setText("recv-active-file", s.hello.name);
            $("recv-active-file").title = s.hello.name;
            setText("recv-active-size", fmtBytes(s.hello.size));
            setText("recv-active-ext", ui.fileExt(s.hello.name));
            progress = ui.progressView("recv-progress", "recv-progress-text", s.hello.size);
          }
          if (s.phase === "negotiated") {
            setText("recv-active-effective", describeEffective(s.effective, state.rm, s.peerMode, "the sender"));
            setText("recv-active-status", s.fromChunk ? "Resuming…" : "Connecting…");
          }
          if (s.phase === "transport") {
            $("recv-transfer").dataset.phase = "active";
            ui.setBadge($("recv-badge"), s.via);
            setText("recv-active-status", "Receiving");
          }
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
      $("recv-transfer").dataset.phase = "waiting";
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
  setText("cancelled-text", "You cancelled the transfer, and the partly downloaded file was deleted.");
  show("cancelled");
};

let downloadURL = null;

function showSave(state, meta) {
  guardLeave = false; // the data is safe in storage; a reload comes back here
  show("recv-save");
  ui.setStep("recv-save", 2);
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
  if (!(await storage.supported())) { show("unsupported"); return; }
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

const f = frag.decode();
if (!location.hash) {
  show("send-new");
  showPickedFile();
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

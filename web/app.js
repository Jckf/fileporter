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
import { keepAwake } from "./wakelock.js";
import * as dl from "./download.js";
import * as savefile from "./savefile.js";
import * as nativefile from "./nativefile.js";
import * as notify from "./notify.js";
import * as scan from "./scan.js";
import * as platform from "./platform.js";

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
// The same span also keeps the screen awake: a phone locking itself
// would suspend the page and drop the transfer.
function setGuard(on) {
  guardLeave = on;
  keepAwake(on);
  notify.transferring(on); // the app: "Transfer paused" if put in the background
}
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
      label.textContent = "Still getting ready. Trying again…";
      break;
    case "ready":
      status.dataset.state = "ready";
      engineReady = true;
      readyCallbacks.forEach((fn) => fn());
      break;
    case "error":
      status.dataset.state = "error";
      console.warn("engine failed to load:", s.error);
      label.textContent = "Couldn't get ready. Check your connection, then reopen fileporter.";
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

// In the app, a file picked through (or shared to) its Files plugin
// stands in for the input's.
let nativeChosen = null;
const chosenFile = () => nativeChosen ?? $("send-file").files[0];
function choose(file) {
  nativeChosen = file;
  showPickedFile();
}

function updateStartButton() {
  const file = chosenFile();
  const mode = pickedMode("send-mode");
  const btn = $("send-start");
  btn.disabled = !(file && mode && engineReady);
  btn.textContent = !engineReady ? "Getting ready…" : !file ? "Choose a file first" : !mode ? "Choose how to connect" : "Create link";
}

function showPickedFile() {
  const file = chosenFile();
  setText("drop-error", "");
  $("dropzone").hidden = !!file;
  $("send-file-card").hidden = !file;
  if (file) ui.fillFileCard($("send-file-card"), file);
  updateStartButton();
}

$("send-file").onchange = () => choose(null);
$("send-file-clear").onclick = () => {
  $("send-file").value = "";
  nativeChosen = null;
  showPickedFile();
  $("send-file").focus();
};
for (const r of document.querySelectorAll('input[name="send-mode"]')) r.onchange = updateStartButton;

// The app picks through its plugin instead of the web view's picker: it
// keeps access to the file, so an interrupted send carries on without
// asking for it again.
function nativePicker(input, onFile, errorId) {
  input.addEventListener("click", async (e) => {
    e.preventDefault();
    try {
      const file = await nativefile.pick();
      if (file) onFile(file);
    } catch (err) {
      setText(errorId, err.message);
    }
  });
}
let resumeWith = null; // set by senderResume
if (nativefile.picks()) {
  nativePicker($("send-file"), choose, "drop-error");
  nativePicker($("send-resume-file"), (file) => resumeWith?.(file), "send-resume-error");
}
whenReady(updateStartButton);

ui.setupDrop({
  zone: $("dropzone"),
  active: () => !$("send-new").hidden,
  onFile: (file) => ui.setInputFile($("send-file"), file),
  onError: (msg) => setText("drop-error", msg),
});

// --- Sender: sharing and sending ---------------------------------------------------

/**
 * Makes btn (icon + <span> label) copy text, confirming with
 * "Copied" for 2 s. onFail runs if the clipboard refuses.
 */
function copyButton(btn, text, onFail) {
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
    btn.querySelector("use").setAttribute("href", "#i-check");
    setTimeout(() => {
      btn.classList.remove("copied");
      btn.querySelector("span").textContent = label;
      btn.querySelector("use").setAttribute("href", "#i-copy");
    }, 2000);
  };
}

function setupShare(link) {
  $("share-link").value = link;
  $("share-link").onfocus = (e) => e.target.select();
  copyButton($("copy-link"), link, () => $("share-link").select()); // let the user copy manually
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
  const nativeShare = platform.plugin("Share");
  if (nativeShare) {
    $("native-share").hidden = false;
    $("native-share").onclick = () => nativeShare.share({ title: "fileporter", text: "A file for you:", url: link }).catch(() => {});
  } else if (navigator.share && navigator.canShare?.({ url: link })) {
    $("native-share").hidden = false;
    $("native-share").onclick = () => navigator.share({ title: "fileporter", text: "A file for you:", url: link }).catch(() => {});
  }
}

async function startSender(state, file) {
  // Enforce privacy before ANY engine call: from here on this page
  // can't create an RTCPeerConnection at all.
  if (state.m === "privacy") rtc.lockOutWebRTC();
  if (!(await storage.lock(state.id))) { show("busy"); return; }
  setGuard(true);
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
        setGuard(false);
        listener.close();
        frag.scrub();
        nativefile.retain(null);
        setText("send-done-file", `${file.name} (${fmtBytes(file.size)})`);
        show("send-done");
        ui.setStep("send-done", 3);
      } catch (err) {
        if (currentCtl !== ctl) return; // replaced by a newer connection
        $("send-transfer").dataset.phase = "waiting";
        if (err instanceof CancelledError) {
          setGuard(false);
          listener.close();
          frag.scrub();
          nativefile.retain(null);
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
  setGuard(false);
  setText("send-active-status", `Couldn't start sending: ${err.message}. Reopen fileporter to try again.`);
  return true;
}

$("send-start").onclick = async () => {
  const file = chosenFile();
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
      // The app's handle on the file, to send it again after a restart.
      ...(file.persistent ? { u: file.uri } : {}),
    };
    nativefile.retain(file.persistent ? file.uri : null);
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
  setGuard(false);
  frag.scrub();
  nativefile.retain(null);
  setText("cancelled-text", "You cancelled the transfer.");
  show("cancelled");
};

async function senderResume(state) {
  if (state.m === "privacy") rtc.lockOutWebRTC();
  resumeWith = async (file) => {
    if (!frag.sameFile(state.f, await frag.fileFingerprint(file))) {
      setText("send-resume-error", "That's not the same file. Choose the one you were sending.");
      return false;
    }
    setText("send-resume-error", engineReady ? "" : "Getting ready…");
    whenReady(() => startSender(state, file).catch((err) => senderStartFailed(err, "send-resume-error")));
    return true;
  };
  $("send-resume-file").onchange = () => {
    const file = $("send-resume-file").files[0];
    if (file) resumeWith(file);
  };
  // The app still has the file: carry on without asking for it.
  const kept = state.u && nativefile.available() ? await nativefile.open(state.u) : null;
  if (kept && (await resumeWith(kept))) return;
  setText("send-resume-error", "");
  show("send-resume");
  setText("send-resume-mode", modeName(state.m));
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
  setGuard(true);
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
        setText("recv-active-status", `Connection lost. Trying again in ${s} s. The sender needs to keep fileporter open.`);
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
        setGuard(false);
        frag.scrub();
        setText("cancelled-text", err.message);
        show("cancelled");
        return;
      }
      if (err instanceof FatalError) {
        setGuard(false);
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
$("busy-retry").onclick = () => location.reload();

$("recv-cancel").onclick = async () => {
  $("recv-cancel").disabled = true;
  recvStopped = true;
  await recvCtl?.cancel?.();
  const f = frag.decode();
  if (f) await storage.remove(f.state.id).catch(() => {});
  setGuard(false);
  frag.scrub();
  setText("cancelled-text", "You cancelled the transfer, and the partly received file was deleted.");
  show("cancelled");
};

let downloadURL = null;

function showSave(state, meta) {
  setGuard(false); // the data is safe in storage; a reload comes back here
  show("recv-save");
  ui.setStep("recv-save", 2);
  setText("recv-save-file", `${meta.name} (${fmtBytes(meta.size)})`);
  const btn = $("recv-save-btn");
  btn.onclick = async () => {
    btn.disabled = true; // one picker or download at a time
    try {
      await save();
    } catch (err) {
      setText("recv-save-status", `Couldn't save the file: ${err.message}. Try again.`);
    } finally {
      btn.disabled = false;
    }
  };
  const save = async () => {
    const data = await storage.getFile(state.id);
    if (savefile.available()) {
      // The app: the system's "Save as" dialog, through a native plugin.
      setText("recv-save-status", "Saving…");
      const result = await savefile.save(data, meta, (f) =>
        setText("recv-save-status", `Saving… ${Math.floor(f * 100)}%`));
      if (result === "done") {
        await clearReceived(state, "Saved. fileporter's temporary copy was removed.");
      } else {
        setText("recv-save-status", "");
      }
    } else if ("showSaveFilePicker" in window) {
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
      await clearReceived(state, "Saved. fileporter's temporary copy was removed.");
    } else {
      // Firefox, Safari: a regular download, through the download
      // worker, which says when the browser has read all of it.
      setText("recv-save-status", "Saving…");
      const result = await dl.download(state.id, meta);
      if (result === "done") {
        await clearReceived(state, "Saved to your downloads. fileporter's temporary copy was removed.");
        return;
      }
      if (result === "cancelled") {
        setText("recv-save-status", "Saving stopped before it finished. Save the file again to retry.");
        return;
      }
      // No worker here: a plain download from the stored file. Its end
      // can't be observed, so the user confirms before we delete it.
      downloadURL ??= URL.createObjectURL(new File([data], meta.name, { type: meta.type || "application/octet-stream" }));
      const a = document.createElement("a");
      a.href = downloadURL;
      a.download = meta.name;
      document.body.append(a);
      a.click();
      a.remove();
      $("recv-clear").hidden = false;
      setText("recv-save-status", "When the file has finished saving, remove fileporter's temporary copy.");
    }
  };
  $("recv-clear").onclick = () => clearReceived(state, "fileporter's temporary copy was removed.");
}

async function clearReceived(state, message) {
  if (downloadURL) { URL.revokeObjectURL(downloadURL); downloadURL = null; }
  await storage.remove(state.id);
  frag.scrub();
  setText("recv-cleared-text", message);
  show("recv-cleared");
}

async function receiver(state) {
  if (!(await storage.supported())) {
    // The way out is opening the link elsewhere, and in a private tab
    // (on phones especially) the address isn't easy to get at.
    const btn = $("unsupported-copy");
    btn.hidden = false;
    // (In the app, the public address: its own means nothing elsewhere.)
    copyButton(btn, new URL(location.hash, platform.publicBase()).href, () => {
      btn.querySelector("span").textContent = "Couldn't copy the link";
      btn.disabled = true;
    });
    show("unsupported");
    return;
  }
  if (!(await storage.lock(state.id))) { show("busy"); return; }
  startSweeping(state.id);
  dl.prepare(); // active by the time the file is saved

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

// In the app, a tapped fileporter link arrives as a launch URL, or as an
// event while the app runs; either way its fragment becomes ours.
// A file shared to the app from another app starts a new send (and a
// shared fileporter link opens).
let shared = null;
if (platform.isApp) {
  platform.onLinkOpened((hash) => { location.hash = hash; }); // hashchange reloads
  nativefile.onShared(() => {
    if (guardLeave && !confirm("Stop this transfer and send the shared file instead?")) {
      nativefile.takeShared(); // declined: don't pick it up later
      return;
    }
    setGuard(false);
    location.href = "./"; // picked up below, on the start page
  });
  const fresh = frag.freshStart();
  shared = await nativefile.takeShared();
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
  choose(shared?.file ?? null);
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

// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// The receiving side: choosing a mode, receiving (redialing as needed),
// and saving the received file.

import { config } from "./config.js";
import * as dl from "./download.js";
import * as engine from "./engine.js";
import * as frag from "./fragment.js";
import * as platform from "./platform.js";
import * as rtc from "./rtc.js";
import * as savefile from "./savefile.js";
import * as savetarget from "./savetarget.js";
import * as storage from "./storage.js";
import * as ui from "./ui.js";
import { receiverSession, FatalError, CancelledError, NeedsRoomError, fmtBytes } from "./session.js";
import {
  $, show, announce, setText, sleep, setGuard, engineReady, engineError, ENGINE_FAILED, errText, pickedMode,
  describeEffective, startSweeping, showCancelled, copyButton, relayName, stallWatch,
} from "./shell.js";

// --- Receiving ----------------------------------------------------------------

let recvCtl = null;
let recvStopped = false;

// Leaving (or reloading): tell the peer, so it can reconnect right away
// instead of waiting for the keepalive timeout. Best effort, see bye()
// in transport.js. (Not from beforeunload: the user may still cancel.)
addEventListener("pagehide", () => recvCtl?.bye?.());


/** The receive was cancelled (by either side): delete what arrived and forget the transfer. */
async function discardReceived(state, text) {
  await storage.remove(state.id).catch(() => {});
  await savetarget.discard(state.id);
  setGuard(false);
  frag.scrub();
  showCancelled(text);
}

// A fresh dial per attempt: each one sets up a new tunnel client, a
// clean slate if the sender's side changed (reloaded page).
const DIAL_TIMEOUT_MS = 20000;

/** Shows a prompt with one button and resolves with the first click that `action` accepts (returns non-null for). */
function askUser(text, label, action) {
  setText("recv-pick-text", text);
  setText("recv-pick-label", label);
  $("recv-pick").hidden = false;
  return new Promise((resolve) => {
    const btn = $("recv-pick-btn");
    btn.disabled = false;
    btn.focus(); // (not a click: the picker still needs one)
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const v = await action();
        if (v != null) {
          $("recv-pick").hidden = true;
          btn.onclick = null;
          resolve(v);
          return;
        }
      } catch (err) {
        setText("recv-active-status", `Something went wrong: ${errText(err)}. Try again.`);
      }
      btn.disabled = false;
    };
  });
}

/**
 * Has the user pick a file to receive into, replacing whatever was
 * received so far. The picker needs a click, hence the button.
 */
async function chooseTarget(state, name, text) {
  setText("recv-active-status", "Waiting for you to choose where to save the file.");
  const handle = await askUser(text, "Choose where to save", () => savetarget.pick(name));
  await storage.remove(state.id);
  await savetarget.set(state.id, handle);
  return handle;
}

/** The picked file from an earlier visit, once writing to it is allowed again; or a new one. */
async function regainTarget(state, handle) {
  if (await savetarget.permitted(handle)) return handle;
  setText("recv-active-status", "Waiting for you to continue.");
  let denied = false;
  return askUser(`To carry on, allow fileporter to keep saving to ${handle.name}.`, "Continue", async () => {
    if (!denied) {
      if (await savetarget.requestPermission(handle)) return handle;
      denied = true;
      setText("recv-pick-text", `fileporter wasn't allowed to save to ${handle.name}. Choose where to save the file instead, and receiving starts over.`);
      setText("recv-pick-label", "Choose where to save");
      return null;
    }
    const h = await savetarget.pick(handle.name);
    if (h) {
      await storage.remove(state.id);
      await savetarget.set(state.id, h);
    }
    return h;
  });
}

// Without a save picker (Firefox, Safari), a file too big for the
// storage limit may still fit once the browser keeps our storage
// persistent: Firefox then allows far more, and asks the user first.
// Asked at most once per page.
let persistAsked = false;
const canAskPersist = async () =>
  !persistAsked && !!navigator.storage?.persist && !(await navigator.storage.persisted().catch(() => true));

async function askPersist(hello) {
  persistAsked = true;
  setText("recv-active-status", "Waiting for you to allow more storage.");
  await askUser(`This file is ${fmtBytes(hello.size)}, more than your browser lets fileporter store unless you allow it. Allow more storage, and say yes if your browser asks.`,
    "Allow more storage", async () => {
      console.info("persistent storage:", await navigator.storage.persist().catch(() => false));
      return true;
    });
}

async function receiverLoop(state) {
  if (state.rm === "privacy" || state.sm === "privacy") rtc.lockOutWebRTC();
  $("recv-cancel").onclick = async () => {
    $("recv-cancel").disabled = true;
    recvStopped = true;
    await recvCtl?.cancel?.();
    await discardReceived(state, "You cancelled the transfer, and the partly received file was deleted.");
  };
  show("recv-active");
  ui.setStep("recv-active", 1);
  setGuard(true);
  let progress = null;
  let stall = null;
  // A file the user picked to receive into, for files too big for the
  // browser's storage (see savetarget.js).
  let target = await savetarget.get(state.id);
  if (target) target = await regainTarget(state, target);
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
      // Said once; the status line counts down silently meanwhile.
      announce("Connection lost. Trying again shortly. The sender needs to keep fileporter open.");
      const status = $("recv-active-status");
      status.setAttribute("aria-live", "off");
      for (let s = wait; s > 0 && !recvStopped; s--) {
        setText("recv-active-status", `Connection lost. Trying again in ${s} s. The sender needs to keep fileporter open.`);
        await sleep(1000);
      }
      status.setAttribute("aria-live", "polite");
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
        state, target, canMakeRoom: savetarget.available() || (await canAskPersist()), iceServers, iceTimeoutMs: config.iceTimeoutMs, ctl,
        onProgress: (b) => { progress?.(b); stall?.progress(b); },
        onStatus: (s) => {
          if (s.phase === "hello") {
            attempt = -1; // got going: redial at once if this drops
            setText("recv-active-file", s.hello.name);
            $("recv-active-file").title = s.hello.name;
            setText("recv-active-size", fmtBytes(s.hello.size));
            setText("recv-active-ext", ui.fileExt(s.hello.name));
            progress = ui.progressView("recv-progress", "recv-progress-text", s.hello.size);
            // Reconnecting drops this session, and the loop redials at once.
            stall ||= stallWatch("recv", s.hello.size, () => recvCtl?.stop?.());
          }
          if (s.phase === "negotiated") {
            setText("recv-active-effective", describeEffective(s.effective, state.rm, s.peerMode, "the sender"));
            setText("recv-active-status", s.fromChunk ? "Resuming…" : "Connecting…");
          }
          if (s.phase === "transport") {
            $("recv-transfer").dataset.phase = "active";
            ui.setBadge($("recv-badge"), s.via, s.turn ? "the sender's" : null);
            setText("recv-active-status", "Receiving");
            stall?.start(s.turn ? "turn" : s.via, relayName(conn.region));
          }
          if (s.phase === "verifying") {
            stall?.stop();
            setText("recv-active-status", "Verifying…");
          }
        },
      });
      recvCtl = null;
      stall?.stop();
      if (target) {
        await savedDirectly(state, target.name);
        return;
      }
      showSave(state, { name: res.hello.name, size: res.hello.size, type: res.hello.type });
      return;
    } catch (err) {
      recvCtl = null;
      stall?.stop();
      if (recvStopped) return;
      if (err instanceof NeedsRoomError) {
        if (savetarget.available()) {
          target = await chooseTarget(state, err.hello.name, "Choose where to save this file.");
        } else {
          await askPersist(err.hello); // if that wasn't enough, the next try says so
        }
        attempt = -1; // redial at once
        continue;
      }
      if (target && err.name === "NotFoundError") {
        // The file being received into was moved or deleted.
        target = await chooseTarget(state, target.name,
          `The file fileporter was saving to (${target.name}) is gone. Choose where to save it, and receiving starts over.`);
        attempt = -1;
        continue;
      }
      if (err instanceof CancelledError) {
        await discardReceived(state, err.message);
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

/**
 * receiverLoop failed outright (not a session: those it handles), e.g.
 * the engine couldn't load or storage failed: say so and offer a retry
 * rather than leave "Getting ready…" up for good.
 */
function receiverFailed(err) {
  console.warn("receiving failed:", err);
  recvCtl = null;
  setGuard(false);
  setText("recv-active-status", engineError ? ENGINE_FAILED : `Something went wrong: ${errText(err)}. Reload to try again.`);
  $("recv-retry").hidden = false;
}

$("recv-retry").onclick = () => location.reload();
$("busy-retry").onclick = () => location.reload();


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
      setText("recv-save-status", `Couldn't save the file: ${errText(err)}. Try again.`);
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

/** Received into a picked file: nothing left to save. */
async function savedDirectly(state, name) {
  setGuard(false);
  await savetarget.forget(state.id);
  await clearReceived(state, `Saved to ${name}. The file arrived and was verified.`);
}

async function clearReceived(state, message) {
  if (downloadURL) { URL.revokeObjectURL(downloadURL); downloadURL = null; }
  await storage.remove(state.id);
  frag.scrub();
  setText("recv-cleared-text", message);
  show("recv-cleared");
}

export async function receiver(state) {
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
    if (existing.meta.direct) await savedDirectly(state, (await savetarget.get(state.id))?.name || existing.meta.name);
    else showSave(state, existing.meta);
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
    receiverLoop(state).catch(receiverFailed);
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
    receiverLoop(state).catch(receiverFailed);
  };
}


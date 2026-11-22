// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// The sending side: picking a file, creating and sharing the link,
// sending, and resuming a send after a reload.

import { config } from "./config.js";
import * as engine from "./engine.js";
import * as frag from "./fragment.js";
import * as nativefile from "./nativefile.js";
import * as platform from "./platform.js";
import * as relay from "./relay.js";
import * as rtc from "./rtc.js";
import * as storage from "./storage.js";
import * as turn from "./turn.js";
import * as ui from "./ui.js";
import { senderSession, ChunkHashes, FatalError, CancelledError, fmtBytes } from "./session.js";
import {
  $, show, setText, setGuard, engineReady, engineError, engineFailedText, whenReady, whenFailed, errText, pickedMode, modeName,
  showCancelled, copyButton, stallWatch, sessionStatus, byeOnLeave,
} from "./shell.js";

// --- Picking a file ----------------------------------------------------

let listener = null;
let currentCtl = null;
let delivered = false;
// Set by Cancel, which shows while sending is still starting: startSender
// checks it after each wait, so a listener that comes up afterwards is
// closed instead of shared.
let sendCancelled = false;
// Takes the file picked on the resume screen (set by senderResume).
let resumeWith = null;

byeOnLeave(() => currentCtl);


/** The send is over (delivered, cancelled or abandoned): stop listening, guarding and remembering it. */
function endSend() {
  setGuard(false);
  listener?.close();
  frag.scrub();
  nativefile.retain(null);
}

// In the app, a file picked through (or shared to) its Files plugin
// stands in for the input's.
let nativeChosen = null;
const chosenFile = () => nativeChosen ?? $("send-file").files[0];
/** Uses the app's file (null: the input's, as picked or dropped). */
function setNativeFile(file) {
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
  if (file) {
    ui.fillFileCard($("send-file-card"), file);
    nearestRegion();
  }
  updateStartButton();
}

// The sender's own TURN server (turn.js), offered with Fast.
const TURN_SAVED = "Saved. It's used when a direct connection isn't possible.";
const turnStatus = (text, error = false) => {
  const st = $("turn-status");
  st.classList.toggle("error", error);
  st.textContent = text;
};
function showTurnSettings() {
  const [saved] = turn.load();
  $("turn-urls").value = saved ? saved.urls.join(" ") : "";
  $("turn-username").value = saved?.username || "";
  $("turn-credential").value = saved?.credential || "";
  $("turn-clear").hidden = !saved;
  return saved;
}
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

/**
 * Sets up the start page (choosing a file and how to connect, TURN
 * settings, "Create link") with `file` chosen, if given (the app's
 * shared file). Only routed to on the start page.
 */
export function initSendPage(file) {
  $("send-file").onchange = () => setNativeFile(null);
  $("send-file-clear").onclick = () => {
    $("send-file").value = "";
    nativeChosen = null;
    showPickedFile();
    $("send-file").focus();
  };
  for (const r of document.querySelectorAll('input[name="send-mode"]')) {
    r.onchange = () => {
      updateStartButton();
      $("turn-settings").hidden = pickedMode("send-mode") !== "performance";
    };
  }

  // (A reload can restore the choice.)
  $("turn-settings").hidden = pickedMode("send-mode") !== "performance";

  if (showTurnSettings()) turnStatus(TURN_SAVED);
  $("turn-save").onclick = () => {
    try {
      const servers = turn.parse($("turn-urls").value, $("turn-username").value, $("turn-credential").value);
      if (!turn.save(servers)) throw new Error("This browser won't let fileporter save it.");
      showTurnSettings();
      turnStatus(servers.length ? TURN_SAVED : "Removed.");
    } catch (err) {
      turnStatus(err.message, true);
    }
  };
  $("turn-clear").onclick = () => {
    turn.save([]);
    showTurnSettings();
    turnStatus("Removed.");
  };

  if (nativefile.picks()) nativePicker($("send-file"), setNativeFile, "drop-error");
  whenReady(updateStartButton);

  ui.setupDrop({
    zone: $("dropzone"),
    active: () => !$("send-new").hidden,
    onFile: (file) => ui.setInputFile($("send-file"), file),
    onError: (msg) => setText("drop-error", msg),
  });

  $("send-start").onclick = async () => {
    const file = chosenFile();
    const mode = pickedMode("send-mode");
    if (!file || !mode) return;
    // A Private attempt that failed has locked WebRTC out of this page for
    // good (rtc.lockOutWebRTC), so Fast would quietly use the relay.
    if (mode === "performance" && rtc.isLockedOut()) {
      setText("send-error", "Private stays on for this page. To use Fast, reload fileporter first.");
      return;
    }
    $("send-start").disabled = true;
    $("send-start").textContent = "Creating link…";
    try {
      if (mode === "privacy") rtc.lockOutWebRTC();
      const s = await engine.newSession({ derpMapURL: config.derpMapURL, regionID: await nearestRegion() });
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
      senderStartFailed(err, () => {
        // Nothing was sent: forget the session, so a reload starts over
        // instead of resuming one that was given up.
        frag.scrub();
        nativefile.retain(null);
        setText("send-error", `Couldn't create the link: ${errText(err)}.`);
        updateStartButton();
      });
    }
  };
  setNativeFile(file);
}

// --- Sharing and sending ---------------------------------------------------

function setupShare(link) {
  $("send-link").value = link;
  $("send-link").onfocus = (e) => e.target.select();
  copyButton($("copy-link"), link, () => $("send-link").select()); // let the user copy manually
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
  const share = nativeShare ? (d) => nativeShare.share(d)
    : navigator.share && navigator.canShare?.({ url: link }) ? (d) => navigator.share(d)
      : null;
  if (share) {
    $("send-via-app").hidden = false;
    $("send-via-app").onclick = () => share({ title: "fileporter", text: "A file for you:", url: link }).catch(() => {});
  }
  // Only now that they work.
  $("send-invite").hidden = false;
}

async function startSender(state, file) {
  // Enforce privacy before ANY engine call: from here on this page
  // can't create an RTCPeerConnection at all.
  if (state.m === "privacy") rtc.lockOutWebRTC();
  if (!(await storage.lock(state.id))) { show("busy"); return; }
  setGuard(true);
  $("send-cancel").onclick = async () => {
    $("send-cancel").disabled = true;
    sendCancelled = true;
    await currentCtl?.cancel?.();
    endSend();
    showCancelled("You cancelled the transfer.");
  };
  show("send-active");
  ui.setStep("send-active", 1);
  setText("send-active-effective", state.m === "performance"
    ? "You chose Fast. It's only used if the recipient also chooses Fast."
    : "You chose Private. The recipient won't see your IP address.");
  ui.fillFileCard($("send-active").querySelector(".file-card"), file);
  setText("send-active-status", "Starting…");
  $("send-invite").hidden = true; // until setupShare: there's no link yet
  const shown = ui.progressView("send-progress", "send-progress-text", file.size);
  // Reconnecting drops this session; the recipient redials.
  const stall = stallWatch("send", file.size, () => currentCtl?.stop?.());
  const progress = (b) => { shown(b); stall.progress(b); };
  progress(0);

  const hashes = new ChunkHashes(file);
  const iceServers = state.m === "performance" ? await rtc.stunServers(config.derpMapURL) : [];
  if (sendCancelled) return;
  listener = await engine.listen(
    { derpMapURL: config.derpMapURL, senderKey: state.sk, allowClient: state.rp, verbose: config.verbose },
    async (conn) => {
      if (delivered) { conn.close(); return; }
      // One receiver key, one session at a time: a reconnect replaces
      // the previous session.
      currentCtl?.stop?.();
      const ctl = {};
      currentCtl = ctl;
      $("send-invite").hidden = true;
      ui.setStep("send-active", 2);
      setText("send-active-status", "Recipient connected…");
      try {
        await senderSession(conn, {
          state, file, hashes, iceServers, iceTimeoutMs: config.iceTimeoutMs, ctl,
        turnServers: state.m === "performance" ? turn.load() : [],
          onProgress: progress,
          onStatus: sessionStatus("send", {
            mine: state.m, peerRole: "the recipient", turnOwner: "your", active: "Sending",
            stall: () => stall, region: () => listener.region,
          }),
        });
        delivered = true;
        stall.stop();
        endSend();
        setText("send-done-file", `${file.name} (${fmtBytes(file.size)})`);
        show("send-done");
        ui.setStep("send-done", 3);
      } catch (err) {
        if (currentCtl !== ctl) return; // replaced by a newer connection
        stall.stop();
        $("send-transfer").dataset.phase = "waiting";
        if (err instanceof CancelledError) {
          endSend();
          showCancelled(err.message);
        } else if (err instanceof FatalError) {
          setText("send-active-status", err.message);
        } else if (engineError) {
          // The engine failed (whenFailed below said so first): no
          // recipient can reconnect, so keep saying that.
          setText("send-active-status", engineFailedText());
        } else {
          setText("send-active-status", "Connection lost. Waiting for the recipient to reconnect…");
        }
      }
    },
  );
  if (sendCancelled) { listener.close(); return; }
  // The engine stopping for good (it can't restart in this page): say so
  // rather than keep waiting for a recipient who can't get through.
  whenFailed(() => {
    if (delivered || sendCancelled) return;
    setGuard(false);
    setText("send-active-status", engineFailedText());
  });
  setupShare(frag.shareLink(state));
  setText("send-active-status", "Waiting for the recipient to open the link…");
}

/**
 * Reports a failed start of sending. Before the transfer screen shows,
 * the caller says so next to the control that started it (before(err));
 * after, that control is hidden, so it goes in the transfer's status line.
 */
function senderStartFailed(err, before) {
  if ($("send-active").hidden) { before(err); return; }
  setGuard(false);
  setText("send-active-status", `Couldn't start sending: ${errText(err)}. Reopen fileporter to try again.`);
}

// The relay nearest this device, measured once (relay.js); started when
// a file is chosen (not before: no requests to the relays until then),
// so it's usually known by "Create link".
let regionP = null;
const nearestRegion = () => (regionP ||= relay.nearestRegion(config.derpMapURL));

export async function senderResume(state) {
  if (state.m === "privacy") rtc.lockOutWebRTC();
  // Nothing is connected yet here, so the recipient can't be told.
  $("send-resume-cancel").onclick = () => {
    resumeWith = null;
    endSend();
    showCancelled("You cancelled the transfer. If the recipient is still waiting, let them know it won't continue.");
  };
  if (nativefile.picks()) nativePicker($("send-resume-file"), (file) => resumeWith?.(file), "send-resume-error");
  let accepted = false;
  resumeWith = async (file) => {
    // Once a file is accepted, sending starts (perhaps after the engine
    // loads); picking again meanwhile mustn't start a second sender.
    if (accepted) return true;
    if (!frag.sameFile(state.f, await frag.fileFingerprint(file))) {
      setText("send-resume-error", "That's not the same file. Choose the one you were sending.");
      return false;
    }
    if (accepted) return true; // (a pick that finished while this one was checked)
    accepted = true;
    setText("send-resume-error", engineReady ? "" : "Getting ready…");
    engine.ready.then(
      () => resumeWith && startSender(state, file).catch((err) => senderStartFailed(err, () => {
        // So choosing the file again tries again: in a browser the input
        // must be cleared too, or picking the same file fires no change.
        accepted = false;
        $("send-resume-file").value = "";
        setText("send-resume-error", `Couldn't carry on sending: ${errText(err)}.`);
      })),
      () => setText("send-resume-error", engineFailedText()),
    );
    return true;
  };
  $("send-resume-file").onchange = () => {
    const file = $("send-resume-file").files[0];
    if (file) resumeWith(file);
  };
  // Shown first, even when the app still has the file: until sending
  // takes over (after the engine loads), it's where "Getting ready…" and
  // any failure appear.
  setText("send-resume-error", "");
  setText("send-resume-mode", modeName(state.m));
  show("send-resume");
  // The app still has the file: carry on without asking for it.
  const kept = state.u && nativefile.available() ? await nativefile.open(state.u) : null;
  if (kept) await resumeWith(kept);
}


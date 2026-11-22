// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// WebRTC, used only when BOTH peers chose performance mode.
//
// Privacy is enforced locally, in two layers:
//   1. lockOutWebRTC() replaces the RTCPeerConnection constructors with
//      ones that throw. app.js calls it as soon as the local user picks
//      privacy (or the sender's link says privacy), before any engine
//      call, so no ICE gathering can ever start in this page.
//   2. connect() refuses unless both local and effective modes are
//      "performance".
// Neither the peer nor an edited link can turn this back on.

let lockedOut = false;

export function lockOutWebRTC() {
  if (lockedOut) return;
  lockedOut = true;
  const blocked = function () { throw new Error("WebRTC disabled: privacy mode"); };
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "mozRTCPeerConnection"]) {
    if (name in globalThis) {
      Object.defineProperty(globalThis, name, { value: blocked, writable: false, configurable: false });
    }
  }
}

export const isLockedOut = () => lockedOut;

/**
 * STUN servers from the DERP map: the relays double as STUN servers.
 * Optional, so a slow or failing fetch gives up rather than hold up
 * the transfer.
 */
export async function stunServers(derpMapURL, max = 2) {
  try {
    const dm = await (await fetch(derpMapURL, { signal: AbortSignal.timeout(5000) })).json();
    const urls = [];
    for (const r of Object.values(dm.Regions || {})) {
      for (const n of r.Nodes || []) {
        if (n.STUNPort === -1 || !n.HostName) continue;
        urls.push(`stun:${n.HostName}:${n.STUNPort || 3478}`);
        break; // one node per region is plenty
      }
      if (urls.length >= max) break;
    }
    return urls.length ? [{ urls }] : [];
  } catch {
    return [];
  }
}

/**
 * Whether the connection goes through a TURN relay (the sender's own,
 * see turn.js) rather than directly. False if it can't tell.
 */
export async function usesRelay(pc) {
  try {
    const stats = [...(await pc.getStats()).values()];
    const byId = new Map(stats.map((s) => [s.id, s]));
    const transport = stats.find((s) => s.type === "transport" && s.selectedCandidatePairId);
    const pair = transport ? byId.get(transport.selectedCandidatePairId)
      : stats.find((s) => s.type === "candidate-pair" && s.nominated && s.state === "succeeded");
    if (!pair) return false;
    return [pair.localCandidateId, pair.remoteCandidateId].some((id) => byId.get(id)?.candidateType === "relay");
  } catch {
    return false;
  }
}

/**
 * Buffers messages from the moment the channel exists, so nothing the
 * peer sends right after open is lost. dc.takeOver(fn) replays the
 * buffer into fn and then delivers new messages to it directly.
 */
function bufferMessages(dc) {
  const queue = [];
  dc.onmessage = (e) => queue.push(e.data);
  dc.takeOver = (fn) => {
    for (const d of queue.splice(0)) fn(d);
    dc.onmessage = (e) => fn(e.data);
  };
}

/**
 * Negotiates a data channel over the framed tailcat control channel.
 * The offerer is the sender. Resolves to an open RTCDataChannel, or
 * rejects on timeout/failure (caller falls back to the relay).
 *
 * `signal` must deliver incoming {t:"rtc"|"ice"} control messages via
 * signal.onMessage = fn, and send via signal.send(msg).
 */
export async function connect({ localMode, effectiveMode, offerer, signal, iceServers, timeoutMs }) {
  if (lockedOut || localMode !== "performance" || effectiveMode !== "performance") {
    throw new Error("refusing WebRTC outside performance mode");
  }
  const pc = new RTCPeerConnection({ iceServers });
  let timer;
  const cleanup = () => clearTimeout(timer);
  const opened = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("ICE timeout")), timeoutMs);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") reject(new Error("ICE failed"));
    };
    const onChannel = (dc) => {
      dc.binaryType = "arraybuffer";
      // Buffer from the very start: the peer may send as soon as the
      // channel opens, before our caller attaches a consumer.
      bufferMessages(dc);
      if (dc.readyState === "open") resolve(dc);
      else dc.onopen = () => resolve(dc);
    };
    if (offerer) onChannel(pc.createDataChannel("fileporter", { ordered: true }));
    else pc.ondatachannel = (e) => onChannel(e.channel);
  });

  pc.onicecandidate = (e) => { if (e.candidate) signal.send({ t: "ice", c: e.candidate.toJSON() }); };
  // Remote candidates can't be added before the remote description.
  const earlyCandidates = [];
  signal.onMessage = async (m) => {
    try {
      if (m.t === "rtc") {
        await pc.setRemoteDescription(m.desc);
        if (m.desc.type === "offer") {
          await pc.setLocalDescription();
          signal.send({ t: "rtc", desc: pc.localDescription.toJSON() });
        }
        for (const c of earlyCandidates.splice(0)) await pc.addIceCandidate(c);
      } else if (m.t === "ice") {
        if (pc.remoteDescription) await pc.addIceCandidate(m.c);
        else earlyCandidates.push(m.c);
      }
    } catch (err) {
      console.warn("signaling error", err);
    }
  };
  try {
    if (offerer) {
      await pc.setLocalDescription();
      signal.send({ t: "rtc", desc: pc.localDescription.toJSON() });
    }
    const dc = await opened;
    cleanup();
    return { pc, dc };
  } catch (err) {
    cleanup();
    pc.close();
    throw err;
  }
}

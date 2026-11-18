// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// Session state lives only in the URL fragment (never sent to any
// server, never written to storage). Reopening the same URL resumes;
// navigating away loses the session.
//
//   Sender:   #s.<b64url JSON>  {v, id, sk, ak, rp, a, m, f}
//   Receiver: #r.<b64url JSON>  {v, id, a, k, sm, rm?}
//
//   id  transfer id (random, also names the receiver's OPFS directory)
//   sk  sender tailcat.PrivateKey JSON          (sender only)
//   rk  receiver "privkey:…"                    (sender keeps it to re-show the link)
//   rp  receiver "nodekey:…" (allowlisted)      (sender only)
//   a   sender "tc…" address
//   k   receiver "privkey:…"                    (receiver only)
//   m   sender's mode / sm: sender's mode as seen by receiver
//   rm  receiver's mode, added once chosen
//   f   file fingerprint {s: size, t: lastModified, nh: SHA-256(name) hex prefix}

export const MODES = ["privacy", "performance"];
const VERSION = 1;

const b64urlEncode = (s) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const b64urlDecode = (s) => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(b, (c) => c.charCodeAt(0)));
};

export function encode(role, state) {
  return `#${role}.${b64urlEncode(JSON.stringify({ v: VERSION, ...state }))}`;
}

/** Returns {role:"s"|"r", state} or null if the fragment is absent or invalid. */
export function decode(hash = location.hash) {
  const m = /^#([sr])\.([A-Za-z0-9_-]+)$/.exec(hash);
  if (!m) return null;
  try {
    const state = JSON.parse(b64urlDecode(m[2]));
    if (state.v !== VERSION || typeof state.id !== "string") return null;
    const modeOK = (x) => x === undefined || MODES.includes(x);
    if (m[1] === "s" && !(state.sk && state.rp && state.rk && state.a && MODES.includes(state.m))) return null;
    if (m[1] === "r" && !(state.a && state.k && MODES.includes(state.sm) && modeOK(state.rm))) return null;
    return { role: m[1], state };
  } catch {
    return null;
  }
}

/** Replace the current history entry's fragment (no new history entry). */
export function set(role, state) {
  history.replaceState(null, "", location.pathname + location.search + encode(role, state));
}

/** Remove the fragment (and with it the keys) from the current history entry. */
export function scrub() {
  history.replaceState(null, "", location.pathname + location.search);
}

export function shareLink(senderState) {
  const url = new URL(location.href);
  url.hash = encode("r", { id: senderState.id, a: senderState.a, k: senderState.rk, sm: senderState.m });
  return url.toString();
}

export function newTransferId() {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export async function fileFingerprint(file) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(file.name));
  const nh = Array.from(new Uint8Array(d).subarray(0, 8), (x) => x.toString(16).padStart(2, "0")).join("");
  return { s: file.size, t: file.lastModified, nh };
}

export const sameFile = (a, b) => a && b && a.s === b.s && a.t === b.t && a.nh === b.nh;

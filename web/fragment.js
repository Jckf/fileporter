// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// Session state lives only in the URL fragment (never sent to any
// server, never written to storage). Reopening the same URL resumes;
// navigating away loses the session.
//
//   Sender:   #s.<b64url JSON>  {v, id, sk, rk, rp, a, m, f}
//   Receiver: #R<b64url bytes>  compact binary, see below
//             #r.<b64url JSON>  {v, id, a, k, sm, rm?}   (older links; still accepted)
//
//   id  transfer id (12 random bytes, hex; also names the receiver's OPFS directory)
//   sk  sender tailcat.PrivateKey JSON          (sender only)
//   rk  receiver "privkey:…"                    (sender keeps it to re-show the link)
//   rp  receiver "nodekey:…" (allowlisted)      (sender only)
//   a   sender "tc…" address
//   k   receiver "privkey:…"                    (receiver only)
//   m   sender's mode / sm: sender's mode as seen by receiver
//   rm  receiver's mode, added once chosen
//   f   file fingerprint {s: size, t: lastModified, nh: SHA-256(name) hex prefix}
//
// The receiver link is the one people share (and scan as a QR code), so
// it is packed:
//
//   [0]       flags: bit 0 = sender chose performance;
//                    bits 1-2 = receiver mode (0 unset, 1 privacy, 2 performance)
//   [1..12]   id
//   [13..44]  receiver private key (raw 32 bytes of "privkey:<hex>")
//   [45..]    sender address (raw bytes of "tc<base64url>")

import { publicBase } from "./platform.js";

export const MODES = ["privacy", "performance"];
const VERSION = 1;
const ID_LEN = 12;
const KEY_LEN = 32;

const toB64url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const toHex = (u8) => Array.from(u8, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => {
  if (!/^([0-9a-f]{2})*$/.test(h)) throw new Error("bad hex");
  return Uint8Array.from(h.match(/../g) || [], (x) => parseInt(x, 16));
};

function packReceiver(st) {
  const addr = st.a.startsWith("tc") ? fromB64url(st.a.slice(2)) : null;
  const key = st.k.startsWith("privkey:") ? fromHex(st.k.slice(8)) : null;
  const id = fromHex(st.id);
  if (!addr || key?.length !== KEY_LEN || id.length !== ID_LEN) throw new Error("cannot pack receiver state");
  const out = new Uint8Array(1 + ID_LEN + KEY_LEN + addr.length);
  out[0] = (st.sm === "performance" ? 1 : 0) | ({ privacy: 1, performance: 2 }[st.rm] || 0) << 1;
  out.set(id, 1);
  out.set(key, 1 + ID_LEN);
  out.set(addr, 1 + ID_LEN + KEY_LEN);
  return toB64url(out);
}

function unpackReceiver(s) {
  const b = fromB64url(s);
  if (b.length <= 1 + ID_LEN + KEY_LEN) throw new Error("short");
  const rmBits = (b[0] >> 1) & 3;
  if (b[0] & ~7 || rmBits === 3) throw new Error("bad flags");
  return {
    v: VERSION,
    id: toHex(b.subarray(1, 1 + ID_LEN)),
    k: "privkey:" + toHex(b.subarray(1 + ID_LEN, 1 + ID_LEN + KEY_LEN)),
    a: "tc" + toB64url(b.subarray(1 + ID_LEN + KEY_LEN)),
    sm: b[0] & 1 ? "performance" : "privacy",
    ...(rmBits ? { rm: rmBits === 1 ? "privacy" : "performance" } : {}),
  };
}

const jsonEncode = (o) => toB64url(new TextEncoder().encode(JSON.stringify(o)));
const jsonDecode = (s) => JSON.parse(new TextDecoder().decode(fromB64url(s)));

export function encode(role, state) {
  if (role === "r") return `#R${packReceiver(state)}`;
  return `#${role}.${jsonEncode({ v: VERSION, ...state })}`;
}

function valid(role, state) {
  const modeOK = (x) => x === undefined || MODES.includes(x);
  if (state.v !== VERSION || typeof state.id !== "string") return false;
  if (role === "s") return !!(state.sk && state.rp && state.rk && state.a && MODES.includes(state.m));
  return !!(state.a && state.k && MODES.includes(state.sm) && modeOK(state.rm));
}

/** Returns {role:"s"|"r", state} or null if the fragment is absent or invalid. */
export function decode(hash = location.hash) {
  try {
    let m = /^#R([A-Za-z0-9_-]+)$/.exec(hash);
    if (m) {
      const state = unpackReceiver(m[1]);
      return valid("r", state) ? { role: "r", state } : null;
    }
    m = /^#([sr])\.([A-Za-z0-9_-]+)$/.exec(hash);
    if (!m) return null;
    const state = jsonDecode(m[2]);
    return valid(m[1], state) ? { role: m[1], state } : null;
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
  const url = new URL(publicBase());
  url.hash = encode("r", { id: senderState.id, a: senderState.a, k: senderState.rk, sm: senderState.m });
  return url.toString();
}

export function newTransferId() {
  return toHex(crypto.getRandomValues(new Uint8Array(ID_LEN)));
}

export async function fileFingerprint(file) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(file.name));
  return { s: file.size, t: file.lastModified, nh: toHex(new Uint8Array(d).subarray(0, 8)) };
}

export const sameFile = (a, b) => a && b && a.s === b.s && a.t === b.t && a.nh === b.nh;

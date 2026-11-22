// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// The sender's own TURN server, an optional WebRTC relay. It only comes
// into play when both sides chose Fast and no direct path works; then
// WebRTC relays through it instead of the transfer falling back to the
// tunnel relay (much slower, and heavy on CPU). In Private mode WebRTC
// is off altogether (rtc.js), so only the public relays are ever used.
//
// Saved on the sender's device only, never in a link. The sender hands
// it to the recipient inside the encrypted tunnel, and only once both
// sides have agreed on Fast (session.js); the recipient checks what it
// gets with sanitize().

const KEY = "fileporter.turn";
const MAX_SERVERS = 4;
const MAX_URLS = 4;
const MAX_LEN = 512;

const isTurnURL = (u) => typeof u === "string" && u.length <= MAX_LEN && /^turns?:[^\s]+$/i.test(u);
const isField = (s) => typeof s === "string" && s.length <= MAX_LEN;

/**
 * Builds the server list from the form's fields. URLs are separated by
 * spaces, commas or new lines. Throws an Error to show the user.
 */
export function parse(urlsText, username, credential) {
  const urls = urlsText.split(/[\s,]+/).filter(Boolean);
  if (!urls.length) return [];
  const bad = urls.find((u) => !isTurnURL(u));
  if (bad) throw new Error(`"${bad}" isn't a TURN address. It should look like turn:relay.example.com:3478 or turns:relay.example.com:5349.`);
  if (urls.length > MAX_URLS) throw new Error(`Give at most ${MAX_URLS} addresses.`);
  if (!username || !credential) throw new Error("A TURN server needs a username and a password.");
  if (!isField(username) || !isField(credential)) throw new Error("The username or password is too long.");
  return [{ urls, username, credential }];
}

/** Valid RTCIceServer entries from untrusted input (the peer, or storage). */
export function sanitize(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list.slice(0, MAX_SERVERS)) {
    const urls = Array.isArray(s?.urls) ? s.urls : [s?.urls];
    if (!urls.length || urls.length > MAX_URLS || !urls.every(isTurnURL)) continue;
    if (!isField(s.username) || !isField(s.credential) || !s.username || !s.credential) continue;
    out.push({ urls: [...urls], username: s.username, credential: s.credential });
  }
  return out;
}

/** The saved servers, or []. */
export function load() {
  try {
    return sanitize(JSON.parse(localStorage.getItem(KEY) || "[]"));
  } catch {
    return [];
  }
}

export function save(servers) {
  try {
    if (servers.length) localStorage.setItem(KEY, JSON.stringify(servers));
    else localStorage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}

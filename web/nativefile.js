// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// Files to send in the Android and iOS apps, through the Files plugin
// (mobile/plugins/files): picked with the system picker, which keeps
// access to them across restarts, or shared to the app from another
// app. The page reads them in byte ranges from a URL the app serves,
// through NativeFile, which stands in for a File wherever the sender
// needs one (name, size, type, lastModified, slice().arrayBuffer()).

import { os, plugin } from "./platform.js";

const files = () => plugin("Files");

/** True where files to send come through the app's plugin. */
export const available = () => !!files();

/**
 * True where picking goes through the plugin too: Android, whose system
 * picker also offers photos and videos. iOS's document picker only
 * browses Files, while the web view's own picker also offers the photo
 * library and the camera, so iOS keeps that (and asks for the file
 * again after a restart, as in a browser).
 */
export const picks = () => available() && os === "android";

class NativeFile {
  constructor({ uri, url, name, size, type, lastModified, persistent, ranges }) {
    Object.assign(this, { uri, url, name, size, type, lastModified, persistent });
    // How to ask for a range: a Range header (iOS: Capacitor serves the
    // file), or query parameters (Android: the plugin does, see there).
    this.ranges = ranges === "query" ? "query" : "header";
  }

  slice(start = 0, end = this.size) {
    start = Math.max(0, Math.min(start, this.size));
    end = Math.max(start, Math.min(end, this.size));
    return {
      size: end - start,
      arrayBuffer: () => this.#read(start, end),
    };
  }

  async #read(start, end) {
    if (end === start) return new ArrayBuffer(0);
    const resp = this.ranges === "query"
      ? await fetch(`${this.url}&start=${start}&end=${end - 1}`, { cache: "no-store" })
      : await fetch(this.url, { headers: { Range: `bytes=${start}-${end - 1}` }, cache: "no-store" });
    if (resp.status !== (this.ranges === "query" ? 200 : 206)) throw new Error(`couldn't read ${this.name} (HTTP ${resp.status})`);
    const buf = await resp.arrayBuffer();
    if (buf.byteLength !== end - start) throw new Error(`couldn't read ${this.name}: it changed or is no longer available`);
    return buf;
  }
}

/** The system file picker: a NativeFile, or null if the user closed it. */
export async function pick() {
  const r = await files().pick();
  return r.file ? new NativeFile(r.file) : null;
}

/** A file picked before (by its uri), or null if it is no longer available. */
export async function open(uri) {
  try {
    return new NativeFile((await files().open({ uri })).file);
  } catch {
    return null;
  }
}

/** Keeps `uri` (when given) and lets go of every other file. */
export const retain = (uri) => files()?.retain({ uri: uri || "" }).catch(() => {});

const SHARE_ERRORS = {
  many: "One file at a time. To send several, zip them first.",
  unreadable: "Couldn't read the shared file. Try sharing it again.",
  notfile: "Only files can be sent. Share a file to fileporter instead.",
};

/**
 * What was last shared to the app, once: {file: NativeFile},
 * {link: "#…"} (a fileporter link), {error: message} or null.
 */
export async function takeShared() {
  if (!files()) return null;
  const s = await files().takeShared();
  if (s.file) return { file: new NativeFile(s.file) };
  if (s.link) return { link: s.link };
  if (s.error) return { error: SHARE_ERRORS[s.error] || SHARE_ERRORS.unreadable };
  return null;
}

/** Calls fn() when something is shared to the app while it runs. */
export const onShared = (fn) => files()?.addListener("shared", fn);

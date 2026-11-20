// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// Saving a received file in the Android and iOS apps, where the web
// view can't download files: the SaveFile plugin (mobile/plugins/
// save-file) shows the system's "Save as" dialog and the file is sent
// to it in chunks over the native bridge.

import { plugin } from "./platform.js";

// Base64 inflates each chunk by a third on its way over the bridge.
const CHUNK = 2 << 20;

/** True where saving goes through the app's native plugin. */
export const available = () => !!plugin("SaveFile");

/**
 * Saves `file` as `name`. Calls onProgress(fraction) while writing.
 * Resolves to "done", or "cancelled" if the user closed the dialog.
 */
export async function save(file, { name, type }, onProgress = () => {}) {
  const native = plugin("SaveFile");
  // Android asks where to save first; iOS once the file is written.
  const started = await native.start({ name, type: type || "" });
  if (started.cancelled) return "cancelled";
  const { id } = started;
  // Read the next chunk while the current one is being written.
  let next = file.size > 0 ? base64(file.slice(0, CHUNK)) : null;
  try {
    for (let off = 0; next; off += CHUNK) {
      const data = await next;
      const end = off + CHUNK;
      next = end < file.size ? base64(file.slice(end, end + CHUNK)) : null;
      await native.write({ id, data });
      onProgress(Math.min(end, file.size) / file.size);
    }
  } catch (err) {
    next?.catch(() => {});
    await native.abort({ id }).catch(() => {});
    throw err;
  }
  const { saved } = await native.finish({ id });
  return saved ? "done" : "cancelled";
}

function base64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.slice(r.result.indexOf(",") + 1));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

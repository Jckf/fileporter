// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// Shared by the e2e and Android tests. Every wait has a deadline, so a
// broken run fails with a message instead of hanging.

export const MiB = 1 << 20;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Polls check() (sync or async) every `every` ms until it returns
 * truthy, and returns that; throws Error(what) after timeout ms.
 * check may throw to fail at once.
 */
export async function waitUntil(check, timeout, what, every = 200) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(what);
    await sleep(every);
  }
}

/** The share link a sender page shows once it's ready. */
export async function linkOf(page, timeout = 120_000) {
  const h = await page.waitForFunction(() => document.getElementById("send-link")?.value, null, { timeout });
  return h.jsonValue();
}

/** "12 MB of 24 MB · …" → 12 MiB in bytes; 0 if there's no number yet. */
export function parseBytes(text) {
  const m = /^([\d.]+) (B|KB|MB|GB)/.exec(text || "");
  return m ? Number(m[1]) * { B: 1, KB: 1024, MB: MiB, GB: 1024 * MiB }[m[2]] : 0;
}

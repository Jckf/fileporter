// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// End-to-end tests: sender and receiver in separate browser contexts
// (separate profiles, like two people), against dist/ served by
// cmd/devserver. Uses tailcat's public DERP relays: needs internet.
//
// Usage: node e2e.test.js [--only=name,...] [--session=normal,incognito] [chromium|firefox|webkit ...]
//
// Every test runs in two kinds of session (both by default):
//   normal     each side gets its own on-disk profile
//   incognito  each side gets a private-browsing context: Chromium's and
//              WebKit's extra contexts already are; Firefox is launched
//              in permanent private browsing mode
// Private modes may refuse the storage receiving needs; see
// INCOGNITO_STORAGE.

import { chromium, firefox, webkit } from "playwright";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:8080/";
const engines = { chromium, firefox, webkit };
const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith("--only=")) || "").slice(7).split(",").filter(Boolean);
const browsers = args.filter((a) => !a.startsWith("--"));
if (!browsers.length) browsers.push("chromium", "firefox");
const sessions = (args.find((a) => a.startsWith("--session=")) || "").slice(10).split(",").filter(Boolean);
if (!sessions.length) sessions.push("normal", "incognito");

// Whether each engine lets a private-browsing receiver store data
// (OPFS). Where it doesn't, the receiver must say so up front (the
// "unsupported" screen), and the incognito run pairs a private sender
// (which needs no storage) with a normal receiver instead. storage-
// support checks this table in both directions, so a browser changing
// its behaviour shows up as a failure.
const INCOGNITO_STORAGE = { chromium: true, firefox: false, webkit: false };
const storageWorks = (engine, session) => session === "normal" || INCOGNITO_STORAGE[engine];

/**
 * Whether WebRTC can connect at all in this browser and environment:
 * two peer connections in one page, no fileporter code involved. Not
 * everywhere can (e.g. WebKit in Playwright's Docker image only offers
 * mDNS host candidates, which nothing there resolves); there the direct
 * transfer test checks the relay fallback instead of failing.
 */
async function rtcLoopbackWorks(engine) {
  const browser = await engine.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    return await page.evaluate(async () => {
      const a = new RTCPeerConnection();
      const b = new RTCPeerConnection();
      a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
      b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
      const dc = a.createDataChannel("probe");
      const opened = new Promise((res) => { dc.onopen = () => res(true); });
      await a.setLocalDescription(await a.createOffer());
      await b.setRemoteDescription(a.localDescription);
      await b.setLocalDescription(await b.createAnswer());
      await a.setRemoteDescription(b.localDescription);
      return Promise.race([opened, new Promise((r) => setTimeout(() => r(false), 10_000))]);
    });
  } finally {
    await browser.close();
  }
}

const MiB = 1 << 20;
const sha = (b) => createHash("sha256").update(b).digest("hex");

// Runs before any page script:
//  - count RTCPeerConnection constructions (privacy check)
//  - hide showSaveFilePicker so every engine takes the download path,
//    which Playwright can capture
const initScript = () => {
  window.__pcCount = 0;
  const Orig = window.RTCPeerConnection;
  if (Orig) {
    window.RTCPeerConnection = new Proxy(Orig, {
      construct(target, a) { window.__pcCount++; return Reflect.construct(target, a); },
    });
  }
  delete window.showSaveFilePicker;
};

const opfsList = (page) => page.evaluate(async () => {
  try {
    const d = await (await navigator.storage.getDirectory()).getDirectoryHandle("fileporter");
    const names = [];
    for await (const [n] of d.entries()) names.push(n);
    return names;
  } catch { return []; }
});

class Pair {
  /**
   * Each side's context comes from its private-mode browser when given
   * (incognito), else from a fresh on-disk profile (normal).
   */
  static async open(engine, { senderBrowser = null, receiverBrowser = null } = {}) {
    const p = new Pair();
    p.profiles = [];
    const ctx = async (browser) => {
      if (browser) return browser.newContext({ acceptDownloads: true });
      const dir = await mkdtemp(join(tmpdir(), "fileporter-profile-"));
      p.profiles.push(dir);
      return engine.launchPersistentContext(dir, { acceptDownloads: true });
    };
    p.sctx = await ctx(senderBrowser);
    p.rctx = await ctx(receiverBrowser);
    await p.sctx.addInitScript(initScript);
    await p.rctx.addInitScript(initScript);
    p.sender = await p.sctx.newPage();
    p.receiver = await p.rctx.newPage();
    p.logs = [];
    p.cleanup = [];
    p.watch(p.sender, "S");
    p.watch(p.receiver, "R");
    return p;
  }
  watch(page, name) {
    page.on("console", (m) => this.logs.push(`${name} ${m.type()}: ${m.text()}`));
    page.on("pageerror", (e) => this.logs.push(`${name} pageerror: ${e.message}`));
  }
  async close() {
    await this.sctx.close();
    await this.rctx.close();
    for (const fn of this.cleanup) await fn();
    for (const dir of this.profiles) await rm(dir, { recursive: true, force: true });
  }

  async startSender(file, mode) {
    const s = this.sender;
    await s.goto(BASE);
    await s.locator("#send-new").waitFor();
    await s.setInputFiles("#send-file", file);
    await s.check(`input[name="send-mode"][value="${mode}"]`);
    await s.locator("#send-start:enabled").waitFor({ timeout: 120_000 });
    await s.click("#send-start");
    return s.locator("#share-link").evaluate(async (el) => {
      while (!el.value) await new Promise((r) => setTimeout(r, 100));
      return el.value;
    });
  }

  async openReceiver(link, senderMode, receiverMode) {
    const r = this.receiver;
    await r.goto(link);
    if (senderMode === "performance") {
      await r.check(`input[name="recv-mode"][value="${receiverMode}"]`);
      await r.click("#recv-continue");
    } else {
      await r.locator("#recv-active").waitFor();
    }
  }

  /** Waits for the save step, downloads, returns the bytes. */
  async download(timeout = 300_000) {
    const r = this.receiver;
    await r.locator("#recv-save").waitFor({ timeout });
    const [dl] = await Promise.all([r.waitForEvent("download"), r.click("#recv-save-btn")]);
    return readFile(await dl.path());
  }

  async recvBytes() {
    const t = (await this.receiver.textContent("#recv-progress-text")) || "";
    const m = /^([\d.]+) (B|KB|MB|GB)/.exec(t);
    if (!m) return 0;
    return Number(m[1]) * { B: 1, KB: 1024, MB: MiB, GB: 1024 * MiB }[m[2]];
  }

  async waitRecvAtLeast(bytes, timeout = 180_000) {
    const end = Date.now() + timeout;
    while ((await this.recvBytes()) < bytes) {
      if (Date.now() > end) throw new Error(`receiver stuck below ${bytes} bytes`);
      if (await this.receiver.locator("#recv-save").isVisible()) throw new Error("finished before the checkpoint; use a bigger file");
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async debug() {
    const st = (p, sel) => p.locator(sel).textContent().catch(() => "?");
    return `sender: ${await st(this.sender, "#send-active-status")} | receiver: ${await st(this.receiver, "#recv-active-status")}\n` +
      this.logs.slice(-25).join("\n");
  }
}

const mkFile = (size, name = "payload.bin") => {
  const buffer = randomBytes(size);
  return { file: { name, mimeType: "application/octet-stream", buffer }, hash: sha(buffer) };
};

async function assertCleanedUp(p) {
  const names = await opfsList(p.receiver);
  if (names.length) throw new Error(`receiver OPFS not cleaned up: ${names}`);
  for (const [n, page] of [["sender", p.sender], ["receiver", p.receiver]]) {
    if (await page.evaluate(() => location.hash)) throw new Error(`${n} fragment not scrubbed`);
  }
}

// --- Tests ---------------------------------------------------------------------

const tests = {};

for (const [sm, rm, wantVia] of [
  ["privacy", "privacy", "relay"],
  ["privacy", "performance", "relay"],
  ["performance", "privacy", "relay"],
  ["performance", "performance", "rtc"],
]) {
  tests[`transfer-${sm}-${rm}`] = async (p) => {
    // Where WebRTC can't work at all, a direct transfer must still
    // complete, over the relay.
    const fallback = wantVia === "rtc" && !p.rtcWorks;
    const want = fallback ? "relay" : wantVia;
    // Not a multiple of the 1 MiB chunk size, to exercise the short last chunk.
    const { file, hash } = mkFile(3 * MiB + 12345);
    const link = await p.startSender(file, sm);
    await p.openReceiver(link, sm, rm);
    const got = await p.download();
    if (sha(got) !== hash) throw new Error("downloaded file hash mismatch");
    await p.sender.locator("#send-done").waitFor({ timeout: 30_000 });
    const via = p.logs.some((l) => l.includes("direct connection failed")) ? "relay" : (sm === "performance" && rm === "performance" ? "rtc" : "relay");
    if (via !== want) throw new Error(`transport ${via}, want ${want}`);
    const pcs = [await p.sender.evaluate(() => window.__pcCount), await p.receiver.evaluate(() => window.__pcCount)];
    if (rm === "privacy" || sm === "privacy") {
      if (pcs[0] || pcs[1]) throw new Error(`privacy leak: RTCPeerConnections created ${pcs}`);
    }
    await p.receiver.click("#recv-clear");
    await p.receiver.locator("#recv-cleared").waitFor();
    await assertCleanedUp(p);
    return `via=${via} pcs=${pcs.join("/")}${fallback ? " (WebRTC unavailable here; checked relay fallback)" : ""}`;
  };
}

tests["empty-file"] = async (p) => {
  const { file, hash } = mkFile(0, "empty.txt");
  const link = await p.startSender(file, "privacy");
  await p.openReceiver(link, "privacy");
  const got = await p.download();
  if (sha(got) !== hash) throw new Error("hash mismatch");
};

tests["resume-receiver-reload"] = async (p) => {
  const { file, hash } = mkFile(24 * MiB + 7);
  const link = await p.startSender(file, "privacy");
  await p.openReceiver(link, "privacy");
  await p.waitRecvAtLeast(4 * MiB);
  const before = await p.recvBytes();
  await p.receiver.reload();
  // Must not prompt again, must not start over.
  await p.receiver.locator("#recv-active").waitFor();
  await p.receiver.locator("#recv-progress-text", { hasText: /\d/ }).waitFor({ timeout: 120_000 });
  const after = await p.recvBytes();
  if (after < before - 2 * MiB) throw new Error(`restarted from ${after}, had ${before}`);
  const got = await p.download();
  if (sha(got) !== hash) throw new Error("hash mismatch after resume");
  return `resumed at ${(after / MiB).toFixed(1)} MiB (had ${(before / MiB).toFixed(1)})`;
};

tests["resume-sender-reload"] = async (p) => {
  // A file on disk: re-picking it must yield the same lastModified,
  // which in-memory test files don't (they get a fresh one each time).
  const { file: mem, hash } = mkFile(24 * MiB + 99);
  const dir = await mkdtemp(join(tmpdir(), "fileporter-e2e-"));
  const file = join(dir, mem.name);
  await writeFile(file, mem.buffer);
  p.cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const link = await p.startSender(file, "privacy");
  await p.openReceiver(link, "privacy");
  await p.waitRecvAtLeast(4 * MiB);
  await p.sender.reload();
  await p.sender.locator("#send-resume").waitFor();
  // A different file must be refused…
  await p.sender.setInputFiles("#send-resume-file", { name: "other.bin", mimeType: "application/octet-stream", buffer: Buffer.from("nope") });
  await p.sender.locator("#send-resume-error", { hasText: "not the same file" }).waitFor();
  // …the same one accepted.
  await p.sender.setInputFiles("#send-resume-file", file);
  const got = await p.download();
  if (sha(got) !== hash) throw new Error("hash mismatch after sender resume");
};

tests["cancel-by-receiver"] = async (p) => {
  const { file } = mkFile(24 * MiB);
  const link = await p.startSender(file, "privacy");
  await p.openReceiver(link, "privacy");
  await p.waitRecvAtLeast(2 * MiB);
  p.receiver.once("dialog", (d) => d.accept());
  await p.receiver.click("#recv-cancel");
  await p.receiver.locator("#cancelled").waitFor();
  await p.sender.locator("#cancelled", { hasText: "recipient cancelled" }).waitFor({ timeout: 30_000 });
  await assertCleanedUp(p);
};

tests["stale-index"] = async (p) => {
  // A browser that cached index.html from before a deploy asks for a
  // version directory that no longer exists. boot.js must refetch the
  // page past the cache and reload, keeping the fragment.
  const s = p.sender;
  let served = 0;
  await s.route((url) => url.pathname === new URL(BASE).pathname, async (route) => {
    const resp = await route.fetch();
    let body = await resp.text();
    if (served++ === 0) body = body.replace(/v\/[0-9a-f]{12}\//g, "v/000000000000/");
    await route.fulfill({ response: resp, body });
  });
  await s.goto(BASE + "#R-not-a-real-link");
  await s.locator("#bad-link").waitFor({ timeout: 30_000 });
  if (served < 2) throw new Error(`page was fetched ${served} time(s), expected a refetch`);
  if (!s.url().endsWith("#R-not-a-real-link")) throw new Error(`fragment lost: ${s.url()}`);

  // If even the fresh page fails, show a message instead of looping.
  await s.unroute("**");
  await s.route("**/v/*/app.js", (route) => route.fulfill({ status: 404, body: "" }));
  await s.goto(BASE + "?x=1");
  await s.locator('[role="alert"]', { hasText: "couldn't load" }).waitFor({ timeout: 30_000 });
  await s.unroute("**");
};

tests["sweep"] = async (p) => {
  const { file } = mkFile(24 * MiB);
  const link = await p.startSender(file, "privacy");
  await p.openReceiver(link, "privacy");
  await p.waitRecvAtLeast(2 * MiB);
  const id = (await opfsList(p.receiver))[0];
  if (!id) throw new Error("no OPFS data while receiving");

  // A live transfer (lock held) survives a sweep even with zero grace.
  const other = await p.rctx.newPage();
  await other.goto(BASE + "?sweepgrace=1");
  await other.locator("#send-new").waitFor();
  await new Promise((r) => setTimeout(r, 1500));
  if (!(await opfsList(other)).includes(id)) throw new Error("sweep deleted a live transfer");

  // Default grace: closing the tab (lock released) doesn't delete at once.
  p.receiver.removeAllListeners("dialog");
  await p.receiver.close({ runBeforeUnload: false });
  await other.goto(BASE);
  await new Promise((r) => setTimeout(r, 1500));
  if (!(await opfsList(other)).includes(id)) throw new Error("sweep ignored the grace period");

  // Past the grace period: gone.
  await other.goto(BASE + "?sweepgrace=1");
  const end = Date.now() + 10_000;
  while ((await opfsList(other)).includes(id)) {
    if (Date.now() > end) throw new Error("abandoned transfer not swept");
    await new Promise((r) => setTimeout(r, 300));
  }
};

// Receiver URL with testing flags (see web/config.js) added.
const withQuery = (link, query) => { const u = new URL(link); u.search = query; return u.toString(); };

tests["storage-support"] = async (p) => {
  const { file } = mkFile(1024);
  const link = await p.startSender(file, "privacy");
  await p.receiver.goto(link);
  const want = p.storageWorks ? "#recv-active" : "#unsupported";
  const other = p.storageWorks ? "#unsupported" : "#recv-active";
  await p.receiver.locator(want).waitFor({ timeout: 30_000 });
  if (await p.receiver.locator(other).isVisible()) throw new Error(`${other} shown too`);
  if (!p.storageWorks) {
    // Must stay put, not dial the sender and fail in a loop.
    await new Promise((r) => setTimeout(r, 3000));
    if (p.logs.some((l) => l.startsWith("R") && l.includes("session dropped"))) throw new Error("receiver retried without storage");
  }
  return p.storageWorks ? "receiving supported" : "unsupported screen shown";
};
tests["storage-support"].always = true;

tests["nospace-upfront"] = async (p) => {
  const { file, hash } = mkFile(3 * MiB);
  const link = await p.startSender(file, "privacy");
  await p.receiver.goto(withQuery(link, `quota=${MiB}`));
  await p.receiver.locator("#recv-active-status", { hasText: "doesn't have enough storage space" }).waitFor({ timeout: 60_000 });
  await p.receiver.locator("#recv-retry").waitFor();
  await p.sender.locator("#send-active-status", { hasText: "doesn't have enough storage space" }).waitFor({ timeout: 30_000 });
  // Space freed: the same link now works.
  await p.receiver.goto(link);
  const got = await p.download();
  if (sha(got) !== hash) throw new Error("hash mismatch after retry");
  await p.sender.locator("#send-done").waitFor({ timeout: 30_000 });
};

tests["nospace-midway"] = async (p) => {
  const { file, hash } = mkFile(6 * MiB + 5);
  const link = await p.startSender(file, "privacy");
  await p.receiver.goto(withQuery(link, `writelimit=${2 * MiB}`));
  await p.receiver.locator("#recv-active-status", { hasText: "ran out of storage space" }).waitFor({ timeout: 120_000 });
  await p.sender.locator("#send-active-status", { hasText: "doesn't have enough storage space" }).waitFor({ timeout: 30_000 });
  // What was stored is kept for the retry…
  if (!(await opfsList(p.receiver)).length) throw new Error("partial data discarded");
  // …which, with space freed, finishes the file.
  await p.receiver.goto(link);
  const got = await p.download();
  if (sha(got) !== hash) throw new Error("hash mismatch after resume");
  await p.sender.locator("#send-done").waitFor({ timeout: 30_000 });
};

// Tests that run with a private receiver even where private mode has no
// storage: they check that case, or don't receive at all.
tests["stale-index"].always = true;

// --- Runner --------------------------------------------------------------------

const launchPrivate = (name) => engines[name].launch(
  name === "firefox" ? { firefoxUserPrefs: { "browser.privatebrowsing.autostart": true } } : {},
);

let failed = 0;
for (const name of browsers) {
  const rtcWorks = await rtcLoopbackWorks(engines[name]);
  if (!rtcWorks) console.log(`NOTE ${name}: WebRTC can't connect in this environment; direct transfers check the relay fallback`);
  for (const session of sessions) {
    // normal: each context is its own on-disk profile (and browser).
    const browser = session === "incognito" ? await launchPrivate(name) : null;
    const works = storageWorks(name, session);
    const label = `${name.padEnd(8)} ${session.padEnd(9)}`;
    for (const [tname, fn] of Object.entries(tests)) {
      if (only.length && !only.some((o) => tname.startsWith(o))) continue;
      // Without private-mode storage, only `always` tests get a private
      // receiver; the rest test a private sender against a normal one.
      const privateReceiver = browser && (works || fn.always);
      const p = await Pair.open(engines[name], { senderBrowser: browser, receiverBrowser: privateReceiver ? browser : null });
      p.storageWorks = works || !privateReceiver;
      p.rtcWorks = rtcWorks;
      const t0 = Date.now();
      try {
        let note = await fn(p);
        if (browser && !privateReceiver) note = `${note || ""} (private sender, normal receiver)`.trim();
        console.log(`PASS ${label} ${tname.padEnd(34)} ${((Date.now() - t0) / 1000).toFixed(1)}s ${note || ""}`);
      } catch (err) {
        failed++;
        console.log(`FAIL ${label} ${tname}: ${err.message}\n${await p.debug()}`);
      } finally {
        await p.close().catch(() => {});
      }
    }
    await browser?.close();
  }
}
process.exit(failed ? 1 : 0);

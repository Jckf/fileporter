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
 * Whether WebRTC can connect at all between two browser processes in
 * this environment, as sender and receiver do in the tests: two
 * separate browser instances, offer and answer passed between them
 * here, no fileporter code involved. Not everywhere can: WebKit offers
 * only mDNS host candidates, which it resolves within one process but
 * nothing resolves across processes in Playwright's Docker image or on
 * GitHub's runners. There the direct transfer test checks the relay
 * fallback instead of failing. (No STUN servers here, unlike the app:
 * both peers are on one host, and NATs rarely route a host's own
 * public address back to it, so they wouldn't help.)
 */
async function rtcLoopbackWorks(engine) {
  const browsers = [await engine.launch(), await engine.launch()];
  try {
    const [a, b] = await Promise.all(browsers.map(async (br) => (await br.newContext()).newPage()));
    // Non-trickle: each side waits for all its candidates (or 5 s), so
    // its description carries them.
    const setup = () => {
      const pc = (window.__pc = new RTCPeerConnection());
      window.__gathered = () => new Promise((res) => {
        if (pc.iceGatheringState === "complete") return res();
        pc.onicegatheringstatechange = () => pc.iceGatheringState === "complete" && res();
        setTimeout(res, 5000);
      });
    };
    await Promise.all([a.evaluate(setup), b.evaluate(setup)]);
    const offer = await a.evaluate(async () => {
      const pc = window.__pc;
      const dc = pc.createDataChannel("probe");
      window.__open = new Promise((res) => { dc.onopen = () => res(true); });
      await pc.setLocalDescription(await pc.createOffer());
      await window.__gathered();
      return pc.localDescription.toJSON();
    });
    const answer = await b.evaluate(async (offer) => {
      const pc = window.__pc;
      await pc.setRemoteDescription(offer);
      await pc.setLocalDescription(await pc.createAnswer());
      await window.__gathered();
      return pc.localDescription.toJSON();
    }, offer);
    return await a.evaluate(async (answer) => {
      await window.__pc.setRemoteDescription(answer);
      return Promise.race([window.__open, new Promise((r) => setTimeout(() => r(false), 10_000))]);
    }, answer);
  } finally {
    await Promise.all(browsers.map((br) => br.close()));
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
  // Headless browsers can't hold a real screen wake lock; record what
  // the page asks for instead.
  window.__wake = { held: 0, requests: 0 };
  const fakeWakeLock = {
    async request(type) {
      if (type !== "screen") throw new TypeError("bad wake lock type");
      window.__wake.requests++;
      window.__wake.held++;
      const s = new EventTarget();
      s.released = false;
      s.type = type;
      s.release = async () => {
        if (s.released) return;
        s.released = true;
        window.__wake.held--;
        s.dispatchEvent(new Event("release"));
      };
      return s;
    },
  };
  Object.defineProperty(Navigator.prototype, "wakeLock", { get: () => fakeWakeLock, configurable: true });
};

const wake = (page) => page.evaluate(() => window.__wake);

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
    if ((await wake(p.sender)).held !== 1) throw new Error("sender: no wake lock while waiting for the recipient");
    await p.openReceiver(link, sm, rm);
    const got = await p.download();
    if ((await wake(p.receiver)).requests < 1) throw new Error("receiver: never asked for a wake lock");
    if (sha(got) !== hash) throw new Error("downloaded file hash mismatch");
    await p.sender.locator("#send-done").waitFor({ timeout: 30_000 });
    const via = p.logs.some((l) => l.includes("direct connection failed")) ? "relay" : (sm === "performance" && rm === "performance" ? "rtc" : "relay");
    if (via !== want) throw new Error(`transport ${via}, want ${want}`);
    const pcs = [await p.sender.evaluate(() => window.__pcCount), await p.receiver.evaluate(() => window.__pcCount)];
    if (rm === "privacy" || sm === "privacy") {
      if (pcs[0] || pcs[1]) throw new Error(`privacy leak: RTCPeerConnections created ${pcs}`);
    }
    // The download worker saw the browser read every byte, so the
    // temporary copy goes without asking.
    await p.receiver.locator("#recv-cleared", { hasText: "Saved to your downloads" }).waitFor({ timeout: 30_000 });
    await assertCleanedUp(p);
    for (const [who, page] of [["sender", p.sender], ["receiver", p.receiver]]) {
      if ((await wake(page)).held !== 0) throw new Error(`${who}: wake lock still held after the transfer`);
    }
    return `via=${via} pcs=${pcs.join("/")}${fallback ? " (WebRTC unavailable here; checked relay fallback)" : ""}`;
  };
}

tests["save-picker"] = async (p) => {
  // Chromium's save path: showSaveFilePicker and a stream into the
  // chosen file. The initScript hides the real picker (Playwright can't
  // drive it); this installs a stand-in that keeps what's written in
  // memory, first failing like a full disk, then working.
  const { file, hash } = mkFile(MiB + 4321);
  const link = await p.startSender(file, "privacy");
  await p.openReceiver(link, "privacy");
  const r = p.receiver;
  await r.locator("#recv-save").waitFor({ timeout: 300_000 });
  const stub = (fail) => {
    window.__saved = [];
    window.showSaveFilePicker = async () => ({
      createWritable: async () => new WritableStream({
        write(chunk) {
          if (fail) throw new DOMException("Simulated full disk", "QuotaExceededError");
          window.__saved.push(new Uint8Array(chunk));
        },
      }),
    });
  };

  await r.evaluate(stub, true);
  await r.click("#recv-save-btn");
  await r.locator("#recv-save-status", { hasText: "Couldn't save the file" }).waitFor({ timeout: 10_000 });
  await r.locator("#recv-save-btn:enabled").waitFor({ timeout: 5_000 });
  if (!(await opfsList(r)).length) throw new Error("received data deleted after a failed save");

  await r.evaluate(stub, false);
  await r.click("#recv-save-btn");
  await r.locator("#recv-cleared").waitFor({ timeout: 30_000 });
  const got = await r.evaluate(async () => {
    const parts = window.__saved;
    const all = new Uint8Array(parts.reduce((n, c) => n + c.length, 0));
    let off = 0;
    for (const c of parts) { all.set(c, off); off += c.length; }
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", all));
    return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
  });
  if (got !== hash) throw new Error("saved file hash mismatch");
  await p.sender.locator("#send-done").waitFor({ timeout: 30_000 });
  await assertCleanedUp(p);
};

tests["scan-qr"] = async (p) => {
  // Receiving by scanning the sender's QR code, as the app offers. The
  // receiver page is made to look like the app (a stand-in Capacitor
  // without plugins), and its camera films a screenshot of the
  // sender's QR code.
  const { file, hash } = mkFile(MiB + 77);
  await p.startSender(file, "privacy");
  await p.sender.click("#toggle-qr");
  const png = (await p.sender.locator("#qr").screenshot()).toString("base64");
  const r = p.receiver;
  await r.addInitScript((png) => {
    window.Capacitor = { isNativePlatform: () => true, isPluginAvailable: () => false, Plugins: {} };
    // (On the prototype: WebKit ignores assigning to the instance.)
    Object.defineProperty(MediaDevices.prototype, "getUserMedia", { configurable: true, value: async () => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      // The code fills most of the frame, as when holding a phone to it
      // (smaller, WebKit's stream blurs its modules together).
      const c = Object.assign(document.createElement("canvas"), { width: 800, height: 800 });
      const ctx = c.getContext("2d");
      const draw = () => {
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 60, 60, 680, 680);
      };
      draw();
      setInterval(draw, 100); // a live stream needs new frames
      return c.captureStream(10);
    } });
  }, png);
  await r.goto(BASE);
  await r.click("#scan-qr");
  await r.locator("#recv-active").waitFor({ timeout: 60_000 }).catch(async (err) => { // Firefox decodes slowly
    const why = await r.evaluate(() => [document.getElementById("scanner-status")?.textContent, document.getElementById("scan-error")?.textContent]).catch(() => []);
    throw new Error(`${err.message.split("\n")[0]} (scanner: ${why.filter(Boolean).join(" / ") || "no message"})`);
  });
  if (!(await r.locator("#scanner").isHidden())) throw new Error("scanner still open");
  if (sha(await p.download()) !== hash) throw new Error("hash mismatch");
  await p.sender.locator("#send-done").waitFor({ timeout: 30_000 });
};

tests["download-fallback"] = async (p) => {
  // Without a service worker (the download can't be followed), saving
  // falls back to a plain download, and the user removes the copy.
  await p.rctx.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "serviceWorker", { get: () => undefined, configurable: true });
  });
  const { file, hash } = mkFile(MiB + 99);
  const link = await p.startSender(file, "privacy");
  await p.openReceiver(link, "privacy");
  const got = await p.download();
  if (sha(got) !== hash) throw new Error("downloaded file hash mismatch");
  if (!(await opfsList(p.receiver)).length) throw new Error("copy removed before the user confirmed");
  await p.receiver.click("#recv-clear");
  await p.receiver.locator("#recv-cleared").waitFor();
  await assertCleanedUp(p);
};

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

tests["resume-sender-cancel"] = async (p) => {
  // Reopened without the file: cancelling there forgets the transfer.
  const { file } = mkFile(1 * MiB);
  await p.startSender(file, "privacy");
  await p.sender.reload();
  await p.sender.locator("#send-resume").waitFor();
  await p.sender.click("#send-resume-cancel");
  await p.sender.locator("#cancelled").waitFor();
  const hash = await p.sender.evaluate(() => location.hash);
  if (hash) throw new Error(`link kept after cancelling: ${hash}`);
  await p.sender.reload();
  await p.sender.locator("#send-new").waitFor();
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
    // The way out: copy the link to open it in a normal window.
    await p.receiver.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t) => { window.__copied = t; } }, configurable: true });
    });
    await p.receiver.click("#unsupported-copy");
    await p.receiver.locator("#unsupported-copy", { hasText: "Copied" }).waitFor({ timeout: 5_000 });
    if ((await p.receiver.evaluate(() => window.__copied)) !== link) throw new Error("copied something other than the link");
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

tests["pwa"] = async (p) => {
  // What browsers need to offer installing the site as an app: a linked
  // manifest with name, start_url, display and 192/512 px icons (plus a
  // maskable one for Android, and an Apple touch icon for iOS).
  const page = p.sender;
  await page.goto(BASE);
  const r = await page.evaluate(async () => {
    const href = document.querySelector('link[rel="manifest"]')?.href;
    if (!href) return { error: "no manifest link" };
    const resp = await fetch(href);
    const m = await resp.json();
    const load = (src) => new Promise((res) => {
      const img = new Image();
      img.onload = () => res(`${img.naturalWidth}x${img.naturalHeight}`);
      img.onerror = () => res("failed");
      img.src = src;
    });
    const icons = [];
    for (const i of m.icons || []) icons.push({ ...i, got: await load(new URL(i.src, href).href) });
    const apple = document.querySelector('link[rel="apple-touch-icon"]')?.href;
    // iOS launch screens: each must be exactly the size its media
    // query selects, or iOS ignores it.
    const splashes = [];
    for (const l of document.querySelectorAll('link[rel="apple-touch-startup-image"]')) {
      const q = (k) => Number(new RegExp(`${k}: (\\d+)`).exec(l.media)?.[1]);
      const [w, h, dpr] = [q("device-width"), q("device-height"), q("-webkit-device-pixel-ratio")];
      const portrait = l.media.includes("portrait");
      const want = portrait ? `${w * dpr}x${h * dpr}` : `${h * dpr}x${w * dpr}`;
      splashes.push({ href: l.getAttribute("href"), want, got: await load(l.href) });
    }
    return {
      m, icons, splashes,
      startURL: new URL(m.start_url, href).href,
      apple: apple ? await load(apple) : "missing",
    };
  });
  if (r.error) throw new Error(r.error);
  const { m, icons } = r;
  if (!m.name || !m.short_name) throw new Error("manifest needs name and short_name");
  if (m.display !== "standalone") throw new Error(`display ${m.display}`);
  if (r.startURL !== new URL(BASE).href) throw new Error(`start_url resolves to ${r.startURL}, not the site root`);
  for (const i of icons) if (i.got !== i.sizes) throw new Error(`icon ${i.src}: ${i.got}, declared ${i.sizes}`);
  const has = (size, purpose) => icons.some((i) => i.sizes === size && (i.purpose || "any").split(" ").includes(purpose));
  if (!has("192x192", "any") || !has("512x512", "any")) throw new Error("needs 192 and 512 px icons");
  if (!has("512x512", "maskable")) throw new Error("needs a maskable icon");
  if (r.apple !== "180x180") throw new Error(`apple-touch-icon: ${r.apple}`);
  if (r.splashes.length < 2) throw new Error("no iOS launch screens");
  for (const sp of r.splashes) if (sp.got !== sp.want) throw new Error(`launch screen ${sp.href}: ${sp.got}, want ${sp.want}`);
  return `${icons.length} icons, ${r.splashes.length} launch screens`;
};
tests["pwa"].always = true;

tests["offline"] = async (p) => {
  // The banner follows the browser's connectivity both ways.
  const page = p.sender;
  await page.goto(BASE);
  await page.locator("#send-new").waitFor();
  const banner = page.locator("#offline");
  if (await banner.isVisible()) throw new Error("banner shown while online");
  await page.context().setOffline(true);
  try {
    await banner.waitFor({ state: "visible", timeout: 5_000 });
  } finally {
    await page.context().setOffline(false);
  }
  await banner.waitFor({ state: "hidden", timeout: 5_000 });
};
tests["offline"].always = true;

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

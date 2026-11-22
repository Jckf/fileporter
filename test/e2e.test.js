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
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MiB, sleep, waitUntil, linkOf, parseBytes } from "./helpers.js";

const BASE = process.env.BASE_URL || "http://localhost:8080/";
// Navigations wait for the DOM, not the load event: every test waits for
// the elements it needs right after, and the load event alone once took
// over 30 s in WebKit on a CI runner for no reason found in the page.
const NAV = { waitUntil: "domcontentloaded" };
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

const sha = (b) => createHash("sha256").update(b).digest("hex");

// Runs before any page script:
//  - count RTCPeerConnection constructions (privacy check)
//  - hide showSaveFilePicker so every engine takes the download path,
//    which Playwright can capture
const initScript = () => {
  // For tests that check what the page saved: the SHA-256 (hex) of byte
  // arrays joined in order, computed in the page.
  window.__sha256OfParts = async (parts) => {
    const all = new Uint8Array(parts.reduce((n, c) => n + c.length, 0));
    let off = 0;
    for (const c of parts) { all.set(c, off); off += c.length; }
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", all));
    return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
  };
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

// Answers Firefox's persistent-storage prompt with "allow".
const FIREFOX_PREFS = { "dom.storageManager.prompt.testing": true, "dom.storageManager.prompt.testing.allow": true };

class Pair {
  /**
   * Each side's context comes from its private-mode browser when given
   * (incognito), else from a fresh on-disk profile (normal).
   */
  static async open(engine, { senderBrowser = null, receiverBrowser = null } = {}) {
    const p = new Pair();
    p.profiles = [];
    p.logs = [];
    p.cleanup = [];
    try {
      await p.setUp(engine, senderBrowser, receiverBrowser);
    } catch (err) {
      await p.close().catch(() => {}); // what was created so far
      throw err;
    }
    return p;
  }
  async setUp(engine, senderBrowser, receiverBrowser) {
    const p = this;
    const ctx = async (browser) => {
      if (browser) return browser.newContext({ acceptDownloads: true });
      const dir = await mkdtemp(join(tmpdir(), "fileporter-profile-"));
      p.profiles.push(dir);
      return engine.launchPersistentContext(dir, { acceptDownloads: true, ...(engine.name() === "firefox" ? { firefoxUserPrefs: FIREFOX_PREFS } : {}) });
    };
    p.sctx = await ctx(senderBrowser);
    p.rctx = await ctx(receiverBrowser);
    await p.sctx.addInitScript(initScript);
    await p.rctx.addInitScript(initScript);
    p.sender = await p.sctx.newPage();
    p.receiver = await p.rctx.newPage();
    p.watch(p.sender, "S");
    p.watch(p.receiver, "R");
  }
  watch(page, name) {
    page.on("console", (m) => this.logs.push(`${name} ${m.type()}: ${m.text()}`));
    page.on("pageerror", (e) => this.logs.push(`${name} pageerror: ${e.message}`));
  }
  async close() {
    await this.sctx?.close();
    await this.rctx?.close();
    for (const fn of this.cleanup) await fn();
    for (const dir of this.profiles) await rm(dir, { recursive: true, force: true });
  }

  async startSender(file, mode) {
    const s = this.sender;
    await s.goto(BASE, NAV);
    await s.locator("#send-new").waitFor();
    await s.setInputFiles("#send-file", file);
    await s.check(`input[name="send-mode"][value="${mode}"]`);
    await s.locator("#send-start:enabled").waitFor({ timeout: 120_000 });
    await s.click("#send-start");
    return linkOf(s);
  }

  async openReceiver(link, senderMode, receiverMode) {
    const r = this.receiver;
    await r.goto(link, NAV);
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
    return parseBytes(await this.receiver.textContent("#recv-progress-text"));
  }

  async waitRecvAtLeast(bytes, timeout = 180_000) {
    await waitUntil(async () => {
      if (await this.receiver.locator("#recv-save").isVisible()) throw new Error("finished before the checkpoint; use a bigger file");
      return (await this.recvBytes()) >= bytes;
    }, timeout, `receiver stuck below ${bytes} bytes`);
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

/** "rtc" or "relay": the transport a transfer badge (ui.setBadge) shows. */
const badgeVia = async (page, sel) => ((await page.getAttribute(sel, "class")) || "").split(" ").includes("direct") ? "rtc" : "relay";

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
    // The transport each side actually used, as its badge shows it.
    const [sentVia, via] = [await badgeVia(p.sender, "#send-badge"), await badgeVia(p.receiver, "#recv-badge")];
    if (sentVia !== via) throw new Error(`sender used ${sentVia}, receiver ${via}`);
    if (via !== want) throw new Error(`transport ${via}, want ${want}`);
    const pcs = [await p.sender.evaluate(() => window.__pcCount), await p.receiver.evaluate(() => window.__pcCount)];
    if (rm === "privacy" || sm === "privacy") {
      if (pcs[0] || pcs[1]) throw new Error(`privacy leak: RTCPeerConnections created ${pcs}`);
    }
    if (via === "rtc" && !(pcs[0] && pcs[1])) throw new Error(`direct transfer without peer connections: ${pcs}`);
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

// The sender's own TURN server: handed to the recipient only when both
// chose Fast. (No TURN server runs here; the transfer itself goes
// direct, or over the tunnel relay where WebRTC can't connect.)
const TURN = { urls: "turn:127.0.0.1:9", username: "fp-user", credential: "fp-secret" };
for (const [sm, rm] of [["performance", "performance"], ["performance", "privacy"], ["privacy", "performance"]]) {
  tests[`turn-${sm}-${rm}`] = async (p) => {
    const s = p.sender, r = p.receiver;
    await s.goto(BASE, NAV);
    await s.check('input[name="send-mode"][value="performance"]');
    await s.click("#turn-settings summary");
    await s.fill("#turn-urls", "turn:bad host");
    await s.click("#turn-save");
    await s.locator("#turn-status.error").waitFor();
    await s.fill("#turn-urls", TURN.urls);
    await s.fill("#turn-username", TURN.username);
    await s.fill("#turn-credential", TURN.credential);
    await s.click("#turn-save");
    await s.locator("#turn-clear:visible").waitFor();
    await s.check('input[name="send-mode"][value="privacy"]');
    if (await s.locator("#turn-settings").isVisible()) throw new Error("TURN settings shown with Private");
    // What the receiver hears from the sender, and what it gives WebRTC.
    await r.addInitScript(() => {
      window.__starts = [];
      window.__ice = [];
      const parse = JSON.parse;
      JSON.parse = function (...a) {
        const v = parse.apply(this, a);
        if (v && v.t === "start") window.__starts.push(v);
        return v;
      };
      const PC = window.RTCPeerConnection;
      if (PC) {
        window.RTCPeerConnection = new Proxy(PC, {
          construct(t, a) { window.__ice.push(JSON.stringify(a[0]?.iceServers || [])); return Reflect.construct(t, a); },
        });
      }
    });
    const { file, hash } = mkFile(MiB + 77);
    const link = await p.startSender(file, sm);
    await p.openReceiver(link, sm, rm);
    if (sha(await p.download()) !== hash) throw new Error("hash mismatch");
    const starts = await r.evaluate(() => window.__starts);
    const ice = (await r.evaluate(() => window.__ice)).join(" ");
    if (!starts.length) throw new Error("never saw the start message");
    const handed = starts.some((m) => m.turn);
    if (sm === "performance" && rm === "performance") {
      if (!handed) throw new Error("TURN server not handed over in Fast mode");
      const t = starts.find((m) => m.turn).turn[0];
      if (t.urls[0] !== TURN.urls || t.username !== TURN.username || t.credential !== TURN.credential) throw new Error(`wrong TURN server: ${JSON.stringify(t)}`);
      if (!ice.includes(TURN.urls)) throw new Error(`receiver's WebRTC didn't get it: ${ice}`);
      return "handed over";
    }
    if (handed) throw new Error("TURN server handed over outside Fast mode");
    if (ice.includes("turn:")) throw new Error("receiver used a TURN server outside Fast mode");
    return "kept back";
  };
}

// A relayed transfer over several peer connections ("lanes",
// web/transport.js), through a TURN server given as FP_TURN
// (turn:host:port; FP_TURN_USER/FP_TURN_PASS, default fp/fp). CI runs
// coturn for it. The sender may only use the relay, as on a network
// where direct connections fail; both sides get the server (the
// receiver from the sender), so the path is relay to relay.
const LOCAL_TURN = process.env.FP_TURN
  ? { urls: process.env.FP_TURN, username: process.env.FP_TURN_USER || "fp", credential: process.env.FP_TURN_PASS || "fp" }
  : null;
/**
 * Opens the sender's start page with its own TURN server set to `turn`,
 * its peer connections limited to the relay (as on a network where
 * direct connections fail) and tracked: window.__lanes.max is the most
 * connected at once, window.__pcs all of them.
 */
async function relayedSender(p, turn) {
  await p.sender.addInitScript(() => {
    window.__lanes = { up: 0, max: 0 };
    window.__pcs = [];
    const PC = window.RTCPeerConnection;
    window.RTCPeerConnection = new Proxy(PC, {
      construct(t, [cfg = {}, ...rest]) {
        const pc = Reflect.construct(t, [{ ...cfg, iceTransportPolicy: "relay" }, ...rest]);
        window.__pcs.push(pc);
        let up = false;
        pc.addEventListener("connectionstatechange", () => {
          const now = pc.connectionState === "connected";
          if (now === up) return;
          up = now;
          window.__lanes.up += now ? 1 : -1;
          window.__lanes.max = Math.max(window.__lanes.max, window.__lanes.up);
        });
        return pc;
      },
    });
  });
  const s = p.sender;
  await s.goto(BASE, NAV);
  await s.check('input[name="send-mode"][value="performance"]');
  await s.click("#turn-settings summary");
  await s.fill("#turn-urls", turn.urls);
  await s.fill("#turn-username", turn.username);
  await s.fill("#turn-credential", turn.credential);
  await s.click("#turn-save");
  await s.locator("#turn-clear:visible").waitFor();
}
const needsTurn = ({ rtcWorks }) =>
  !LOCAL_TURN ? "needs a TURN server (FP_TURN), which CI starts"
    : !rtcWorks ? "WebRTC can't connect in this environment" : null;
const lanesUp = (page) => page.evaluate(() => window.__lanes.up);

tests["turn-lanes"] = async (p) => {
  await relayedSender(p, LOCAL_TURN);
  const s = p.sender;
  const { file, hash } = mkFile(24 * MiB + 4321);
  const link = await p.startSender(file, "performance");
  await p.openReceiver(link, "performance", "performance");
  if (sha(await p.download()) !== hash) throw new Error("downloaded file hash mismatch");
  await s.locator("#send-done").waitFor({ timeout: 30_000 });
  const lanes = await s.evaluate(() => window.__lanes.max);
  if (lanes < 2) throw new Error(`only ${lanes} peer connection(s) up at once; want lanes`);
  if (await badgeVia(p.receiver, "#recv-badge") !== "relay") throw new Error("receiver's badge doesn't say relayed");
  return `${lanes} lanes`;
};
tests["turn-lanes"].skipWhy = needsTurn;

// One lane dropping mid-transfer loses the chunks in flight on it: the
// session ends and resumes, and the file must still arrive intact.
tests["turn-lane-drop"] = async (p) => {
  await relayedSender(p, LOCAL_TURN);
  const { path, hash } = await fileOnDisk(p, 64 * MiB + 77); // (over Playwright's 50 MB in-memory limit)
  const link = await p.startSender(path, "performance");
  await p.openReceiver(link, "performance", "performance");
  await waitUntil(async () => (await lanesUp(p.sender)) >= 2, 60_000, "no extra lanes came up");
  await p.waitRecvAtLeast(8 * MiB);
  await p.sender.evaluate(() => window.__pcs.filter((pc) => pc.connectionState === "connected").at(-1).close());
  if (sha(await p.download()) !== hash) throw new Error("hash mismatch after a lane dropped");
  if (!p.logs.some((l) => l.startsWith("R") && l.includes("session dropped"))) throw new Error("the session didn't drop and resume");
  await p.sender.locator("#send-done").waitFor({ timeout: 30_000 });
};
tests["turn-lane-drop"].skipWhy = needsTurn;

// The sender cancelling a relayed transfer over lanes: its cancel must
// reach the receiver even with chunks queued ahead of it on the lanes
// (it also goes over the link).
tests["turn-cancel-by-sender"] = async (p) => {
  await relayedSender(p, LOCAL_TURN);
  const { path } = await fileOnDisk(p, 64 * MiB);
  const link = await p.startSender(path, "performance");
  await p.openReceiver(link, "performance", "performance");
  await waitUntil(async () => (await lanesUp(p.sender)) >= 2, 60_000, "no extra lanes came up");
  await p.waitRecvAtLeast(4 * MiB);
  await p.sender.click("#send-cancel");
  await p.sender.locator("#cancelled").waitFor();
  await p.receiver.locator("#cancelled", { hasText: "sender cancelled" }).waitFor({ timeout: 30_000 });
  await assertCleanedUp(p);
};
tests["turn-cancel-by-sender"].skipWhy = needsTurn;

// Cancelling while the two sides are still connecting directly (the
// sender is limited to a TURN server that never answers, so ICE can only
// time out, after 8 s): the other side must hear it at once, not after.
for (const who of ["sender", "receiver"]) {
  tests[`cancel-while-connecting-by-${who}`] = async (p) => {
    // (TEST-NET-1: never answers. Not loopback, which Firefox refuses at
    // once, ending the attempt instead of leaving it connecting.)
    await relayedSender(p, { urls: "turn:192.0.2.1:3478", username: "x", credential: "x" });
    const { file } = mkFile(1 * MiB);
    const link = await p.startSender(file, "performance");
    await p.openReceiver(link, "performance", "performance");
    await p.receiver.locator("#recv-active-status", { hasText: "Connecting" }).waitFor({ timeout: 30_000 });
    await p.sender.locator("#send-active-status", { hasText: "Connecting" }).waitFor({ timeout: 30_000 });
    const [mine, theirs, text] = who === "sender" ? [p.sender, p.receiver, "sender cancelled"] : [p.receiver, p.sender, "recipient cancelled"];
    const t0 = Date.now();
    await mine.click(who === "sender" ? "#send-cancel" : "#recv-cancel");
    await theirs.locator("#cancelled", { hasText: text }).waitFor({ timeout: 30_000 });
    const ms = Date.now() - t0;
    if (ms > 6000) throw new Error(`the other side heard the cancel only after ${ms} ms (ICE timeout is 8 s)`);
    return `heard in ${ms} ms`;
  };
  tests[`cancel-while-connecting-by-${who}`].skipWhy = ({ rtcWorks }) => (rtcWorks ? null : "WebRTC can't connect in this environment");
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
  const got = await r.evaluate(() => window.__sha256OfParts(window.__saved));
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
  await r.goto(BASE, NAV);
  await r.click("#scan-qr");
  await r.locator("#recv-active").waitFor({ timeout: 60_000 }).catch(async (err) => { // Firefox decodes slowly
    const why = await r.evaluate(() => [document.getElementById("scanner-status")?.textContent, document.getElementById("scan-error")?.textContent]).catch(() => []);
    throw new Error(`${err.message.split("\n")[0]} (scanner: ${why.filter(Boolean).join(" / ") || "no message"})`);
  });
  if (!(await r.locator("#scanner").isHidden())) throw new Error("scanner still open");
  if (sha(await p.download()) !== hash) throw new Error("hash mismatch");
  await p.sender.locator("#send-done").waitFor({ timeout: 30_000 });
};

// Makes `page` look like the Android app (web/platform.js), with
// stand-in plugins. kind "send": a Files plugin whose pick() returns
// `file` (described by arg), read in ranges from /native-file. kind
// "save": a SaveFile plugin that keeps what it's given in
// window.__save, failing one write first. (Defined in the init script
// itself: the page's CSP rules out building them from a string.)
async function asApp(page, kind, arg = {}) {
  await page.addInitScript(({ kind, arg }) => {
    const ok = async () => ({});
    const Plugins = { App: { getLaunchUrl: ok, addListener: ok } };
    if (kind === "send") {
      const picked = { uri: "content://test/1", url: `${location.origin}/native-file?id=1`, ranges: "query", persistent: true, ...arg };
      Plugins.Files = { pick: async () => ({ file: picked }), open: async () => ({ file: picked }), retain: ok, takeShared: ok, addListener: ok };
    } else {
      const save = window.__save = { failNext: true, chunks: [], aborted: 0 };
      Plugins.Files = { retain: ok, takeShared: ok, addListener: ok };
      Plugins.SaveFile = {
        start: async () => { save.chunks = []; return { id: "s1" }; },
        write: async ({ data }) => {
          if (save.failNext && save.chunks.length === 1) { save.failNext = false; throw new Error("Simulated full disk."); }
          save.chunks.push(data);
        },
        finish: async () => ({ saved: true }),
        abort: async () => { save.aborted++; },
      };
    }
    window.Capacitor = {
      isNativePlatform: () => true, getPlatform: () => "android",
      isPluginAvailable: (name) => name in Plugins, Plugins,
    };
  }, { kind, arg });
}

// Sending a file the app picked through its Files plugin, which the
// page reads in byte ranges from a URL the plugin serves (here, a
// route doing what FilesPlugin.java does with ?start=&end=).
tests["app-send"] = async (p) => {
  const { file, hash } = mkFile(3 * MiB + 12345); // not a multiple of the chunk size
  const ranges = [];
  await p.sctx.route("**/native-file?*", (route) => {
    const u = new URL(route.request().url());
    const start = Number(u.searchParams.get("start")), end = Number(u.searchParams.get("end"));
    ranges.push([start, end]);
    if (!(start >= 0 && end >= start && end < file.buffer.length)) return route.fulfill({ status: 416 });
    return route.fulfill({ status: 200, body: file.buffer.subarray(start, end + 1), contentType: "application/octet-stream" });
  });
  await asApp(p.sender, "send", { name: file.name, size: file.buffer.length, type: file.mimeType, lastModified: Date.now() });
  const s = p.sender;
  await s.goto(BASE, NAV);
  await s.locator("#send-new").waitFor();
  await s.click('label[for="send-file"]');
  await s.locator("#send-file-card:visible").waitFor();
  await s.check('input[name="send-mode"][value="privacy"]');
  await s.locator("#send-start:enabled").waitFor({ timeout: 120_000 });
  await s.click("#send-start");
  // In the app the link is fileporter.app's; the receiver here is local.
  const link = BASE + new URL(await linkOf(s)).hash;
  await p.openReceiver(link, "privacy");
  if (sha(await p.download()) !== hash) throw new Error("downloaded file hash mismatch");
  if (ranges.some(([a, b]) => b < a || b >= file.buffer.length)) throw new Error(`asked for a range outside the file: ${JSON.stringify(ranges)}`);
  // In order, each starting where the last ended: FilesPlugin.java keeps
  // a streamed file's stream for the next range on that assumption.
  if (ranges.some(([a], i) => a !== (i ? ranges[i - 1][1] + 1 : 0))) throw new Error(`ranges not read in order: ${JSON.stringify(ranges)}`);
  return `${ranges.length} ranges read`;
};

// Saving in the app through its SaveFile plugin: base64 chunks over the
// bridge. The first save fails partway and must be aborted and
// reported; the second must deliver every byte.
tests["app-save"] = async (p) => {
  const { file, hash } = mkFile(5 * MiB + 777); // not a multiple of the bridge chunk
  const link = await p.startSender(file, "privacy");
  await asApp(p.receiver, "save");
  const r = p.receiver;
  await r.goto(link, NAV);
  await r.locator("#recv-save").waitFor({ timeout: 300_000 });
  await r.click("#recv-save-btn");
  await r.locator("#recv-save-status", { hasText: "Couldn't save the file: Simulated full disk. Try again." }).waitFor({ timeout: 30_000 });
  if ((await r.evaluate(() => window.__save.aborted)) !== 1) throw new Error("failed save not aborted");
  await r.locator("#recv-save-btn:enabled").waitFor();
  await r.click("#recv-save-btn");
  await r.locator("#recv-cleared").waitFor({ timeout: 60_000 });
  const got = await r.evaluate(() => window.__sha256OfParts(window.__save.chunks.map((b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))));
  if (got !== hash) throw new Error("saved file hash mismatch");
  await p.sender.locator("#send-done").waitFor({ timeout: 30_000 });
  return `${await r.evaluate(() => window.__save.chunks.length)} chunks`;
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
  await p.receiver.reload(NAV);
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
  await p.sender.reload(NAV);
  await p.sender.locator("#send-resume").waitFor();
  // A different file must be refused…
  await p.sender.setInputFiles("#send-resume-file", { name: "other.bin", mimeType: "application/octet-stream", buffer: Buffer.from("nope") });
  await p.sender.locator("#send-resume-error", { hasText: "not the same file" }).waitFor();
  // …the same one accepted.
  await p.sender.setInputFiles("#send-resume-file", file);
  const got = await p.download();
  if (sha(got) !== hash) throw new Error("hash mismatch after sender resume");
};

tests["relay-nearest"] = async (p) => {
  // Every relay but Frankfurt (303) answers its latency check slowly:
  // the sender must put the transfer on Frankfurt.
  await p.sctx.route(/\/derp\/latency-check$/, async (route) => {
    if (!route.request().url().includes("tc303a.")) await new Promise((r) => setTimeout(r, 600));
    await route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*" }, body: "" });
  });
  const hosts = [];
  p.sctx.on("websocket", (ws) => hosts.push(new URL(ws.url()).host));
  p.sender.on("websocket", (ws) => hosts.push(new URL(ws.url()).host));
  const { file, hash } = mkFile(1 * MiB + 3);
  const link = await p.startSender(file, "privacy");
  await p.openReceiver(link, "privacy");
  if (sha(await p.download()) !== hash) throw new Error("hash mismatch");
  const used = p.logs.filter((l) => l.includes("websocket: connected to")).map((l) => l.replace(/.*connected to /, ""));
  if (!used.length && !hosts.length) throw new Error("couldn't tell which relay was used");
  const all = [...used, ...hosts];
  if (!all.every((h) => h.includes("tc303a."))) throw new Error(`used ${all.join(", ")}, want tc303a`);
  return [...new Set(all)].join(", ");
};

tests["stall-reconnect"] = async (p) => {
  // The receiver goes offline mid-transfer: it must say nothing is
  // getting through, and once back online, Reconnect must finish it.
  const { file, hash } = mkFile(24 * MiB + 5);
  const link = await p.startSender(file, "privacy");
  await p.receiver.goto(link.replace("/#", "/?stall=4000#"), NAV);
  await p.receiver.locator("#recv-active").waitFor();
  await p.waitRecvAtLeast(2 * MiB);
  await p.rctx.setOffline(true);
  await p.receiver.locator("#recv-stall").waitFor({ timeout: 60_000 });
  const code = await p.receiver.textContent("#recv-stall-code");
  if (!/ · recv · relay · [a-z]{3} · \d+\/\d+ · \d+s · web$/.test(code)) throw new Error(`unexpected report line: ${code}`);
  await p.rctx.setOffline(false);
  await p.receiver.click("#recv-stall-retry");
  if (sha(await p.download()) !== hash) throw new Error("hash mismatch after reconnecting");
  return code;
};

// Taking the browser offline only cuts the engine worker's relay
// connection in Chromium; elsewhere the transfer just carries on.
tests["stall-reconnect"].browsers = ["chromium"];
tests["stall-reconnect"].browsersWhy = "offline mode doesn't cut a worker's WebSocket here";

tests["cancel-by-sender"] = async (p) => {
  const { file } = mkFile(24 * MiB);
  const link = await p.startSender(file, "privacy");
  await p.openReceiver(link, "privacy");
  await p.waitRecvAtLeast(2 * MiB);
  await p.sender.click("#send-cancel");
  await p.sender.locator("#cancelled").waitFor();
  await p.receiver.locator("#cancelled", { hasText: "sender cancelled" }).waitFor({ timeout: 30_000 });
  await assertCleanedUp(p);
};

/** A file on disk, so re-picking it after a reload gives the same fingerprint. */
async function fileOnDisk(p, size) {
  const { file: mem, hash } = mkFile(size);
  const dir = await mkdtemp(join(tmpdir(), "fileporter-e2e-"));
  const path = join(dir, mem.name);
  await writeFile(path, mem.buffer);
  p.cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return { path, buffer: mem.buffer, hash };
}

// The connection drops after the receiver stored the whole file but
// before the sender heard (?dropcomplete, config.js): the redial finds
// the transfer complete and must only finish it.
tests["complete-reconnect"] = async (p) => {
  const { file, hash } = mkFile(3 * MiB + 5);
  const link = await p.startSender(file, "privacy");
  await p.openReceiver(withQuery(link, "dropcomplete"), "privacy");
  if (sha(await p.download()) !== hash) throw new Error("hash mismatch after reconnecting complete");
  if (!p.logs.some((l) => l.includes("test: dropped after complete"))) throw new Error("the drop after completing didn't happen");
  await p.sender.locator("#send-done").waitFor({ timeout: 30_000 });
};

// As complete-reconnect, but while the receiver is away the sender's file
// changes underneath (same name, size and modification time): in the
// middle (so the final check fails) or at its end (so the sender starts
// over). Either way the receiver keeps what it verified, says the
// sender's file changed, and cancels, so the sender stops too.
for (const where of ["middle", "end"]) {
  tests[`complete-file-changed-${where}`] = async (p) => {
    const size = 3 * MiB + 5;
    const { path, buffer } = await fileOnDisk(p, size);
    // A whole-second modification time, which survives being restored
    // exactly (a stat()'s finer one can round differently).
    const mtime = new Date(1_700_000_000_000);
    await utimes(path, mtime, mtime);
    const link = await p.startSender(path, "privacy");
    const r = p.receiver;
    const holding = r.waitForEvent("console", { predicate: (m) => m.text() === "test: holding after complete", timeout: 120_000 });
    await p.openReceiver(withQuery(link, "dropcomplete=4000"), "privacy");
    await holding;
    // The sender goes away while the receiver holds on, its file changes…
    const senderURL = p.sender.url();
    await p.sender.goto("about:blank");
    const changed = Buffer.from(buffer);
    const at = where === "middle" ? MiB + 100 : size - 1;
    changed[at] ^= 0xff;
    await writeFile(path, changed);
    await utimes(path, mtime, mtime);
    // …and it comes back with that file, which still passes as the same
    // one. (A fresh load, not goBack(): the back/forward cache could
    // restore the old page instead.)
    await p.sender.goto(senderURL, NAV);
    await p.sender.locator("#send-resume").waitFor();
    await p.sender.setInputFiles("#send-resume-file", path);
    await p.sender.locator("#send-active:visible").waitFor({ timeout: 30_000 }).catch(async () => {
      throw new Error(`sender didn't resume: ${await p.sender.textContent("#send-resume-error")}`);
    });
    await r.locator("#recv-active-status", { hasText: "file has changed" }).waitFor({ timeout: 120_000 });
    await p.sender.locator("#cancelled", { hasText: "recipient cancelled" }).waitFor({ timeout: 30_000 });
    if (!(await opfsList(r)).length) throw new Error("the received file wasn't kept");
  };
}

// The engine failing after it was ready (?engineexit, config.js): both
// sides must say fileporter stopped, not wait or redial for good.
tests["engine-stopped"] = async (p) => {
  const { path: file } = await fileOnDisk(p, 64 * MiB);
  // Sender: stops while waiting for the recipient.
  const s = p.sender;
  await s.goto(BASE + "?engineexit=6000", NAV);
  await s.setInputFiles("#send-file", file);
  await s.check('input[name="send-mode"][value="privacy"]');
  await s.locator("#send-start:enabled").waitFor({ timeout: 120_000 });
  await s.click("#send-start");
  await linkOf(s);
  await s.locator("#send-active-status", { hasText: "stopped working" }).waitFor({ timeout: 30_000 });
  // Receiver: stops mid-transfer, from a sender that keeps going.
  const link = await p.startSender(file, "privacy");
  await p.openReceiver(withQuery(link, "engineexit=4000"), "privacy");
  await p.receiver.locator("#recv-active-status", { hasText: "stopped working" }).waitFor({ timeout: 60_000 });
  await p.receiver.locator("#recv-retry:visible").waitFor();
};

tests["resume-sender-cancel"] = async (p) => {
  // Reopened without the file: cancelling there forgets the transfer.
  const { file } = mkFile(1 * MiB);
  await p.startSender(file, "privacy");
  await p.sender.reload(NAV);
  await p.sender.locator("#send-resume").waitFor();
  await p.sender.click("#send-resume-cancel");
  await p.sender.locator("#cancelled").waitFor();
  const hash = await p.sender.evaluate(() => location.hash);
  if (hash) throw new Error(`link kept after cancelling: ${hash}`);
  await p.sender.reload(NAV);
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
  await s.goto(BASE + "#R-not-a-real-link", NAV);
  await s.locator("#bad-link").waitFor({ timeout: 30_000 });
  if (served < 2) throw new Error(`page was fetched ${served} time(s), expected a refetch`);
  if (!s.url().endsWith("#R-not-a-real-link")) throw new Error(`fragment lost: ${s.url()}`);

  // If even the fresh page fails, show a message instead of looping.
  await s.unroute("**");
  await s.route("**/v/*/app.js", (route) => route.fulfill({ status: 404, body: "" }));
  await s.goto(BASE + "?x=1", NAV);
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

  // Opens url in page and waits for the sweep it starts to finish.
  const swept = async (page, url) => {
    const done = page.waitForEvent("console", { predicate: (m) => m.text() === "sweep finished", timeout: 30_000 });
    await page.goto(url, NAV);
    await done;
  };

  // A live transfer (lock held) survives a sweep even with zero grace.
  const other = await p.rctx.newPage();
  await swept(other, BASE + "?sweepgrace=1");
  if (!(await opfsList(other)).includes(id)) throw new Error("sweep deleted a live transfer");

  // Default grace: closing the tab (lock released) doesn't delete at once.
  p.receiver.removeAllListeners("dialog");
  await p.receiver.close({ runBeforeUnload: false });
  await swept(other, BASE);
  if (!(await opfsList(other)).includes(id)) throw new Error("sweep ignored the grace period");

  // Past the grace period: gone.
  await swept(other, BASE + "?sweepgrace=1");
  if ((await opfsList(other)).includes(id)) throw new Error("abandoned transfer not swept");
};

// Receiver URL with testing flags (see web/config.js) added.
const withQuery = (link, query) => { const u = new URL(link); u.search = query; return u.toString(); };

tests["storage-support"] = async (p) => {
  const { file } = mkFile(1024);
  const link = await p.startSender(file, "privacy");
  await p.receiver.goto(link, NAV);
  const want = p.storageWorks ? "#recv-active" : "#unsupported";
  const other = p.storageWorks ? "#unsupported" : "#recv-active";
  await p.receiver.locator(want).waitFor({ timeout: 30_000 });
  if (await p.receiver.locator(other).isVisible()) throw new Error(`${other} shown too`);
  if (!p.storageWorks) {
    // Must stay put, not dial the sender and fail in a loop. (An absence:
    // nothing to wait for but time. A dial would fail within this.)
    await sleep(3000);
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
  // Where a save location can be picked, that's offered instead (below).
  await p.receiver.addInitScript(() => {
    delete Window.prototype.showSaveFilePicker; delete window.showSaveFilePicker;
    Object.defineProperty(StorageManager.prototype, "persist", { value: undefined, configurable: true });
  });
  const link = await p.startSender(file, "privacy");
  await p.receiver.goto(withQuery(link, `quota=${MiB}`), NAV);
  await p.receiver.locator("#recv-active-status", { hasText: "doesn't have enough storage space" }).waitFor({ timeout: 60_000 });
  await p.receiver.locator("#recv-retry").waitFor();
  await p.sender.locator("#send-active-status", { hasText: "doesn't have enough storage space" }).waitFor({ timeout: 30_000 });
  // Space freed: the same link now works.
  await p.receiver.goto(link, NAV);
  const got = await p.download();
  if (sha(got) !== hash) throw new Error("hash mismatch after retry");
  await p.sender.locator("#send-done").waitFor({ timeout: 30_000 });
};

// Stands in for the save picker: hands out a file in OPFS (outside
// fileporter's own directory), which supports the same writes.
const fakeSavePicker = () => {
  window.showSaveFilePicker = async ({ suggestedName }) =>
    (await navigator.storage.getDirectory()).getFileHandle(`picked-${suggestedName}`, { create: true });
};
const pickedHash = (page, name) => page.evaluate(async (name) => {
  const f = await (await (await navigator.storage.getDirectory()).getFileHandle(`picked-${name}`)).getFile();
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await f.arrayBuffer())), (b) => b.toString(16).padStart(2, "0")).join("");
}, name);

// Too big for the browser's storage: received straight into a picked
// file, surviving a reload on the way.
tests["save-direct"] = async (p) => {
  const { file, hash } = mkFile(12 * MiB + 5, "big.bin");
  await p.receiver.addInitScript(fakeSavePicker);
  const link = await p.startSender(file, "privacy");
  const r = p.receiver;
  await r.goto(withQuery(link, `quota=${MiB}`), NAV);
  await r.locator("#recv-pick-text", { hasText: "Choose where to save this file" }).waitFor({ timeout: 60_000 });
  await r.click("#recv-pick-btn");
  await p.waitRecvAtLeast(3 * MiB);
  await r.reload(NAV);
  await r.locator("#recv-cleared").waitFor({ timeout: 300_000 });
  const text = await r.textContent("#recv-cleared-text");
  if (!text.includes("Saved to picked-big.bin")) throw new Error(`unexpected: ${text}`);
  if ((await pickedHash(r, "big.bin")) !== hash) throw new Error("hash mismatch");
  await p.sender.locator("#send-done").waitFor({ timeout: 30_000 });
  await assertCleanedUp(p);
  if (await r.evaluate(() => new Promise((res) => {
    const q = indexedDB.open("fileporter");
    q.onsuccess = () => q.result.transaction("save-targets").objectStore("save-targets").count().onsuccess = (e) => res(e.target.result);
  }))) throw new Error("save target not forgotten");
};
tests["save-direct"].browsers = ["chromium"];
tests["save-direct"].browsersWhy = "no save picker in this browser";

// The same, with part of the file committed before the reload: picks up
// from there rather than starting over.
tests["save-direct-resume"] = async (p) => {
  const { file, hash } = mkFile(16 * MiB + 5, "big.bin");
  await p.receiver.addInitScript(fakeSavePicker);
  const link = await p.startSender(file, "privacy");
  const r = p.receiver;
  const url = withQuery(link, `quota=${MiB}&commit=${4 * MiB}`);
  await r.goto(url, NAV);
  await r.locator("#recv-pick-btn").waitFor({ timeout: 60_000 });
  await r.click("#recv-pick-btn");
  await p.waitRecvAtLeast(6 * MiB);
  await r.goto("about:blank", NAV);
  // "Resuming…" is shown only for a moment: record every status.
  await r.addInitScript(() => addEventListener("DOMContentLoaded", () => {
    const el = document.getElementById("recv-active-status");
    window.__statuses = [];
    new MutationObserver(() => window.__statuses.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
  }));
  await r.goto(url, NAV);
  await r.locator("#recv-cleared").waitFor({ timeout: 300_000 });
  if (!(await r.evaluate(() => window.__statuses)).includes("Resuming…")) throw new Error("started over instead of resuming");
  if ((await pickedHash(r, "big.bin")) !== hash) throw new Error("hash mismatch");
  await p.sender.locator("#send-done").waitFor({ timeout: 30_000 });
};
tests["save-direct-resume"].browsers = ["chromium"];
tests["save-direct-resume"].browsersWhy = "no save picker in this browser";

// No save picker: asks for persistent storage, which (here, with the
// simulated limit) makes room where the browser grants it.
tests["persist-more"] = async (p) => {
  const { file, hash } = mkFile(3 * MiB);
  const r = p.receiver;
  await r.addInitScript(() => { delete Window.prototype.showSaveFilePicker; delete window.showSaveFilePicker; });
  const link = await p.startSender(file, "privacy");
  await r.goto(withQuery(link, `quota=${MiB}`), NAV);
  await r.locator("#recv-pick-text", { hasText: "unless you allow it" }).waitFor({ timeout: 60_000 });
  await r.click("#recv-pick-btn");
  if (!(await r.evaluate(() => navigator.storage.persisted()))) {
    // Not granted (private windows): says so, and stops.
    await r.locator("#recv-active-status", { hasText: "doesn't have enough storage space" }).waitFor({ timeout: 60_000 });
    return "not granted here; reported no space";
  }
  const got = await p.download();
  if (sha(got) !== hash) throw new Error("hash mismatch");
  await p.sender.locator("#send-done").waitFor({ timeout: 30_000 });
  return "granted";
};
tests["persist-more"].browsers = ["firefox"];
tests["persist-more"].browsersWhy = "only Firefox raises the limit for persistent storage and can be told to allow it here";

tests["nospace-midway"] = async (p) => {
  const { file, hash } = mkFile(6 * MiB + 5);
  const link = await p.startSender(file, "privacy");
  await p.receiver.goto(withQuery(link, `writelimit=${2 * MiB}`), NAV);
  await p.receiver.locator("#recv-active-status", { hasText: "ran out of storage space" }).waitFor({ timeout: 120_000 });
  await p.sender.locator("#send-active-status", { hasText: "doesn't have enough storage space" }).waitFor({ timeout: 30_000 });
  // What was stored is kept for the retry…
  if (!(await opfsList(p.receiver)).length) throw new Error("partial data discarded");
  // …which, with space freed, finishes the file.
  await p.receiver.goto(link, NAV);
  const got = await p.download();
  if (sha(got) !== hash) throw new Error("hash mismatch after resume");
  await p.sender.locator("#send-done").waitFor({ timeout: 30_000 });
};

tests["pwa"] = async (p) => {
  // What browsers need to offer installing the site as an app: a linked
  // manifest with name, start_url, display and 192/512 px icons (plus a
  // maskable one for Android, and an Apple touch icon for iOS).
  const page = p.sender;
  await page.goto(BASE, NAV);
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
  await page.goto(BASE, NAV);
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
  name === "firefox" ? { firefoxUserPrefs: { ...FIREFOX_PREFS, "browser.privatebrowsing.autostart": true } } : {},
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
      if (fn.browsers && !fn.browsers.includes(name)) {
        console.log(`SKIP ${label} ${tname.padEnd(34)} ${fn.browsersWhy}`);
        continue;
      }
      const skipWhy = fn.skipWhy?.({ rtcWorks });
      if (skipWhy) {
        console.log(`SKIP ${label} ${tname.padEnd(34)} ${skipWhy}`);
        continue;
      }
      // Without private-mode storage, only `always` tests get a private
      // receiver; the rest test a private sender against a normal one.
      const privateReceiver = browser && (works || fn.always);
      const t0 = Date.now();
      let p = null;
      try {
        p = await Pair.open(engines[name], { senderBrowser: browser, receiverBrowser: privateReceiver ? browser : null });
        p.storageWorks = works || !privateReceiver;
        p.rtcWorks = rtcWorks;
        let note = await fn(p);
        if (browser && !privateReceiver) note = `${note || ""} (private sender, normal receiver)`.trim();
        console.log(`PASS ${label} ${tname.padEnd(34)} ${((Date.now() - t0) / 1000).toFixed(1)}s ${note || ""}`);
      } catch (err) {
        failed++;
        console.log(`FAIL ${label} ${tname}: ${err.message}\n${p ? await p.debug() : "(setting up the browsers failed)"}`);
      } finally {
        await p?.close().catch(() => {});
      }
    }
    await browser?.close();
  }
}
process.exit(failed ? 1 : 0);

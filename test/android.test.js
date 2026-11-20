// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// End-to-end test of the Android app: a desktop Chromium sends a file
// from dist/ (served by cmd/devserver); the app, on a fresh emulator,
// is opened on the link as tapping it would, receives the file and
// saves it through the system's "Save as" dialog. Checks the saved
// file's hash on the device and that the temporary copy is gone.
//
// Needs Docker, /dev/kvm and internet (tailcat's public DERP relays).
// Build the APK first (mobile/run mobile/build android), then:
//
//   node android.test.js
//
// The emulator runs in a container (mobile/emulator); Playwright
// reaches its adb server, which shares the host's network.

import { _android as android, chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const BASE = process.env.BASE_URL || "http://localhost:8080/";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = `${ROOT}/mobile/smoke-out`;
const CONTAINER = "fileporter-android-test";
const ADB_PORT = 5137; // mobile/emulator's
const MiB = 1 << 20;
const SIZE = Number(process.env.FP_SIZE_MIB || 24) * MiB;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const step = (msg) => console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`);

function startEmulator() {
  const p = spawn(`${ROOT}/mobile/run`, ["mobile/emulator"], {
    env: { ...process.env, FP_IMAGE: "emulator", FP_NAME: CONTAINER },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    let out = "";
    p.stdout.on("data", (d) => {
      out += d;
      if (/^ready$/m.test(out)) resolve(p);
    });
    p.on("exit", (code) => reject(new Error(`emulator container exited (${code})`)));
  });
}

const stopEmulator = () => {
  try { execFileSync("docker", ["stop", "-t", "5", CONTAINER], { stdio: "ignore" }); } catch {}
};

async function main() {
  if (!(await fetch(BASE).then((r) => r.ok, () => false))) throw new Error(`nothing served at ${BASE} (cmd/devserver)`);
  step("booting emulator");
  stopEmulator();
  await startEmulator();
  const sender = await chromium.launch();
  let device;
  try {
    [device] = await android.devices({ host: "127.0.0.1", port: ADB_PORT });
    if (!device) throw new Error("no device");
    const shell = async (cmd) => (await device.shell(cmd)).toString();
    // The bounds' centre of the first on-screen view whose text matches
    // re, waiting for one to appear. (uiautomator dump: stock adb, no
    // driver app needed.)
    const find = async (re, timeout = 30_000) => {
      const end = Date.now() + timeout;
      for (;;) {
        const xml = await shell("uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; cat /sdcard/ui.xml");
        for (const [node] of xml.matchAll(/<node [^>]*>/g)) {
          const text = /\btext="([^"]*)"/.exec(node)?.[1];
          const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node);
          if (text && b && re.test(text)) return { x: (+b[1] + +b[3]) >> 1, y: (+b[2] + +b[4]) >> 1 };
        }
        if (Date.now() > end) throw new Error(`nothing on screen matches ${re}`);
        await new Promise((r) => setTimeout(r, 500));
      }
    };
    const tap = async ({ x, y }) => shell(`input tap ${x} ${y}`);

    step("sending");
    const buffer = randomBytes(SIZE);
    const s = await (await sender.newContext()).newPage();
    s.on("console", (m) => m.type() !== "debug" && console.log(`  sender ${m.type()}: ${m.text()}`));
    await s.goto(BASE);
    await s.locator("#send-new").waitFor();
    await s.setInputFiles("#send-file", { name: "payload.bin", mimeType: "application/octet-stream", buffer });
    await s.check('input[name="send-mode"][value="privacy"]');
    await s.locator("#send-start:enabled").waitFor({ timeout: 120_000 });
    await s.click("#send-start");
    const link = await s.locator("#share-link").evaluate(async (el) => {
      while (!el.value) await new Promise((r) => setTimeout(r, 100));
      return el.value;
    });
    // As shared from fileporter.app (the sender here is localhost).
    const appLink = "https://fileporter.app/" + new URL(link).hash;

    step("opening the link in the app");
    await shell(`am start -W -a android.intent.action.VIEW -d '${appLink}' app.fileporter`);
    const page = await (await device.webView({ pkg: "app.fileporter" })).page();
    // Not Capacitor's per-call groups (debug builds log every plugin call).
    page.on("console", (m) => ["log", "info", "warning", "error"].includes(m.type()) && console.log(`  app ${m.type()}: ${m.text()}`));
    await page.locator("#recv-save").waitFor({ timeout: 300_000 });
    step("received");

    // Closing the dialog leaves the file in place, ready to save again.
    await page.click("#recv-save-btn");
    await find(/^save$/i);
    await shell("input keyevent KEYCODE_BACK");
    await page.locator("#recv-save-btn:enabled").waitFor();
    if (!(await page.locator("#recv-save").isVisible())) throw new Error("left the save step after cancelling");

    step("saving");
    await page.click("#recv-save-btn");
    const saveButton = await find(/^save$/i);
    const t0 = Date.now();
    await tap(saveButton);
    await page.locator("#recv-cleared").waitFor({ timeout: 120_000 });
    const secs = (Date.now() - t0) / 1000;
    const text = await page.textContent("#recv-cleared-text");
    if (!/^Saved\./.test(text)) throw new Error(`unexpected result: ${text}`);

    const saved = (await shell("sha256sum /sdcard/Download/payload.bin")).split(/\s/)[0];
    if (saved !== sha(buffer)) throw new Error(`saved file differs: ${saved}`);
    const left = await page.evaluate(async () => {
      const names = [];
      try {
        const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("fileporter");
        for await (const n of dir.keys()) names.push(n);
      } catch {}
      return names;
    });
    if (left.length) throw new Error(`temporary copy left behind: ${left}`);
    step(`PASS android save: ${SIZE / MiB} MiB saved in ${secs.toFixed(1)} s (${(SIZE / MiB / secs).toFixed(1)} MiB/s), hash OK`);
  } catch (err) {
    // What the device showed, for the failure.
    if (device) {
      await mkdir(OUT, { recursive: true });
      await device.screenshot({ path: `${OUT}/android-fail.png` }).catch(() => {});
      const tree = await device.shell("uiautomator dump /sdcard/ui.xml >/dev/null; cat /sdcard/ui.xml").catch(() => "");
      await writeFile(`${OUT}/android-fail.xml`, tree);
      console.error(`device screenshot and UI tree in ${OUT}`);
    }
    throw err;
  } finally {
    await device?.close().catch(() => {});
    await sender.close();
    stopEmulator();
  }
}

main().catch((err) => {
  console.error("FAIL android:", err);
  stopEmulator();
  process.exit(1);
});

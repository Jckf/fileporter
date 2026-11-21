// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// End-to-end tests of the Android app on an emulator, with a desktop
// Chromium on dist/ (served by cmd/devserver) on the other end:
//
//   receive-save  the app is opened on a link as tapping it would,
//                 receives (put in the background on the way: "Transfer
//                 paused"), and saves through the system's Save dialog
//                 (cancelled once first); checks the saved file's hash
//                 and that the temporary copy is gone
//   share         another app shares a file to fileporter: it's ready
//                 to send on the start page
//   send-resume   the app sends a file picked with the system picker;
//                 it's force-stopped halfway and reopened, and carries
//                 on by itself (no picking the file again)
//
// Needs Docker, /dev/kvm and internet (tailcat's public DERP relays).
// Build the APK first (mobile/run mobile/build android), then:
//
//   node android.test.js [--only=name,...]
//
// The emulator runs in a container (mobile/emulator); Playwright
// reaches its adb server, which shares the host's network. To reuse a
// running one (FP_NAME=x … mobile/emulator), set FP_CONTAINER=x; the
// APK is reinstalled.

import { _android as android, chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const BASE = process.env.BASE_URL || "http://localhost:8080/";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = `${ROOT}/mobile/smoke-out`;
const REUSE = process.env.FP_CONTAINER;
const CONTAINER = REUSE || "fileporter-android-test";
const only = (process.argv.find((a) => a.startsWith("--only=")) || "").slice(7).split(",").filter(Boolean);
const APK = "mobile/android/app/build/outputs/apk/debug/app-debug.apk";
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
  if (REUSE) return;
  try { execFileSync("docker", ["stop", "-t", "5", CONTAINER], { stdio: "ignore" }); } catch {}
};


// Runs before any desktop page script: no showSaveFilePicker, so saving
// is a download Playwright can capture.
const desktopInit = () => { delete window.showSaveFilePicker; };

const parseBytes = (t) => {
  const m = /^([\d.]+) (B|KB|MB|GB)/.exec(t || "");
  return m ? Number(m[1]) * { B: 1, KB: 1024, MB: MiB, GB: 1024 * MiB }[m[2]] : 0;
};

const tests = {};

tests["receive-save"] = async ({ desktop, device, shell, find, tap, appPage }) => {
  const buffer = randomBytes(SIZE);
  // Unique: the Save dialog renames a file that already exists.
  const name = `payload-${Date.now()}.bin`;
  const s = await desktop.newPage();
  await s.goto(BASE);
  await s.locator("#send-new").waitFor();
  await s.setInputFiles("#send-file", { name, mimeType: "application/octet-stream", buffer });
  await s.check('input[name="send-mode"][value="privacy"]');
  await s.locator("#send-start:enabled").waitFor({ timeout: 120_000 });
  await s.click("#send-start");
  const link = await s.locator("#send-link").evaluate(async (el) => {
    while (!el.value) await new Promise((r) => setTimeout(r, 100));
    return el.value;
  });
  // As shared from fileporter.app (the sender here is localhost).
  const appLink = "https://fileporter.app/" + new URL(link).hash;

  step("opening the link in the app");
  await shell(`am start -W -a android.intent.action.VIEW -d '${appLink}' app.fileporter`);
  const page = await appPage();

  // Put in the background mid-transfer: "Transfer paused", gone again
  // once back.
  await page.locator("#recv-active").waitFor({ timeout: 60_000 });
  const posted = async () => /NotificationRecord\(\S+ pkg=app\.fileporter user=\S+ id=1 /.test(await shell("dumpsys notification"));
  let end = Date.now() + 10_000;
  while (await posted()) { // one from an earlier run is removed at start
    if (Date.now() > end) throw new Error("stale notification not removed at start");
    await new Promise((r) => setTimeout(r, 500));
  }
  await shell("input keyevent KEYCODE_HOME");
  end = Date.now() + 10_000;
  while (!(await posted())) {
    if (Date.now() > end) throw new Error("no \"Transfer paused\" notification");
    await new Promise((r) => setTimeout(r, 500));
  }
  await shell("am start -W -n app.fileporter/.MainActivity");
  end = Date.now() + 10_000;
  while (await posted()) {
    if (Date.now() > end) throw new Error("notification not removed on return");
    await new Promise((r) => setTimeout(r, 500));
  }
  step("paused and back");

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

  const saved = (await shell(`sha256sum /sdcard/Download/${name}`)).split(/\s/)[0];
  if (saved !== sha(buffer)) throw new Error(`saved file differs: ${saved}`);
  const left = await page.evaluate(async () => {
    const names = [];
    try {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("fileporter");
      for await (const n of dir.keys()) names.push(n);
    } catch {}
    return names;
  });
  // This transfer's (a reused emulator may hold others, swept later): its
  // id is bytes 1..12 of the receiver link's fragment.
  const id = Buffer.from(new URL(link).hash.slice(2), "base64url").subarray(1, 13).toString("hex");
  if (left.includes(id)) throw new Error(`temporary copy left behind: ${id}`);
  await s.close();
  return `${SIZE / MiB} MiB saved in ${secs.toFixed(1)} s (${(SIZE / MiB / secs).toFixed(1)} MiB/s), hash OK`;
};

/** Puts bytes in the device's Downloads, indexed; returns its content URI. */
async function pushDownload(device, shell, name, buffer) {
  await device.push(buffer, `/sdcard/Download/${name}`);
  await shell(`content call --uri content://media --method scan_file --arg /sdcard/Download/${name}`);
  const row = await shell(`content query --uri content://media/external/downloads --projection _id --where "_display_name='${name}'"`);
  const id = /_id=(\d+)/.exec(row)?.[1];
  if (!id) throw new Error(`${name} not in MediaStore: ${row}`);
  return `content://media/external/downloads/${id}`;
}

tests.share = async ({ device, shell, appPage }) => {
  const name = `shared-${Date.now()}.bin`;
  const uri = await pushDownload(device, shell, name, randomBytes(MiB));
  // As a sharing app does: the stream, readable through a grant (here on
  // the intent's data; apps put it in the intent's ClipData).
  await shell(`am start -W -a android.intent.action.SEND -t application/octet-stream -d ${uri} --eu android.intent.extra.STREAM ${uri} --grant-read-uri-permission -n app.fileporter/.MainActivity`);
  const page = await appPage();
  await page.locator("#send-file-card:visible").waitFor({ timeout: 30_000 });
  const shown = await page.textContent("#send-file-card .file-name");
  if (shown !== name) throw new Error(`file card shows ${shown}`);
  return "shared file ready to send";
};

tests["send-resume"] = async ({ desktop, device, shell, find, tap, appPage }) => {
  const buffer = randomBytes(SIZE);
  const name = `upload-${Date.now()}.bin`;
  await pushDownload(device, shell, name, buffer);
  await shell("am force-stop app.fileporter");
  await shell("am start -W -n app.fileporter/.MainActivity");
  let page = await appPage();
  await page.locator("#send-new").waitFor();

  step("picking the file");
  await page.click('label[for="send-file"]');
  await tap(await find(new RegExp(`^${name.replace(".", "\\.")}$`)));
  await page.locator("#send-file-card:visible").waitFor({ timeout: 30_000 });
  await page.check('input[name="send-mode"][value="privacy"]');
  await page.locator("#send-start:enabled").waitFor({ timeout: 120_000 });
  await page.click("#send-start");
  const link = await page.locator("#send-link").evaluate(async (el) => {
    while (!el.value) await new Promise((r) => setTimeout(r, 100));
    return el.value;
  });

  step("receiving on the desktop");
  const r = await desktop.newPage();
  await r.goto(BASE + new URL(link).hash);
  await r.locator("#recv-active").waitFor();
  const end = Date.now() + 180_000;
  while (parseBytes(await r.textContent("#recv-progress-text")) < SIZE / 4) {
    if (Date.now() > end) throw new Error("receiver stuck");
    if (await r.locator("#recv-save").isVisible()) throw new Error("finished before the restart; use a bigger file");
    await new Promise((res) => setTimeout(res, 200));
  }

  step("restarting the app mid-transfer");
  await shell("am force-stop app.fileporter");
  await shell("am start -W -n app.fileporter/.MainActivity");
  page = await appPage();
  await page.locator("#send-active:visible, #send-resume:visible").first().waitFor({ timeout: 60_000 });
  if (await page.locator("#send-resume").isVisible()) throw new Error("asked for the file again");

  await r.locator("#recv-save").waitFor({ timeout: 300_000 });
  const [dl] = await Promise.all([r.waitForEvent("download"), r.click("#recv-save-btn")]);
  const got = sha(await readFile(await dl.path()));
  if (got !== sha(buffer)) throw new Error("received file differs");
  await page.locator("#send-done").waitFor({ timeout: 60_000 });
  await r.close();
  return `${SIZE / MiB} MiB sent across an app restart, hash OK`;
};

async function main() {
  if (!(await fetch(BASE).then((r) => r.ok, () => false))) throw new Error(`nothing served at ${BASE} (cmd/devserver)`);
  if (!REUSE) {
    step("booting emulator");
    stopEmulator();
    await startEmulator();
  }
  const browser = await chromium.launch();
  const desktop = await browser.newContext({ acceptDownloads: true });
  await desktop.addInitScript(desktopInit);
  let device;
  let failed = 0;
  try {
    [device] = await android.devices({ host: "127.0.0.1", port: ADB_PORT });
    if (!device) throw new Error("no device");
    const shell = async (cmd) => (await device.shell(cmd)).toString();
    // (Playwright's installApk hangs here; the container's adb doesn't.)
    if (REUSE) execFileSync("docker", ["exec", "-e", `ANDROID_ADB_SERVER_PORT=${ADB_PORT}`, CONTAINER, "adb", "install", "-r", "-g", `/src/${APK}`], { stdio: "ignore" });
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
    const appPage = async () => {
      const page = await (await device.webView({ pkg: "app.fileporter" })).page();
      // Not Capacitor's per-call groups (debug builds log every plugin call).
      page.on("console", (m) => ["warning", "error"].includes(m.type()) && console.log(`  app ${m.type()}: ${m.text()}`));
      await page.waitForLoadState();
      return page;
    };

    for (const [name, test] of Object.entries(tests)) {
      if (only.length && !only.includes(name)) continue;
      step(`${name}…`);
      try {
        step(`PASS ${name}: ${await test({ desktop, device, shell, find, tap, appPage })}`);
      } catch (err) {
        failed++;
        console.error(`FAIL ${name}:`, err);
        // What the device showed.
        await mkdir(OUT, { recursive: true });
        await device.screenshot({ path: `${OUT}/android-${name}.png` }).catch(() => {});
        const tree = await shell("uiautomator dump /sdcard/ui.xml >/dev/null; cat /sdcard/ui.xml").catch(() => "");
        await writeFile(`${OUT}/android-${name}.xml`, tree);
        console.error(`  device screenshot and UI tree in ${OUT}`);
      }
    }
  } finally {
    await device?.close().catch(() => {});
    await browser.close();
    stopEmulator();
  }
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error("FAIL android:", err);
  stopEmulator();
  process.exit(1);
});

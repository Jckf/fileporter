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
//   send-pipe     the app sends a file shared from a provider that can
//                 only stream it (the debug build's PipeProvider); the
//                 receiver reloads halfway, so the sender goes back
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
import { MiB, waitUntil, linkOf, parseBytes } from "./helpers.js";

const BASE = process.env.BASE_URL || "http://localhost:8080/";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = `${ROOT}/mobile/smoke-out`;
const REUSE = process.env.FP_CONTAINER;
const CONTAINER = REUSE || "fileporter-android-test";
const only = (process.argv.find((a) => a.startsWith("--only=")) || "").slice(7).split(",").filter(Boolean);
const APK = "mobile/android/app/build/outputs/apk/debug/app-debug.apk";
const ADB_PORT = 5137; // mobile/emulator's
const SIZE = Number(process.env.FP_SIZE_MIB || 24) * MiB;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const step = (msg) => console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`);

// Booting from cold, image download aside, takes a few minutes.
const EMULATOR_TIMEOUT_MS = Number(process.env.FP_EMULATOR_TIMEOUT_S || 600) * 1000;

function startEmulator() {
  const p = spawn(`${ROOT}/mobile/run`, ["mobile/emulator"], {
    env: { ...process.env, FP_IMAGE: "emulator", FP_NAME: CONTAINER },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stopEmulator();
      reject(new Error(`emulator not ready after ${EMULATOR_TIMEOUT_MS / 1000} s`));
    }, EMULATOR_TIMEOUT_MS);
    let out = "";
    p.stdout.on("data", (d) => {
      out += d;
      if (/^ready$/m.test(out)) { clearTimeout(timer); resolve(p); }
    });
    p.on("exit", (code) => { clearTimeout(timer); reject(new Error(`emulator container exited (${code})`)); });
  });
}

const stopEmulator = () => {
  if (REUSE) return;
  try { execFileSync("docker", ["stop", "-t", "5", CONTAINER], { stdio: "ignore" }); } catch {}
};


// Runs before any desktop page script: no showSaveFilePicker, so saving
// is a download Playwright can capture.
const desktopInit = () => { delete window.showSaveFilePicker; };


const tests = {};

tests["receive-save"] = async ({ desktop, shell, find, tap, appPage }) => {
  const buffer = randomBytes(SIZE);
  // Unique: the Save dialog renames a file that already exists.
  const name = `payload-${Date.now()}.bin`;
  const s = await desktop.newPage();
  // Closed however this ends: a sender left open would keep its session
  // going into the next test.
  try {
    await s.goto(BASE);
    await s.locator("#send-new").waitFor();
    await s.setInputFiles("#send-file", { name, mimeType: "application/octet-stream", buffer });
    await s.check('input[name="send-mode"][value="privacy"]');
    await s.locator("#send-start:enabled").waitFor({ timeout: 120_000 });
    await s.click("#send-start");
    const link = await linkOf(s);
    // As shared from fileporter.app (the sender here is localhost).
    const appLink = "https://fileporter.app/" + new URL(link).hash;

    step("opening the link in the app");
    await shell(`am start -W -a android.intent.action.VIEW -d '${appLink}' app.fileporter`);
    const page = await appPage();

    // Put in the background mid-transfer: "Transfer paused", gone again
    // once back.
    await page.locator("#recv-active").waitFor({ timeout: 60_000 });
    const posted = async () => /NotificationRecord\(\S+ pkg=app\.fileporter user=\S+ id=1 /.test(await shell("dumpsys notification"));
    const gone = async () => !(await posted());
    // (One from an earlier run is removed at start.)
    await waitUntil(gone, 10_000, "stale notification not removed at start", 500);
    await shell("input keyevent KEYCODE_HOME");
    await waitUntil(posted, 10_000, "no \"Transfer paused\" notification", 500);
    await shell("am start -W -n app.fileporter/.MainActivity");
    await waitUntil(gone, 10_000, "notification not removed on return", 500);
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
    return `${SIZE / MiB} MiB saved in ${secs.toFixed(1)} s (${(SIZE / MiB / secs).toFixed(1)} MiB/s), hash OK`;
  } finally {
    await s.close();
  }
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

// Shared text that isn't a fileporter link: the start page must say
// only files can be sent. (Sharing several files at once can't be
// driven from here: am can't put the ArrayList<Uri> a share sheet sends
// into an intent.)
tests["share-text"] = async ({ shell, appPage }) => {
  await shell(`am start -W -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT 'just-some-words' -n app.fileporter/.MainActivity`);
  const page = await appPage();
  await page.locator("#drop-error", { hasText: "Only files can be sent" }).waitFor({ timeout: 30_000 });
  return "plain text refused";
};

// Shared text with a fileporter link in it opens that link (here one
// that isn't valid, so no sender is needed: the app must show so).
tests["share-link"] = async ({ shell, appPage }) => {
  await shell(`am start -W -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT 'Here:https://fileporter.app/#Rnot-a-real-link' -n app.fileporter/.MainActivity`);
  const page = await appPage();
  await page.locator("#bad-link").waitFor({ timeout: 30_000 });
  // Back to the start page for the tests after this one.
  await page.evaluate(() => { location.href = "./"; });
  return "link opened";
};

/**
 * Receives the app's send (link) on the desktop. Once a quarter has
 * arrived, disrupt(receiverPage) interrupts it ("what" names how) and
 * returns the app's sender page; then the file must arrive intact and
 * the sender finish.
 */
async function receiveAcross(desktop, link, buffer, what, disrupt) {
  step("receiving on the desktop");
  const r = await desktop.newPage();
  try {
    await r.goto(BASE + new URL(link).hash);
    await r.locator("#recv-active").waitFor();
    await waitUntil(async () => {
      if (await r.locator("#recv-save").isVisible()) throw new Error(`finished before the ${what}; use a bigger file`);
      return parseBytes(await r.textContent("#recv-progress-text")) >= buffer.length / 4;
    }, 180_000, "receiver stuck");
    step(`${what} mid-transfer`);
    const sender = await disrupt(r);
    await r.locator("#recv-save").waitFor({ timeout: 300_000 });
    const [dl] = await Promise.all([r.waitForEvent("download"), r.click("#recv-save-btn")]);
    if (sha(await readFile(await dl.path())) !== sha(buffer)) throw new Error("received file differs");
    await sender.locator("#send-done").waitFor({ timeout: 60_000 });
  } finally {
    await r.close();
  }
}

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
  const link = await linkOf(page);

  await receiveAcross(desktop, link, buffer, "app restart", async () => {
    await shell("am force-stop app.fileporter");
    await shell("am start -W -n app.fileporter/.MainActivity");
    page = await appPage();
    await page.locator("#send-active:visible, #send-resume:visible").first().waitFor({ timeout: 60_000 });
    if (await page.locator("#send-resume").isVisible()) throw new Error("asked for the file again");
    return page;
  });
  return `${SIZE / MiB} MiB sent across an app restart, hash OK`;
};

// A file the provider can only stream through a pipe, so the plugin
// can't read it at an offset: it keeps the stream a range leaves off for
// the next one, and opens it again when the receiver reloads and the
// sender goes back to where the receiver had got to.
tests["send-pipe"] = async ({ desktop, device, shell, appPage }) => {
  const buffer = randomBytes(SIZE);
  const name = `pipe-${Date.now()}.bin`;
  // Into the app's files/pipe/, which PipeProvider serves.
  await device.push(buffer, `/data/local/tmp/${name}`);
  await shell(`run-as app.fileporter sh -c 'mkdir -p files/pipe && rm -f files/pipe/* && cp /data/local/tmp/${name} files/pipe/' && rm /data/local/tmp/${name}`);
  await shell("logcat -c");
  // From a stopped app, as send-resume does: one still sending (an
  // earlier test that failed mid-transfer) would rightly ask before
  // taking the shared file.
  await shell("am force-stop app.fileporter");
  const uri = `content://app.fileporter.pipe/${name}`;
  await shell(`am start -W -a android.intent.action.SEND -t application/octet-stream --eu android.intent.extra.STREAM ${uri} -n app.fileporter/.MainActivity`);
  const page = await appPage();
  await page.locator("#send-file-card:visible").waitFor({ timeout: 30_000 });
  const shown = await page.textContent("#send-file-card .file-name");
  if (shown !== name) throw new Error(`file card shows ${shown}`);
  await page.check('input[name="send-mode"][value="privacy"]');
  await page.locator("#send-start:enabled").waitFor({ timeout: 120_000 });
  await page.click("#send-start");
  const link = await linkOf(page);

  await receiveAcross(desktop, link, buffer, "receiver reload", async (r) => {
    await r.reload();
    return page;
  });
  // Once to tell it's a pipe, whose stream then serves from the start,
  // and again after the reload sent the sender back: at least two, and a
  // few at most, not one for each of the file's 1 MiB ranges.
  const opens = (await shell("logcat -d -s PipeProvider:I")).split("\n").filter((l) => l.includes(` open ${name}`)).length;
  if (opens < 2 || opens > SIZE / MiB / 4) throw new Error(`opened ${opens} times`);
  return `${SIZE / MiB} MiB streamed across a receiver reload (opened ${opens} times), hash OK`;
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
      return waitUntil(async () => {
        const xml = await shell("uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; cat /sdcard/ui.xml");
        for (const [node] of xml.matchAll(/<node [^>]*>/g)) {
          const text = /\btext="([^"]*)"/.exec(node)?.[1];
          const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node);
          if (text && b && re.test(text)) return { x: (+b[1] + +b[3]) >> 1, y: (+b[2] + +b[4]) >> 1 };
        }
        return null;
      }, timeout, `nothing on screen matches ${re}`, 500);
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

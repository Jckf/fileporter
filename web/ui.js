// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// Presentational helpers: steps, file cards, badges, progress, QR code,
// drag & drop. No protocol logic here.

import qrcode from "./vendor/qrcode.mjs";
import { fmtBytes } from "./session.js";

const $ = (id) => document.getElementById(id);
const SVG = "http://www.w3.org/2000/svg";

const FLOWS = {
  send: ["File", "Share", "Transfer", "Done"],
  recv: ["Connect", "Receive", "Save", "Done"],
};

/** Renders every <ol class="steps" data-flow data-current>. */
export function renderSteps(root = document) {
  for (const ol of root.querySelectorAll("ol.steps")) {
    const labels = FLOWS[ol.dataset.flow] || [];
    const cur = Number(ol.dataset.current) || 0;
    ol.replaceChildren(...labels.map((label, i) => {
      const li = document.createElement("li");
      if (i < cur) li.className = "done";
      if (i === cur) { li.className = "current"; li.setAttribute("aria-current", "step"); }
      const span = document.createElement("span");
      span.textContent = label;
      li.append(span);
      return li;
    }));
  }
}

/** Sets the current step of the steps list inside the given section. */
export function setStep(sectionId, index) {
  const ol = $(sectionId)?.querySelector("ol.steps");
  if (!ol) return;
  ol.dataset.current = String(index);
  renderSteps(ol.parentElement);
}

export function fileExt(name) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

export function icon(id, cls = "icon") {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG, "use");
  use.setAttribute("href", `#${id}`);
  svg.append(use);
  return svg;
}

/** Fills a .file-card with name, size and extension label. */
export function fillFileCard(card, { name, size }) {
  card.querySelector(".file-name").textContent = name;
  card.querySelector(".file-name").title = name;
  card.querySelector(".file-size").textContent = fmtBytes(size);
  card.querySelector(".file-ext").textContent = fileExt(name);
}

/** "Direct" / "Relayed" pill. */
export function setBadge(el, via) {
  el.hidden = false;
  el.className = `badge ${via === "rtc" ? "direct" : "relay"}`;
  el.replaceChildren(icon(via === "rtc" ? "i-direct" : "i-relay"), document.createTextNode(via === "rtc" ? "Direct" : "Relayed"));
  el.title = via === "rtc"
    ? "Connected directly between the two browsers."
    : "Going through the encrypted relay.";
}

const fmtDuration = (s) => {
  if (!isFinite(s) || s <= 0) return "";
  if (s < 60) return `${Math.ceil(s)} s left`;
  if (s < 3600) return `${Math.ceil(s / 60)} min left`;
  return `${(s / 3600).toFixed(1)} h left`;
};

/**
 * Returns an update(bytes) function driving a <progress> and a text line
 * "x of y · rate · time left", with a rate estimate over ~5 s.
 */
export function progressView(barId, textId, total) {
  const samples = [];
  const bar = $(barId);
  const text = $(textId);
  bar.max = total || 1;
  return (bytes) => {
    const now = performance.now();
    const last = samples.at(-1);
    // After a long pause (waiting, reconnecting) or a rewind, start over:
    // old samples would drag the rate down.
    if (last && (bytes < last[1] || now - last[0] > 15000)) samples.length = 0;
    // Until bytes start moving, keep only the latest sample, so setup
    // time (negotiating, picking a transport) isn't counted as slowness.
    if (samples.length === 1 && samples[0][1] === bytes) samples[0][0] = now;
    else samples.push([now, bytes]);
    while (samples.length > 2 && now - samples[0][0] > 5000) samples.shift();
    const [t0, b0] = samples[0];
    const rate = now - t0 > 500 ? ((bytes - b0) * 1000) / (now - t0) : 0;
    bar.value = total ? bytes : 1;
    const parts = [`${fmtBytes(bytes)} of ${fmtBytes(total)}`];
    if (rate > 0 && bytes < total) {
      parts.push(`${fmtBytes(rate)}/s`);
      const eta = fmtDuration((total - bytes) / rate);
      if (eta) parts.push(eta);
    }
    text.textContent = parts.join(" · ");
  };
}

/** Renders text as a QR code (SVG) into container. Generated locally. */
export function renderQR(container, text) {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  let d = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${n + 2 * quiet} ${n + 2 * quiet}`);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "QR code of the share link");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "#000000");
  svg.append(path);
  container.replaceChildren(svg);
}

/**
 * Whole-page drag & drop while `active()` is true. Calls onFile(file)
 * for a single dropped file, or onError(message).
 */
export function setupDrop({ active, onFile, onError, zone }) {
  const overlay = $("drop-overlay");
  let depth = 0;
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes("Files");
  const hide = () => { depth = 0; overlay.hidden = true; zone?.classList.remove("over"); };
  window.addEventListener("dragenter", (e) => {
    if (!active() || !hasFiles(e)) return;
    e.preventDefault();
    depth++;
    overlay.hidden = false;
    zone?.classList.add("over");
  });
  window.addEventListener("dragover", (e) => {
    if (!active() || !hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  window.addEventListener("dragleave", (e) => {
    if (!active() || !hasFiles(e)) return;
    if (--depth <= 0) hide();
  });
  window.addEventListener("drop", (e) => {
    if (!active() || !hasFiles(e)) return;
    e.preventDefault();
    hide();
    const items = Array.from(e.dataTransfer.items || []).filter((i) => i.kind === "file");
    const entry = items[0]?.webkitGetAsEntry?.();
    if (entry?.isDirectory) { onError("Folders can't be sent. Zip the folder first, then send the zip file."); return; }
    const files = e.dataTransfer.files;
    if (!files.length) return;
    if (files.length > 1) { onError("One file at a time. To send several, zip them first."); return; }
    onFile(files[0]);
  });
}

/** Puts a File into an <input type=file> (for drops) and fires change. */
export function setInputFile(input, file) {
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

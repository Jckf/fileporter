// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// Appends what the Android and iOS apps ship on top of the site to the
// bundled www/THIRD_PARTY_LICENSES.txt (written by cmd/build): the
// Capacitor runtime and plugins (npm production dependencies, with
// their license files) and the native Android libraries. Run by
// mobile/build after building the site into www/.

import { readFileSync, appendFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const lock = JSON.parse(readFileSync(join(here, "package-lock.json"), "utf8"));

let out = "\n\n" + "=".repeat(72) + "\nAlso shipped in the Android and iOS apps\n" + "=".repeat(72) + "\n";
const pkgs = Object.entries(lock.packages)
  .filter(([path, p]) => path.startsWith("node_modules/") && !p.dev && !p.link && !path.startsWith("node_modules/@fileporter/"))
  .sort(([a], [b]) => a.localeCompare(b));
for (const [path, p] of pkgs) {
  const dir = join(here, path);
  const name = path.slice("node_modules/".length);
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\..*)?$/i.test(f));
  if (!file) throw new Error(`${name}: no license file`);
  out += `\n${"-".repeat(72)}\n${name} ${p.version} (${p.license})\n${"-".repeat(72)}\n\n`;
  out += readFileSync(join(dir, file), "utf8").trim() + "\n";
}
out += `\n${"-".repeat(72)}\n` + readFileSync(join(here, "licenses/native.txt"), "utf8");
out += `${"-".repeat(72)}\n\n` + readFileSync(join(here, "licenses/Apache-2.0.txt"), "utf8");

const target = join(here, "www/THIRD_PARTY_LICENSES.txt");
if (!existsSync(target)) throw new Error(`${target} missing: build the site first`);
appendFileSync(target, out);
console.log(`licenses: added ${pkgs.length} packages and the Android libraries`);

// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// Where the page is running: in a browser, or bundled in the Android
// or iOS app (mobile/, a Capacitor shell). In the app, native plugins
// replace the web APIs that don't work inside a web view. They are
// reached through window.Capacitor.Plugins, which the shell injects,
// so the site needs no build step or npm packages for them.

const cap = globalThis.Capacitor;

/** True inside the Android or iOS app. */
export const isApp = !!cap?.isNativePlatform?.();

/** "android", "ios" or "web". */
export const os = isApp ? cap.getPlatform?.() || "web" : "web";

/** A native plugin by name, or null (in a browser, or not installed). */
export const plugin = (name) => (isApp && cap.isPluginAvailable?.(name) ? cap.Plugins[name] : null);

/**
 * The public address of the site. Share links must use it: in the app
 * the page's own URL is a local one (capacitor://… on iOS) that means
 * nothing on another device.
 */
export const PUBLIC_URL = "https://fileporter.app/";
export const publicBase = () => (/^https?:$/.test(location.protocol) && !isApp ? location.href : PUBLIC_URL);

/**
 * The fragment the app was opened with, when it was opened from a
 * fileporter link (App Links / Universal Links), else "". In a browser
 * the link is simply the page's URL, so this is only needed in the app.
 */
export async function launchFragment() {
  const app = plugin("App");
  if (!app) return "";
  try {
    const launch = await app.getLaunchUrl();
    return fragmentOf(launch?.url);
  } catch {
    return "";
  }
}

/** Calls fn(fragment) when a fileporter link is opened while the app runs. */
export function onLinkOpened(fn) {
  plugin("App")?.addListener("appUrlOpen", (e) => {
    const frag = fragmentOf(e?.url);
    if (frag) fn(frag);
  });
}

function fragmentOf(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    return u.origin === new URL(PUBLIC_URL).origin ? u.hash : "";
  } catch {
    return "";
  }
}

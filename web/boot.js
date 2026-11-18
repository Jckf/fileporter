// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// Recovers from a stale index.html. This file is deliberately NOT
// versioned (it lives next to index.html) and must stay stable.
//
// Every other asset lives in v/<hash>/, and a deploy replaces that
// directory. GitHub Pages lets browsers cache index.html for up to 10
// minutes, so right after a deploy a browser may load a cached page
// that points at a version that no longer exists. When one of the
// page's own scripts or stylesheets fails to load, this fetches the
// page again bypassing the cache (which also replaces the cached copy)
// and reloads. The URL fragment, and with it the session, survives.
// It retries once: if a fresh page fails too, the problem is elsewhere
// and it shows a message instead of looping.
(() => {
  "use strict";
  const KEY = "fileporter:boot-reload";
  let handled = false;

  const message = (text) => {
    const show = () => {
      const p = document.createElement("p");
      p.setAttribute("role", "alert");
      p.style.cssText = "margin:16px;padding:12px 16px;border:1px solid #c33;border-radius:8px;font:16px system-ui,sans-serif";
      p.textContent = text;
      document.body.prepend(p);
    };
    if (document.body) show();
    else document.addEventListener("DOMContentLoaded", show, { once: true });
  };

  const recover = () => {
    if (handled) return;
    handled = true;
    let last = 0;
    try { last = Number(sessionStorage.getItem(KEY)) || 0; } catch {}
    if (Date.now() - last < 60_000) {
      message("fileporter couldn't load. Check your connection and reload the page.");
      return;
    }
    try { sessionStorage.setItem(KEY, String(Date.now())); } catch {
      // Without sessionStorage we can't tell a retry from a loop.
      message("fileporter couldn't load. Reload the page to try again.");
      return;
    }
    fetch(location.href, { cache: "reload" })
      .catch(() => {})
      .then(() => location.reload());
  };

  // Resource load errors don't bubble, but a capturing listener on
  // window sees them. Only our own versioned assets count.
  window.addEventListener("error", (e) => {
    const el = e.target;
    if (!(el instanceof HTMLScriptElement || el instanceof HTMLLinkElement)) return;
    const url = el.src || el.href || "";
    if (url.startsWith(new URL("v/", location.href).href)) recover();
  }, true);

  // A page that loaded fine clears the marker, so a later deploy can
  // recover again in this tab.
  window.addEventListener("load", () => {
    if (handled) return;
    try { sessionStorage.removeItem(KEY); } catch {}
  });
})();

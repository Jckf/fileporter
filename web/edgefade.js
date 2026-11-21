// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// Fades content out where it leaves the top or bottom of the screen
// (the html::before / ::after strips in style.css). Each edge's fade
// shows only while there is content beyond it, so the page at rest,
// scrolled to the top, looks the same as without it.

const root = document.documentElement;

function update() {
  const top = window.scrollY;
  const rest = root.scrollHeight - window.innerHeight - top;
  root.classList.toggle("fade-top", top > 1);
  root.classList.toggle("fade-bottom", rest > 1);
}

addEventListener("scroll", update, { passive: true });
addEventListener("resize", update);
// The page's height changes as screens and cards come and go.
new ResizeObserver(update).observe(document.body);
update();

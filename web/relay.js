// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// Picks the relay (DERP region) nearest the sender, by timing an HTTPS
// request to each. The engine can't measure this itself in a browser
// (no raw UDP for its STUN probes), so it would pick one at random,
// often on another continent. Both sides of a relayed transfer go
// through the sender's region.

const PROBE_PATH = "/derp/latency-check"; // served with CORS by every DERP server
const BUDGET_MS = 3000;

/** {id, code, ms}: what was picked, for diagnostics; null until then. */
export let picked = null;

/**
 * The region ID with the fastest round trip, or 0 if none answered (the
 * engine then picks one itself).
 */
export async function nearestRegion(derpMapURL) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), BUDGET_MS);
  try {
    const map = await (await fetch(derpMapURL, { signal: ctl.signal })).json();
    const regions = Object.values(map.Regions || {}).filter((r) => !r.Avoid && r.Nodes?.length);
    const results = await Promise.all(regions.map(async (r) => {
      try {
        return { id: r.RegionID, code: r.RegionCode, ms: await roundTrip(r.Nodes[0].HostName, ctl.signal) };
      } catch {
        return null;
      }
    }));
    const best = results.filter(Boolean).sort((a, b) => a.ms - b.ms)[0];
    picked = best || null;
    return best ? best.id : 0;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

// The first request pays for DNS, TCP and TLS; the second, on the same
// connection, is close to one network round trip.
async function roundTrip(host, signal) {
  const url = `https://${host}${PROBE_PATH}`;
  await fetch(url, { cache: "no-store", signal });
  let best = Infinity;
  for (let i = 0; i < 2; i++) {
    const t = performance.now();
    await fetch(url, { cache: "no-store", signal });
    best = Math.min(best, performance.now() - t);
  }
  return best;
}

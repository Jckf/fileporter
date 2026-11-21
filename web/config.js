// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

const params = new URLSearchParams(location.search);

export const config = {
  // P0 uses tailcat's free, rate-limited public relays. P3 replaces
  // this with our own derper + derpmap.json (served with CORS).
  derpMapURL: params.get("derpmap") || "https://tailcat.dev/derpmap.json",
  // How long the sender waits for a direct WebRTC path before falling
  // back to the relay.
  iceTimeoutMs: 8000,
  verbose: params.has("verbose"),
  // A transfer's temporary data is deleted once no tab has it open AND
  // it has been inactive this long. Covers reloads and crash-and-reopen;
  // after it, the session is gone for good.
  sweepGraceMs: Number(params.get("sweepgrace")) || 30 * 60 * 1000,
  // How long no data may move during a transfer before the page says
  // so and offers to reconnect (shorter for tests: ?stall=<ms>).
  stallMs: Number(params.get("stall")) || 30_000,
  // Testing only: simulate a nearly full disk on the receiver.
  //   ?quota=<bytes>       report at most this much free storage (until persisted)
  //   ?writelimit=<bytes>  fail writes past this offset with QuotaExceededError
  simQuota: Number(params.get("quota")) || 0,
  simWriteLimit: Number(params.get("writelimit")) || 0,
  // Testing only: ?commit=<bytes> commits a picked file (see
  // storage-worker.js) this often instead of rarely.
  commitEvery: Number(params.get("commit")) || 0,
};

# fileporter

Browser-to-browser file transfer with no application server. Peers meet
through [tailcat](https://github.com/tailscale/tailcat) (Tailscale's data
plane without its control plane: WireGuard over DERP relays), compiled to
WebAssembly. When **both** users choose performance mode, the tailcat
channel carries WebRTC signaling and the data goes direct; otherwise it
stays on the relay, and no `RTCPeerConnection` is ever created.

## Status

Done (P0–P2):

- Go engine (`cmd/engine`, forked from `tailcat/web/main_js.go`) runs in a
  dedicated Web Worker; downloaded in the background with progress and
  SHA-384 verification. The page works without it; sessions wait for it.
- Session keys exist only in URL fragments (`#s.` sender, `#r.` receiver).
  The sender pre-generates the receiver key and allowlists it
  (`AllowClient`). Reopening the URL resumes; nothing goes to storage.
- Privacy/performance negotiation before any IP-revealing connection;
  privacy is enforced locally (WebRTC constructors locked out).
- Chunked transfer (1 MiB, per-chunk SHA-256, root hash check, 8-chunk
  ack window) over the relay or a WebRTC data channel.
- Resume: receiver redials with backoff; receiver reload continues from
  what is in OPFS; sender reload continues after re-picking the file
  (checked by fingerprint and the last chunk's hash). Keepalive pings
  detect a vanished peer within 20 s.
- Receiver storage in OPFS via sync access handles in a worker. Cleanup:
  deleted on cancel or confirmed save; abandoned transfers are swept
  once no tab holds their Web Lock and they have been inactive for 30 min.

Next: own DERP/STUN infrastructure (P3; currently tailcat's free,
rate-limited public relays), hardening (CSP review, real Safari/iOS
testing).

### Protocol

See the comment at the top of `web/session.js`.

## Develop

    go run ./cmd/build          # → dist/ (engine ≈ 6.2 MB gzipped)
    go run ./cmd/devserver      # http://localhost:8080/

    cd test && npm install && npx playwright install
    node e2e.test.js chromium firefox webkit

Debug flags: `?verbose` (engine logs), `?derpmap=<url>`.

tailcat is pinned in `go.mod`; it is pre-1.0, so bump deliberately.

## Deploy

Pushing to `main` runs `.github/workflows/pages.yml`, which builds the
site and publishes it to GitHub Pages: https://fileporter.app/

## License

Copyright (c) 2026 Jim C K Flaten. Licensed under the
[GNU Affero General Public License v3.0 or later](LICENSE).

If you run a modified version of fileporter as a network service, the AGPL
requires you to offer its users the corresponding source code.

`cmd/engine/main_js.go` is derived from tailcat (Copyright (c) Tailscale Inc
& contributors, BSD-3-Clause, see [`LICENSE.tailcat`](LICENSE.tailcat)).
The build writes `THIRD_PARTY_LICENSES.txt` with the licenses of everything
compiled into the engine; the site links to it. fileporter is not
affiliated with or endorsed by Tailscale.

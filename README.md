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
- Resume: receiver redials (at once after a dropped session, then with
  a short backoff); receiver reload continues from what is in OPFS;
  sender reload continues after re-picking the file (checked by
  fingerprint and the last chunk's hash). A closed direct connection is
  noticed at once; over the relay, keepalive pings detect a vanished
  peer within 12 s.
- Receiver storage in OPFS via sync access handles in a worker. Cleanup:
  deleted on cancel or once saved; abandoned transfers are swept once no
  tab holds their Web Lock and they have been inactive for 30 min.
- Saving: Chromium writes to a file picked with showSaveFilePicker.
  Firefox and Safari download through a service worker scoped to dl/
  (web/sw.js) that streams the stored file and reports when the browser
  has read all of it, so the copy is deleted without asking. Without a
  service worker it falls back to a plain download and a "Remove
  temporary copy" button.

- Installable as an app (PWA): web app manifest and icons at the site
  root. Deliberately no offline cache: the app needs the network
  anyway, and a cache would fight the versioned deploys.

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

Every test runs in a normal and an incognito (private browsing) session;
`--session=normal` or `--session=incognito` picks one. Firefox's and
WebKit's private modes refuse the storage a receiver needs: there the
receiver must show the "unsupported" screen, and the other tests pair a
private sender with a normal receiver (`INCOGNITO_STORAGE` in
`test/e2e.test.js`).

Playwright's WebKit needs Ubuntu's libraries. Elsewhere (e.g. Arch), run
it in Playwright's image, with the dev server running on the host:

    cd test && docker run --rm --network host --ipc host \
      -v "$PWD":/test -v /test/node_modules -w /test \
      mcr.microsoft.com/playwright:v1.65.1-noble \
      sh -c 'npm ci && node e2e.test.js webkit'

WebRTC can't connect inside that container (only mDNS host candidates,
which nothing there resolves); the suite detects this and checks the
relay fallback instead of the direct path.

Debug flags: `?verbose` (engine logs), `?derpmap=<url>`. For tests:
`?sweepgrace=<ms>`, and on the receiver `?quota=<bytes>` (report at most
this much free storage) and `?writelimit=<bytes>` (fail writes past this
offset) to simulate a full disk.

tailcat is pinned in `go.mod`; it is pre-1.0, so bump deliberately.

## Deploy

Pushing to `main` runs `.github/workflows/pages.yml`, which builds the
site and publishes it to GitHub Pages: https://fileporter.app/

Pages caches every file for 10 minutes, so all assets except
`index.html` and `boot.js` live in a content-versioned directory
(`v/<hash>/`, see `cmd/build`); a page always loads the assets it was
built with. Only the current version is published: if a cached
`index.html` points at a removed version, `web/boot.js` refetches the
page past the cache and reloads once. Open tabs load everything at
startup, so they keep working across a deploy.

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

// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// Command devserver serves dist/ for local development.
//
// Versioned assets (v/<hash>/) and content-hashed engine files get
// immutable caching, everything else is served with no-cache so edits
// show up on reload (a rebuild changes the version). It sets the
// same security headers production should.
//
// Usage: go run ./cmd/devserver [-addr localhost:8080] [-dir dist]
package main

import (
	"flag"
	"log"
	"mime"
	"net/http"
	"strings"
)

func main() {
	// As GitHub Pages serves it; Go doesn't know the extension.
	mime.AddExtensionType(".webmanifest", "application/manifest+json")
	addr := flag.String("addr", "localhost:8080", "listen address")
	dir := flag.String("dir", "dist", "directory to serve")
	flag.Parse()

	fs := http.FileServer(http.Dir(*dir))
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hd := w.Header()
		if strings.HasPrefix(r.URL.Path, "/v/") {
			hd.Set("Cache-Control", "public, max-age=31536000, immutable")
		} else if strings.HasPrefix(r.URL.Path, "/engine.") && strings.HasSuffix(r.URL.Path, ".wasm.gzip") {
			hd.Set("Cache-Control", "public, max-age=31536000, immutable")
			// Served raw; the page decompresses it itself.
			hd.Set("Content-Type", "application/gzip")
		} else {
			hd.Set("Cache-Control", "no-cache")
		}
		hd.Set("Referrer-Policy", "no-referrer")
		hd.Set("X-Content-Type-Options", "nosniff")
		hd.Set("Cross-Origin-Opener-Policy", "same-origin")
		// 'wasm-unsafe-eval' lets the worker compile WebAssembly
		// without allowing JavaScript eval. connect-src must allow the
		// DERP map host and the DERP relays' WebSockets.
		hd.Set("Content-Security-Policy", strings.Join([]string{
			"default-src 'self'",
			"script-src 'self' 'wasm-unsafe-eval'",
			"worker-src 'self'",
			"connect-src 'self' https: wss:",
			"img-src 'self' data:",
			"style-src 'self'",
			"object-src 'none'",
			"base-uri 'none'",
			"form-action 'none'",
			"frame-ancestors 'none'",
		}, "; "))
		fs.ServeHTTP(w, r)
	})
	log.Printf("serving %s on http://%s/", *dir, *addr)
	log.Fatal(http.ListenAndServe(*addr, h))
}

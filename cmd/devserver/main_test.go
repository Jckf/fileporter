// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMain(m *testing.M) {
	if err := addTypes(); err != nil {
		panic(err)
	}
	os.Exit(m.Run())
}

// testDist is a small dist/ with one file of each kind.
func testDist(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for _, n := range []string{
		"index.html", "boot.js", "sw.js", "manifest.webmanifest", "THIRD_PARTY_LICENSES.txt",
		"engine.0123456789ab.wasm.gzip", "engine.wasm", "icons/engine.0123456789ab.wasm.gzip",
		"v/0123456789ab/app.js", "v/0123456789ab/style.css", "v/0123456789ab/engine-manifest.json",
	} {
		p := filepath.Join(dir, filepath.FromSlash(n))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func get(t *testing.T, h http.Handler, path string) *http.Response {
	t.Helper()
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
	return w.Result()
}

const immutable = "public, max-age=31536000, immutable"

func TestCaching(t *testing.T) {
	h := handler(testDist(t))
	for _, tc := range []struct {
		path, cache, ctype string
	}{
		// Versioned and content-hashed: never change, cache for good.
		{"/v/0123456789ab/app.js", immutable, "text/javascript; charset=utf-8"},
		{"/v/0123456789ab/style.css", immutable, "text/css; charset=utf-8"},
		{"/v/0123456789ab/engine-manifest.json", immutable, "application/json"},
		{"/engine.0123456789ab.wasm.gzip", immutable, "application/gzip"},
		// Everything else is revalidated, so a rebuild shows on reload.
		{"/", "no-cache", "text/html; charset=utf-8"},
		{"/boot.js", "no-cache", "text/javascript; charset=utf-8"},
		{"/sw.js", "no-cache", "text/javascript; charset=utf-8"},
		{"/manifest.webmanifest", "no-cache", "application/manifest+json"},
		{"/THIRD_PARTY_LICENSES.txt", "no-cache", "text/plain; charset=utf-8"},
		// Not the engine: no hash, or not at the root.
		{"/engine.wasm", "no-cache", "application/wasm"},
		{"/icons/engine.0123456789ab.wasm.gzip", "no-cache", ""},
	} {
		res := get(t, h, tc.path)
		if res.StatusCode != http.StatusOK {
			t.Errorf("%s: status %d", tc.path, res.StatusCode)
		}
		if got := res.Header.Get("Cache-Control"); got != tc.cache {
			t.Errorf("%s: Cache-Control %q, want %q", tc.path, got, tc.cache)
		}
		if got := res.Header.Get("Content-Type"); tc.ctype != "" && got != tc.ctype {
			t.Errorf("%s: Content-Type %q, want %q", tc.path, got, tc.ctype)
		}
		if got := res.Header.Get("Content-Encoding"); got != "" {
			t.Errorf("%s: Content-Encoding %q; the page decompresses the engine itself", tc.path, got)
		}
	}
}

func TestSecurityHeaders(t *testing.T) {
	h := handler(testDist(t))
	for _, path := range []string{"/", "/v/0123456789ab/app.js", "/engine.0123456789ab.wasm.gzip", "/missing"} {
		res := get(t, h, path)
		for k, want := range map[string]string{
			"Referrer-Policy":            "no-referrer",
			"X-Content-Type-Options":     "nosniff",
			"Cross-Origin-Opener-Policy": "same-origin",
		} {
			if got := res.Header.Get(k); got != want {
				t.Errorf("%s: %s %q, want %q", path, k, got, want)
			}
		}
		csp := map[string]string{}
		for d := range strings.SplitSeq(res.Header.Get("Content-Security-Policy"), ";") {
			name, value, _ := strings.Cut(strings.TrimSpace(d), " ")
			csp[name] = value
		}
		for name, want := range map[string]string{
			"default-src":     "'self'",
			"script-src":      "'self' 'wasm-unsafe-eval'",
			"worker-src":      "'self'",
			"connect-src":     "'self' https: wss:",
			"img-src":         "'self' data:",
			"style-src":       "'self'",
			"object-src":      "'none'",
			"base-uri":        "'none'",
			"form-action":     "'none'",
			"frame-ancestors": "'none'",
		} {
			if got := csp[name]; got != want {
				t.Errorf("%s: CSP %s %q, want %q", path, name, got, want)
			}
		}
		if len(csp) != 10 {
			t.Errorf("%s: CSP has %d directives, want 10: %q", path, len(csp), res.Header.Get("Content-Security-Policy"))
		}
	}
}

func TestNotFound(t *testing.T) {
	h := handler(testDist(t))
	for _, path := range []string{"/missing", "/v/ffffffffffff/app.js", "/engine.ffffffffffff.wasm.gzip", "/../main.go"} {
		if res := get(t, h, path); res.StatusCode != http.StatusNotFound {
			t.Errorf("%s: status %d, want 404", path, res.StatusCode)
		}
	}
}

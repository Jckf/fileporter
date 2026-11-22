// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// writeTree creates files (slash-separated paths to contents) under a
// new temporary directory and returns it.
func writeTree(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for n, s := range files {
		p := filepath.Join(dir, filepath.FromSlash(n))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestCollectAssets(t *testing.T) {
	web := writeTree(t, map[string]string{
		"index.html":                         "<html>",
		"boot.js":                            "boot",
		"sw.js":                              "sw",
		"favicon.svg":                        "<svg>",
		"manifest.webmanifest":               "{}",
		"icons/icon.svg":                     "<svg>",
		"icons/splash/1x2.png":               "png",
		".well-known/assetlinks.json":        "[]",
		"app.js":                             "app",
		"style.css":                          "css",
		"engine-worker.js":                   "worker",
		"vendor/lib.js":                      "lib",
		"vendor/lib.js.LICENSE":              "MIT",
		"sub/index.html":                     "not the root index",
		"icons.js":                           "not in icons/",
		"well-known/x":                       "not .well-known/",
		"boot.js.map":                        "not boot.js",
		".well-known-not/apple-app-site-ass": "not .well-known/",
	})
	goroot := writeTree(t, map[string]string{"lib/wasm/wasm_exec.js": "wasm_exec"})
	manifest := []byte(`{"url":"x"}`)

	assets, root, err := collectAssets(web, goroot, manifest)
	if err != nil {
		t.Fatal(err)
	}

	wantRoot := []string{
		".well-known/assetlinks.json", "boot.js", "favicon.svg", "icons/icon.svg",
		"icons/splash/1x2.png", "index.html", "manifest.webmanifest", "sw.js",
	}
	if got := slices.Sorted(maps.Keys(root)); !slices.Equal(got, wantRoot) {
		t.Errorf("root files:\n got %q\nwant %q", got, wantRoot)
	}
	wantAssets := []string{
		".well-known-not/apple-app-site-ass", "app.js", "boot.js.map", "engine-manifest.json",
		"engine-worker.js", "icons.js", "style.css", "sub/index.html", "vendor/lib.js",
		"vendor/lib.js.LICENSE", "wasm_exec.js", "well-known/x",
	}
	if got := slices.Sorted(maps.Keys(assets)); !slices.Equal(got, wantAssets) {
		t.Errorf("versioned assets:\n got %q\nwant %q", got, wantAssets)
	}
	if string(assets["wasm_exec.js"]) != "wasm_exec" {
		t.Errorf("wasm_exec.js = %q, want the toolchain's", assets["wasm_exec.js"])
	}
	if !bytes.Equal(assets["engine-manifest.json"], manifest) {
		t.Errorf("engine-manifest.json = %q, want %q", assets["engine-manifest.json"], manifest)
	}
	if string(root["icons/splash/1x2.png"]) != "png" || string(assets["vendor/lib.js"]) != "lib" {
		t.Error("file contents not carried over")
	}
}

func TestCollectAssetsNoWasmExec(t *testing.T) {
	web := writeTree(t, map[string]string{"index.html": "x"})
	if _, _, err := collectAssets(web, t.TempDir(), nil); err == nil {
		t.Error("no error without the toolchain's wasm_exec.js")
	}
}

func TestAssetsVersion(t *testing.T) {
	base := map[string][]byte{"app.js": []byte("app"), "style.css": []byte("css"), "vendor/a.js": []byte("a")}
	v := assetsVersion(base)
	if !regexp.MustCompile(`^[0-9a-f]{12}$`).MatchString(v) {
		t.Fatalf("version %q isn't 12 hex digits", v)
	}
	// Same inputs, built again (map order differs from run to run).
	for range 20 {
		if got := assetsVersion(maps.Clone(base)); got != v {
			t.Fatalf("same assets gave version %s, then %s", v, got)
		}
	}

	with := func(f func(m map[string][]byte)) map[string][]byte {
		m := maps.Clone(base)
		f(m)
		return m
	}
	changes := map[string]map[string][]byte{
		"content changed":  with(func(m map[string][]byte) { m["app.js"] = []byte("app2") }),
		"file renamed":     with(func(m map[string][]byte) { m["app2.js"] = m["app.js"]; delete(m, "app.js") }),
		"file added":       with(func(m map[string][]byte) { m["new.js"] = nil }),
		"file removed":     with(func(m map[string][]byte) { delete(m, "vendor/a.js") }),
		"bytes moved over": with(func(m map[string][]byte) { m["app.js"] = []byte("ap"); m["style.css"] = []byte("pcss") }),
	}
	for name, m := range changes {
		if got := assetsVersion(m); got == v {
			t.Errorf("%s: version unchanged (%s)", name, v)
		}
	}
}

func TestPackEngine(t *testing.T) {
	wasm := bytes.Repeat([]byte("\x00asm fake engine "), 1000)
	eng, gz, err := packEngine(wasm)
	if err != nil {
		t.Fatal(err)
	}

	zr, err := gzip.NewReader(bytes.NewReader(gz))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(raw, wasm) {
		t.Error("gzipped engine doesn't decompress to the wasm")
	}

	sum := sha256.Sum256(gz)
	if want := "engine." + hex.EncodeToString(sum[:6]) + ".wasm.gzip"; eng.name != want {
		t.Errorf("name = %q, want %q (named by the gzipped content)", eng.name, want)
	}
	if eng.rawSize != len(wasm) || eng.gzSize != len(gz) {
		t.Errorf("sizes = %d raw, %d gz; want %d, %d", eng.rawSize, eng.gzSize, len(wasm), len(gz))
	}
	checkManifest(t, eng.manifest, eng.name, gz, len(wasm))

	// The same wasm packs to the same file; different wasm doesn't.
	eng2, gz2, _ := packEngine(wasm)
	if eng2.name != eng.name || !bytes.Equal(gz2, gz) || !bytes.Equal(eng2.manifest, eng.manifest) {
		t.Error("packing the same wasm twice gave different results")
	}
	if eng3, _, _ := packEngine(append(wasm, 1)); eng3.name == eng.name {
		t.Error("different wasm got the same name")
	}
}

// checkManifest checks engine-manifest.json against the engine file
// it describes: the URL (relative to v/<hash>/) names it, and the size
// and SRI integrity are those of its bytes.
func checkManifest(t *testing.T, manifest []byte, name string, gz []byte, rawSize int) {
	t.Helper()
	var m struct {
		URL       string `json:"url"`
		Integrity string `json:"integrity"`
		Size      int    `json:"size"`
		RawSize   int    `json:"rawSize"`
	}
	dec := json.NewDecoder(bytes.NewReader(manifest))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&m); err != nil {
		t.Fatalf("manifest %s: %v", manifest, err)
	}
	if want := "../../" + name; m.URL != want {
		t.Errorf("manifest url = %q, want %q", m.URL, want)
	}
	sri := sha512.Sum384(gz)
	if want := "sha384-" + base64.StdEncoding.EncodeToString(sri[:]); m.Integrity != want {
		t.Errorf("manifest integrity = %q, want %q", m.Integrity, want)
	}
	if m.Size != len(gz) {
		t.Errorf("manifest size = %d, want %d", m.Size, len(gz))
	}
	if m.RawSize != rawSize {
		t.Errorf("manifest rawSize = %d, want %d", m.RawSize, rawSize)
	}
}

const testIndex = `<link rel="stylesheet" href="style.css">
<script type="module" src="app.js"></script>
<footer>fileporter <!--build:version--></footer>`

func TestRewriteIndex(t *testing.T) {
	got, err := rewriteIndex([]byte(testIndex), "0123456789ab", "v1.2.3-4-g<x>&", "deadbeef")
	if err != nil {
		t.Fatal(err)
	}
	want := `<link rel="stylesheet" href="v/0123456789ab/style.css">
<script type="module" src="v/0123456789ab/app.js"></script>
<footer>fileporter · Version <a href="https://github.com/Jckf/fileporter/commit/deadbeef">v1.2.3-4-g&lt;x&gt;&amp;</a></footer>`
	if string(got) != want {
		t.Errorf("rewritten index:\n%s\nwant:\n%s", got, want)
	}
}

func TestRewriteIndexNoGit(t *testing.T) {
	got, err := rewriteIndex([]byte(testIndex), "0123456789ab", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), "<footer>fileporter </footer>") {
		t.Errorf("without a git version the marker should just go:\n%s", got)
	}
}

func TestRewriteIndexErrors(t *testing.T) {
	for name, index := range map[string]string{
		"no stylesheet":     strings.Replace(testIndex, `href="style.css"`, `href="other.css"`, 1),
		"no script":         strings.Replace(testIndex, `src="app.js"`, `src="main.js"`, 1),
		"two scripts":       testIndex + `<script src="app.js"></script>`,
		"two stylesheets":   testIndex + `<link href="style.css">`,
		"no version marker": strings.Replace(testIndex, "<!--build:version-->", "", 1),
		"two markers":       testIndex + "<!--build:version-->",
	} {
		if _, err := rewriteIndex([]byte(index), "v", "d", "c"); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
}

func TestLicenseFiles(t *testing.T) {
	dir := writeTree(t, map[string]string{
		"LICENSE":           "",
		"license.md":        "",
		"LICENCE-APACHE":    "",
		"COPYING":           "",
		"NOTICE.txt":        "",
		"license.go":        "", // Go source, not a license
		"README.md":         "",
		"LICENSES/MIT.txt":  "", // directories are skipped
		"sub/LICENSE":       "", // only the top level
		"UNLICENSE-nothing": "",
	})
	got, err := licenseFiles(dir)
	if err != nil {
		t.Fatal(err)
	}
	for i, p := range got {
		got[i] = filepath.Base(p)
	}
	slices.Sort(got)
	want := []string{"COPYING", "LICENCE-APACHE", "LICENSE", "NOTICE.txt", "license.md"}
	if !slices.Equal(got, want) {
		t.Errorf("license files = %q, want %q", got, want)
	}
}

// TestBuild runs the whole build, engine included, and checks dist/
// hangs together: every web/ file is either at the root or in the one
// version directory, index.html points into it, and the engine
// manifest describes the engine file next to index.html. Compiling the
// engine takes a while from a cold cache, so -short skips it.
func TestBuild(t *testing.T) {
	if testing.Short() {
		t.Skip("builds the engine; skipped with -short")
	}
	t.Chdir(filepath.Join("..", ".."))
	out := filepath.Join(t.TempDir(), "dist")
	if err := run(out); err != nil {
		t.Fatal(err)
	}

	versions, err := os.ReadDir(filepath.Join(out, "v"))
	if err != nil {
		t.Fatal(err)
	}
	if len(versions) != 1 {
		t.Fatalf("%d version directories, want 1", len(versions))
	}
	version := versions[0].Name()
	vdir := filepath.Join(out, "v", version)

	index, err := os.ReadFile(filepath.Join(out, "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	for _, ref := range []string{`href="v/` + version + `/style.css"`, `src="v/` + version + `/app.js"`} {
		if !bytes.Contains(index, []byte(ref)) {
			t.Errorf("index.html lacks %s", ref)
		}
	}
	if bytes.Contains(index, []byte("<!--build:version-->")) {
		t.Error("index.html still has the version marker")
	}

	// Every web/ file is in exactly one place, unchanged except index.html.
	err = filepath.WalkDir("web", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel("web", path)
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		atRoot, errRoot := os.ReadFile(filepath.Join(out, rel))
		inV, errV := os.ReadFile(filepath.Join(vdir, rel))
		switch {
		case errRoot == nil && errV == nil:
			t.Errorf("%s is both at the root and in v/", rel)
		case errRoot != nil && errV != nil:
			t.Errorf("%s is missing from dist", rel)
		case rel == "index.html":
		case errRoot == nil && !bytes.Equal(atRoot, src), errV == nil && !bytes.Equal(inV, src):
			t.Errorf("%s changed on the way to dist", rel)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"index.html", "boot.js", "sw.js", "manifest.webmanifest", "THIRD_PARTY_LICENSES.txt"} {
		if _, err := os.Stat(filepath.Join(out, f)); err != nil {
			t.Errorf("not at the root: %v", err)
		}
	}
	for _, f := range []string{"app.js", "style.css", "wasm_exec.js", "engine-manifest.json"} {
		if _, err := os.Stat(filepath.Join(vdir, f)); err != nil {
			t.Errorf("not in v/%s: %v", version, err)
		}
	}

	// The version is the hash of what's in its directory.
	assets := map[string][]byte{}
	err = filepath.WalkDir(vdir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(vdir, path)
		assets[filepath.ToSlash(rel)], err = os.ReadFile(path)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := assetsVersion(assets); got != version {
		t.Errorf("v/%s holds assets of version %s", version, got)
	}

	engines, _ := filepath.Glob(filepath.Join(out, "engine.*.wasm.gzip"))
	if len(engines) != 1 {
		t.Fatalf("engine files: %q, want one", engines)
	}
	gz, err := os.ReadFile(engines[0])
	if err != nil {
		t.Fatal(err)
	}
	zr, err := gzip.NewReader(bytes.NewReader(gz))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(raw, []byte("\x00asm")) {
		t.Error("the engine isn't wasm")
	}
	checkManifest(t, assets["engine-manifest.json"], filepath.Base(engines[0]), gz, len(raw))
}

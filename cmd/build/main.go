// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// Command build produces the static site in dist/:
//
//   - index.html, boot.js, sw.js, favicon.svg, manifest.webmanifest,
//     icons/ and THIRD_PARTY_LICENSES.txt at the root. sw.js must be
//     there to serve dl/ (a service worker's scope can't be above its
//     script), and like boot.js stays compatible with every deployed
//     page instead of being versioned. The web app manifest
//     stays put so its start_url ("./", relative to the manifest) is
//     the site root, and the installed app's identity (derived from
//     start_url) never changes. icons/*.png are rendered from the
//     SVGs next to them and committed, e.g.
//     rsvg-convert -w 512 -h 512 icon.svg -o icon-512.png
//     (icon-192 and icon-512 from icon.svg; icon-maskable-512 and the
//     180 px apple-touch-icon from icon-maskable.svg). icons/splash/
//     holds the iPhone launch screens, made by go run ./cmd/splash.
//   - v/<hash>/: every other page asset (JS modules, workers, CSS,
//     wasm_exec.js, vendored libraries, engine-manifest.json). <hash>
//     covers all of them, and index.html is rewritten to point into
//     the directory. Static hosts like GitHub Pages cache everything
//     for a while (max-age=600) and can't be told otherwise, so
//     unversioned asset URLs could mix a new index.html with old
//     cached modules, or the reverse. Versioned URLs never change
//     content, so a page only ever loads the assets it was built with.
//     Only the current version is published; boot.js recovers a
//     browser whose cached index.html points at a removed version.
//   - engine.<hash>.wasm.gzip: the js/wasm engine, gzipped and named
//     by content, shared across versions. Static hosts can't be relied
//     on to negotiate Content-Encoding for wasm, so the page fetches it
//     raw and decompresses it with DecompressionStream. Not ".gz": the
//     Android build (mobile/) gunzips .gz assets and drops the suffix.
//     engine-manifest.json holds its URL, size and SHA-384.
//   - THIRD_PARTY_LICENSES.txt: the license of every module compiled
//     into the engine, plus Go's. Serving the engine to browsers is
//     binary distribution, which BSD/MIT/ISC/Apache all require to be
//     accompanied by these notices. The build fails if a module has no
//     license file, so a new dependency can't slip in unnoticed.
//
// Usage: go run ./cmd/build [-o dist]
package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

// wasmTags mirrors github.com/tailscale/tailcat/build-tags.txt (the
// tailcat module keeps its tag list in an internal package we can't
// import). The ts_omit_* tags drop Tailscale features tailcat doesn't
// use, which shrinks the wasm considerably.
const wasmTags = "ts_omit_ace,ts_omit_acme,ts_omit_advertiseexitnode,ts_omit_advertiseroutes,ts_omit_appconnectors,ts_omit_aws,ts_omit_bird,ts_omit_cachenetmap,ts_omit_captiveportal,ts_omit_capture,ts_omit_cliconndiag,ts_omit_clientmetrics,ts_omit_clientupdate,ts_omit_cloud,ts_omit_colorable,ts_omit_completion,ts_omit_completion_scripts,ts_omit_conn25,ts_omit_connreject,ts_omit_debug,ts_omit_debugeventbus,ts_omit_debugportmapper,ts_omit_desktop_sessions,ts_omit_dns,ts_omit_dnsresolvecache,ts_omit_doctor,ts_omit_drive,ts_omit_exitnodehealth,ts_omit_favorites,ts_omit_flashappliance,ts_omit_health,ts_omit_hujsonconf,ts_omit_identityfederation,ts_omit_ipnbus,ts_omit_iptables,ts_omit_kube,ts_omit_linkspeed,ts_omit_linuxdnsfight,ts_omit_listenrawdisco,ts_omit_logtail,ts_omit_netlog,ts_omit_networkmanager,ts_omit_oauthkey,ts_omit_osrouter,ts_omit_outboundproxy,ts_omit_peerapiclient,ts_omit_peerapiserver,ts_omit_portlist,ts_omit_portmapper,ts_omit_posture,ts_omit_qrcodes,ts_omit_relayserver,ts_omit_remoteconfig,ts_omit_resolved,ts_omit_routecheck,ts_omit_runtimemetrics,ts_omit_sdnotify,ts_omit_serve,ts_omit_serviceclientprefs,ts_omit_synology,ts_omit_syslog,ts_omit_syspolicy,ts_omit_systray,ts_omit_taildrop,ts_omit_tailnetlock,ts_omit_tap,ts_omit_tpm,ts_omit_tundevstats,ts_omit_unixsocketidentity,ts_omit_useexitnode,ts_omit_usermetrics,ts_omit_useroutes,ts_omit_wakeonlan,ts_omit_webbrowser,ts_omit_webclient"

func main() {
	out := flag.String("o", "dist", "output directory")
	flag.Parse()
	if err := run(*out); err != nil {
		log.Fatal(err)
	}
}

func run(out string) error {
	if err := os.RemoveAll(out); err != nil {
		return err
	}
	if err := os.MkdirAll(out, 0o755); err != nil {
		return err
	}

	// Build the engine.
	raw := filepath.Join(out, "engine.wasm.tmp")
	// -buildvcs=false: otherwise the git commit and dirty flag are
	// stamped into the binary, and every commit would change the
	// engine's hash and make browsers download it again.
	cmd := exec.Command("go", "build", "-tags", wasmTags, "-trimpath", "-buildvcs=false", "-ldflags=-s -w", "-o", raw, "./cmd/engine")
	cmd.Env = append(os.Environ(), "GOOS=js", "GOARCH=wasm")
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("go build engine: %w", err)
	}
	wasm, err := os.ReadFile(raw)
	if err != nil {
		return err
	}
	os.Remove(raw)

	var gz bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&gz, gzip.BestCompression)
	if _, err := zw.Write(wasm); err != nil {
		return err
	}
	if err := zw.Close(); err != nil {
		return err
	}
	sum := sha256.Sum256(gz.Bytes())
	name := "engine." + hex.EncodeToString(sum[:6]) + ".wasm.gzip"
	if err := os.WriteFile(filepath.Join(out, name), gz.Bytes(), 0o644); err != nil {
		return err
	}
	sri := sha512.Sum384(gz.Bytes())
	manifest, _ := json.MarshalIndent(map[string]any{
		// Relative to the manifest, which lives in v/<hash>/.
		"url":       "../../" + name,
		"integrity": "sha384-" + base64.StdEncoding.EncodeToString(sri[:]),
		"size":      gz.Len(),
		"rawSize":   len(wasm),
	}, "", "  ")

	goroot, err := exec.Command("go", "env", "GOROOT").Output()
	if err != nil {
		return fmt.Errorf("go env GOROOT: %w", err)
	}
	gorootDir := strings.TrimSpace(string(goroot))
	if err := writeThirdPartyLicenses(filepath.Join(out, "THIRD_PARTY_LICENSES.txt"), gorootDir); err != nil {
		return err
	}

	// Collect the versioned assets: web/ (minus the root files),
	// wasm_exec.js from the toolchain that built the engine, and the
	// manifest.
	assets := map[string][]byte{"engine-manifest.json": manifest}
	wasmExec, err := os.ReadFile(filepath.Join(gorootDir, "lib", "wasm", "wasm_exec.js"))
	if err != nil {
		return err
	}
	assets["wasm_exec.js"] = wasmExec
	rootFiles := map[string][]byte{}
	err = filepath.WalkDir("web", func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel("web", path)
		rel = filepath.ToSlash(rel)
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		switch {
		case rel == "index.html", rel == "boot.js", rel == "sw.js", rel == "favicon.svg", rel == "manifest.webmanifest",
			strings.HasPrefix(rel, "icons/"):
			rootFiles[rel] = b
		default:
			assets[rel] = b
		}
		return nil
	})
	if err != nil {
		return err
	}
	names := make([]string, 0, len(assets))
	for n := range assets {
		names = append(names, n)
	}
	sort.Strings(names)
	h := sha256.New()
	for _, n := range names {
		fmt.Fprintf(h, "%s\x00%d\x00", n, len(assets[n]))
		h.Write(assets[n])
	}
	version := hex.EncodeToString(h.Sum(nil)[:6])
	vdir := filepath.Join(out, "v", version)
	for _, n := range names {
		dst := filepath.Join(vdir, filepath.FromSlash(n))
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(dst, assets[n], 0o644); err != nil {
			return err
		}
	}

	// Point index.html into the version directory.
	html := string(rootFiles["index.html"])
	for _, ref := range []string{`href="style.css"`, `src="app.js"`} {
		if strings.Count(html, ref) != 1 {
			return fmt.Errorf("index.html: expected exactly one %s", ref)
		}
		attr, file, _ := strings.Cut(ref, `="`)
		html = strings.Replace(html, ref, attr+`="v/`+version+"/"+file, 1)
	}
	rootFiles["index.html"] = []byte(html)
	for n, b := range rootFiles {
		dst := filepath.Join(out, filepath.FromSlash(n))
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(dst, b, 0o644); err != nil {
			return err
		}
	}

	log.Printf("built %s: version %s, engine %s (%.1f MB raw, %.1f MB gz)",
		out, version, name, float64(len(wasm))/(1<<20), float64(gz.Len())/(1<<20))
	return nil
}

// writeThirdPartyLicenses collects the license files of every module
// linked into the js/wasm engine, and Go's own license (the runtime,
// standard library and wasm_exec.js ship to browsers too).
func writeThirdPartyLicenses(dst, goroot string) error {
	cmd := exec.Command("go", "list", "-tags", wasmTags, "-deps", "-json=Module", "./cmd/engine")
	cmd.Env = append(os.Environ(), "GOOS=js", "GOARCH=wasm")
	cmd.Stderr = os.Stderr
	raw, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("go list: %w", err)
	}
	type module struct {
		Path, Version, Dir string
		Main               bool
	}
	mods := map[string]module{}
	dec := json.NewDecoder(bytes.NewReader(raw))
	for dec.More() {
		var pkg struct{ Module *module }
		if err := dec.Decode(&pkg); err != nil {
			return err
		}
		if m := pkg.Module; m != nil && !m.Main {
			mods[m.Path] = *m
		}
	}
	paths := make([]string, 0, len(mods))
	for p := range mods {
		paths = append(paths, p)
	}
	sort.Strings(paths)

	var b strings.Builder
	b.WriteString("Third-party software shipped by fileporter: the engine (engine.*.wasm.gzip),\n")
	b.WriteString("wasm_exec.js and vendored browser libraries, with their licenses.\n\n")
	section := func(title string, files ...string) error {
		b.WriteString(strings.Repeat("=", 78) + "\n" + title + "\n" + strings.Repeat("=", 78) + "\n")
		for _, f := range files {
			txt, err := os.ReadFile(f)
			if err != nil {
				return err
			}
			b.WriteString("\n--- " + filepath.Base(f) + " ---\n\n")
			b.Write(bytes.TrimSpace(txt))
			b.WriteString("\n")
		}
		b.WriteString("\n")
		return nil
	}
	if err := section("Go (runtime, standard library, wasm_exec.js)", filepath.Join(goroot, "LICENSE")); err != nil {
		return err
	}
	// Vendored browser libraries: each ships with a <file>.LICENSE.
	vendored, _ := filepath.Glob(filepath.Join("web", "vendor", "*.LICENSE"))
	sort.Strings(vendored)
	for _, f := range vendored {
		if err := section("web/vendor/"+strings.TrimSuffix(filepath.Base(f), ".LICENSE"), f); err != nil {
			return err
		}
	}
	for _, p := range paths {
		m := mods[p]
		files, err := licenseFiles(m.Dir)
		if err != nil {
			return err
		}
		if len(files) == 0 {
			return fmt.Errorf("module %s has no license file; refusing to ship it without one", p)
		}
		if err := section(m.Path+" "+m.Version, files...); err != nil {
			return err
		}
	}
	return os.WriteFile(dst, []byte(b.String()), 0o644)
}

// licenseFiles returns the license and notice files at the top of a
// module directory.
func licenseFiles(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range entries {
		n := strings.ToUpper(e.Name())
		if e.IsDir() || strings.HasSuffix(n, ".GO") {
			continue
		}
		for _, prefix := range []string{"LICENSE", "LICENCE", "COPYING", "NOTICE"} {
			if strings.HasPrefix(n, prefix) {
				out = append(out, filepath.Join(dir, e.Name()))
				break
			}
		}
	}
	return out, nil
}

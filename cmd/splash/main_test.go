// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestUpdateHTML(t *testing.T) {
	path := filepath.Join(t.TempDir(), "index.html")
	before := "<head>\n  <meta charset=\"utf-8\">\n  <!-- splash:begin: generated -->\n  <link old1>\n  <link old2>\n  <!-- splash:end -->\n  <title>x</title>\n</head>\n"
	if err := os.WriteFile(path, []byte(before), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := updateHTML(path, []string{"  <link new1>", "  <link new2>", "  <link new3>"}); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(path)
	want := "<head>\n  <meta charset=\"utf-8\">\n  <!-- splash:begin: generated -->\n  <link new1>\n  <link new2>\n  <link new3>\n  <!-- splash:end -->\n  <title>x</title>\n</head>\n"
	if string(got) != want {
		t.Errorf("got:\n%s\nwant:\n%s", got, want)
	}

	// Running it again with the same tags changes nothing.
	if err := updateHTML(path, []string{"  <link new1>", "  <link new2>", "  <link new3>"}); err != nil {
		t.Fatal(err)
	}
	if again, _ := os.ReadFile(path); string(again) != want {
		t.Errorf("second run changed the file:\n%s", again)
	}
}

func TestUpdateHTMLNoMarkers(t *testing.T) {
	for name, html := range map[string]string{
		"none":     "<head></head>\n",
		"no end":   "<!-- splash:begin -->\n<link>\n",
		"no begin": "<link>\n<!-- splash:end -->\n",
		"reversed": "<!-- splash:end -->\n<!-- splash:begin -->\n",
	} {
		path := filepath.Join(t.TempDir(), "index.html")
		if err := os.WriteFile(path, []byte(html), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := updateHTML(path, []string{"<link new>"}); err == nil {
			t.Errorf("%s: no error", name)
		}
		if got, _ := os.ReadFile(path); string(got) != html {
			t.Errorf("%s: file changed to %q", name, got)
		}
	}
}

func TestRender(t *testing.T) {
	const w, h = 60, 100
	img := render(w, h)
	if b := img.Bounds(); b.Dx() != w || b.Dy() != h {
		t.Fatalf("size %v, want %dx%d", b, w, h)
	}
	// Green background, white mark in the middle (the left half disc).
	for _, p := range [][2]int{{0, 0}, {w - 1, h - 1}, {w - 1, 0}, {0, h / 2}} {
		if got := img.RGBAAt(p[0], p[1]); got != green {
			t.Errorf("background at %v is %v, want %v", p, got, green)
		}
	}
	if got := img.RGBAAt(w/2-2, h/2); got != white {
		t.Errorf("mark centre is %v, want %v", got, white)
	}
}

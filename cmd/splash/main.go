// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// Command splash renders the iPhone launch screens for the installed
// app and points index.html at them.
//
// Android builds its splash screen from the web app manifest
// (background_color plus the icon); iOS instead shows a prebuilt image
// that must match the screen exactly, chosen by media query. Each one
// is the logo mark in white on the logo's green, like Android's.
//
// It writes web/icons/splash/<w>x<h>.png for every screen in screens,
// in both orientations, and replaces the lines between the
// "splash:begin" and "splash:end" markers in web/index.html with the
// matching <link rel="apple-touch-startup-image"> tags. Add new iPhone
// sizes to screens and run it again:
//
//	go run ./cmd/splash
package main

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"log"
	"math"
	"os"
	"path/filepath"
	"strings"
)

// screen is an iPhone display in CSS pixels (portrait) and its
// device pixel ratio.
type screen struct {
	w, h, dpr int
	models    string
}

var screens = []screen{
	{440, 956, 3, "16 Pro Max, 17 Pro Max"},
	{430, 932, 3, "14 Pro Max, 15 Plus/Pro Max, 16 Plus"},
	{428, 926, 3, "12/13 Pro Max, 14 Plus"},
	{420, 912, 3, "Air"},
	{414, 896, 3, "XS Max, 11 Pro Max"},
	{414, 896, 2, "XR, 11"},
	{414, 736, 3, "6/7/8 Plus"},
	{402, 874, 3, "16 Pro, 17, 17 Pro"},
	{393, 852, 3, "14 Pro, 15, 15 Pro, 16, 16e"},
	{390, 844, 3, "12, 12 Pro, 13, 13 Pro, 14"},
	{375, 812, 3, "X, XS, 11 Pro, 12/13 mini"},
	{375, 667, 2, "6/7/8, SE (2nd, 3rd gen)"},
	{320, 568, 2, "SE (1st gen), 5s"},
}

var (
	green = color.RGBA{0x0b, 0x7a, 0x69, 0xff} // icon.svg's fill and the manifest's background_color
	white = color.RGBA{0xff, 0xff, 0xff, 0xff}
)

// markSize is the mark's width as a fraction of the screen's shorter
// side, about what Android's splash screen shows of the icon.
const markSize = 0.32

func main() {
	dir := filepath.Join("web", "icons", "splash")
	if err := os.RemoveAll(dir); err != nil {
		log.Fatal(err)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Fatal(err)
	}
	var tags []string
	for _, s := range screens {
		pw, ph := s.w*s.dpr, s.h*s.dpr
		for _, o := range []struct {
			name string
			w, h int
		}{{"portrait", pw, ph}, {"landscape", ph, pw}} {
			name := fmt.Sprintf("%dx%d.png", o.w, o.h)
			if err := writePNG(filepath.Join(dir, name), render(o.w, o.h)); err != nil {
				log.Fatal(err)
			}
			tags = append(tags, fmt.Sprintf(`  <link rel="apple-touch-startup-image" media="(device-width: %dpx) and (device-height: %dpx) and (-webkit-device-pixel-ratio: %d) and (orientation: %s)" href="icons/splash/%s">`,
				s.w, s.h, s.dpr, o.name, name))
		}
	}
	if err := updateHTML(filepath.Join("web", "index.html"), tags); err != nil {
		log.Fatal(err)
	}
	log.Printf("wrote %d launch screens to %s", len(tags), dir)
}

// render draws the logo mark (see web/icons/icon.svg, a 32-unit box)
// centred on green, anti-aliased by 4×4 supersampling.
func render(w, h int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for i := 0; i < len(img.Pix); i += 4 {
		copy(img.Pix[i:], []byte{green.R, green.G, green.B, green.A})
	}
	// The mark spans units 2..30 (the ring's outer edge); 28 units wide.
	unit := markSize * float64(min(w, h)) / 28
	cx, cy := float64(w)/2, float64(h)/2
	toMark := func(px, py float64) (float64, float64) {
		return 16 + (px-cx)/unit, 16 + (py-cy)/unit
	}
	x0, x1 := int(cx-15*unit), int(cx+15*unit)+1
	y0, y1 := int(cy-15*unit), int(cy+15*unit)+1
	const ss = 4
	for y := y0; y < y1; y++ {
		for x := x0; x < x1; x++ {
			n := 0
			for sy := 0; sy < ss; sy++ {
				for sx := 0; sx < ss; sx++ {
					mx, my := toMark(float64(x)+(float64(sx)+0.5)/ss, float64(y)+(float64(sy)+0.5)/ss)
					if inMark(mx, my) {
						n++
					}
				}
			}
			if n == 0 {
				continue
			}
			a := float64(n) / (ss * ss)
			mix := func(bg, fg uint8) uint8 { return uint8(math.Round(float64(bg)*(1-a) + float64(fg)*a)) }
			img.SetRGBA(x, y, color.RGBA{mix(green.R, white.R), mix(green.G, white.G), mix(green.B, white.B), 0xff})
		}
	}
	return img
}

// inMark reports whether (x, y), in the mark's 32-unit box, is inked:
// a ring (radius 12.5, stroke 3), the left half of a disc (radius 7.5)
// and a dot (radius 2.25 at 20.5, 16).
func inMark(x, y float64) bool {
	d := math.Hypot(x-16, y-16)
	switch {
	case d >= 11 && d <= 14:
		return true
	case x <= 16 && d <= 7.5:
		return true
	case math.Hypot(x-20.5, y-16) <= 2.25:
		return true
	}
	return false
}

func writePNG(path string, img image.Image) error {
	var b bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestCompression}
	if err := enc.Encode(&b, img); err != nil {
		return err
	}
	return os.WriteFile(path, b.Bytes(), 0o644)
}

func updateHTML(path string, tags []string) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	const begin, end = "<!-- splash:begin", "<!-- splash:end -->"
	html := string(b)
	i := strings.Index(html, begin)
	j := strings.Index(html, end)
	if i < 0 || j < i {
		return fmt.Errorf("%s: no %q … %q markers", path, begin, end)
	}
	// Keep the begin marker's line, replace everything up to the end marker.
	i += strings.Index(html[i:], "\n") + 1
	lineStart := strings.LastIndex(html[:j], "\n") + 1
	html = html[:i] + strings.Join(tags, "\n") + "\n" + html[lineStart:]
	return os.WriteFile(path, []byte(html), 0o644)
}

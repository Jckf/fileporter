// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later

// Checks the JavaScript boundary: bad input is rejected instead of
// panicking (which would kill the engine), closing a Conn is safe, and
// writes arrive intact. Needs node to run:
//
//	GOOS=js GOARCH=wasm go test -exec="$(go env GOROOT)/lib/wasm/go_js_wasm_exec" ./cmd/engine
package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net"
	"strings"
	"syscall/js"
	"testing"

	"github.com/tailscale/tailcat"
	"tailscale.com/types/key"
)

// await waits for p to settle and returns its value, or its rejection
// message as err.
func await(t *testing.T, p any) (val js.Value, err string) {
	t.Helper()
	type result struct {
		val js.Value
		err string
	}
	ch := make(chan result, 1)
	ok := js.FuncOf(func(this js.Value, args []js.Value) any {
		ch <- result{val: args[0]}
		return nil
	})
	defer ok.Release()
	fail := js.FuncOf(func(this js.Value, args []js.Value) any {
		ch <- result{err: args[0].Get("message").String()}
		return nil
	})
	defer fail.Release()
	js.ValueOf(p).Call("then", ok, fail)
	r := <-ch
	return r.val, r.err
}

func opts(m map[string]any) []js.Value { return []js.Value{js.ValueOf(m)} }

func TestDialRejectsBadPort(t *testing.T) {
	for _, port := range []any{0, -1, 65536, 1.5, js.Global().Get("NaN"), js.Global().Get("Infinity")} {
		_, err := await(t, tsDial(js.Undefined(), opts(map[string]any{"addr": "x", "clientKey": "x", "port": port})))
		if !strings.Contains(err, "port must be") {
			t.Errorf("port %v: got %q, want a port error", port, err)
		}
	}
}

func TestListenRejectsKeyWithoutRegion(t *testing.T) {
	pk := tailcat.NewPrivateKey() // RegionID 0: Expand leaves Region empty
	senderKey, _ := json.Marshal(pk)
	allow, _ := key.NewNode().Public().MarshalText()
	_, err := await(t, tsListen(js.Undefined(), opts(map[string]any{
		"derpMapURL":   "http://127.0.0.1:1/derpmap",
		"senderKey":    string(senderKey),
		"allowClient":  string(allow),
		"onConnection": js.Global().Get("Function").New(),
	})))
	if !strings.Contains(err, "no DERP region") {
		t.Errorf("got %q, want a region error", err)
	}
}

func TestConn(t *testing.T) {
	a, b := net.Pipe()
	defer b.Close()
	closed := 0
	jc := makeJSConn(a, 1, func() { closed++ })

	for _, arg := range []js.Value{js.ValueOf("hi"), js.ValueOf(3), js.Null(), js.Global().Get("Array").New(1)} {
		if _, err := await(t, jc.Call("write", arg)); !strings.Contains(err, "requires a Uint8Array") {
			t.Errorf("write(%v): got %q, want a type error", arg, err)
		}
	}

	// A write in flight when the conn closes settles with an error.
	u8 := uint8Array.New(3)
	pending := jc.Call("write", u8)
	jc.Call("close")
	jc.Call("close")
	if closed != 1 {
		t.Errorf("onClose ran %d times, want 1", closed)
	}
	if _, err := await(t, pending); err == "" {
		t.Error("write in flight: resolved after close, want an error")
	}
	for _, m := range []string{"read", "write", "closeWrite"} {
		if _, err := await(t, jc.Call(m, u8)); err == "" {
			t.Errorf("%s after close: resolved, want an error", m)
		}
	}
}

// Writes of varying sizes reuse pooled buffers; each must arrive whole.
func TestWrite(t *testing.T) {
	a, b := net.Pipe()
	jc := makeJSConn(a, 1, nil)
	defer jc.Call("close")
	defer b.Close()
	for _, n := range []int{3, 100 << 10, 5, 200 << 10, 7} {
		want := make([]byte, n)
		for i := range want {
			want[i] = byte(n + i)
		}
		u8 := uint8Array.New(n)
		js.CopyBytesToJS(u8, want)
		p := jc.Call("write", u8)
		got := make([]byte, n)
		if _, err := io.ReadFull(b, got); err != nil {
			t.Fatal(err)
		}
		if _, err := await(t, p); err != "" {
			t.Fatal(err)
		}
		if !bytes.Equal(got, want) {
			t.Fatalf("write of %d bytes arrived changed", n)
		}
	}
}

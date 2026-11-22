// Copyright (c) 2026 Jim C K Flaten
// SPDX-License-Identifier: AGPL-3.0-or-later AND BSD-3-Clause
//
// Derived from github.com/tailscale/tailcat/web/main_js.go:
// Copyright (c) Tailscale Inc & contributors, BSD-3-Clause (see LICENSE.tailcat).
// Modifications are licensed under the AGPL-3.0-or-later.

// The fileporter engine is tailcat compiled to js/wasm. It is meant to
// run inside a dedicated Web Worker (see web/engine-worker.js), but
// only depends on globalThis, so it also runs on a page's main thread.
//
// It exposes three global functions:
//
//	tsNewSession({derpMapURL})                       → Promise<Session>
//	tsListen({derpMapURL, senderKey, allowClient,
//	          onConnection, verbose})                → Promise<Listener>
//	tsDial({addr, derpMapURL, clientKey, port,
//	        timeoutMs, verbose})                     → Promise<Conn>
//
// Unlike the upstream web demo, keys are never generated implicitly
// by tsListen/tsDial: the page creates all session keys up front with
// tsNewSession and carries them in URL fragments, so that reopening
// the same URL resumes the same session (same server address, same
// allowed client key) without persisting anything in storage.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"os"
	"sync"
	"syscall/js"
	"time"

	"github.com/tailscale/tailcat"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

// tunnelMTU replaces the tunnel's usual 1280 bytes. In a browser the
// tunnel only ever runs over the DERP relay's WebSocket (there's no
// UDP), so packets are never fragmented on the way and the MTU only
// sets how many packets a transfer takes. Each one costs about the
// same CPU (WireGuard, the userspace TCP stack, the WebSocket, and
// crossing into JS), so 1280 made a relayed transfer use more than a
// core on each side. 16000 cuts that by more than half at the same
// speed. Upper bound: the browser rejects WebSocket messages over 32 KiB
// (github.com/coder/websocket's read limit, which derphttp leaves as
// is), and a DERP frame adds headers; this leaves room for two frames
// in one message. TCP's MSS is negotiated, so a peer with the old MTU
// still works: both sides use the smaller one.
const tunnelMTU = "16000"

func main() {
	// Read when the engine starts, which is later.
	os.Setenv("TS_DEBUG_MTU", tunnelMTU)
	g := js.Global()
	g.Set("tsNewSession", js.FuncOf(tsNewSession))
	g.Set("tsListen", js.FuncOf(tsListen))
	g.Set("tsDial", js.FuncOf(tsDial))
	if f := g.Get("onEngineReady"); f.Type() == js.TypeFunction {
		f.Invoke()
	}
	select {}
}

// tsNewSession creates every key a transfer session needs:
//
//   - the sender's tailcat server key (with a WireGuard pre-shared key
//     and a pinned DERP region, so the address is stable for the
//     lifetime of the session), and
//   - the receiver's client key, which the sender allowlists.
//
// It resolves to:
//
//	{
//	  senderKey:   string, // tailcat.PrivateKey JSON; secret, sender fragment only
//	  addr:        string, // the sender's "tc…" address; secret, receiver fragment
//	  receiverKey: string, // "privkey:…"; secret, receiver fragment only
//	  receiverPub: string, // "nodekey:…"; sender fragment (allowlist)
//	}
func tsNewSession(this js.Value, args []js.Value) any {
	if len(args) != 1 || args[0].Type() != js.TypeObject {
		return rejectedPromise(errors.New("tsNewSession requires an options object"))
	}
	derpMapURL := optString(args[0], "derpMapURL")
	// The relay region nearest the sender, measured by the page (here,
	// in a browser, tailcat can only pick one at random); 0 if unknown.
	regionID, err := optInt(args[0], "regionID", 0, math.MaxInt32, 0)
	if err != nil {
		return rejectedPromise(err)
	}
	return makePromise(func() (any, error) {
		if derpMapURL == "" {
			return nil, errors.New("derpMapURL is required")
		}
		pk := tailcat.NewPrivateKey()
		pk.Public.RegionID = -1 // auto-select below
		if regionID > 0 {
			pk.Public.RegionID = tailcfg.DERPRegionID(regionID)
		}

		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		ci := pk.Public
		if err := ci.Expand(ctx, tailcat.ExpandForServer, tailcat.DERPMapURL(derpMapURL)); err != nil {
			return nil, fmt.Errorf("picking DERP region: %w", err)
		}
		if len(ci.Region) == 0 || ci.Region[0] == nil {
			return nil, errors.New("picking DERP region: none picked")
		}
		// Pin the region so reopening the sender URL yields the
		// same address.
		pk.Public.RegionID = ci.Region[0].RegionID

		senderKey, err := json.Marshal(pk)
		if err != nil {
			return nil, err
		}
		recv := key.NewNode()
		recvPriv, err := recv.MarshalText()
		if err != nil {
			return nil, err
		}
		recvPub, err := recv.Public().MarshalText()
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"senderKey":   string(senderKey),
			"addr":        string(pk.Public.Addr()),
			"receiverKey": string(recvPriv),
			"receiverPub": string(recvPub),
		}, nil
	})
}

// tsListen starts the sender's tailcat server from a key made by
// tsNewSession. Only the client whose public key is allowClient may
// connect; every other client is silently ignored by tailcat.
//
// It resolves to {addr: string, region: string (the relay's code),
// close: () => void}. Each incoming TCP connection is passed to
// onConnection as a Conn (see makeJSConn).
func tsListen(this js.Value, args []js.Value) any {
	if len(args) != 1 || args[0].Type() != js.TypeObject {
		return rejectedPromise(errors.New("tsListen requires an options object"))
	}
	opts := args[0]
	onConnection := opts.Get("onConnection")
	derpMapURL := optString(opts, "derpMapURL")
	senderKey := optString(opts, "senderKey")
	allowClient := optString(opts, "allowClient")
	logf := optLogf(opts)
	return makePromise(func() (any, error) {
		if onConnection.Type() != js.TypeFunction {
			return nil, errors.New("onConnection function is required")
		}
		if derpMapURL == "" || senderKey == "" || allowClient == "" {
			return nil, errors.New("derpMapURL, senderKey and allowClient are required")
		}
		var pk tailcat.PrivateKey
		if err := json.Unmarshal([]byte(senderKey), &pk); err != nil {
			return nil, fmt.Errorf("parsing senderKey: %w", err)
		}
		if pk.Public.PresharedKey.IsZero() {
			return nil, errors.New("senderKey has no pre-shared key")
		}
		var allowed key.NodePublic
		if err := allowed.UnmarshalText([]byte(allowClient)); err != nil {
			return nil, fmt.Errorf("parsing allowClient: %w", err)
		}
		var allow tailcat.KeySet
		allow.Add(allowed)

		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		ci := pk.Public
		if err := ci.Expand(ctx, tailcat.ExpandForServer, tailcat.DERPMapURL(derpMapURL)); err != nil {
			return nil, fmt.Errorf("expand: %w", err)
		}
		// Expand leaves Region empty when RegionID is 0, which a
		// senderKey (from a URL fragment) can carry.
		if len(ci.Region) == 0 || ci.Region[0] == nil {
			return nil, errors.New("senderKey has no DERP region")
		}
		region := ci.Region[0]

		srv := &tailcat.Server{
			Key:          pk.Private,
			PresharedKey: pk.Public.PresharedKey,
			Logf:         logf,
			Region:       region,
			AllowClient:  allow.Contains,
		}
		srv.OnTCP = func(port uint16) func(net.Conn) {
			return func(c net.Conn) {
				onConnection.Invoke(makeJSConn(c, port, nil))
			}
		}
		if err := srv.Start(); err != nil {
			srv.Close()
			return nil, fmt.Errorf("Server.Start: %w", err)
		}
		ln := js.ValueOf(map[string]any{
			"addr":   string(pk.Public.Addr()),
			"region": region.RegionCode, // the relay, for diagnostics
		})
		// Released on close, like a Conn's methods (see makeJSConn).
		var once sync.Once
		var closeFn js.Func
		closeFn = js.FuncOf(func(this js.Value, args []js.Value) any {
			once.Do(func() {
				srv.Close()
				ln.Set("close", closedClose)
				closeFn.Release()
			})
			return nil
		})
		ln.Set("close", closeFn)
		return ln, nil
	})
}

// tsDial connects to the sender with the receiver's client key from
// tsNewSession and opens one TCP stream (default port 1).
// It resolves to a Conn (see makeJSConn), with region set to the
// relay's code.
func tsDial(this js.Value, args []js.Value) any {
	if len(args) != 1 || args[0].Type() != js.TypeObject {
		return rejectedPromise(errors.New("tsDial requires an options object"))
	}
	opts := args[0]
	addr := optString(opts, "addr")
	derpMapURL := optString(opts, "derpMapURL")
	clientKey := optString(opts, "clientKey")
	logf := optLogf(opts)
	p, err := optInt(opts, "port", 1, 65535, 1)
	if err != nil {
		return rejectedPromise(err)
	}
	port := uint16(p)
	timeoutMs, err := optInt(opts, "timeoutMs", 1, 3_600_000, 60_000)
	if err != nil {
		return rejectedPromise(err)
	}
	timeout := time.Duration(timeoutMs) * time.Millisecond
	return makePromise(func() (any, error) {
		if addr == "" || clientKey == "" {
			return nil, errors.New("addr and clientKey are required")
		}
		var priv key.NodePrivate
		if err := priv.UnmarshalText([]byte(clientKey)); err != nil {
			return nil, fmt.Errorf("parsing clientKey: %w", err)
		}
		cl := &tailcat.Client{
			Server:     tailcat.Addr(addr),
			Key:        priv,
			Logf:       logf,
			DERPMapURL: derpMapURL,
		}
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		if err := pingUntil(ctx, cl); err != nil {
			cl.Close()
			return nil, err
		}
		c, err := cl.DialTCPPort(ctx, port)
		if err != nil {
			cl.Close()
			return nil, fmt.Errorf("DialTCPPort: %w", err)
		}
		jc := makeJSConn(c, port, func() { cl.Close() })
		// Which relay carries it, for diagnostics.
		if r := cl.DERPRegion(); r != nil {
			jc.Set("region", r.RegionCode)
		}
		return jc, nil
	})
}

// pingUntil retries the meow/meowed handshake until it succeeds or
// ctx expires. The first pings can be lost while either side's DERP
// connection is still coming up.
//
// A ping that fails fast (offline, or the DERP map fetch failing) is
// retried with a growing pause, so it isn't refetched in a tight loop.
// Attempts start at least delay apart, so a ping that timed out is
// retried right away as before.
func pingUntil(ctx context.Context, cl *tailcat.Client) error {
	delay := 250 * time.Millisecond
	for {
		start := time.Now()
		pctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		_, err := cl.Ping(pctx)
		cancel()
		if err == nil {
			return nil
		}
		if ctx.Err() != nil {
			return fmt.Errorf("ping: %w", err)
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("ping: %w", err)
		case <-time.After(delay - time.Since(start)):
		}
		delay = min(delay*2, 2*time.Second)
	}
}

// makeJSConn wraps a tunneled TCP connection as a JavaScript object:
//
//	{
//	  port: number,
//	  read: () => Promise<Uint8Array|null>, // null on EOF; no concurrent calls
//	  write: (Uint8Array) => Promise,     // wait for each before the next
//	  closeWrite: () => Promise,
//	  close: () => void,
//	}
//
// read is pull-based, so a fast sender stalls on TCP backpressure
// instead of filling memory.
//
// Each write runs in its own goroutine, so writes started before the
// previous one settled could reach the connection in any order; the
// worker's callers chain them (web/framing.js).
//
// close releases the methods' js.Funcs. syscall/js keeps every Func in
// a global table until then, and with it the conn, its read buffer and
// (for tsDial) the whole tailcat.Client. Calling a released Func only
// logs a console error and returns undefined, so close also swaps the
// methods for shared stubs: the others reject, close does nothing. A
// read or write already in flight is unaffected: its goroutine holds
// the conn and buffer, not the Func, and settles (with an error) once
// the conn is closed.
func makeJSConn(c net.Conn, port uint16, onClose func()) js.Value {
	buf := make([]byte, 64<<10)
	read := js.FuncOf(func(this js.Value, args []js.Value) any {
		return makePromise(func() (any, error) {
			for {
				n, err := c.Read(buf)
				if n > 0 {
					u8 := uint8Array.New(n)
					js.CopyBytesToJS(u8, buf[:n])
					return u8, nil
				}
				if errors.Is(err, io.EOF) {
					return js.Null(), nil
				}
				if err != nil {
					return nil, err
				}
				// (0, nil) is allowed and means nothing yet, not EOF.
			}
		})
	})
	write := js.FuncOf(func(this js.Value, args []js.Value) any {
		// CopyBytesToGo panics on anything else, which would kill the
		// engine.
		if len(args) != 1 || !args[0].InstanceOf(uint8Array) {
			return rejectedPromise(errors.New("write requires a Uint8Array"))
		}
		// The copy can't be skipped (Go can't see JavaScript's memory),
		// but its buffer can be reused: Write doesn't keep it.
		n := args[0].Get("length").Int()
		bp := writeBufs.Get().(*[]byte)
		if cap(*bp) < n {
			*bp = make([]byte, n)
		}
		b := (*bp)[:n]
		js.CopyBytesToGo(b, args[0])
		return makePromise(func() (any, error) {
			_, err := c.Write(b)
			writeBufs.Put(bp)
			if err != nil {
				return nil, err
			}
			return js.Undefined(), nil
		})
	})
	closeWrite := js.FuncOf(func(this js.Value, args []js.Value) any {
		return makePromise(func() (any, error) {
			cw, ok := c.(interface{ CloseWrite() error })
			if !ok {
				return nil, errors.New("connection does not support half-close")
			}
			return js.Undefined(), cw.CloseWrite()
		})
	})
	jc := js.ValueOf(map[string]any{
		"port":       int(port),
		"read":       read,
		"write":      write,
		"closeWrite": closeWrite,
	})
	var once sync.Once
	var closeFn js.Func
	closeFn = js.FuncOf(func(this js.Value, args []js.Value) any {
		once.Do(func() {
			c.Close()
			if onClose != nil {
				onClose()
			}
			jc.Set("read", closedMethod)
			jc.Set("write", closedMethod)
			jc.Set("closeWrite", closedMethod)
			jc.Set("close", closedClose)
			for _, f := range []js.Func{read, write, closeWrite, closeFn} {
				f.Release()
			}
		})
		return nil
	})
	jc.Set("close", closeFn)
	return jc
}

var uint8Array = js.Global().Get("Uint8Array")

// writeBufs holds the buffers Conn writes copy into, one per write in
// flight. Each grows to the largest write it has carried (a frame,
// during a transfer); the pool drops them when idle across GCs.
var writeBufs = sync.Pool{New: func() any { return new([]byte) }}

// closedMethod and closedClose replace a closed Conn's (or Listener's)
// methods. They're shared, so they hold on to nothing.
var (
	closedMethod = js.FuncOf(func(this js.Value, args []js.Value) any {
		return rejectedPromise(net.ErrClosed)
	})
	closedClose = js.FuncOf(func(this js.Value, args []js.Value) any { return nil })
)

// optInt returns v[name] as a whole number from lo to hi, or def if
// it isn't a number. Checked as a float: Value.Int would truncate 1.5,
// and turns Infinity or 1e300 into anything. NaN fails the range check.
func optInt(v js.Value, name string, lo, hi, def int) (int, error) {
	p := v.Get(name)
	if p.Type() != js.TypeNumber {
		return def, nil
	}
	f := p.Float()
	if !(f >= float64(lo) && f <= float64(hi)) || f != math.Trunc(f) {
		return 0, fmt.Errorf("%s must be an integer from %d to %d", name, lo, hi)
	}
	return int(f), nil
}

func optString(v js.Value, name string) string {
	if p := v.Get(name); p.Type() == js.TypeString {
		return p.String()
	}
	return ""
}

func optLogf(v js.Value) logger.Logf {
	if v.Get("verbose").Truthy() {
		return log.Printf
	}
	return logger.Discard
}

// makePromise runs f on a new goroutine and returns a JavaScript
// Promise of its result, rejected with a JavaScript Error if f
// returns an error.
func makePromise(f func() (any, error)) js.Value {
	handler := js.FuncOf(func(this js.Value, args []js.Value) any {
		resolve, reject := args[0], args[1]
		go func() {
			if res, err := f(); err == nil {
				resolve.Invoke(res)
			} else {
				reject.Invoke(js.Global().Get("Error").New(err.Error()))
			}
		}()
		return nil
	})
	// The Promise constructor calls handler synchronously, so it can be
	// released right away. Otherwise every call (one per 64 KiB read
	// during a transfer) would leave a js.Func registered for good.
	defer handler.Release()
	return js.Global().Get("Promise").New(handler)
}

func rejectedPromise(err error) js.Value {
	return js.Global().Get("Promise").Call("reject", js.Global().Get("Error").New(err.Error()))
}

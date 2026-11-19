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
	"net"
	"syscall/js"
	"time"

	"github.com/tailscale/tailcat"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

func main() {
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
	return makePromise(func() (any, error) {
		if derpMapURL == "" {
			return nil, errors.New("derpMapURL is required")
		}
		pk := tailcat.NewPrivateKey()
		pk.Public.RegionID = -1 // auto-select below

		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		ci := pk.Public
		if err := ci.Expand(ctx, tailcat.ExpandForServer, tailcat.DERPMapURL(derpMapURL)); err != nil {
			return nil, fmt.Errorf("picking DERP region: %w", err)
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
// It resolves to {addr: string, close: () => void}. Each incoming
// TCP connection is passed to onConnection as a Conn (see makeJSConn).
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
			return nil, fmt.Errorf("Expand: %w", err)
		}

		srv := &tailcat.Server{
			Key:          pk.Private,
			PresharedKey: pk.Public.PresharedKey,
			Logf:         logf,
			Region:       ci.Region[0],
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
		return map[string]any{
			"addr": string(pk.Public.Addr()),
			"close": js.FuncOf(func(this js.Value, args []js.Value) any {
				srv.Close()
				return nil
			}),
		}, nil
	})
}

// tsDial connects to the sender with the receiver's client key from
// tsNewSession and opens one TCP stream (default port 1).
// It resolves to a Conn (see makeJSConn).
func tsDial(this js.Value, args []js.Value) any {
	if len(args) != 1 || args[0].Type() != js.TypeObject {
		return rejectedPromise(errors.New("tsDial requires an options object"))
	}
	opts := args[0]
	addr := optString(opts, "addr")
	derpMapURL := optString(opts, "derpMapURL")
	clientKey := optString(opts, "clientKey")
	logf := optLogf(opts)
	port := uint16(1)
	if p := opts.Get("port"); p.Type() == js.TypeNumber {
		port = uint16(p.Int())
	}
	timeout := 60 * time.Second
	if t := opts.Get("timeoutMs"); t.Type() == js.TypeNumber && t.Int() > 0 {
		timeout = time.Duration(t.Int()) * time.Millisecond
	}
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
		return makeJSConn(c, port, func() { cl.Close() }), nil
	})
}

// pingUntil retries the meow/meowed handshake until it succeeds or
// ctx expires. The first pings can be lost while either side's DERP
// connection is still coming up.
func pingUntil(ctx context.Context, cl *tailcat.Client) error {
	for {
		pctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		_, err := cl.Ping(pctx)
		cancel()
		if err == nil {
			return nil
		}
		if ctx.Err() != nil {
			return fmt.Errorf("ping: %w", err)
		}
	}
}

// makeJSConn wraps a tunneled TCP connection as a JavaScript object:
//
//	{
//	  port: number,
//	  read: () => Promise<Uint8Array|null>, // null on EOF; no concurrent calls
//	  write: (Uint8Array) => Promise,
//	  closeWrite: () => Promise,
//	  close: () => void,
//	}
//
// read is pull-based, so a fast sender stalls on TCP backpressure
// instead of filling memory.
func makeJSConn(c net.Conn, port uint16, onClose func()) js.Value {
	buf := make([]byte, 64<<10)
	return js.ValueOf(map[string]any{
		"port": int(port),
		"read": js.FuncOf(func(this js.Value, args []js.Value) any {
			return makePromise(func() (any, error) {
				n, err := c.Read(buf)
				if n > 0 {
					u8 := js.Global().Get("Uint8Array").New(n)
					js.CopyBytesToJS(u8, buf[:n])
					return u8, nil
				}
				if err == nil || errors.Is(err, io.EOF) {
					return js.Null(), nil
				}
				return nil, err
			})
		}),
		"write": js.FuncOf(func(this js.Value, args []js.Value) any {
			if len(args) != 1 {
				return rejectedPromise(errors.New("write requires a Uint8Array"))
			}
			b := make([]byte, args[0].Get("length").Int())
			js.CopyBytesToGo(b, args[0])
			return makePromise(func() (any, error) {
				if _, err := c.Write(b); err != nil {
					return nil, err
				}
				return js.Undefined(), nil
			})
		}),
		"closeWrite": js.FuncOf(func(this js.Value, args []js.Value) any {
			return makePromise(func() (any, error) {
				cw, ok := c.(interface{ CloseWrite() error })
				if !ok {
					return nil, errors.New("connection does not support half-close")
				}
				return js.Undefined(), cw.CloseWrite()
			})
		}),
		"close": js.FuncOf(func(this js.Value, args []js.Value) any {
			c.Close()
			if onClose != nil {
				onClose()
			}
			return nil
		}),
	})
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

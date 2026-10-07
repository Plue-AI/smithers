package main

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"testing"
)

func TestRelayRefusesMissingInstalledAuthentication(t *testing.T) {
	r := relayControl{}
	if _, err := r.opener(context.Background())(&open{Kind: "exec", Argv: []string{"/bin/sh"}}); err != errAuthority {
		t.Fatal(err)
	}
	if err := r.revoke(context.Background()); err != errAuthority {
		t.Fatal(err)
	}
}
func TestControlExchangeRequiresOwnedSessionOrConfirmedDrain(t *testing.T) {
	for _, body := range []string{`{"session":"s-0000000000000001"}`, `{"ok":true}`, `{"session":"s-0000000000000001","received":3}`} {
		host, guest := net.Pipe()
		go func() {
			defer guest.Close()
			var length [4]byte
			io.ReadFull(guest, length[:])
			n := int(length[0])<<24 | int(length[1])<<16 | int(length[2])<<8 | int(length[3])
			input := make([]byte, n)
			io.ReadFull(guest, input)
			(&frameWriter{w: guest}).write(json.RawMessage(body))
		}()
		_, err := controlExchange(host, map[string]string{"type": "kill_sessions"})
		host.Close()
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, body := range []string{`{}`, `{"ok":false}`, `{"ok":true,"ok":false}`, `{"ok":true,"uid":0}`, `{"session":"../other"}`, `{"session":"s-0000000000000001","ok":true}`, `{"ok":null}`, `{"ok":true} {}`, `{"session":"s-0000000000000001","received":null}`} {
		var reply controlReply
		if strictControlReply([]byte(body), &reply) == nil {
			t.Fatalf("accepted %s", body)
		}
	}
}

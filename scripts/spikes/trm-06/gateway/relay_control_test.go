package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"testing"
	"time"
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
	for _, body := range []string{`{"session":"s-0000000000000001"}`, `{"ok":true}`, `{"session":"s-0000000000000001","received":3,"written":2,"input_eof":false}`} {
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

func TestRevocationWaitsForDrainAndCancellationEndsActualControlRead(t *testing.T) {
	host, guest := net.Pipe()
	defer host.Close()
	defer guest.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	completed := make(chan error, 1)
	go func() { completed <- confirmRevocation(ctx, host) }()
	var length uint32
	if err := binary.Read(guest, binary.BigEndian, &length); err != nil {
		t.Fatal(err)
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(guest, body); err != nil {
		t.Fatal(err)
	}
	if string(body) != `{"type":"kill_sessions"}` {
		t.Fatalf("%s", body)
	}
	select {
	case <-completed:
		t.Fatal("completed before populated-zero reply")
	default:
	}
	cancel()
	select {
	case err := <-completed:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("control read survived cancellation")
	}
	if _, err := guest.Write([]byte{0}); err == nil {
		t.Fatal("canceled control transport remained open")
	}
}

func TestRevocationUsesCallerDeadlineAndRequiresConfirmedDrain(t *testing.T) {
	for _, body := range []string{`{"ok":true}`, `{"class":"invalid","code":"session_refused"}`, "stall"} {
		t.Run(body, func(t *testing.T) {
			host, guest := net.Pipe()
			defer host.Close()
			defer guest.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
			defer cancel()
			peerDone := make(chan struct{})
			go func() {
				defer close(peerDone)
				var length uint32
				binary.Read(guest, binary.BigEndian, &length)
				io.CopyN(io.Discard, guest, int64(length))
				if body != "stall" {
					(&frameWriter{w: guest}).write(json.RawMessage(body))
				}
			}()
			err := confirmRevocation(ctx, host)
			if (body == `{"ok":true}`) != (err == nil) {
				t.Fatalf("reply %s error %v", body, err)
			}
			<-peerDone
		})
	}
}

func TestCloseSessionUsesOwnedIDAndRequiresConfirmation(t *testing.T) {
	for _, body := range []string{`{"ok":true}`, `{"ok":false}`, `{"class":"invalid","code":"session_refused"}`, `{"ok":true,"ok":true}`, "stall"} {
		t.Run(body, func(t *testing.T) {
			host, guest := net.Pipe()
			defer host.Close()
			defer guest.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			request := make(chan string, 1)
			done := make(chan struct{})
			go func() {
				defer close(done)
				var length uint32
				if err := binary.Read(guest, binary.BigEndian, &length); err != nil {
					return
				}
				raw := make([]byte, length)
				if _, err := io.ReadFull(guest, raw); err != nil {
					return
				}
				request <- string(raw)
				if body != "stall" {
					(&frameWriter{w: guest}).write(json.RawMessage(body))
				}
			}()
			err := confirmSessionClose(ctx, host, "s-0000000000000017")
			if (err == nil) != (body == `{"ok":true}`) {
				t.Fatalf("close reply %s: %v", body, err)
			}
			if got := <-request; got != `{"id":"s-0000000000000017","type":"close_session"}` {
				t.Fatalf("wrong owned close envelope: %s", got)
			}
			<-done
			if body == "stall" {
				if !errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("caller deadline lost: %v", err)
				}
				if _, err := guest.Write([]byte{0}); err == nil {
					t.Fatal("canceled close left transport open")
				}
			}
		})
	}
}

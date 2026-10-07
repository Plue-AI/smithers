package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"io"
	"net"
	"testing"
	"time"
)

func TestBootProofAuthenticatesRealTCPBeforeControl(t *testing.T) {
	b := bootIdentity{Boot: [16]byte{1}, Secret: [32]byte{2}}
	for _, scenario := range []string{"valid", "wrong-boot", "wrong-secret", "replayed-guest"} {
		t.Run(scenario, func(t *testing.T) {
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			done := make(chan error, 1)
			go func() {
				stream, err := listener.Accept()
				if err != nil {
					done <- err
					return
				}
				defer stream.Close()
				stream.SetDeadline(time.Now().Add(2 * time.Second))
				challenge := append([]byte("TRM06\x01"), b.Boot[:]...)
				challenge = append(challenge, make([]byte, 32)...)
				if scenario == "wrong-boot" {
					challenge[6] ^= 1
				}
				if err = writeAll(stream, challenge); err != nil {
					done <- err
					return
				}
				var response [64]byte
				if _, err = io.ReadFull(stream, response[:]); err != nil {
					done <- nil
					return
				}
				mac := hmac.New(sha256.New, b.Secret[:])
				mac.Write([]byte("smithers-machined/v1 host"))
				mac.Write(b.Boot[:])
				mac.Write(challenge[22:])
				if !hmac.Equal(response[32:], mac.Sum(nil)) {
					done <- nil
					return
				}
				mac = hmac.New(sha256.New, b.Secret[:])
				mac.Write([]byte("smithers-trm06/v1 guest"))
				mac.Write(b.Boot[:])
				mac.Write(challenge[22:])
				mac.Write(response[:32])
				proof := mac.Sum(nil)
				if scenario == "replayed-guest" {
					proof[0] ^= 1
				}
				if err = writeAll(stream, proof); err != nil {
					done <- err
					return
				}
				var control [7]byte
				n, _ := io.ReadFull(stream, control[:])
				if scenario == "valid" && (n != 7 || string(control[:]) != "control") {
					done <- io.ErrUnexpectedEOF
					return
				}
				if scenario != "valid" && n != 0 {
					done <- io.ErrShortBuffer
					return
				}
				done <- nil
			}()
			stream, err := net.Dial("tcp", listener.Addr().String())
			if err != nil {
				t.Fatal(err)
			}
			defer stream.Close()
			candidate := b
			if scenario == "wrong-secret" {
				candidate.Secret[0] ^= 1
			}
			err = candidate.authenticate(context.Background(), stream)
			if (err == nil) != (scenario == "valid") {
				t.Fatalf("authentication: %v", err)
			}
			if err == nil {
				if err = writeAll(stream, []byte("control")); err != nil {
					t.Fatal(err)
				}
			}
			if err = <-done; err != nil {
				t.Fatal(err)
			}
		})
	}
}
func TestBootCancellationClosesStalledPeer(t *testing.T) {
	host, guest := net.Pipe()
	defer guest.Close()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- (bootIdentity{Boot: [16]byte{1}, Secret: [32]byte{2}}).authenticate(ctx, host) }()
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("accepted canceled authentication")
		}
	case <-time.After(time.Second):
		t.Fatal("authentication outlived cancellation")
	}
	if n, _ := guest.Read(make([]byte, 1)); n != 0 {
		t.Fatal("transport remained open")
	}
}

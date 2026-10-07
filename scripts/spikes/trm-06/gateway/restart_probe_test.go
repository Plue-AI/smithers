package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

// Actual gateway SSH boundary with a test-only guest protocol peer. This does
// not certify installed relay/cgroups or first admission on a real VM.
func TestRestartRaceUsesConcurrentAuthenticatedSSHAndKeepsRefusals(t *testing.T) {
	for _, mode := range []string{"ready", "refused", "wrong-key"} {
		t.Run(mode, func(t *testing.T) {
			_, hostPrivate, _ := ed25519.GenerateKey(rand.Reader)
			host, _ := ssh.NewSignerFromKey(hostPrivate)
			_, benPrivate, _ := ed25519.GenerateKey(rand.Reader)
			ben, _ := ssh.NewSignerFromKey(benPrivate)
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			var calls atomic.Int32
			done := make(chan error, 1)
			go func() {
				done <- serveListener(ctx, listener, listenerAuthority{host, ben.PublicKey(), func(spec *open) (io.ReadWriteCloser, error) {
					calls.Add(1)
					if spec.Kind != "exec" || len(spec.Argv) != 3 || spec.Argv[2] != "exit 0" {
						return nil, errors.New("wrong literal probe")
					}
					if mode == "refused" {
						return nil, errors.New("startup barrier unavailable")
					}
					gateway, guest := net.Pipe()
					go func() {
						defer guest.Close()
						for _, body := range []string{`{"type":"exit","code":0}`} {
							if binary.Write(guest, binary.BigEndian, uint32(len(body))) != nil {
								return
							}
							if writeAll(guest, []byte(body)) != nil {
								return
							}
						}
					}()
					return gateway, nil
				}})
			}()
			defer func() {
				cancel()
				if err := <-done; err != nil && !errors.Is(err, context.Canceled) {
					t.Error(err)
				}
			}()
			key := ben
			if mode == "wrong-key" {
				key = host
			}
			config := &ssh.ClientConfig{User: "ben", Auth: []ssh.AuthMethod{ssh.PublicKeys(key)}, HostKeyCallback: ssh.FixedHostKey(host.PublicKey())}
			invoked := time.Now()
			if mode != "ready" {
				invoked = invoked.Add(-1900 * time.Millisecond)
			}
			rows, first, err := restartAdmissionRace(ctx, listener.Addr().String(), config, invoked)
			if (err == nil) != (mode == "ready") {
				t.Fatalf("%s: %v", mode, err)
			}
			if mode == "ready" {
				if len(rows) != 4 || calls.Load() != 4 {
					t.Fatalf("rows=%d opens=%d", len(rows), calls.Load())
				}
				workers := map[int]bool{}
				minimum := rows[0].Submitted
				for _, row := range rows {
					if row.Failure != "" || row.Completed.Before(row.Submitted) || row.Submitted.Before(invoked) {
						t.Fatalf("invalid sample: %+v", row)
					}
					workers[row.Worker] = true
					if row.Submitted.Before(minimum) {
						minimum = row.Submitted
					}
				}
				if len(workers) != 4 || !minimum.Equal(first) {
					t.Fatal("lost concurrent submission evidence")
				}
			} else {
				if !first.IsZero() || len(rows) == 0 {
					t.Fatal("refusal claimed admission or lost evidence")
				}
				for _, row := range rows {
					if row.Failure == "" {
						t.Fatal("refusal lost its error")
					}
				}
				if mode == "wrong-key" && calls.Load() != 0 {
					t.Fatal("unauthorized probe reached guest")
				}
			}
		})
	}
}

func TestRestartRaceExpiredBudgetDoesNotSubmit(t *testing.T) {
	rows, first, err := restartAdmissionRace(context.Background(), "127.0.0.1:1", nil, time.Now().Add(-3*time.Second))
	if err == nil || len(rows) != 0 || !first.IsZero() {
		t.Fatalf("expired: %+v %v", rows, err)
	}
}

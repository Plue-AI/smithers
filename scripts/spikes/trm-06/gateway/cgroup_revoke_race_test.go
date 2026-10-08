package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Exercise the actual framed host termination operation and filesystem swaps.
// The peer substitutes the guest: this validates the campaign's concurrency and
// failure evidence, not a root/cgroup-v2 or installed-acceptance receipt.
func TestSynchronizedCgroupRevokeRetainsBothOperations(t *testing.T) {
	for _, failure := range []string{"", "mutation", "revocation", "both"} {
		t.Run(failure, func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, "sessions")
			if err := os.Mkdir(path, 0700); err != nil {
				t.Fatal(err)
			}
			original := filepath.Join(root, "original")
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			mutating, revoking := make(chan struct{}), make(chan struct{})
			finished := make(chan error, 1)
			go func() {
				conn, err := listener.Accept()
				if err != nil {
					finished <- err
					return
				}
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
				var length uint32
				if err = binary.Read(conn, binary.BigEndian, &length); err != nil {
					finished <- err
					return
				}
				if length > 4096 {
					finished <- errors.New("oversized request")
					return
				}
				body := make([]byte, length)
				if _, err = io.ReadFull(conn, body); err != nil {
					finished <- err
					return
				}
				if string(body) != `{"type":"kill_sessions"}` {
					finished <- errors.New("wrong termination request")
					return
				}
				close(revoking)
				<-mutating
				reply := `{"ok":true}`
				if failure == "revocation" || failure == "both" {
					reply = `{"class":"invalid","code":"session_refused"}`
				}
				finished <- (&frameWriter{w: conn}).write(json.RawMessage(reply))
			}()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			race := synchronizedCgroupRevoke(func() ([]byte, error) {
				select {
				case <-revoking:
				case <-ctx.Done():
					return nil, ctx.Err()
				}
				if err := os.Rename(path, original); err != nil {
					close(mutating)
					return nil, err
				}
				if err := os.Mkdir(path, 0700); err != nil {
					close(mutating)
					return nil, err
				}
				close(mutating)
				if failure == "mutation" || failure == "both" {
					return []byte("partial-observation"), errors.New("mutation failed")
				}
				return []byte("replacement-observed"), nil
			}, func() error {
				conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", listener.Addr().String())
				if err != nil {
					return err
				}
				defer conn.Close()
				return confirmRevocation(ctx, conn)
			})
			if err := <-finished; err != nil {
				t.Fatal(err)
			}
			if err := race.validateOverlap(); err != nil {
				t.Fatal(err)
			}
			wantMutation := failure == "mutation" || failure == "both"
			wantRevocation := failure == "revocation" || failure == "both"
			if (race.Mutation.err != nil) != wantMutation || (race.Revocation.err != nil) != wantRevocation {
				t.Fatalf("failures lost: %+v", race)
			}
			if (race.Mutation.Failure != "") != wantMutation || (race.Revocation.Failure != "") != wantRevocation {
				t.Fatal("failure absent from durable fields")
			}
			expected := "replacement-observed"
			if wantMutation {
				expected = "partial-observation"
			}
			if string(race.Mutation.Raw) != expected {
				t.Fatal("raw observation lost")
			}
			for _, name := range []string{path, original} {
				if _, err := os.Stat(name); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

func TestCgroupRevokeRaceRejectsSequentialOrMissingEvidence(t *testing.T) {
	base := time.Date(2026, 10, 8, 0, 0, 0, 0, time.UTC)
	good := cgroupRevokeRace{Released: base, Mutation: cgroupRaceOperation{Started: base.Add(time.Second), Completed: base.Add(3 * time.Second)}, Revocation: cgroupRaceOperation{Started: base.Add(2 * time.Second), Completed: base.Add(4 * time.Second)}}
	if err := good.validateOverlap(); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*cgroupRevokeRace){
		func(r *cgroupRevokeRace) { r.Released = time.Time{} },
		func(r *cgroupRevokeRace) { r.Mutation.Started = base.Add(-time.Second) },
		func(r *cgroupRevokeRace) { r.Revocation.Started = base.Add(-time.Second) },
		func(r *cgroupRevokeRace) { r.Mutation.Completed = r.Mutation.Started },
		func(r *cgroupRevokeRace) { r.Revocation.Completed = r.Revocation.Started },
		func(r *cgroupRevokeRace) { r.Mutation.Completed = r.Revocation.Started },
		func(r *cgroupRevokeRace) { r.Revocation.Completed = r.Mutation.Started },
	} {
		r := good
		change(&r)
		if r.validateOverlap() == nil {
			t.Fatal("non-overlapping campaign passed")
		}
	}
}

func TestCgroupRevokeRaceSelectorsRemainClosed(t *testing.T) {
	for _, selector := range []string{"cgroup-live-ancestor-replaced", "cgroup-live-ancestor-writable", "cgroup-live-ancestor-owner", "cgroup-live-parent-replaced", "cgroup-live-parent-writable", "cgroup-live-parent-owner"} {
		if !cgroupRevokeRaceFixture(selector) || !cgroupLiveFixture(selector) {
			t.Fatal(selector)
		}
	}
	for _, selector := range []string{"", "cgroup-live-child-replaced", "cgroup-live-child-writable", "cgroup-live-child-owner", "../cgroup-live-parent-replaced", "cgroup-live-parent-replaced-revoke-race", "cgroup-parent-replaced"} {
		if cgroupRevokeRaceFixture(selector) {
			t.Fatal("unbounded selector accepted")
		}
	}
}

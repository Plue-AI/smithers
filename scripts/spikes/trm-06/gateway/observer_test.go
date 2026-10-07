package main

import (
	"context"
	"io"
	"net"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestOwnerObserverBoundaryRejectsSelectorsBeforeDispatch(t *testing.T) {
	listener, err := net.Listen("unix", filepath.Join(t.TempDir(), "control.sock"))
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var calls atomic.Int32
	done := make(chan struct{})
	go func() {
		serveRevocation(ctx, listener, make(chan revocationRequest, 1), &ownerControl{observe: func(_ context.Context, mode string) ([]byte, error) {
			calls.Add(1)
			if mode != "sample" {
				t.Errorf("untrusted selector reached observer: %s", mode)
			}
			return []byte(`{"processes":[],"supervisors":[11],"cgroups":{}}`), nil
		}})
		close(done)
	}()
	for _, command := range []string{"../sample\n", "sample --uid=0\n", "sample\n"} {
		peer, err := net.Dial("unix", listener.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		peer.SetDeadline(time.Now().Add(time.Second))
		if err = writeAll(peer, []byte(command)); err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(peer)
		peer.Close()
		if err != nil {
			t.Fatal(err)
		}
		if command != "sample\n" && len(body) != 0 {
			t.Fatal("invalid observer selector produced a reply")
		}
		if command == "sample\n" && string(body) != "{\"processes\":[],\"supervisors\":[11],\"cgroups\":{}}\n" {
			t.Fatalf("sample: %q", body)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("dispatch count: %d", calls.Load())
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("observer control did not shut down")
	}
}
func TestEvidenceDoesNotInferPopulatedZeroFromRemoval(t *testing.T) {
	for _, events := range []string{"", "populated 1\n", "populated 00\n", "not populated 0\n"} {
		if containsPopulatedZero(events) {
			t.Fatalf("inferred 0 from %q", events)
		}
	}
	if !containsPopulatedZero("populated 0\nfrozen 0\n") {
		t.Fatal("did not recognize literal kernel observation")
	}
	if _, err := ownerObservation(context.Background(), t.TempDir(), "restart --pid=1"); err == nil {
		t.Fatal("accepted caller PID selector")
	}
	if _, err := runGuestFixture(context.Background(), nil, "", "", "", "../sample"); err == nil {
		t.Fatal("accepted guest path selector")
	}
	if err := systemInstallTree(t.TempDir()); err == nil {
		t.Fatal("owner-writable tree became installed system authority")
	}
}

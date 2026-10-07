package main

import (
	"context"
	"encoding/json"
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

func TestDrainSummaryRequiresItsLiteralRawKernelSample(t *testing.T) {
	for _, rows := range [][]json.RawMessage{
		nil,
		{json.RawMessage(`{"utc":"now","events":{}}`)},
		{json.RawMessage(`{"utc":"before","events":{"s-001":"populated 0\n"}}`)},
		{json.RawMessage(`{"utc":"now","events":{"s-001":{"error":"removed"}}}`)},
		{json.RawMessage(`{"utc":"now","events":{"s-001":"populated 1\n"}}`)},
	} {
		if zeroHasRawSample("s-001", "now", rows) {
			t.Fatal("summary supplied absent kernel evidence")
		}
	}
	if !zeroHasRawSample("s-001", "now", []json.RawMessage{json.RawMessage(`{"utc":"now","events":{"s-001":"populated 0\nfrozen 0\n"}}`)}) {
		t.Fatal("direct kernel evidence refused")
	}
}

func TestRestartRequiresEveryHeldCgroupBeforeAdmissionWithinTwoSeconds(t *testing.T) {
	invoked := time.Date(2026, 10, 7, 0, 0, 0, 0, time.UTC)
	groups := map[string]string{"s-0000000000000001": "populated 1\n"}
	for _, fixture := range []struct {
		name                     string
		offset                   time.Duration
		events                   string
		surviving, missing, pass bool
	}{
		{name: "direct", offset: time.Second, events: "populated 0\n", pass: true},
		{name: "boundary", offset: 2 * time.Second, events: "populated 0\n", pass: true},
		{name: "late", offset: 2*time.Second + time.Nanosecond, events: "populated 0\n"},
		{name: "stale", offset: -time.Nanosecond, events: "populated 0\n"},
		{name: "removed", offset: time.Second, missing: true},
		{name: "still-live", offset: time.Second, events: "populated 1\n"},
		{name: "surviving-process", offset: time.Second, events: "populated 0\n", surviving: true},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			stamp := invoked.Add(fixture.offset).Format(time.RFC3339Nano)
			zero := map[string]string{}
			events := map[string]string{}
			if !fixture.missing {
				zero["s-0000000000000001"] = stamp
				events["s-0000000000000001"] = fixture.events
			}
			processes := []any{}
			if fixture.surviving {
				processes = append(processes, map[string]any{"pid": 11})
			}
			raw, _ := json.Marshal(map[string]any{"sample": map[string]any{"processes": processes}, "observation": map[string]any{"zero": zero, "samples": []any{map[string]any{"utc": stamp, "events": events}}}})
			err := validateRestartDrain(raw, groups, invoked, invoked.Add(3*time.Second))
			if (err == nil) != fixture.pass {
				t.Fatalf("restart evidence: %v, want pass=%v", err, fixture.pass)
			}
			if fixture.pass && validateRestartDrain(raw, groups, invoked, invoked.Add(500*time.Millisecond)) == nil {
				t.Fatal("accepted zero after admission")
			}
		})
	}
}

func TestRestartPreviouslyEmptyGroupStillRequiresHeldRawZero(t *testing.T) {
	invoked := time.Now().UTC()
	stamp := invoked.Add(-time.Millisecond).Format(time.RFC3339Nano)
	const name = "s-0000000000000001"
	for _, events := range []string{"populated 0\n", "populated 1\n", ""} {
		raw, _ := json.Marshal(map[string]any{"sample": map[string]any{"processes": []any{}}, "observation": map[string]any{"zero": map[string]string{name: stamp}, "samples": []any{map[string]any{"utc": stamp, "events": map[string]string{name: events}}}}})
		err := validateRestartDrain(raw, map[string]string{name: "populated 0\n"}, invoked, invoked.Add(time.Second))
		if (err == nil) != (events == "populated 0\n") {
			t.Fatalf("initial empty, events=%q: %v", events, err)
		}
		if validateRestartDrain(raw, map[string]string{name: "populated 1\n"}, invoked, invoked.Add(time.Second)) == nil {
			t.Fatal("live old group accepted pre-invocation zero")
		}
	}
}

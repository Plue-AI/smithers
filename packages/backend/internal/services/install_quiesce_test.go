package services

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

type memoryFreeze struct {
	row *QuiesceFreeze
	mu  sync.Mutex
}

func (m *memoryFreeze) Update(_ context.Context, f func(*QuiesceFreeze) (*QuiesceFreeze, error)) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	row, err := f(m.row)
	if err == nil {
		m.row = row
	}
	return err
}
func TestQuiesceGateClasses(t *testing.T) {
	for _, class := range []string{"POST", "PUT", "PATCH", "DELETE", "GET"} {
		t.Run(class, func(t *testing.T) {
			s := &memoryFreeze{row: &QuiesceFreeze{Op: "backup", LeaseUntil: time.Now().Add(time.Minute)}}
			g := &QuiesceGate{Store: s, StateDir: t.TempDir()}
			err := g.Admit(t.Context(), class)
			if (err != nil) != (class != "GET") {
				t.Fatalf("class %s: %v", class, err)
			}
		})
	}
}
func TestQuiesceLeaseLapse(t *testing.T) {
	for _, marker := range []bool{false, true} {
		t.Run(map[bool]string{false: "reopen", true: "upgrade"}[marker], func(t *testing.T) {
			dir := t.TempDir()
			if marker {
				if err := os.WriteFile(filepath.Join(dir, ".upgrade-incomplete"), nil, 0600); err != nil {
					t.Fatal(err)
				}
			}
			s := &memoryFreeze{row: &QuiesceFreeze{Op: "backup", LeaseUntil: time.Now().Add(-time.Second)}}
			g := &QuiesceGate{Store: s, StateDir: dir}
			err := g.Admit(t.Context(), "POST")
			if (err != nil) != marker || (s.row != nil) != marker {
				t.Fatalf("marker %v: %v row %v", marker, err, s.row)
			}
		})
	}
}
func TestQuiesceDefaultMachineRefuses(t *testing.T) {
	err := (UnavailableMachineQuiescer{}).CaptureAndStop(t.Context())
	var dependency *QuiesceDependencyError
	if !errors.As(err, &dependency) || dependency.Ticket != "T-MCH-07" {
		t.Fatalf("%v", err)
	}
}

type quiesceSteps struct {
	calls *[]string
	fail  string
}

func (s quiesceSteps) step(name string) error {
	*s.calls = append(*s.calls, name)
	if s.fail == name {
		return errors.New(name)
	}
	return nil
}
func (s quiesceSteps) Drain(context.Context) error          { return s.step("drain") }
func (s quiesceSteps) Stop(context.Context) error           { return s.step("stop") }
func (s quiesceSteps) CaptureAndStop(context.Context) error { return s.step("capture") }
func TestQuiesceStepsAndRenewal(t *testing.T) {
	for _, fail := range []string{"", "drain", "capture", "stop"} {
		t.Run("failure="+fail, func(t *testing.T) {
			store := &memoryFreeze{}
			gate := &QuiesceGate{Store: store, StateDir: t.TempDir()}
			calls := []string{}
			steps := quiesceSteps{&calls, fail}
			service := &InstallQuiesce{Gate: gate, Admission: steps, Machines: steps, Host: steps}
			row, err := service.Freeze(t.Context(), "unique-op", 7)
			if fail != "" {
				if err == nil || store.row != nil {
					t.Fatalf("failure failed to reopen: %v %v", err, store.row)
				}
				return
			}
			if err != nil || !row.Ready {
				t.Fatalf("%v %v", row, err)
			}
			if len(calls) != 3 || calls[0] != "drain" || calls[1] != "capture" || calls[2] != "stop" {
				t.Fatal(calls)
			}
			until := row.LeaseUntil
			row, err = service.Freeze(t.Context(), "unique-op", 7)
			if err != nil || !row.LeaseUntil.After(until) || len(calls) != 3 {
				t.Fatalf("renew: %v %v", row, err)
			}
			if _, err = service.Freeze(t.Context(), "other-op", 7); err == nil {
				t.Fatal("competing freeze accepted")
			}
			if err = service.Reopen(t.Context(), "other-op"); err == nil {
				t.Fatal("other operation cleared")
			}
			if err = service.Reopen(t.Context(), "unique-op"); err != nil || store.row != nil {
				t.Fatalf("reopen: %v", err)
			}
		})
	}
}
func TestQuiesceFailureUpgradeMarker(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".upgrade-incomplete"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	store := &memoryFreeze{row: &QuiesceFreeze{Op: "upgrade", By: 7, LeaseUntil: time.Now().Add(time.Minute)}}
	service := &InstallQuiesce{Gate: &QuiesceGate{Store: store, StateDir: dir}}
	if err := service.Reopen(t.Context(), ""); err == nil || store.row == nil {
		t.Fatal("upgrade freeze cleared")
	}
}
func TestQuiesceDefaultFreezeReopens(t *testing.T) {
	store := &memoryFreeze{}
	service := &InstallQuiesce{Gate: &QuiesceGate{Store: store, StateDir: t.TempDir()}}
	_, err := service.Freeze(t.Context(), "backup", 7)
	var dependency *QuiesceDependencyError
	if !errors.As(err, &dependency) || dependency.Ticket != "T-MCH-07" || store.row != nil {
		t.Fatalf("%v %v", err, store.row)
	}
}

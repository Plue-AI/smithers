package services

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"
)

type memoryFreeze struct {
	row     *QuiesceFreeze
	mu      sync.Mutex
	updates int
}

func (m *memoryFreeze) Update(_ context.Context, f func(*QuiesceFreeze) (*QuiesceFreeze, error)) error {
	m.mu.Lock()
	m.updates++
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
			calls := []string{}
			service := NewInstallQuiesce(g)
			service.Host = quiesceSteps{calls: &calls}
			service.Admission = quiesceSteps{calls: &calls}
			service.Barriers = barrierFixtures(&calls, "")
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
func (s quiesceSteps) Resume(context.Context) error         { return s.step("resume") }

type quiesceBarrierFixture struct {
	calls  *[]string
	fail   string
	ticket string
}

func (s quiesceBarrierFixture) Check(context.Context) error {
	if s.fail == "check-"+s.ticket {
		return errors.New(s.fail)
	}
	return nil
}
func (s quiesceBarrierFixture) Drain(context.Context) error {
	*s.calls = append(*s.calls, s.ticket)
	if s.fail == s.ticket {
		return errors.New(s.fail)
	}
	return nil
}
func (s quiesceBarrierFixture) Resume(context.Context) error {
	*s.calls = append(*s.calls, "resume-"+s.ticket)
	return nil
}
func barrierFixtures(calls *[]string, fail string) map[string]QuiesceBarrier {
	return map[string]QuiesceBarrier{
		"T-STK-04": quiesceBarrierFixture{calls, fail, "T-STK-04"},
		"T-COL-08": quiesceBarrierFixture{calls, fail, "T-COL-08"},
		"T-COL-09": quiesceBarrierFixture{calls, fail, "T-COL-09"},
		"T-GH-09":  quiesceBarrierFixture{calls, fail, "T-GH-09"},
		"T-TRM-07": quiesceBarrierFixture{calls, fail, "T-TRM-07"},
		"T-SEC-01": quiesceBarrierFixture{calls, fail, "T-SEC-01"},
	}
}
func TestQuiesceStepsAndRenewal(t *testing.T) {
	for _, fail := range []string{"", "drain", "capture", "stop", "T-STK-04", "T-COL-08", "T-COL-09", "T-GH-09", "T-TRM-07", "T-SEC-01"} {
		t.Run("failure="+fail, func(t *testing.T) {
			store := &memoryFreeze{}
			gate := &QuiesceGate{Store: store, StateDir: t.TempDir()}
			calls := []string{}
			steps := quiesceSteps{&calls, fail}
			service := &InstallQuiesce{Gate: gate, Admission: steps, Machines: steps, Host: steps, Barriers: barrierFixtures(&calls, fail)}
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
			if len(calls) != 9 || calls[0] != "drain" || calls[1] != "T-STK-04" || calls[2] != "T-COL-08" || calls[3] != "T-COL-09" || calls[4] != "T-GH-09" || calls[5] != "T-TRM-07" || calls[6] != "T-SEC-01" || calls[7] != "capture" || calls[8] != "stop" {
				t.Fatal(calls)
			}
			until := row.LeaseUntil
			row, err = service.Freeze(t.Context(), "unique-op", 7)
			if err != nil || !row.LeaseUntil.After(until) || len(calls) != 9 {
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

func TestHostMaintenanceUnavailableProvidersFailClosed(t *testing.T) {
	for _, missing := range []string{"machines", "machine-pointer", "admission", "host", "T-STK-04", "T-COL-08", "T-COL-09", "T-GH-09", "T-TRM-07", "T-SEC-01"} {
		t.Run(missing, func(t *testing.T) {
			store := &memoryFreeze{}
			calls := []string{}
			steps := quiesceSteps{calls: &calls}
			service := &InstallQuiesce{Gate: &QuiesceGate{Store: store, StateDir: t.TempDir()}, Machines: steps, Admission: steps, Host: steps, Barriers: barrierFixtures(&calls, "")}
			want := "T-MCH-07"
			switch missing {
			case "machines":
				service.Machines = nil
			case "machine-pointer":
				service.Machines = &UnavailableMachineQuiescer{}
			case "admission":
				service.Admission = nil
				want = "T-MCH-06"
			case "host":
				service.Host = nil
				want = "T-FLW-01"
			default:
				delete(service.Barriers, missing)
				want = missing
			}
			_, err := service.Freeze(t.Context(), "backup", 7)
			var dependency *QuiesceDependencyError
			if !errors.As(err, &dependency) || dependency.Ticket != want || store.updates != 0 || len(calls) != 0 {
				t.Fatalf("want %s before any freeze or execution: err=%v writes=%d calls=%v", want, err, store.updates, calls)
			}
		})
	}
}

func TestQuiesceMarkerNeverFollowsLinks(t *testing.T) {
	root := t.TempDir()
	if err := os.Symlink(filepath.Join(root, "missing"), filepath.Join(root, ".upgrade-incomplete")); err != nil {
		t.Fatal(err)
	}
	store := &memoryFreeze{row: &QuiesceFreeze{Op: "upgrade", LeaseUntil: time.Now().Add(-time.Minute)}}
	service := &InstallQuiesce{Gate: &QuiesceGate{Store: store, StateDir: root}}
	var frozen *InstallQuiescedError
	if err := service.Gate.Admit(t.Context(), "POST"); !errors.As(err, &frozen) {
		t.Fatalf("marker failed to retain freeze: %v", err)
	}
	if err := service.Reopen(t.Context(), ""); !errors.As(err, &frozen) || store.row == nil {
		t.Fatalf("reopen ignored marker: %v", err)
	}
}

func TestQuiesceMissingAuthorityAndCancellationNeverFreeze(t *testing.T) {
	for _, service := range []*InstallQuiesce{nil, {}, {Gate: &QuiesceGate{}}} {
		_, err := service.Freeze(t.Context(), "backup", 7)
		if err == nil || err.Error() != "quiesce authority unavailable" {
			t.Fatalf("freeze: %v", err)
		}
		if err := service.Reopen(t.Context(), ""); err == nil || err.Error() != "quiesce authority unavailable" {
			t.Fatalf("reopen: %v", err)
		}
	}
	store := &memoryFreeze{}
	calls := []string{}
	steps := quiesceSteps{calls: &calls}
	service := &InstallQuiesce{Gate: &QuiesceGate{Store: store, StateDir: t.TempDir()}, Machines: steps, Admission: steps, Host: steps, Barriers: barrierFixtures(&calls, "")}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := service.Freeze(ctx, "backup", 7); !errors.Is(err, context.Canceled) || store.updates != 0 || len(calls) != 0 {
		t.Fatalf("cancelled freeze: %v writes=%d calls=%v", err, store.updates, calls)
	}
}

func TestQuiesceBarrierChecksDoNotFreeze(t *testing.T) {
	for _, ticket := range []string{"T-STK-04", "T-COL-08", "T-COL-09", "T-GH-09", "T-TRM-07", "T-SEC-01"} {
		t.Run(ticket, func(t *testing.T) {
			store := &memoryFreeze{}
			calls := []string{}
			steps := quiesceSteps{calls: &calls}
			service := &InstallQuiesce{Gate: &QuiesceGate{Store: store, StateDir: t.TempDir()}, Machines: steps, Admission: steps, Host: steps, Barriers: barrierFixtures(&calls, "check-"+ticket)}
			_, err := service.Freeze(t.Context(), "backup", 7)
			if err == nil || store.updates != 0 || len(calls) != 0 {
				t.Fatalf("preflight mutated: err=%v writes=%d calls=%v", err, store.updates, calls)
			}
		})
	}
}

func TestQuiesceResumeFailurePreservesFreeze(t *testing.T) {
	store := &memoryFreeze{}
	calls := []string{}
	steps := quiesceSteps{calls: &calls}
	service := &InstallQuiesce{Gate: &QuiesceGate{Store: store, StateDir: t.TempDir()}, Machines: steps, Admission: steps, Host: steps, Barriers: barrierFixtures(&calls, "")}
	if _, err := service.Freeze(t.Context(), "backup", 7); err != nil {
		t.Fatal(err)
	}
	service.Host = quiesceSteps{calls: &calls, fail: "resume"}
	if err := service.Reopen(t.Context(), "backup"); err == nil || store.row == nil {
		t.Fatalf("resume failure lost freeze: %v", err)
	}
	store.row.LeaseUntil = time.Now().Add(-time.Second)
	if err := service.Gate.Admit(t.Context(), "POST"); err == nil || store.row == nil {
		t.Fatalf("expiry lost freeze: %v", err)
	}
	service.Host = steps
	if err := service.Gate.Admit(t.Context(), "POST"); err != nil || store.row != nil {
		t.Fatalf("resume retry: %v", err)
	}
}

func TestQuiesceCompositionRecoversPersistedLease(t *testing.T) {
	store := &memoryFreeze{row: &QuiesceFreeze{Op: "old-operation", Ready: true, LeaseUntil: time.Now().Add(-time.Second)}}
	gate := &QuiesceGate{Store: store, StateDir: t.TempDir()}
	service := NewInstallQuiesce(gate)
	calls := []string{}
	steps := quiesceSteps{calls: &calls}
	service.Host = steps
	service.Admission = steps
	service.Barriers = barrierFixtures(&calls, "")
	if err := gate.Admit(t.Context(), "POST"); err != nil || store.row != nil {
		t.Fatalf("restart recovery: %v row=%v", err, store.row)
	}
	want := []string{"resume", "resume-T-SEC-01", "resume-T-TRM-07", "resume-T-GH-09", "resume-T-COL-09", "resume-T-COL-08", "resume-T-STK-04", "resume"}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("resume order: %v", calls)
	}
}

func TestQuiesceRecoveryMissingProvidersPreservesFreeze(t *testing.T) {
	for _, missing := range []string{"unbound", "host", "admission", "T-STK-04", "T-COL-08", "T-COL-09", "T-GH-09", "T-TRM-07", "T-SEC-01"} {
		t.Run(missing, func(t *testing.T) {
			store := &memoryFreeze{row: &QuiesceFreeze{Op: "persisted", Ready: true, LeaseUntil: time.Now().Add(-time.Second)}}
			gate := &QuiesceGate{Store: store, StateDir: t.TempDir()}
			calls := []string{}
			service := NewInstallQuiesce(gate)
			service.Host = quiesceSteps{calls: &calls}
			service.Admission = quiesceSteps{calls: &calls}
			service.Barriers = barrierFixtures(&calls, "")
			switch missing {
			case "unbound":
				gate = &QuiesceGate{Store: store, StateDir: gate.StateDir}
			case "host":
				service.Host = nil
			case "admission":
				service.Admission = nil
			default:
				delete(service.Barriers, missing)
			}
			if err := gate.Admit(t.Context(), "POST"); err == nil || store.row == nil {
				t.Fatalf("expiry lost freeze: %v", err)
			}
			if missing != "unbound" {
				if err := service.Reopen(t.Context(), "persisted"); err == nil || store.row == nil {
					t.Fatalf("reopen lost freeze: %v", err)
				}
			}
			if len(calls) != 0 {
				t.Fatalf("partial resume: %v", calls)
			}
		})
	}
}

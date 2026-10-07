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
			if err := service.Check(t.Context()); err == nil || store.updates != 0 || len(calls) != 0 {
				t.Fatalf("preflight mutated: err=%v writes=%d calls=%v", err, store.updates, calls)
			}
			_, err := service.Freeze(t.Context(), "backup", 7)
			if err == nil || store.updates != 0 || len(calls) != 0 {
				t.Fatalf("preflight mutated: err=%v writes=%d calls=%v", err, store.updates, calls)
			}
		})
	}
}

type quiesceCheckFixture struct {
	quiesceBarrierFixture
	check func(context.Context) error
}

func (s quiesceCheckFixture) Check(ctx context.Context) error { return s.check(ctx) }

func TestQuiesceCheckCancellationPreservesRefusals(t *testing.T) {
	for _, tc := range []struct {
		ticket string
		checks int
	}{{"T-STK-04", 1}, {"T-SEC-01", 6}} {
		t.Run(tc.ticket, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			store := &memoryFreeze{}
			calls := []string{}
			steps := quiesceSteps{calls: &calls}
			service := NewInstallQuiesce(&QuiesceGate{Store: store, StateDir: t.TempDir()})
			service.Machines, service.Admission, service.Host = steps, steps, steps
			service.Barriers = map[string]QuiesceBarrier{}
			checks := 0
			refusal := errors.New("merge in flight")
			for _, ticket := range []string{"T-STK-04", "T-COL-08", "T-COL-09", "T-GH-09", "T-TRM-07", "T-SEC-01"} {
				service.Barriers[ticket] = quiesceCheckFixture{
					quiesceBarrierFixture: quiesceBarrierFixture{calls: &calls, ticket: ticket},
					check: func(context.Context) error {
						checks++
						if ticket == tc.ticket {
							cancel()
						}
						return refusal
					},
				}
			}
			err := service.Check(ctx)
			if !errors.Is(err, context.Canceled) || !errors.Is(err, refusal) || checks != tc.checks || store.updates != 0 || len(calls) != 0 {
				t.Fatalf("cancelled preflight: err=%v checks=%d writes=%d calls=%v", err, checks, store.updates, calls)
			}
			if _, err := service.Freeze(ctx, "backup", 7); !errors.Is(err, context.Canceled) || checks != tc.checks || store.updates != 0 {
				t.Fatalf("cancelled freeze: err=%v checks=%d writes=%d", err, checks, store.updates)
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

func TestQuiesceRenewCannotAcquire(t *testing.T) {
	for _, name := range []string{"missing", "expired", "draining", "ready", "marker", "wrong owner", "wrong op"} {
		t.Run(name, func(t *testing.T) {
			state := t.TempDir()
			calls := []string{}
			steps := quiesceSteps{calls: &calls}
			store := &memoryFreeze{}
			gate := &QuiesceGate{Store: store, StateDir: state}
			service := &InstallQuiesce{Gate: gate, Machines: steps, Admission: steps, Host: steps, Barriers: barrierFixtures(&calls, "")}
			since := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
			if name != "missing" {
				store.row = &QuiesceFreeze{Op: "backup", By: 7, Since: since, Ready: name != "draining", LeaseUntil: time.Now().Add(time.Minute)}
			}
			if name == "expired" || name == "marker" {
				store.row.LeaseUntil = time.Now().Add(-time.Second)
			}
			if name == "marker" {
				if err := os.WriteFile(filepath.Join(state, ".upgrade-incomplete"), []byte("backup"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			by, op := int64(7), "backup"
			if name == "wrong owner" {
				by = 8
			}
			if name == "wrong op" {
				op = "another"
			}
			row, err := service.Renew(t.Context(), op, by)
			if name == "missing" || name == "expired" {
				if err == nil || err.Error() != "quiesce lease lost" || row != nil || store.row != nil {
					t.Fatalf("reacquired: %v %v %v", row, store.row, err)
				}
			} else if name == "wrong owner" || name == "wrong op" {
				var frozen *InstallQuiescedError
				if !errors.As(err, &frozen) || store.row.By != 7 || store.row.Op != "backup" {
					t.Fatalf("wrong authority: %v %v", store.row, err)
				}
			} else if err != nil || row == nil || !row.Since.Equal(since) || row.Ready != (name != "draining") || !time.Now().Before(row.LeaseUntil) {
				t.Fatalf("renew: %v %v", row, err)
			}
			for _, call := range calls {
				if call == "capture" || call == "drain" || call == "stop" {
					t.Fatalf("renew ran %s: %v", call, calls)
				}
			}
		})
	}
}

func TestQuiesceTypedNilProvidersFailBeforeFreeze(t *testing.T) {
	for _, missing := range []string{"machines", "admission", "host", "T-STK-04", "T-COL-08", "T-COL-09", "T-GH-09", "T-TRM-07", "T-SEC-01"} {
		t.Run(missing, func(t *testing.T) {
			store := &memoryFreeze{}
			calls := []string{}
			steps := quiesceSteps{calls: &calls}
			service := &InstallQuiesce{Gate: &QuiesceGate{Store: store, StateDir: t.TempDir()}, Machines: steps, Admission: steps, Host: steps, Barriers: barrierFixtures(&calls, "")}
			var absent *quiesceSteps
			want := missing
			switch missing {
			case "machines":
				service.Machines = absent
				want = "T-MCH-07"
			case "admission":
				service.Admission = absent
				want = "T-MCH-06"
			case "host":
				service.Host = absent
				want = "T-FLW-01"
			default:
				var barrier *quiesceBarrierFixture
				service.Barriers[missing] = barrier
			}
			_, err := service.Freeze(t.Context(), "backup", 7)
			if err == nil || err.Error() != "quiesce unavailable: "+want+" required" || store.updates != 0 || len(calls) != 0 {
				t.Fatalf("provider %s: %v, writes %d, calls %v", missing, err, store.updates, calls)
			}
		})
	}
}

func TestQuiesceTypedNilRecoveryRetainsFreeze(t *testing.T) {
	store := &memoryFreeze{row: &QuiesceFreeze{Op: "backup", By: 7, LeaseUntil: time.Now().Add(-time.Second)}}
	calls := []string{}
	gate := &QuiesceGate{Store: store, StateDir: t.TempDir()}
	service := NewInstallQuiesce(gate)
	var absent *quiesceSteps
	service.Host = absent
	service.Admission = quiesceSteps{calls: &calls}
	service.Barriers = barrierFixtures(&calls, "")
	err := gate.Admit(t.Context(), "POST")
	if err == nil || err.Error() != "quiesce unavailable: T-FLW-01 required" || store.row == nil || len(calls) != 0 {
		t.Fatalf("lost recovery authority: %v, row %v, calls %v", err, store.row, calls)
	}
}

// A provider returning success does not prove the original freeze still owns
// the next phase. Reopening, expiry and replacement must stop stale work.
type leaseChangingQuiesceStep struct {
	quiesceSteps
	change func()
}

func (s leaseChangingQuiesceStep) Drain(ctx context.Context) error {
	if err := s.quiesceSteps.Drain(ctx); err != nil {
		return err
	}
	s.change()
	return nil
}
func (s leaseChangingQuiesceStep) CaptureAndStop(ctx context.Context) error {
	if err := s.quiesceSteps.CaptureAndStop(ctx); err != nil {
		return err
	}
	s.change()
	return nil
}

type leaseChangingBarrier struct {
	quiesceBarrierFixture
	change func()
}

func (s leaseChangingBarrier) Drain(ctx context.Context) error {
	if err := s.quiesceBarrierFixture.Drain(ctx); err != nil {
		return err
	}
	s.change()
	return nil
}

func TestQuiesceLeaseLossFencesRemainingPhases(t *testing.T) {
	for _, phase := range []string{"admission", "T-STK-04", "T-COL-08", "T-COL-09", "T-GH-09", "T-TRM-07", "T-SEC-01", "capture"} {
		for _, loss := range []string{"reopened", "expired", "replaced", "canceled"} {
			t.Run(phase+"/"+loss, func(t *testing.T) {
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				store := &memoryFreeze{}
				calls := []string{}
				steps := quiesceSteps{calls: &calls}
				service := NewInstallQuiesce(&QuiesceGate{Store: store, StateDir: t.TempDir()})
				service.Machines, service.Admission, service.Host = steps, steps, steps
				service.Barriers = barrierFixtures(&calls, "")
				change := func() {
					if loss == "canceled" {
						cancel()
						return
					}
					if err := store.Update(ctx, func(row *QuiesceFreeze) (*QuiesceFreeze, error) {
						switch loss {
						case "reopened":
							return nil, nil
						case "expired":
							row.LeaseUntil = time.Date(2026, 1, 1, 0, 0, 30, 0, time.UTC)
						case "replaced":
							row.Since = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
						}
						return row, nil
					}); err != nil {
						t.Fatal(err)
					}
				}
				switch phase {
				case "admission":
					service.Admission = leaseChangingQuiesceStep{steps, change}
				case "capture":
					service.Machines = leaseChangingQuiesceStep{steps, change}
				default:
					service.Barriers[phase] = leaseChangingBarrier{quiesceBarrierFixture{calls: &calls, ticket: phase}, change}
				}
				row, err := service.Freeze(ctx, "original", 7)
				if err == nil || row != nil {
					t.Fatalf("stale drain succeeded: %v %v", row, err)
				}
				if loss == "canceled" {
					if !errors.Is(err, context.Canceled) {
						t.Fatal(err)
					}
				} else if err.Error() != "quiesce lease lost" {
					t.Fatal(err)
				}
				for _, call := range calls {
					if call == "stop" || (call == "capture" && phase != "capture") {
						t.Fatalf("stale %s: %v", phase, calls)
					}
				}
				if phase != "admission" && phase != "capture" {
					found := false
					for _, call := range calls {
						if call == phase {
							found = true
							continue
						}
						if found && len(call) > 1 && call[:2] == "T-" {
							t.Fatalf("stale barrier: %v", calls)
						}
					}
				}
			})
		}
	}
}

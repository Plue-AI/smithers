package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const QuiesceLease = 30 * time.Second
const QuiesceRenewInterval = 10 * time.Second

type QuiesceFreeze struct {
	Op         string    `json:"op"`
	By         int64     `json:"by"`
	Since      time.Time `json:"since"`
	LeaseUntil time.Time `json:"lease_until"`
	Ready      bool      `json:"ready"`
}

// Update serializes freeze transitions, including lease expiry and renewal.
type QuiesceStore interface {
	Update(context.Context, func(*QuiesceFreeze) (*QuiesceFreeze, error)) error
}
type InstallQuiesceStore struct{ Pool *pgxpool.Pool }

func (s InstallQuiesceStore) Update(ctx context.Context, f func(*QuiesceFreeze) (*QuiesceFreeze, error)) error {
	if s.Pool == nil {
		return errors.New("quiesce storage unavailable")
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// The singleton key may not exist yet; a transaction lock also fences creation.
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('install.quiesce',0))`); err != nil {
		return err
	}
	var raw []byte
	var row *QuiesceFreeze
	err = tx.QueryRow(ctx, `SELECT value FROM install_settings WHERE key='quiesce'`).Scan(&raw)
	if err == nil {
		row = &QuiesceFreeze{}
		if err = json.Unmarshal(raw, row); err != nil {
			return err
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	row, err = f(row)
	if err != nil {
		return err
	}
	if row == nil {
		_, err = tx.Exec(ctx, `DELETE FROM install_settings WHERE key='quiesce'`)
	} else {
		raw, err = json.Marshal(row)
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO install_settings(key,value) VALUES('quiesce',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()`, raw)
	}
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

type QuiesceDependencyError struct{ Ticket string }

func (e *QuiesceDependencyError) Error() string {
	return fmt.Sprintf("quiesce unavailable: %s required", e.Ticket)
}

// MachineQuiescer ends sessions, stops coding hosts, captures each awake branch
// and stops its VM, retaining its disk. Capture errors must name the branch.
type MachineQuiescer interface{ CaptureAndStop(context.Context) error }
type UnavailableMachineQuiescer struct{}

func (UnavailableMachineQuiescer) CaptureAndStop(context.Context) error {
	return &QuiesceDependencyError{"T-MCH-07"}
}

// Drain stops admission and waits for durable boundaries. Stop interrupts work
// remaining after the 60-second deadline; it must honor cancellation.
type QuiesceAdmission interface {
	Drain(context.Context) error
	Stop(context.Context) error
	Resume(context.Context) error
}
type QuiesceHostRuntime interface {
	Stop(context.Context) error
	Resume(context.Context) error
}
type InstallQuiescedError struct{ RetryAt time.Time }

func (e *InstallQuiescedError) Error() string { return "install quiesced" }

type QuiesceGate struct {
	Store    QuiesceStore
	StateDir string
	// resume restarts stopped providers before clearing the durable freeze.
	resume atomic.Value // func(context.Context) error
}

func (g *QuiesceGate) marker() (bool, error) {
	if g.StateDir == "" {
		return false, errors.New("quiesce STATE directory unavailable")
	}
	_, err := os.Lstat(filepath.Join(g.StateDir, ".upgrade-incomplete"))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}
func (g *QuiesceGate) expire(ctx context.Context, row *QuiesceFreeze) (*QuiesceFreeze, error) {
	marker, err := g.marker()
	if err != nil {
		return nil, err
	}
	if row != nil && !time.Now().Before(row.LeaseUntil) && !marker {
		slog.Warn("quiesce lease lapsed", "op", row.Op)
		resume, ok := g.resume.Load().(func(context.Context) error)
		if !ok {
			return row, errors.New("quiesce recovery providers unavailable")
		}
		if err := resume(ctx); err != nil {
			return row, err
		}
		return nil, nil
	}
	if marker && row == nil {
		return &QuiesceFreeze{Op: "upgrade"}, nil
	}
	return row, nil
}

// Admit is the shared admission boundary. Reads remain available even when the
// durable authority is unavailable; every other class fails closed.
func (g *QuiesceGate) Admit(ctx context.Context, class string) error {
	if class == "GET" || class == "HEAD" || class == "OPTIONS" {
		return nil
	}
	if g == nil || g.Store == nil {
		return errors.New("quiesce authority unavailable")
	}
	var frozen *QuiesceFreeze
	err := g.Store.Update(ctx, func(row *QuiesceFreeze) (*QuiesceFreeze, error) {
		var err error
		frozen, err = g.expire(ctx, row)
		return frozen, err
	})
	if err != nil {
		return err
	}
	if frozen != nil {
		return &InstallQuiescedError{frozen.LeaseUntil}
	}
	return nil
}

type InstallQuiesce struct {
	Gate      *QuiesceGate
	Machines  MachineQuiescer
	Admission QuiesceAdmission
	Host      QuiesceHostRuntime
	// Persistence barriers cover documents, wiki, periodic work and outbound
	// writes. Each must preflight without side effects, then drain durably.
	Barriers map[string]QuiesceBarrier
}

// Methods are idempotent. Resume runs while the durable freeze still fences
// writes and must not recursively acquire the quiesce store transaction.
type QuiesceBarrier interface {
	Check(context.Context) error
	Drain(context.Context) error
	Resume(context.Context) error
}

var quiesceBarrierTickets = []string{"T-STK-04", "T-COL-08", "T-COL-09", "T-GH-09", "T-TRM-07", "T-SEC-01"}

// NewInstallQuiesce binds lease recovery at composition, including freezes
// persisted before this process started. Provider fields are set before serving.
func NewInstallQuiesce(gate *QuiesceGate) *InstallQuiesce {
	s := &InstallQuiesce{Gate: gate}
	if gate != nil {
		gate.resume.Store(s.resume)
	}
	return s
}

func (s *InstallQuiesce) resume(ctx context.Context) error {
	// Persisted leases can outlive the process which stopped these providers.
	// Clearing one without every resume authority would report a live install
	// while some of its workers remain stopped.
	if missingQuiesceProvider(s.Host) {
		return &QuiesceDependencyError{"T-FLW-01"}
	}
	if missingQuiesceProvider(s.Admission) {
		return &QuiesceDependencyError{"T-MCH-06"}
	}
	for _, ticket := range quiesceBarrierTickets {
		if missingQuiesceProvider(s.Barriers[ticket]) {
			return &QuiesceDependencyError{ticket}
		}
	}
	// Runtime first; admission resumes last, while the gate still fences writes.
	if err := s.Host.Resume(ctx); err != nil {
		return err
	}
	for i := len(quiesceBarrierTickets) - 1; i >= 0; i-- {
		if err := s.Barriers[quiesceBarrierTickets[i]].Resume(ctx); err != nil {
			return err
		}
	}
	return s.Admission.Resume(ctx)
}

func (s *InstallQuiesce) Reopen(ctx context.Context, op string) error {
	if s == nil || s.Gate == nil || missingQuiesceProvider(s.Gate.Store) {
		return errors.New("quiesce authority unavailable")
	}
	return s.Gate.Store.Update(ctx, func(row *QuiesceFreeze) (*QuiesceFreeze, error) {
		marker, err := s.Gate.marker()
		if err != nil {
			return row, err
		}
		if marker {
			return row, &InstallQuiescedError{}
		}
		if row != nil && op != "" && row.Op != op {
			return row, &InstallQuiescedError{row.LeaseUntil}
		}
		if row != nil {
			if err := s.resume(ctx); err != nil {
				return row, err
			}
		}
		return nil, nil
	})
}

// Available checks every provider without acquiring a freeze.
func (s *InstallQuiesce) Available() error {
	// Check composition before writing the durable freeze. An unavailable
	// provider is not an empty queue, and must not briefly close admissions.
	if s == nil || s.Gate == nil || missingQuiesceProvider(s.Gate.Store) {
		return errors.New("quiesce authority unavailable")
	}
	machines := s.Machines
	if missingQuiesceProvider(machines) {
		return &QuiesceDependencyError{"T-MCH-07"}
	}
	switch machines.(type) {
	case nil, UnavailableMachineQuiescer, *UnavailableMachineQuiescer:
		return &QuiesceDependencyError{"T-MCH-07"}
	}
	if missingQuiesceProvider(s.Admission) {
		return &QuiesceDependencyError{"T-MCH-06"}
	}
	if missingQuiesceProvider(s.Host) {
		return &QuiesceDependencyError{"T-FLW-01"}
	}
	for _, ticket := range quiesceBarrierTickets {
		if missingQuiesceProvider(s.Barriers[ticket]) {
			return &QuiesceDependencyError{ticket}
		}
	}
	return nil
}

// Check runs all read-only barriers before any freeze, reporting each refusal.
// The native owner preflight and Freeze share this boundary.
func (s *InstallQuiesce) Check(ctx context.Context) error {
	if err := s.Available(); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	var refusals []error
	for _, ticket := range quiesceBarrierTickets {
		if err := ctx.Err(); err != nil {
			return errors.Join(append(refusals, err)...)
		}
		if err := s.Barriers[ticket].Check(ctx); err != nil {
			refusals = append(refusals, fmt.Errorf("%s: %w", ticket, err))
		}
	}
	return errors.Join(append(refusals, ctx.Err())...)
}

// Freeze renews an existing ready operation. Callers POST the same op every 10s,
// including while the initial drain request is outstanding.
func (s *InstallQuiesce) Freeze(ctx context.Context, op string, by int64) (*QuiesceFreeze, error) {
	return s.freeze(ctx, op, by, false)
}

// Renew cannot turn an expired operation into a new capture/drain. The native
// owner bridge uses it while the initial Freeze request is still outstanding.
func (s *InstallQuiesce) Renew(ctx context.Context, op string, by int64) (*QuiesceFreeze, error) {
	return s.freeze(ctx, op, by, true)
}

func (s *InstallQuiesce) freeze(ctx context.Context, op string, by int64, renewalOnly bool) (freeze *QuiesceFreeze, err error) {
	if op == "" {
		return nil, errors.New("quiesce op required")
	}
	if err := s.Check(ctx); err != nil {
		return nil, err
	}
	machines := s.Machines
	s.Gate.resume.Store(s.resume)
	fresh, lostRenewal := false, false
	err = s.Gate.Store.Update(ctx, func(row *QuiesceFreeze) (*QuiesceFreeze, error) {
		row, e := s.Gate.expire(ctx, row)
		if e != nil {
			return nil, e
		}
		if row != nil {
			if row.Op != op || row.By != by {
				return row, &InstallQuiescedError{row.LeaseUntil}
			}
		} else {
			if renewalOnly {
				lostRenewal = true
				return nil, nil // Commit expiry/reopen before reporting the lost lease.
			}
			row = &QuiesceFreeze{Op: op, By: by, Since: time.Now()}
			fresh = true
		}
		copy := *row
		copy.LeaseUntil = time.Now().Add(QuiesceLease)
		freeze = &copy
		return freeze, nil
	})
	if err == nil && lostRenewal {
		return nil, errors.New("quiesce lease lost")
	}
	if err == nil {
		// Each renewal schedules its own expiry check. Durable admission reads
		// also recover expiry after a host restart.
		time.AfterFunc(QuiesceLease, func() {
			expiry, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if e := s.Gate.Store.Update(expiry, func(row *QuiesceFreeze) (*QuiesceFreeze, error) { return s.Gate.expire(expiry, row) }); e != nil {
				slog.Error("quiesce expiry failed", "error", e)
			}
		})
	}
	if err != nil || !fresh {
		return freeze, err
	}
	since := freeze.Since
	defer func() {
		if err != nil {
			cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			defer cancel()
			err = errors.Join(err, s.Gate.Store.Update(cleanup, func(row *QuiesceFreeze) (*QuiesceFreeze, error) {
				marker, e := s.Gate.marker()
				if e != nil {
					return row, e
				}
				if !marker && row != nil && row.Op == op && row.Since.Equal(since) {
					if e := s.resume(cleanup); e != nil {
						return row, e
					}
					return nil, nil
				}
				return row, nil
			}))
		}
	}()
	// A pending drain may return after the owner reopened or its lease expired.
	// Fence every subsequent phase against the original operation, not only
	// publication of Ready: stale work must never stop a reopened install.
	checkLease := func() error {
		if err := ctx.Err(); err != nil {
			return err
		}
		return s.Gate.Store.Update(ctx, func(row *QuiesceFreeze) (*QuiesceFreeze, error) {
			if row == nil || row.Op != op || row.By != by || !row.Since.Equal(since) || !time.Now().Before(row.LeaseUntil) {
				return row, errors.New("quiesce lease lost")
			}
			return row, nil
		})
	}
	drain, cancel := context.WithTimeout(ctx, 60*time.Second)
	err = s.Admission.Drain(drain)
	defer cancel()
	if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
		if err = checkLease(); err == nil {
			err = s.Admission.Stop(ctx)
		}
	}
	if err != nil {
		return nil, err
	}
	for _, ticket := range quiesceBarrierTickets {
		if err = checkLease(); err != nil {
			return nil, err
		}
		if err = s.Barriers[ticket].Drain(drain); err != nil {
			return nil, fmt.Errorf("%s: %w", ticket, err)
		}
	}
	if err = checkLease(); err != nil {
		return nil, err
	}
	if err = machines.CaptureAndStop(ctx); err != nil {
		return nil, err
	}
	if err = checkLease(); err != nil {
		return nil, err
	}
	if err = s.Host.Stop(ctx); err != nil {
		return nil, err
	}
	err = s.Gate.Store.Update(ctx, func(row *QuiesceFreeze) (*QuiesceFreeze, error) {
		row, e := s.Gate.expire(ctx, row)
		if e != nil {
			return nil, e
		}
		if row == nil || row.Op != op || row.By != by || !row.Since.Equal(since) {
			return row, errors.New("quiesce lease lost")
		}
		copy := *row
		copy.Ready = true
		freeze = &copy
		return freeze, nil
	})
	return freeze, err
}

// RequireReady fences authority exports against an existing owner operation.
// It cannot create or renew a freeze; callers maintain their lease separately.
func (s *InstallQuiesce) RequireReady(ctx context.Context, op string, by int64) error {
	if op == "" || len(op) > 256 {
		return errors.New("quiesce op required")
	}
	if err := s.Available(); err != nil {
		return err
	}
	return s.Gate.Store.Update(ctx, func(row *QuiesceFreeze) (*QuiesceFreeze, error) {
		if row == nil || !row.Ready || row.Op != op || row.By != by || !time.Now().Before(row.LeaseUntil) {
			return row, errors.New("ready owner quiesce lease required")
		}
		return row, nil
	})
}

// Interface values may contain an absent pointer or function. They must not
// cross the freeze or recovery boundary as an apparently composed provider.
func missingQuiesceProvider(provider any) bool {
	if provider == nil {
		return true
	}
	value := reflect.ValueOf(provider)
	switch value.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Ptr, reflect.Slice:
		return value.IsNil()
	default:
		return false
	}
}

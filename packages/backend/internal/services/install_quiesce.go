package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
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
		if resume, ok := g.resume.Load().(func(context.Context) error); ok {
			if err := resume(ctx); err != nil {
				return row, err
			}
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
	// Runtime first; admission resumes last, while the gate still fences writes.
	if s.Host != nil {
		if err := s.Host.Resume(ctx); err != nil {
			return err
		}
	}
	for i := len(quiesceBarrierTickets) - 1; i >= 0; i-- {
		if p := s.Barriers[quiesceBarrierTickets[i]]; p != nil {
			if err := p.Resume(ctx); err != nil {
				return err
			}
		}
	}
	if s.Admission != nil {
		return s.Admission.Resume(ctx)
	}
	return nil
}

func (s *InstallQuiesce) Reopen(ctx context.Context, op string) error {
	if s == nil || s.Gate == nil || s.Gate.Store == nil {
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
	if s == nil || s.Gate == nil || s.Gate.Store == nil {
		return errors.New("quiesce authority unavailable")
	}
	machines := s.Machines
	switch machines.(type) {
	case nil, UnavailableMachineQuiescer, *UnavailableMachineQuiescer:
		return &QuiesceDependencyError{"T-MCH-07"}
	}
	if s.Admission == nil {
		return &QuiesceDependencyError{"T-MCH-06"}
	}
	if s.Host == nil {
		return &QuiesceDependencyError{"T-FLW-01"}
	}
	for _, ticket := range quiesceBarrierTickets {
		if s.Barriers[ticket] == nil {
			return &QuiesceDependencyError{ticket}
		}
	}
	return nil
}

// Freeze renews an existing ready operation. Callers POST the same op every 10s,
// including while the initial drain request is outstanding.
func (s *InstallQuiesce) Freeze(ctx context.Context, op string, by int64) (freeze *QuiesceFreeze, err error) {
	if op == "" {
		return nil, errors.New("quiesce op required")
	}
	if err := s.Available(); err != nil {
		return nil, err
	}
	machines := s.Machines
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	for _, ticket := range quiesceBarrierTickets {
		if err := s.Barriers[ticket].Check(ctx); err != nil {
			return nil, fmt.Errorf("%s: %w", ticket, err)
		}
	}
	s.Gate.resume.Store(s.resume)
	fresh := false
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
			row = &QuiesceFreeze{Op: op, By: by, Since: time.Now()}
			fresh = true
		}
		copy := *row
		copy.LeaseUntil = time.Now().Add(QuiesceLease)
		freeze = &copy
		return freeze, nil
	})
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
	drain, cancel := context.WithTimeout(ctx, 60*time.Second)
	err = s.Admission.Drain(drain)
	defer cancel()
	if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
		err = s.Admission.Stop(ctx)
	}
	if err != nil {
		return nil, err
	}
	for _, ticket := range quiesceBarrierTickets {
		if err = s.Barriers[ticket].Drain(drain); err != nil {
			return nil, fmt.Errorf("%s: %w", ticket, err)
		}
	}
	if err = machines.CaptureAndStop(ctx); err != nil {
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

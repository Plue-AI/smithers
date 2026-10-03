package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
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
}
type QuiesceHostRuntime interface{ Stop(context.Context) error }
type InstallQuiescedError struct{ RetryAt time.Time }

func (e *InstallQuiescedError) Error() string { return "install quiesced" }

type QuiesceGate struct {
	Store    QuiesceStore
	StateDir string
}

func (g *QuiesceGate) marker() (bool, error) {
	if g.StateDir == "" {
		return false, errors.New("quiesce STATE directory unavailable")
	}
	_, err := os.Stat(filepath.Join(g.StateDir, ".upgrade-incomplete"))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}
func (g *QuiesceGate) expire(row *QuiesceFreeze) (*QuiesceFreeze, error) {
	marker, err := g.marker()
	if err != nil {
		return nil, err
	}
	if row != nil && !time.Now().Before(row.LeaseUntil) && !marker {
		slog.Warn("quiesce lease lapsed", "op", row.Op)
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
		frozen, err = g.expire(row)
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
}

func (s *InstallQuiesce) Reopen(ctx context.Context, op string) error {
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
		return nil, nil
	})
}

// Freeze renews an existing ready operation. Callers POST the same op every 10s,
// including while the initial drain request is outstanding.
func (s *InstallQuiesce) Freeze(ctx context.Context, op string, by int64) (freeze *QuiesceFreeze, err error) {
	if op == "" {
		return nil, errors.New("quiesce op required")
	}
	fresh := false
	err = s.Gate.Store.Update(ctx, func(row *QuiesceFreeze) (*QuiesceFreeze, error) {
		row, e := s.Gate.expire(row)
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
			if e := s.Gate.Store.Update(expiry, s.Gate.expire); e != nil {
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
					return nil, nil
				}
				return row, nil
			}))
		}
	}()
	machines := s.Machines
	if machines == nil {
		machines = UnavailableMachineQuiescer{}
	}
	// Missing dependencies refuse before touching live execution.
	if _, missing := machines.(UnavailableMachineQuiescer); missing {
		return nil, machines.CaptureAndStop(ctx)
	}
	if s.Admission == nil {
		return nil, &QuiesceDependencyError{"T-MCH-06"}
	}
	if s.Host == nil {
		return nil, &QuiesceDependencyError{"T-INS-08"}
	}
	drain, cancel := context.WithTimeout(ctx, 60*time.Second)
	err = s.Admission.Drain(drain)
	cancel()
	if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
		err = s.Admission.Stop(ctx)
	}
	if err != nil {
		return nil, err
	}
	if err = machines.CaptureAndStop(ctx); err != nil {
		return nil, err
	}
	if err = s.Host.Stop(ctx); err != nil {
		return nil, err
	}
	err = s.Gate.Store.Update(ctx, func(row *QuiesceFreeze) (*QuiesceFreeze, error) {
		row, e := s.Gate.expire(row)
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

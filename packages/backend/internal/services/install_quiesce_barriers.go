package services

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// StackQuiesceBarrier reads the same durable operation slot as merge recovery.
// It never settles an uncertain write or invents authority to resend it.
type StackQuiesceBarrier struct {
	Pool           *pgxpool.Pool
	ExternalWrites bool
}

func (b StackQuiesceBarrier) Check(ctx context.Context) error {
	if b.Pool == nil {
		return errors.New("stack persistence unavailable")
	}
	query := `SELECT COALESCE(number::text,id::text),pending_op FROM mythical_items WHERE pending_op IS NOT NULL ORDER BY id`
	rows, err := b.Pool.Query(ctx, query)
	if err != nil {
		return err
	}
	defer rows.Close()
	var refusals []error
	for rows.Next() {
		var number string
		var raw []byte
		if err := rows.Scan(&number, &raw); err != nil {
			return err
		}
		op, err := decodeMythicalOutbound(raw)
		if err != nil {
			refusals = append(refusals, fmt.Errorf("TODO %s: unreadable outbound operation", number))
			continue
		}
		if !b.ExternalWrites && op.Kind == "merge" {
			refusals = append(refusals, fmt.Errorf("merge in flight: TODO %s", number))
		}
	}
	return errors.Join(append(refusals, rows.Err())...)
}
func (b StackQuiesceBarrier) Drain(ctx context.Context) error {
	if !b.ExternalWrites {
		return b.Check(ctx)
	}
	if err := b.Check(ctx); err != nil {
		return err
	}
	timer := time.NewTicker(25 * time.Millisecond)
	defer timer.Stop()
	for {
		var pending bool
		if err := b.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM mythical_items WHERE pending_op IS NOT NULL) OR EXISTS(SELECT 1 FROM mythical_stacks WHERE pending_op IS NOT NULL OR running)`).Scan(&pending); err != nil {
			return err
		}
		if !pending {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
		}
	}
}
func (b StackQuiesceBarrier) Resume(ctx context.Context) error { return ctx.Err() }

// SecurityQuiesceBarrier remains closed until the root-input review lands.
type SecurityQuiesceBarrier struct{}

func (SecurityQuiesceBarrier) Check(context.Context) error {
	return errors.New("quiesce unavailable: T-SEC-01 required; waiting on smithers-3f root-input validation")
}
func (b SecurityQuiesceBarrier) Drain(ctx context.Context) error  { return b.Check(ctx) }
func (b SecurityQuiesceBarrier) Resume(ctx context.Context) error { return b.Check(ctx) }

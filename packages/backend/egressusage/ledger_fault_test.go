package egressusage

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// faultTx isolates database failure points that a real transaction cannot
// reliably trigger between successive statements. Integration tests exercise
// the same Charge path against PostgreSQL for committed and rolled-back work.
type faultTx struct {
	pgx.Tx
	failAt int
	calls  int
	cause  error
}

// forbiddenTx proves invalid requests are rejected before the ledger is read
// or written. Its embedded interface supplies the rest of pgx.Tx's shape.
type forbiddenTx struct{ pgx.Tx }

func (forbiddenTx) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	panic("invalid charge reached transaction Exec")
}

func (forbiddenTx) QueryRow(context.Context, string, ...any) pgx.Row {
	panic("invalid charge reached transaction QueryRow")
}

func (tx *faultTx) Exec(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
	tx.calls++
	if tx.calls == tx.failAt {
		return pgconn.CommandTag{}, tx.cause
	}
	if !strings.HasPrefix(sql, "INSERT INTO sandbox_egress_daily_usage") &&
		!strings.HasPrefix(sql, "INSERT INTO sandbox_egress_usage") &&
		!strings.HasPrefix(sql, "UPDATE sandbox_egress_daily_usage") {
		panic("unexpected SQL: " + sql)
	}
	return pgconn.CommandTag{}, nil
}

func (tx *faultTx) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	tx.calls++
	if tx.calls == tx.failAt {
		return faultRow{err: tx.cause}
	}
	if strings.HasPrefix(sql, "SELECT bytes FROM sandbox_egress_daily_usage") {
		return faultRow{daily: true}
	}
	if strings.HasPrefix(sql, "SELECT sandbox_id,billing_user_id") {
		return faultRow{err: pgx.ErrNoRows}
	}
	panic("unexpected SQL: " + sql)
}

type faultRow struct {
	daily bool
	err   error
}

func (row faultRow) Scan(dest ...any) error {
	if row.err != nil {
		return row.err
	}
	if row.daily && len(dest) == 1 {
		*dest[0].(*int64) = 0
		return nil
	}
	panic("unexpected Scan")
}

func TestChargePropagatesTransactionFailures(t *testing.T) {
	for _, stage := range []struct {
		name string
		call int
		zero bool
	}{
		{"daily row insert", 1, true},
		{"daily row lock", 2, true},
		{"receipt read", 3, true},
		{"receipt insert", 4, true},
		{"daily total update", 5, false},
	} {
		t.Run(stage.name, func(t *testing.T) {
			cause := errors.New("database unavailable at " + stage.name)
			tx := &faultTx{failAt: stage.call, cause: cause}
			allowed, err := Charge(context.Background(), tx, chargeRequest("fault", 77, 10, 10))
			if !errors.Is(err, cause) || tx.calls != stage.call {
				t.Fatalf("allowed=%d err=%v calls=%d, want failure at call %d", allowed, err, tx.calls, stage.call)
			}
			if stage.zero && allowed != 0 {
				t.Fatalf("failed charge returned allowance %d", allowed)
			}
		})
	}
}

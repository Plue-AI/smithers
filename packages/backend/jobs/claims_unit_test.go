package jobs

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"
)

// Unit tests isolate database error handling; the PostgreSQL setup recovery
// tests exercise the real lease predicate and transaction lock.
type fenceTx struct {
	pgx.Tx
	args []any
	err  error
}

func (tx *fenceTx) QueryRow(_ context.Context, _ string, args ...any) pgx.Row {
	tx.args = args
	return fenceRow{err: tx.err}
}

type fenceRow struct{ err error }

func (row fenceRow) Scan(...any) error { return row.err }

func TestFenceInTxRefusesMissingClaimAndPreservesDatabaseErrors(t *testing.T) {
	claim := Claim{OperationID: "image-operation", Token: "current-token", Generation: 3, WorkerID: "image-worker"}
	databaseFailure := errors.New("database unavailable")
	for _, test := range []struct {
		name string
		err  error
		want error
	}{
		{"live claim", nil, nil},
		{"expired or replaced claim", pgx.ErrNoRows, ErrClaimLost},
		{"cancelled", context.Canceled, context.Canceled},
		{"database failure", databaseFailure, databaseFailure},
	} {
		t.Run(test.name, func(t *testing.T) {
			tx := &fenceTx{err: test.err}
			err := (&Store{}).FenceInTx(t.Context(), tx, claim)
			if test.want == nil {
				require.NoError(t, err)
			} else {
				require.ErrorIs(t, err, test.want)
			}
			require.Equal(t, []any{"image-operation", "current-token", int64(3), "image-worker"}, tx.args)
		})
	}
}

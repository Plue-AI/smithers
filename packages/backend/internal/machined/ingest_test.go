package machined

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

func TestDispatcherRequiresDurableConsumer(t *testing.T) {
	writer := func(context.Context, pgx.Tx, string, Event) (Acknowledgement, error) {
		t.Fatal("unavailable dispatcher must not project an event")
		return Acknowledgement{}, nil
	}
	for _, test := range []struct {
		name     string
		ingestor *Ingestor
	}{
		{"nil", nil},
		{"pool", &Ingestor{Write: writer}},
		{"writer", &Ingestor{Pool: new(pgxpool.Pool)}},
	} {
		t.Run(test.name, func(t *testing.T) {
			r := new(Registry)
			authority, err := r.MintBoot("branch", "vm")
			require.NoError(t, err)
			link, _ := connectTest(t, r, "branch", authority)
			require.NoError(t, link.Reconciled())
			require.ErrorIs(t, test.ingestor.Dispatch(t.Context(), link, "branch"), ErrNotReady)
			_, err = r.Current("branch")
			require.ErrorIs(t, err, ErrNotReady)
		})
	}
	require.ErrorIs(t, (*Ingestor)(nil).Dispatch(t.Context(), nil, "branch"), ErrNotReady)
	require.ErrorIs(t, (*Ingestor)(nil).Dispatch(t.Context(), &Link{}, "branch"), ErrUnauthorized)
	require.ErrorIs(t, (*Ingestor)(nil).Dispatch(t.Context(), &Link{Connection: &Connection{}}, "branch"), ErrUnauthorized)
}

func TestStoppedDispatcherCannotEvictReplacement(t *testing.T) {
	r := new(Registry)
	authority, err := r.MintBoot("branch", "vm")
	require.NoError(t, err)
	old, _ := connectTest(t, r, "branch", authority)
	replacement, _ := connectTest(t, r, "branch", authority)
	require.NoError(t, replacement.Reconciled())
	require.ErrorIs(t, (*Ingestor)(nil).Dispatch(t.Context(), old, "branch"), ErrNotReady)
	current, err := r.Current("branch")
	require.NoError(t, err)
	require.Same(t, replacement, current)
	require.NoError(t, replacement.RequireReady("branch"))
}

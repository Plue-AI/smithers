package modelproxy

import (
	"context"
	"math"
	"net"
	"sync/atomic"
	"syscall"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/modelprice"
	"github.com/stretchr/testify/require"
)

func TestMeterAdmissionUnitInvalidPriceOrBoundNeverAcquiresConnection(t *testing.T) {
	config, err := pgxpool.ParseConfig("postgres://127.0.0.1:1/unit_admission?sslmode=disable")
	require.NoError(t, err)
	config.MinConns = 0
	config.MaxConns = 1
	var connections, dials atomic.Int64
	config.BeforeConnect = func(context.Context, *pgx.ConnConfig) error {
		connections.Add(1)
		return nil
	}
	// The supported dial port prevents accidental network access if admission
	// regresses, and records the attempt. This is not a SQL response substitute.
	config.ConnConfig.DialFunc = func(context.Context, string, string) (net.Conn, error) {
		dials.Add(1)
		return nil, &net.OpError{Op: "dial", Net: "tcp", Err: syscall.ECONNREFUSED}
	}
	pool, err := pgxpool.NewWithConfig(t.Context(), config)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	meter := Meter{Ledger: credits.Ledger{DB: pool}}
	for _, item := range []struct {
		name, provider, model string
		maximum               modelprice.Usage
		message               string
	}{
		{"unknown model", "openai", "unknown-unit-model", modelprice.Usage{OutputTokens: 3}, "modelproxy: model is not offered on platform keys"},
		{"wrong provider", "openai", "claude-haiku-4-5", modelprice.Usage{OutputTokens: 3}, "modelproxy: model is not offered on platform keys"},
		{"empty model", "openai", "", modelprice.Usage{OutputTokens: 3}, "modelproxy: model is not offered on platform keys"},
		{"zero bound", "openai", "gpt-6-sol", modelprice.Usage{}, "modelproxy: invalid bound: bound must be positive"},
		{"negative input", "openai", "gpt-6-sol", modelprice.Usage{InputTokens: -1, OutputTokens: 3}, "modelproxy: invalid bound: negative model usage\nbound must be positive"},
		{"negative output", "openai", "gpt-6-sol", modelprice.Usage{OutputTokens: -1}, "modelproxy: invalid bound: negative model usage\nbound must be positive"},
		{"negative cache read", "openai", "gpt-6-sol", modelprice.Usage{CacheReadTokens: -1}, "modelproxy: invalid bound: negative model usage\nbound must be positive"},
		{"negative cache write", "openai", "gpt-6-sol", modelprice.Usage{CacheWriteTokens: math.MinInt64}, "modelproxy: invalid bound: negative model usage\nbound must be positive"},
		{"unrepresentable cost", "openai", "gpt-6-sol", modelprice.Usage{OutputTokens: math.MaxInt64}, "modelproxy: invalid bound: model cost overflow\nbound must be positive"},
	} {
		t.Run(item.name, func(t *testing.T) {
			reservation, err := meter.Execute(t.Context(), Caller{OwnerType: "user", OwnerID: 1, Source: "app", UserID: 1},
				Call{Provider: item.provider, Model: item.model, Maximum: item.maximum}, func(context.Context) (Result, error) {
					t.Fatal("refused model or bound must never run provider work")
					return Result{}, nil
				})
			require.EqualError(t, err, item.message)
			require.Equal(t, credits.Reservation{}, reservation)
			require.Zero(t, connections.Load(), "refusal precedes connection acquisition")
			require.Zero(t, dials.Load(), "refusal precedes network dialing")
		})
	}
}

func TestMeterAdmissionUnitOptionalUsageIdentifierValues(t *testing.T) {
	// Optional model_usage references encode missing/nonpositive IDs as NULL;
	// present signed IDs must retain their exact value for foreign-key lookup.
	for _, id := range []int64{0, -1, math.MinInt64} {
		require.Nil(t, positive(id))
	}
	for _, id := range []int64{1, 42, math.MaxInt64} {
		value := positive(id)
		require.NotNil(t, value)
		require.Equal(t, id, *value)
	}
	for _, text := range []string{"", " \t\n", "\u2003"} {
		require.Nil(t, nonEmpty(text))
	}
	value := nonEmpty("00000000-0000-0000-0000-000000000001")
	require.NotNil(t, value)
	require.Equal(t, "00000000-0000-0000-0000-000000000001", *value)
}

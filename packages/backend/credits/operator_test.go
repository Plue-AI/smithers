package credits

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestParseAndFormatUSD(t *testing.T) {
	for in, want := range map[string]int64{
		"25": 25 * NanosPerUSD, "0.50": 50 * NanosPerCent,
		"0.000000001": 1, " 000.000000001 ": 1,
		"9223372036.854775807": math.MaxInt64,
	} {
		got, err := ParseUSD(in)
		require.NoError(t, err, in)
		require.Equal(t, want, got, in)
	}
	for _, bad := range []string{"", "0", "0.000000000", "-1", "+1", ".5", "1.", "1,000", "abc", "0x19", "1/4", "0.0000000001", "1e30", "99999999999", "9223372036.854775808"} {
		_, err := ParseUSD(bad)
		require.Error(t, err, bad)
	}
	require.Equal(t, "25", FormatUSD(25*NanosPerUSD))
	require.Equal(t, "0.5", FormatUSD(50*NanosPerCent))
	require.Equal(t, "-0.000000001", FormatUSD(-1))
	require.Equal(t, "0", FormatUSD(0))
	require.Equal(t, "9223372036.854775807", FormatUSD(math.MaxInt64))
	require.Equal(t, "-9223372036.854775808", FormatUSD(math.MinInt64))
}

func TestOperatorCommandRejectsSyntaxBeforeDatabase(t *testing.T) {
	l := Ledger{}
	for _, tc := range []struct {
		name string
		args []string
		want string
	}{
		{name: "missing command", want: "usage: credits"},
		{name: "unknown command", args: []string{"transfer"}, want: "usage: credits"},
		{name: "unknown flag", args: []string{"balance", "-bogus"}, want: "flag provided but not defined"},
		{name: "extra argument", args: []string{"balance", "extra"}, want: "unexpected argument"},
		{name: "missing owner", args: []string{"balance"}, want: "-owner must be"},
		{name: "blank owner name", args: []string{"balance", "-owner", "user: "}, want: "-owner must be"},
		{name: "unknown owner type", args: []string{"balance", "-owner", "team:alice"}, want: "-owner must be"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var out, diagnostics bytes.Buffer
			err := l.OperatorCommand(context.Background(), tc.args, &out, &diagnostics)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error=%v, want %q", err, tc.want)
			}
			if out.Len() != 0 {
				t.Fatalf("failed command wrote balance: %q", out.String())
			}
		})
	}
}

func TestOperatorCommandRequiresActorAndReason(t *testing.T) {
	for _, tc := range []struct {
		name string
		args []string
		want string
	}{
		{name: "missing both", args: []string{"grant", "-owner", "user:alice", "-usd", "25", "-key", "october"}, want: "-actor"},
		{name: "missing actor", args: []string{"grant", "-owner", "user:alice", "-usd", "25", "-key", "october", "-reason", "support credit"}, want: "-actor"},
		{name: "blank actor", args: []string{"grant", "-owner", "user:alice", "-usd", "25", "-key", "october", "-actor", "  ", "-reason", "support credit"}, want: "-actor"},
		{name: "missing reason", args: []string{"grant", "-owner", "user:alice", "-usd", "25", "-key", "october", "-actor", "operator@example.com"}, want: "-reason"},
		{name: "blank reason", args: []string{"grant", "-owner", "user:alice", "-usd", "25", "-key", "october", "-actor", "operator@example.com", "-reason", "  "}, want: "-reason"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var out, diagnostics bytes.Buffer
			err := (Ledger{}).OperatorCommand(context.Background(), tc.args, &out, &diagnostics)
			require.ErrorContains(t, err, tc.want)
			require.Empty(t, out.String())
		})
	}
}

func TestOperatorCommandGrantsIdempotentlyByKey(t *testing.T) {
	l := Ledger{DB: testPool(t)}
	ctx := context.Background()
	_, err := l.DB.Exec(ctx, `INSERT INTO users (id, username, lower_username) VALUES (41, 'Alice', 'alice')`)
	require.NoError(t, err)
	var out bytes.Buffer
	run := func(args ...string) error { out.Reset(); return l.OperatorCommand(ctx, args, &out, io.Discard) }
	_, err = l.DB.Exec(ctx, `INSERT INTO users (id, username, lower_username) VALUES (42, 'Bob', 'bob')`)
	require.NoError(t, err)
	require.NoError(t, run("list", "-owner", "user:bob"))
	require.JSONEq(t, `[]`, out.String())
	var accounts int
	require.NoError(t, l.DB.QueryRow(ctx, `SELECT count(*) FROM credit_accounts WHERE owner_type = 'user' AND owner_id = 42`).Scan(&accounts))
	require.Zero(t, accounts, "listing a user must not create an account")
	grant := func() error {
		args := []string{"grant", "-owner", "user:Alice", "-usd", "25", "-key", "2026-10", "-actor", "admin@example.com", "-reason", "customer goodwill", "-expires", "2099-01-01T00:00:00Z"}
		return run(args...)
	}
	require.NoError(t, grant())
	require.Equal(t, "user:Alice balance 25 USD\n", out.String())
	var actor, reason string
	var expiry time.Time
	var grants, events int
	require.NoError(t, l.DB.QueryRow(ctx, `SELECT actor, reason, expires_at FROM credit_grants WHERE source_key = 'operator:2026-10'`).Scan(&actor, &reason, &expiry))
	require.Equal(t, "admin@example.com", actor)
	require.Equal(t, "customer goodwill", reason)
	require.True(t, expiry.Equal(time.Date(2099, 1, 1, 0, 0, 0, 0, time.UTC)), "stored expiry = %s", expiry)
	require.NoError(t, grant(), "a repeated grant is a no-op")
	require.NoError(t, l.DB.QueryRow(ctx, `SELECT (SELECT count(*) FROM credit_grants WHERE source_key = 'operator:2026-10'),
		(SELECT count(*) FROM credit_events WHERE grant_id = (SELECT id FROM credit_grants WHERE source_key = 'operator:2026-10'))`).Scan(&grants, &events))
	require.Equal(t, 1, grants)
	require.Equal(t, 1, events)
	require.NoError(t, run("list", "-owner", "user:alice"))
	var listed []struct {
		ID             int64      `json:"id"`
		Key            string     `json:"key"`
		AmountUSD      string     `json:"amount_usd"`
		AvailableNanos int64      `json:"available_nanos"`
		ExpiresAt      *time.Time `json:"expires_at"`
		Actor          string     `json:"actor"`
		Reason         string     `json:"reason"`
		CreatedAt      time.Time  `json:"created_at"`
	}
	require.NoError(t, json.Unmarshal(out.Bytes(), &listed))
	require.Len(t, listed, 1)
	require.Positive(t, listed[0].ID)
	require.Equal(t, "operator:2026-10", listed[0].Key)
	require.Equal(t, "25", listed[0].AmountUSD)
	require.Equal(t, int64(25*NanosPerUSD), listed[0].AvailableNanos)
	require.Equal(t, "admin@example.com", listed[0].Actor)
	require.Equal(t, "customer goodwill", listed[0].Reason)
	require.NotNil(t, listed[0].ExpiresAt)
	require.True(t, listed[0].ExpiresAt.Equal(time.Date(2099, 1, 1, 0, 0, 0, 0, time.UTC)), "listed expiry = %s", listed[0].ExpiresAt)
	require.False(t, listed[0].CreatedAt.IsZero())
	require.NoError(t, run("balance", "-owner", "user:alice"))
	require.Equal(t, "user:alice balance 25 USD\n", out.String())
	require.ErrorIs(t, run("grant", "-owner", "user:alice", "-usd", "30", "-key", "2026-10", "-actor", "admin@example.com", "-reason", "customer goodwill", "-expires", "2099-01-01T00:00:00Z"), ErrConflict)
	require.ErrorIs(t, run("grant", "-owner", "user:alice", "-usd", "25", "-key", "2026-10", "-actor", "other@example.com", "-reason", "customer goodwill", "-expires", "2099-01-01T00:00:00Z"), ErrConflict)
	require.ErrorIs(t, run("grant", "-owner", "user:alice", "-usd", "25", "-key", "2026-10", "-actor", "admin@example.com", "-reason", "different reason", "-expires", "2099-01-01T00:00:00Z"), ErrConflict)
	require.ErrorIs(t, run("grant", "-owner", "user:alice", "-usd", "25", "-key", "2026-10", "-actor", "admin@example.com", "-reason", "customer goodwill", "-expires", "2099-02-01T00:00:00Z"), ErrConflict)
	require.Error(t, run("grant", "-owner", "user:alice", "-usd", "5", "-actor", "admin@example.com", "-reason", "customer goodwill"), "a grant needs a key")
	require.Error(t, run("grant", "-owner", "user:nobody", "-usd", "5", "-key", "k", "-actor", "admin@example.com", "-reason", "customer goodwill"))
	require.Error(t, run("grant", "-owner", "team:alice", "-usd", "5", "-key", "k", "-actor", "admin@example.com", "-reason", "customer goodwill"))
	require.Error(t, run("spend", "-owner", "user:alice"))
	require.Error(t, run("grant", "-owner", "user:alice", "-usd", "5", "-key", "old", "-actor", "admin@example.com", "-reason", "customer goodwill", "-expires", "2020-01-01T00:00:00Z"))
	accountID, err := l.EnsureAccount(ctx, "user", 41)
	require.NoError(t, err)
	require.Error(t, l.Grant(ctx, accountID, "operator:bypass", NanosPerUSD, nil), "operator credit must not bypass audit metadata")
	require.NoError(t, l.DB.QueryRow(ctx, `SELECT count(*) FROM credit_grants WHERE source_key = 'operator:bypass'`).Scan(&grants))
	require.Zero(t, grants)
	var legacyID int64
	require.NoError(t, l.DB.QueryRow(ctx, `INSERT INTO credit_grants (account_id, source_key, original_nanos, available_nanos)
		VALUES ($1, 'operator:legacy', $2, $2) RETURNING id`, accountID, 25*NanosPerUSD).Scan(&legacyID))
	_, err = l.DB.Exec(ctx, `INSERT INTO credit_events (account_id, grant_id, kind, available_delta_nanos)
		VALUES ($1, $2, 'grant', $3)`, accountID, legacyID, 25*NanosPerUSD)
	require.NoError(t, err)
	require.ErrorIs(t, run("grant", "-owner", "user:alice", "-usd", "25", "-key", "legacy", "-actor", "admin@example.com", "-reason", "new attribution"), ErrConflict,
		"replaying an unattributed historical grant must not replace its audit fields")
	require.NoError(t, l.DB.QueryRow(ctx, `SELECT actor, reason FROM credit_grants WHERE id = $1`, legacyID).Scan(&actor, &reason))
	require.Empty(t, actor)
	require.Empty(t, reason)
	require.NoError(t, l.DB.QueryRow(ctx, `SELECT count(*) FROM credit_events WHERE grant_id = $1`, legacyID).Scan(&events))
	require.Equal(t, 1, events)
}

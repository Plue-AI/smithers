package operator

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/smithersai/smithers/packages/backend/testkit/testdb"
)

func TestDispatchValidatesBeforeOpeningDatabase(t *testing.T) {
	basePlan := []string{"plans", "grant", "-owner", "user:alice", "-plan", "pro", "-expires", "2099-01-01T00:00:00Z", "-key", "case-1", "-actor", "operator", "-reason", "support"}
	baseCredit := []string{"credits", "grant", "-owner", "user:alice", "-usd", "25", "-key", "case-2", "-actor", "operator", "-reason", "support"}
	for _, tc := range []struct {
		name, want string
		args       []string
		handled    bool
	}{
		{name: "no command"},
		{name: "unrelated command", args: []string{"serve", "-port", "8080"}},
		{name: "unknown command", args: []string{"unknown"}},
		{name: "credits unknown action", args: []string{"credits", "spend"}, handled: true, want: "usage: credits"},
		{name: "credits missing actor", args: baseCredit[:len(baseCredit)-4], handled: true, want: "-actor"},
		{name: "credits blank actor", args: append(append([]string{}, baseCredit[:len(baseCredit)-4]...), "-actor", "  ", "-reason", "support"), handled: true, want: "-actor"},
		{name: "credits missing reason", args: baseCredit[:len(baseCredit)-2], handled: true, want: "-reason"},
		{name: "credits blank reason", args: append(append([]string{}, baseCredit[:len(baseCredit)-1]...), "  "), handled: true, want: "-reason"},
		{name: "plans unknown action", args: []string{"plans", "list"}, handled: true, want: "usage: plans grant"},
		{name: "plans missing actor", args: append(append([]string{}, basePlan[:len(basePlan)-4]...), "-reason", "support"), handled: true, want: "-actor"},
		{name: "plans blank actor", args: append(append([]string{}, basePlan[:len(basePlan)-4]...), "-actor", " ", "-reason", "support"), handled: true, want: "-actor"},
		{name: "plans missing reason", args: basePlan[:len(basePlan)-2], handled: true, want: "-reason"},
		{name: "plans blank reason", args: append(append([]string{}, basePlan[:len(basePlan)-1]...), " "), handled: true, want: "-reason"},
		{name: "plans disallowed plan", args: []string{"plans", "grant", "-owner", "user:alice", "-plan", "team", "-expires", "2099-01-01T00:00:00Z", "-key", "case-1", "-actor", "operator", "-reason", "support"}, handled: true, want: "-plan"},
		{name: "plans bad end date", args: []string{"plans", "grant", "-owner", "user:alice", "-plan", "pro", "-expires", "tomorrow", "-key", "case-1", "-actor", "operator", "-reason", "support"}, handled: true, want: "-expires"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			opens := 0
			var out bytes.Buffer
			handled, err := Dispatch(t.Context(), tc.args, Config{OpenDatabase: func(context.Context) (*pgxpool.Pool, error) {
				opens++
				return nil, errors.New("database opened")
			}, Stdout: &out})
			require.Equal(t, tc.handled, handled)
			if tc.want == "" {
				require.NoError(t, err)
			} else {
				require.ErrorContains(t, err, tc.want)
			}
			require.Zero(t, opens)
			require.Empty(t, out.String())
		})
	}
}

func TestDispatchDatabaseOpenerFailures(t *testing.T) {
	args := []string{"credits", "balance", "-owner", "user:alice"}
	for _, tc := range []struct {
		name string
		open func(context.Context) (*pgxpool.Pool, error)
		want string
	}{
		{name: "missing opener", want: "database opener required"},
		{name: "opener error", open: func(context.Context) (*pgxpool.Pool, error) { return nil, errors.New("connect failed") }, want: "connect failed"},
		{name: "nil pool", open: func(context.Context) (*pgxpool.Pool, error) { return nil, nil }, want: "database pool required"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			handled, err := Dispatch(t.Context(), args, Config{OpenDatabase: tc.open})
			require.True(t, handled)
			require.ErrorContains(t, err, tc.want)
		})
	}
}

func TestDispatchGrantsPlansAndCreditsThroughProductDatabase(t *testing.T) {
	if testdb.ServerURL() == "" {
		testdb.Unavailable(t, testdb.ErrNotConfigured)
	}
	pool, url := postgresfixture.NewProductDatabase(t)
	_, err := pool.Exec(t.Context(), `INSERT INTO users (id, username, lower_username) VALUES (101, 'Alice', 'alice')`)
	require.NoError(t, err)
	var out bytes.Buffer
	opens := 0
	run := func(args ...string) error {
		t.Helper()
		out.Reset()
		handled, err := Dispatch(t.Context(), args, Config{OpenDatabase: func(ctx context.Context) (*pgxpool.Pool, error) {
			opens++
			return postgresfixture.Open(ctx, url, 0)
		}, Stdout: &out})
		require.True(t, handled)
		return err
	}
	plan := []string{"plans", "grant", "-owner", "user:Alice", "-plan", "max", "-expires", "2099-01-01T00:00:00Z", "-key", "case-plan", "-actor", "admin@example.com", "-reason", "support comp"}
	require.NoError(t, run(plan...))
	require.Equal(t, "user:Alice max until 2099-01-01T00:00:00Z\n", out.String())
	require.NoError(t, run(plan...), "exact replay must be safe")
	changed := append([]string{}, plan...)
	changed[len(changed)-1] = "different reason"
	require.ErrorIs(t, run(changed...), credits.ErrConflict)
	var planCount, creditCount int
	var planKey, actor, reason string
	var end time.Time
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT plan_key, actor, reason, expires_at FROM billing_plan_grants WHERE source_key = 'case-plan'`).Scan(&planKey, &actor, &reason, &end))
	require.Equal(t, "max", planKey)
	require.Equal(t, "admin@example.com", actor)
	require.Equal(t, "support comp", reason)
	require.True(t, end.Equal(time.Date(2099, 1, 1, 0, 0, 0, 0, time.UTC)))
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM billing_plan_grants`).Scan(&planCount))
	require.Equal(t, 1, planCount)
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM credit_grants`).Scan(&creditCount))
	require.Zero(t, creditCount, "plan comp must not issue credit")

	credit := []string{"credits", "grant", "-owner", "user:alice", "-usd", "25", "-key", "case-credit", "-actor", "admin@example.com", "-reason", "support credit"}
	require.NoError(t, run(credit...))
	require.Equal(t, "user:alice balance 25 USD\n", out.String())
	require.NoError(t, run(credit...))
	require.NoError(t, run("credits", "list", "-owner", "user:alice"))
	var listed []struct {
		Key    string `json:"key"`
		Actor  string `json:"actor"`
		Reason string `json:"reason"`
	}
	require.NoError(t, json.Unmarshal(out.Bytes(), &listed))
	require.Len(t, listed, 1)
	require.Equal(t, "operator:case-credit", listed[0].Key)
	require.Equal(t, "admin@example.com", listed[0].Actor)
	require.Equal(t, "support credit", listed[0].Reason)
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM credit_grants`).Scan(&creditCount))
	require.Equal(t, 1, creditCount)
	require.GreaterOrEqual(t, opens, 6)

	require.ErrorContains(t, run("plans", "grant", "-owner", "user:alice", "-plan", "pro", "-expires", "2020-01-01T00:00:00Z", "-key", "expired", "-actor", "admin@example.com", "-reason", "support comp"), "future")
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM billing_plan_grants`).Scan(&planCount))
	require.Equal(t, 1, planCount)
}

func TestDispatchOperatorFirstPreservesConfiguredSignupCredit(t *testing.T) {
	if testdb.ServerURL() == "" {
		testdb.Unavailable(t, testdb.ErrNotConfigured)
	}
	pool, url := postgresfixture.NewProductDatabase(t)
	_, err := pool.Exec(t.Context(), `INSERT INTO users (id, username, lower_username) VALUES (102, 'First', 'first')`)
	require.NoError(t, err)
	const signup = 1000 * credits.NanosPerCent
	var out bytes.Buffer
	callbackCalled := false
	handled, err := Dispatch(t.Context(), []string{
		"credits", "grant", "-owner", "user:first", "-usd", "25", "-key", "operator-first",
		"-actor", "admin@example.com", "-reason", "support credit",
	}, Config{
		OpenDatabase: func(ctx context.Context) (*pgxpool.Pool, error) { return postgresfixture.Open(ctx, url, 0) },
		CreditLedger: func(operatorPool *pgxpool.Pool) (credits.Ledger, error) {
			callbackCalled = true
			return credits.Ledger{DB: operatorPool, SignupGrantNanos: signup}, nil
		},
		Stdout: &out,
	})
	require.True(t, handled)
	require.NoError(t, err)
	require.True(t, callbackCalled)

	ledger := credits.Ledger{DB: pool, SignupGrantNanos: signup}
	accountID, err := ledger.EnsureAccount(t.Context(), "user", 102)
	require.NoError(t, err)
	accountIDAgain, err := ledger.EnsureAccount(t.Context(), "user", 102)
	require.NoError(t, err)
	require.Equal(t, accountID, accountIDAgain)
	var signupCount, operatorCount int
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM credit_grants WHERE account_id = $1 AND source_key = $2`, accountID, credits.SignupGrantKey).Scan(&signupCount))
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM credit_grants WHERE account_id = $1 AND source_key = 'operator:operator-first'`, accountID).Scan(&operatorCount))
	require.Equal(t, 1, signupCount)
	require.Equal(t, 1, operatorCount)
	require.Equal(t, "user:first balance 35 USD\n", out.String())
	balance, err := ledger.OwnerBalance(t.Context(), "user", 102)
	require.NoError(t, err)
	require.Equal(t, signup+25*credits.NanosPerUSD, balance)
}

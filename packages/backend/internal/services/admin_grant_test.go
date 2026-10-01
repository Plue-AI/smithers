package services

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestAdminGrantAmountAndKeyBoundaries(t *testing.T) {
	for _, tc := range []struct {
		raw   string
		nanos int64
	}{
		{"1e-9", 1}, {"0.000000001", 1}, {"25", 25_000_000_000}, {"1.25e2", 125_000_000_000}, {"9223372036.854775807", 9223372036854775807},
	} {
		t.Run(tc.raw, func(t *testing.T) {
			login, nanos, err := validateAdminGrant(AdminGrantRequest{" OCTOCAT ", json.Number(tc.raw), "grant-1"})
			require.NoError(t, err)
			require.Equal(t, "octocat", login)
			require.Equal(t, tc.nanos, nanos)
		})
	}
	for _, raw := range []string{"", "NaN", "Inf", "-1", "0", "0.0000000001", "9223372036.854775808", "1e10", "1e99999999", "1e-9999999", "01", "+1", "0x1p0", "1/2", strings.Repeat("1", 65)} {
		t.Run("refuse-"+raw, func(t *testing.T) {
			_, _, err := validateAdminGrant(AdminGrantRequest{"octocat", json.Number(raw), "grant-1"})
			require.Equal(t, http.StatusBadRequest, apiStatus(t, err))
		})
	}
	for _, req := range []AdminGrantRequest{{" ", "1", "key"}, {strings.Repeat("a", 256), "1", "key"}, {"a", "1", ""}, {"a", "1", "../key"}, {"a", "1", strings.Repeat("a", 129)}} {
		_, _, err := validateAdminGrant(req)
		require.Equal(t, http.StatusBadRequest, apiStatus(t, err))
	}
	_, _, err := validateAdminGrant(AdminGrantRequest{strings.Repeat("a", 255), "1", strings.Repeat("a", 128)})
	require.NoError(t, err)
}

func TestAdminGrantRealLedgerIdempotencyAndGlobalFence(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	q := db.New(pool)
	create := func(name string, admin bool) db.User {
		u, err := q.CreateUser(ctx, db.CreateUserParams{Username: name, LowerUsername: name})
		require.NoError(t, err)
		if admin {
			require.NoError(t, q.SetUserAdmin(ctx, db.SetUserAdminParams{UserID: u.ID, IsAdmin: true}))
			u, err = q.GetUserByID(ctx, u.ID)
			require.NoError(t, err)
		}
		return u
	}
	admin := create("grant-admin", true)
	otherAdmin := create("grant-other-admin", true)
	target := create("grant-target", false)
	other := create("grant-other", false)
	svc := NewAdminGrantService(pool, credits.Ledger{DB: pool})
	req := AdminGrantRequest{target.Username, "1e-9", "grant-once"}
	got, err := svc.Grant(ctx, &admin, req)
	require.NoError(t, err)
	require.True(t, got.Granted)
	require.False(t, got.Duplicate)
	require.Regexp(t, `^credit-grant:[1-9][0-9]*$`, got.GrantID)
	require.Equal(t, json.Number("0.000000001"), got.AmountUSD)
	retry, err := svc.Grant(ctx, &admin, req)
	require.NoError(t, err)
	require.True(t, retry.Duplicate)
	require.Equal(t, got.GrantID, retry.GrantID)
	for _, tc := range []struct {
		actor db.User
		req   AdminGrantRequest
	}{{admin, AdminGrantRequest{other.Username, "1e-9", req.OperationKey}}, {admin, AdminGrantRequest{target.Username, "2e-9", req.OperationKey}}, {otherAdmin, req}} {
		_, err := svc.Grant(ctx, &tc.actor, tc.req)
		require.Equal(t, http.StatusConflict, apiStatus(t, err))
	}
	balance, err := (credits.Ledger{DB: pool}).OwnerBalance(ctx, "user", target.ID)
	require.NoError(t, err)
	require.Equal(t, int64(1), balance)
	var audits int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE event_type='admin.credit.grant'`).Scan(&audits))
	require.Equal(t, 1, audits)
	var actor, reason string
	require.NoError(t, pool.QueryRow(ctx, `SELECT actor,reason FROM credit_grants WHERE source_key='admin:grant-once'`).Scan(&actor, &reason))
	require.Equal(t, "admin.grant", reason)
	require.NotEmpty(t, actor)
	// Concurrent retries must serialize before reading the account-scoped ledger key.
	var wg sync.WaitGroup
	results := make(chan AdminGrantResult, 12)
	errs := make(chan error, 12)
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, e := svc.Grant(ctx, &admin, AdminGrantRequest{target.Username, "25", "grant-race"})
			results <- r
			errs <- e
		}()
	}
	wg.Wait()
	close(results)
	close(errs)
	fresh := 0
	ids := map[string]bool{}
	for e := range errs {
		require.NoError(t, e)
	}
	for r := range results {
		if !r.Duplicate {
			fresh++
		}
		ids[r.GrantID] = true
	}
	require.Equal(t, 1, fresh)
	require.Len(t, ids, 1)
	balance, err = (credits.Ledger{DB: pool}).OwnerBalance(ctx, "user", target.ID)
	require.NoError(t, err)
	require.Equal(t, int64(25_000_000_001), balance)
	// A different recipient with the same key cannot obtain another credit account grant.
	outcomes := make(chan error, 2)
	for _, u := range []db.User{target, other} {
		wg.Add(1)
		go func(u db.User) {
			defer wg.Done()
			_, e := svc.Grant(ctx, &admin, AdminGrantRequest{u.Username, "3", "grant-recipient-race"})
			outcomes <- e
		}(u)
	}
	wg.Wait()
	close(outcomes)
	success, conflict := 0, 0
	for e := range outcomes {
		if e == nil {
			success++
		} else {
			require.Equal(t, http.StatusConflict, apiStatus(t, e))
			conflict++
		}
	}
	require.Equal(t, 1, success)
	require.Equal(t, 1, conflict)
}

func TestAdminGrantRechecksAuthorityAndRecipient(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	q := db.New(pool)
	u, err := q.CreateUser(ctx, db.CreateUserParams{Username: "grant-ordinary", LowerUsername: "grant-ordinary"})
	require.NoError(t, err)
	svc := NewAdminGrantService(pool, credits.Ledger{DB: pool})
	req := AdminGrantRequest{u.Username, "1", "grant-authority"}
	for _, actor := range []*db.User{nil, {ID: 0, IsAdmin: true}} {
		_, err := svc.Grant(ctx, actor, req)
		require.Equal(t, http.StatusUnauthorized, apiStatus(t, err))
	}
	_, err = svc.Grant(ctx, &u, req)
	require.Equal(t, http.StatusForbidden, apiStatus(t, err))
	u.IsAdmin = true
	_, err = svc.Grant(ctx, &u, req)
	require.Equal(t, http.StatusForbidden, apiStatus(t, err), "a client role assertion is not authority")
	absent := db.User{ID: u.ID + 999, IsAdmin: true}
	_, err = svc.Grant(ctx, &absent, req)
	require.Equal(t, http.StatusForbidden, apiStatus(t, err))
	require.NoError(t, q.SetUserAdmin(ctx, db.SetUserAdminParams{UserID: u.ID, IsAdmin: true}))
	_, err = svc.Grant(ctx, &u, AdminGrantRequest{"missing", "1", "grant-authority"})
	require.Equal(t, http.StatusNotFound, apiStatus(t, err))
	_, err = NewAdminGrantService(nil, credits.Ledger{}).Grant(ctx, &u, req)
	require.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
	_, err = svc.Grant(ctx, &u, AdminGrantRequest{u.Username, "0", "grant-authority"})
	require.Equal(t, http.StatusBadRequest, apiStatus(t, err))
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	_, err = svc.Grant(cancelled, &u, req)
	require.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
	_, err = pool.Exec(ctx, `UPDATE users SET is_active=false WHERE id=$1`, u.ID)
	require.NoError(t, err)
	_, err = svc.Grant(ctx, &u, req)
	require.Equal(t, http.StatusForbidden, apiStatus(t, err))
	var grants int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM credit_grants WHERE source_key='admin:grant-authority'`).Scan(&grants))
	require.Zero(t, grants)
}

func TestAdminGrantCancellationWhileWaitingForGlobalFence(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	q := db.New(pool)
	admin, e := q.CreateUser(ctx, db.CreateUserParams{Username: "cancel-grant-admin", LowerUsername: "cancel-grant-admin"})
	require.NoError(t, e)
	require.NoError(t, q.SetUserAdmin(ctx, db.SetUserAdminParams{UserID: admin.ID, IsAdmin: true}))
	admin.IsAdmin = true
	target, e := q.CreateUser(ctx, db.CreateUserParams{Username: "cancel-grant-target", LowerUsername: "cancel-grant-target"})
	require.NoError(t, e)
	held, e := pool.Begin(ctx)
	require.NoError(t, e)
	defer held.Rollback(ctx)
	_, e = held.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "admin:cancelled-grant")
	require.NoError(t, e)
	requestCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan error, 1)
	svc := NewAdminGrantService(pool, credits.Ledger{DB: pool})
	req := AdminGrantRequest{target.Username, "1", "cancelled-grant"}
	go func() { _, e := svc.Grant(requestCtx, &admin, req); done <- e }()
	require.Eventually(t, func() bool {
		var waiting bool
		e := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory')`).Scan(&waiting)
		return e == nil && waiting
	}, time.Second, 10*time.Millisecond)
	cancel()
	select {
	case e := <-done:
		require.Equal(t, 500, apiStatus(t, e))
	case <-time.After(time.Second):
		t.Fatal("Cancelled grant did not release its transaction")
	}
	require.NoError(t, held.Rollback(ctx))
	var n int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM credit_grants WHERE source_key='admin:cancelled-grant'`).Scan(&n))
	require.Zero(t, n)
	result, e := svc.Grant(ctx, &admin, req)
	require.NoError(t, e)
	require.False(t, result.Duplicate)
	balance, e := (credits.Ledger{DB: pool}).OwnerBalance(ctx, "user", target.ID)
	require.NoError(t, e)
	require.Equal(t, int64(1_000_000_000), balance)
}

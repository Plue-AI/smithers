package services

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

// Inject unavailable transport boundaries around real PostgreSQL transactions.
// Every successful statement, savepoint and rollback still executes on PostgreSQL.
type grantFaultPool struct {
	pool  *pgxpool.Pool
	stage string
}

func (p grantFaultPool) Begin(ctx context.Context) (pgx.Tx, error) {
	if p.stage == "begin" {
		return nil, errors.New("grant transport unavailable")
	}
	tx, e := p.pool.Begin(ctx)
	if e != nil {
		return nil, e
	}
	return grantFaultTx{Tx: tx, stage: p.stage}, nil
}

type grantFaultTx struct {
	pgx.Tx
	stage string
	depth int
}
type grantFaultRow struct{}

func (grantFaultRow) Scan(...any) error { return errors.New("grant transport unavailable") }
func (tx grantFaultTx) Begin(ctx context.Context) (pgx.Tx, error) {
	nested, e := tx.Tx.Begin(ctx)
	if e != nil {
		return nil, e
	}
	return grantFaultTx{Tx: nested, stage: tx.stage, depth: tx.depth + 1}, nil
}
func (tx grantFaultTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	match := map[string]string{"actor": "-- name: GetUserByID", "recipient": "-- name: GetUserByLowerUsername", "existing": "SELECT count(*) OVER()", "account": "INSERT INTO credit_accounts", "grant": "INSERT INTO credit_grants", "receipt": "SELECT id FROM credit_grants WHERE account_id"}[tx.stage]
	if match != "" && strings.Contains(sql, match) {
		return grantFaultRow{}
	}
	return tx.Tx.QueryRow(ctx, sql, args...)
}
func (tx grantFaultTx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	if (tx.stage == "lock" && strings.Contains(sql, "pg_advisory_xact_lock")) || (tx.stage == "audit" && strings.Contains(sql, "INSERT INTO audit_log")) {
		return pgconn.CommandTag{}, errors.New("grant transport unavailable")
	}
	return tx.Tx.Exec(ctx, sql, args...)
}
func (tx grantFaultTx) Commit(ctx context.Context) error {
	if tx.stage == "commit" && tx.depth == 0 {
		return errors.New("grant transport unavailable")
	}
	return tx.Tx.Commit(ctx)
}

func TestAdminGrantTransportFailuresRemainAtomicAndRetryable(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	q := db.New(pool)
	admin, e := q.CreateUser(ctx, db.CreateUserParams{Username: "fault-admin", LowerUsername: "fault-admin"})
	require.NoError(t, e)
	require.NoError(t, q.SetUserAdmin(ctx, db.SetUserAdminParams{UserID: admin.ID, IsAdmin: true}))
	admin.IsAdmin = true
	target, e := q.CreateUser(ctx, db.CreateUserParams{Username: "fault-target", LowerUsername: "fault-target"})
	require.NoError(t, e)
	for _, stage := range []string{"begin", "actor", "lock", "recipient", "existing", "account", "grant", "receipt", "audit", "commit"} {
		t.Run(stage, func(t *testing.T) {
			svc := NewAdminGrantService(pool, credits.Ledger{DB: pool})
			svc.pool = grantFaultPool{pool, stage}
			req := AdminGrantRequest{target.Username, "1", "fault-" + stage}
			result, e := svc.Grant(ctx, &admin, req)
			require.Equal(t, 500, apiStatus(t, e))
			require.False(t, result.Granted)
			var n int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM credit_grants WHERE source_key=$1`, "admin:"+req.OperationKey).Scan(&n))
			require.Zero(t, n)
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE event_type='admin.credit.grant' AND metadata->>'operation_key'=$1`, req.OperationKey).Scan(&n))
			require.Zero(t, n)
			// The same approved request recovers without manufacturing a new operation key.
			result, e = NewAdminGrantService(pool, credits.Ledger{DB: pool}).Grant(ctx, &admin, req)
			require.NoError(t, e)
			require.True(t, result.Granted)
			require.False(t, result.Duplicate)
		})
	}
	balance, e := (credits.Ledger{DB: pool}).OwnerBalance(ctx, "user", target.ID)
	require.NoError(t, e)
	require.Equal(t, int64(10_000_000_000), balance)
}

func TestAdminGrantKeepsConfiguredSignupPolicy(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	q := db.New(pool)
	admin, e := q.CreateUser(ctx, db.CreateUserParams{Username: "signup-admin", LowerUsername: "signup-admin"})
	require.NoError(t, e)
	require.NoError(t, q.SetUserAdmin(ctx, db.SetUserAdminParams{UserID: admin.ID, IsAdmin: true}))
	admin.IsAdmin = true
	target, e := q.CreateUser(ctx, db.CreateUserParams{Username: "signup-target", LowerUsername: "signup-target"})
	require.NoError(t, e)
	ledger := credits.Ledger{DB: pool, SignupGrantNanos: 3_000_000_000}
	svc := NewAdminGrantService(pool, ledger)
	req := AdminGrantRequest{target.Username, "2", "signup-policy"}
	_, e = svc.Grant(ctx, &admin, req)
	require.NoError(t, e)
	_, e = svc.Grant(ctx, &admin, req)
	require.NoError(t, e)
	balance, e := ledger.OwnerBalance(ctx, "user", target.ID)
	require.NoError(t, e)
	require.Equal(t, int64(5_000_000_000), balance)
	var n int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM credit_grants WHERE source_key=$1`, credits.SignupGrantKey).Scan(&n))
	require.Equal(t, 1, n)
}

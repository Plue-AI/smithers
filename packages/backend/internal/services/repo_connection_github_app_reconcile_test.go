package services

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// recordedExec captures each Exec issued by the reconcile so the test can assert
// upserts and prunes without a live database.
type recordedExec struct {
	sql  string
	args []any
}

// newReconcileFakeGitHub stands up an httptest server that speaks the subset of
// the GitHub App API the reconcile walks: list installations, mint an
// installation token, then list that installation's repositories.
func newReconcileFakeGitHub(t *testing.T) *httptest.Server {
	t.Helper()
	expiresAt := time.Now().Add(time.Hour).UTC().Truncate(time.Second)
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/app/installations":
			// Single page (no Link header ⇒ walk terminates).
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`[{"id":4163546,"repository_selection":"selected","account":{"login":"smithersbot","type":"User"}}]`))
		case r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/app/installations/") && strings.HasSuffix(r.URL.Path, "/access_tokens"):
			w.WriteHeader(http.StatusCreated)
			_, _ = fmt.Fprintf(w, `{"token":"ghs_reconcile","expires_at":%q}`, expiresAt.Format(time.RFC3339))
		case r.Method == http.MethodGet && r.URL.Path == "/installation/repositories":
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"total_count":1,"repositories":[{"id":42,"name":"MultI","private":true,"owner":{"login":"SmithersBot"}}]}`))
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}

// RED: ReconcileGitHubAppInstallations must authenticate as the app, walk the
// installations + their repositories, and UPSERT rows into
// github_app_installation_repositories (owner/repo lowercased, is_private,
// installation_id). There is no such method today — the table is written only by
// webhook events, so pre-webhook installations can never appear. This fails to
// compile / run until the reconcile is implemented.
func TestRepoConnectionService_ReconcileGitHubAppInstallations_UpsertsRepositories(t *testing.T) {
	server := newReconcileFakeGitHub(t)
	defer server.Close()

	setTestCallerCredentials(t, "ID", "12345")
	setTestCallerCredentials(t, "PEM", testGitHubAppPrivateKeyPEM(t))
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)

	var mu sync.Mutex
	var execs []recordedExec
	installationPersisted := false
	svc := newTestRepoConnectionService(t, &mockRepoConnectionDB{
		execFn: func(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error) {
			mu.Lock()
			defer mu.Unlock()
			if strings.Contains(sql, "INSERT INTO github_app_installations") {
				installationPersisted = true
			}
			if strings.Contains(sql, "INSERT INTO github_app_installation_repositories") && !installationPersisted {
				return pgconn.NewCommandTag(""), &pgconn.PgError{Code: "23503", ConstraintName: "github_app_installation_repositories_installation_id_fkey"}
			}
			execs = append(execs, recordedExec{sql: sql, args: arguments})
			return pgconn.NewCommandTag("INSERT 0 1"), nil
		},
		queryRowFn: func(ctx context.Context, sql string, args ...any) pgx.Row {
			return mockRepoConnectionRow{scanFn: func(dest ...any) error { return pgx.ErrNoRows }}
		},
	})

	err := svc.ReconcileGitHubAppInstallations(context.Background())
	require.NoError(t, err)

	mu.Lock()
	defer mu.Unlock()
	var upsertedRepo bool
	var upsertedInstallation bool
	for _, e := range execs {
		if strings.Contains(e.sql, "INSERT INTO github_app_installations") {
			assert.Equal(t, []any{int64(4163546), "smithersbot", "User", "selected"}, e.args)
			upsertedInstallation = true
		}
		if strings.Contains(e.sql, "github_app_installation_repositories") && strings.Contains(strings.ToUpper(e.sql), "INSERT") {
			flat := fmt.Sprint(e.args...)
			if strings.Contains(flat, "smithersbot") && strings.Contains(flat, "multi") {
				upsertedRepo = true
			}
		}
	}
	assert.True(t, upsertedInstallation,
		"reconcile must persist the parent installation before its repository mappings")
	assert.True(t, upsertedRepo,
		"reconcile must upsert the installation's repositories (owner/repo lowercased) into github_app_installation_repositories")
}

// RED: when credentials are unconfigured the reconcile must no-op cleanly —
// return nil (no error spam) and never touch the database.
func TestRepoConnectionService_ReconcileGitHubAppInstallations_NoopWhenUnconfigured(t *testing.T) {
	setTestCallerCredentials(t, "ID", "")
	setTestCallerCredentials(t, "PEM", "")

	execCalled := false
	svc := newTestRepoConnectionService(t, &mockRepoConnectionDB{
		execFn: func(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error) {
			execCalled = true
			return pgconn.NewCommandTag(""), nil
		},
	})

	err := svc.ReconcileGitHubAppInstallations(context.Background())
	require.NoError(t, err, "reconcile must no-op (nil error) when creds are unconfigured")
	assert.False(t, execCalled, "reconcile must not touch the database when creds are unconfigured")
}

// Ported from Plue eae48148c (smithersai/plue#528).

// One tenant's failure must not freeze mapping freshness for every other
// tenant. A suspended installation answers the token mint with 403; the
// reconcile must still upsert and prune the healthy installation, still prune
// installations GitHub no longer lists, keep the failed installation's
// last-known repository rows, and report the partial failure.
func TestRepoConnectionService_ReconcileGitHubAppInstallations_SkipsFailingInstallation(t *testing.T) {
	const failingID, healthyID = int64(7001001), int64(7001002)
	expiresAt := time.Now().Add(time.Hour).UTC().Truncate(time.Second)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/app/installations":
			_, _ = fmt.Fprintf(w, `[{"id":%d,"repository_selection":"all","account":{"login":"suspended-org","type":"Organization"}},{"id":%d,"repository_selection":"all","account":{"login":"healthy-org","type":"Organization"}}]`, failingID, healthyID)
		case r.Method == http.MethodPost && r.URL.Path == fmt.Sprintf("/app/installations/%d/access_tokens", failingID):
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"message":"This installation has been suspended"}`))
		case r.Method == http.MethodPost && r.URL.Path == fmt.Sprintf("/app/installations/%d/access_tokens", healthyID):
			w.WriteHeader(http.StatusCreated)
			_, _ = fmt.Fprintf(w, `{"token":"ghs_healthy","expires_at":%q}`, expiresAt.Format(time.RFC3339))
		case r.Method == http.MethodGet && r.URL.Path == "/installation/repositories":
			_, _ = w.Write([]byte(`{"total_count":1,"repositories":[{"id":77,"name":"Api","private":true,"owner":{"login":"Healthy-Org"}}]}`))
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	setTestCallerCredentials(t, "ID", "12345")
	setTestCallerCredentials(t, "PEM", testGitHubAppPrivateKeyPEM(t))
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)

	var mu sync.Mutex
	var execs []recordedExec
	svc := newTestRepoConnectionService(t, &mockRepoConnectionDB{
		execFn: func(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error) {
			mu.Lock()
			defer mu.Unlock()
			execs = append(execs, recordedExec{sql: sql, args: arguments})
			return pgconn.NewCommandTag("INSERT 0 1"), nil
		},
	})

	err := svc.ReconcileGitHubAppInstallations(context.Background())
	require.Error(t, err, "a skipped installation must surface as a partial failure")

	mu.Lock()
	defer mu.Unlock()
	var healthyRepoUpserted bool
	var prunedRepoInstallations []any
	var prunedInstallationsKeep []int64
	for _, e := range execs {
		switch e.sql {
		case upsertGitHubAppInstallationRepositorySQL:
			if e.args[0] == healthyID && e.args[3] == "healthy-org" && e.args[5] == "api" {
				healthyRepoUpserted = true
			}
		case pruneGitHubAppInstallationRepositoriesSQL:
			prunedRepoInstallations = append(prunedRepoInstallations, e.args[0])
		case pruneGitHubAppInstallationsSQL:
			prunedInstallationsKeep = e.args[0].([]int64)
		}
	}
	assert.True(t, healthyRepoUpserted, "the installation after the failing one must still be reconciled")
	assert.Equal(t, []any{healthyID}, prunedRepoInstallations,
		"only the reconciled installation may have its repositories pruned; the failed one keeps its last-known rows")
	assert.ElementsMatch(t, []int64{failingID, healthyID}, prunedInstallationsKeep,
		"the installation prune must still run and keep every installation GitHub lists")
}

type fakeGitHubAppReconcileLocker struct {
	acquired bool
	calls    int
}

func (l *fakeGitHubAppReconcileLocker) TryWithLock(ctx context.Context, fn func(context.Context) error) (bool, error) {
	l.calls++
	if !l.acquired {
		return false, nil
	}
	return true, fn(ctx)
}

// The reconcile is the only repair path for missed webhooks, so it must repeat
// on an interval rather than run once per pod boot, and it must run only on the
// replica that wins the lock.
func TestRunGitHubAppInstallationReconcileLoop_RepeatsUnderLock(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runs := make(chan struct{}, 8)
	locker := &fakeGitHubAppReconcileLocker{acquired: true}
	done := make(chan struct{})
	go func() {
		defer close(done)
		runGitHubAppInstallationReconcileLoop(ctx, locker, 5*time.Millisecond, func(context.Context) error {
			runs <- struct{}{}
			return fmt.Errorf("installation 1 suspended")
		})
	}()

	for i := 0; i < 3; i++ {
		select {
		case <-runs:
		case <-time.After(2 * time.Second):
			t.Fatalf("reconcile ran %d times; want it to repeat on the interval even after a failure", i)
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("reconcile loop did not stop on context cancel")
	}
}

func TestRunGitHubAppInstallationReconcileLoop_SkipsWhenAnotherReplicaHoldsLock(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()

	locker := &fakeGitHubAppReconcileLocker{acquired: false}
	ran := false
	runGitHubAppInstallationReconcileLoop(ctx, locker, 5*time.Millisecond, func(context.Context) error {
		ran = true
		return nil
	})
	assert.False(t, ran, "a replica that loses the lock must not reconcile")
	assert.GreaterOrEqual(t, locker.calls, 2, "the losing replica must keep retrying the lock each interval")
}

type fakeReconcileLockTx struct {
	pgx.Tx
	acquired   bool
	lockSQL    string
	rolledBack bool
}

func (tx *fakeReconcileLockTx) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	tx.lockSQL = sql
	return mockRepoConnectionRow{scanFn: func(dest ...any) error {
		*(dest[0].(*bool)) = tx.acquired
		return nil
	}}
}

func (tx *fakeReconcileLockTx) Rollback(context.Context) error {
	tx.rolledBack = true
	return nil
}

type fakeReconcileLockBeginner struct{ tx *fakeReconcileLockTx }

func (b fakeReconcileLockBeginner) Begin(context.Context) (pgx.Tx, error) { return b.tx, nil }

func TestPgGitHubAppReconcileLocker_RunsOnlyWhenLockAcquired(t *testing.T) {
	for _, acquired := range []bool{true, false} {
		tx := &fakeReconcileLockTx{acquired: acquired}
		locker := NewPgGitHubAppReconcileLocker(fakeReconcileLockBeginner{tx: tx})
		called := false
		ran, err := locker.TryWithLock(context.Background(), func(context.Context) error {
			called = true
			return nil
		})
		require.NoError(t, err)
		assert.Equal(t, acquired, ran)
		assert.Equal(t, acquired, called)
		assert.Contains(t, tx.lockSQL, "pg_try_advisory_xact_lock")
		assert.True(t, tx.rolledBack, "the lock transaction must be released")
	}
}

// Two workers sharing one database: only the lock holder reconciles, and the
// lock is free again as soon as its transaction ends.
func TestPgGitHubAppReconcileLocker_PostgresElectsOneWorker(t *testing.T) {
	pool := getAgentTestPool(t)
	first, second := NewPgGitHubAppReconcileLocker(pool), NewPgGitHubAppReconcileLocker(pool)
	ctx := context.Background()
	ran, err := first.TryWithLock(ctx, func(ctx context.Context) error {
		contended, err := second.TryWithLock(ctx, func(context.Context) error {
			t.Error("a second worker reconciled while the first held the lock")
			return nil
		})
		require.NoError(t, err)
		assert.False(t, contended)
		return nil
	})
	require.NoError(t, err)
	require.True(t, ran)
	ran, err = second.TryWithLock(ctx, func(context.Context) error { return nil })
	require.NoError(t, err)
	assert.True(t, ran, "the lock must be released with its transaction")
}

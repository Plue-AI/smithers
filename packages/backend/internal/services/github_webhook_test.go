package services

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type mockGitHubWebhookDB struct {
	execFn func(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
}

func (m *mockGitHubWebhookDB) Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error) {
	if m.execFn != nil {
		return m.execFn(ctx, sql, arguments...)
	}
	return pgconn.NewCommandTag(""), nil
}

func TestGitHubWebhookService_HandleGitHubWebhook_InvalidSignature(t *testing.T) {
	t.Parallel()

	callCount := 0
	svc := newTestGitHubWebhookService(&mockGitHubWebhookDB{
		execFn: func(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error) {
			callCount++
			return pgconn.NewCommandTag(""), nil
		},
	}, "webhook-secret")

	err := svc.HandleGitHubWebhook(
		context.Background(),
		uuid.NewString(),
		"push",
		"sha256=deadbeef",
		[]byte(`{"repository":{"id":1},"installation":{"id":2}}`),
	)
	require.Error(t, err)
	assertGitHubWebhookAPIErrorStatus(t, err, 401)
	assert.Equal(t, 0, callCount, "DB should not be touched for invalid signatures")
}

func TestGitHubWebhookService_HandleGitHubWebhook_UnsupportedEventIsNoOp(t *testing.T) {
	t.Parallel()

	callCount := 0
	svc := newTestGitHubWebhookService(&mockGitHubWebhookDB{
		execFn: func(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error) {
			callCount++
			return pgconn.NewCommandTag(""), nil
		},
	}, "webhook-secret")

	payload := []byte(`{"action":"created","repository":{"id":1},"installation":{"id":2}}`)
	err := svc.HandleGitHubWebhook(
		context.Background(),
		uuid.NewString(),
		"fork",
		signGitHubWebhookForTest(payload, "webhook-secret"),
		payload,
	)
	require.NoError(t, err)
	assert.Equal(t, 0, callCount, "unsupported events should not write queue rows")
}

func TestGitHubWebhookService_HandleGitHubWebhook_PushEnqueuesJob(t *testing.T) {
	t.Parallel()

	payload := []byte(`{"repository":{"id":99},"installation":{"id":123}}`)
	calls := 0
	svc := newTestGitHubWebhookService(&mockGitHubWebhookDB{
		execFn: func(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error) {
			calls++
			assert.True(t, strings.Contains(sql, "INSERT INTO github_webhook_jobs"))
			require.Len(t, arguments, 6)
			assert.Equal(t, "push", arguments[1])
			assert.Equal(t, "", arguments[2])
			assert.Equal(t, int64(123), arguments[3])
			assert.Equal(t, int64(99), arguments[4])
			assert.Equal(t, string(payload), arguments[5])
			return pgconn.NewCommandTag("INSERT 1"), nil
		},
	}, "webhook-secret")

	err := svc.HandleGitHubWebhook(
		context.Background(),
		uuid.NewString(),
		"push",
		signGitHubWebhookForTest(payload, "webhook-secret"),
		payload,
	)
	require.NoError(t, err)
	assert.Equal(t, 1, calls)
}

func TestGitHubWebhookService_HandleGitHubWebhook_SupportedAsyncEventsEnqueue(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name   string
		event  string
		action string
	}{
		{name: "pull request", event: "pull_request", action: "opened"},
		{name: "pull request review", event: "pull_request_review", action: "submitted"},
		{name: "review comment", event: "pull_request_review_comment", action: "created"},
		{name: "check suite", event: "check_suite", action: "requested"},
		{name: "check run", event: "check_run", action: "created"},
	}

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			payload := []byte(fmt.Sprintf(
				`{"action":"%s","repository":{"id":99},"installation":{"id":123}}`,
				tc.action,
			))

			calls := 0
			svc := newTestGitHubWebhookService(&mockGitHubWebhookDB{
				execFn: func(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error) {
					calls++
					assert.True(t, strings.Contains(sql, "INSERT INTO github_webhook_jobs"))
					require.Len(t, arguments, 6)
					assert.Equal(t, tc.event, arguments[1])
					assert.Equal(t, tc.action, arguments[2])
					assert.Equal(t, int64(123), arguments[3])
					assert.Equal(t, int64(99), arguments[4])
					assert.Equal(t, string(payload), arguments[5])
					return pgconn.NewCommandTag("INSERT 1"), nil
				},
			}, "webhook-secret")

			err := svc.HandleGitHubWebhook(
				context.Background(),
				uuid.NewString(),
				tc.event,
				signGitHubWebhookForTest(payload, "webhook-secret"),
				payload,
			)
			require.NoError(t, err)
			assert.Equal(t, 1, calls)
		})
	}
}

func TestGitHubWebhookService_HandleGitHubWebhook_InstallationCreatedStoresMappings(t *testing.T) {
	t.Parallel()

	payload := []byte(`{
		"action":"created",
		"installation":{"id":777,"repository_selection":"selected","account":{"login":"AcmeOrg","type":"Organization"}},
		"repositories":[{"id":1001,"name":"demo","full_name":"AcmeOrg/demo","private":true,"owner":{"login":"AcmeOrg"}}]
	}`)

	var callOrder []string
	svc := newTestGitHubWebhookService(&mockGitHubWebhookDB{
		execFn: func(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error) {
			switch {
			case strings.Contains(sql, "INSERT INTO github_app_installations"):
				callOrder = append(callOrder, "upsert-installation")
			case strings.Contains(sql, "DELETE FROM github_app_installation_repositories"):
				callOrder = append(callOrder, "reset-installation-repos")
			case strings.Contains(sql, "INSERT INTO github_app_installation_repositories"):
				callOrder = append(callOrder, "upsert-installation-repo")
			case strings.Contains(sql, "INSERT INTO github_webhook_jobs"):
				callOrder = append(callOrder, "enqueue")
			default:
				t.Fatalf("unexpected SQL: %s", sql)
			}
			return pgconn.NewCommandTag("INSERT 1"), nil
		},
	}, "webhook-secret")

	err := svc.HandleGitHubWebhook(
		context.Background(),
		uuid.NewString(),
		"installation",
		signGitHubWebhookForTest(payload, "webhook-secret"),
		payload,
	)
	require.NoError(t, err)
	assert.Equal(t, []string{
		"enqueue",
		"upsert-installation",
		"reset-installation-repos",
		"upsert-installation-repo",
	}, callOrder, "the replay-dedup guard row must be inserted before installation side effects")
}

func TestGitHubWebhookService_HandleGitHubWebhook_InstallationDeletedCleansUp(t *testing.T) {
	t.Parallel()

	payload := []byte(`{
		"action":"deleted",
		"installation":{"id":888,"account":{"login":"AcmeOrg","type":"Organization"}}
	}`)

	var callOrder []string
	svc := newTestGitHubWebhookService(&mockGitHubWebhookDB{
		execFn: func(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error) {
			switch {
			case strings.Contains(sql, "DELETE FROM github_app_installations"):
				callOrder = append(callOrder, "delete-installation")
			case strings.Contains(sql, "INSERT INTO github_webhook_jobs"):
				callOrder = append(callOrder, "enqueue")
			default:
				t.Fatalf("unexpected SQL: %s", sql)
			}
			return pgconn.NewCommandTag("DELETE 1"), nil
		},
	}, "webhook-secret")

	err := svc.HandleGitHubWebhook(
		context.Background(),
		uuid.NewString(),
		"installation",
		signGitHubWebhookForTest(payload, "webhook-secret"),
		payload,
	)
	require.NoError(t, err)
	assert.Equal(t, []string{"enqueue", "delete-installation"}, callOrder)
}

// A suspend/unsuspend installation event must evict any cached installation
// token on the receiving pod so a revoked token is not served for the rest of
// its ~1h lifetime. (Not parallel: the token cache is a package global.)
func TestGitHubWebhookService_HandleGitHubWebhook_InstallationSuspendEvictsTokenCache(t *testing.T) {
	const instID = int64(919191)
	storeCachedInstallationToken(instID, "ghs_cached", time.Now().Add(time.Hour))
	t.Cleanup(func() { invalidateCachedInstallationToken(instID) })
	if _, ok := getCachedInstallationToken(instID); !ok {
		t.Fatal("precondition: token should be cached")
	}

	payload := []byte(`{
		"action":"suspend",
		"installation":{"id":919191,"account":{"login":"AcmeOrg","type":"Organization"}}
	}`)
	svc := newTestGitHubWebhookService(&mockGitHubWebhookDB{
		execFn: func(_ context.Context, _ string, _ ...any) (pgconn.CommandTag, error) {
			return pgconn.NewCommandTag("INSERT 1"), nil
		},
	}, "webhook-secret")

	err := svc.HandleGitHubWebhook(
		context.Background(),
		uuid.NewString(),
		"installation",
		signGitHubWebhookForTest(payload, "webhook-secret"),
		payload,
	)
	require.NoError(t, err)
	_, ok := getCachedInstallationToken(instID)
	assert.False(t, ok, "a suspend event must evict the cached installation token")
}

func TestGitHubWebhookService_HandleGitHubWebhook_InstallationRepositoriesEvictsCachedToken(t *testing.T) {
	const instID = int64(929292)
	storeCachedInstallationToken(instID, "ghs_stale_grant_set", time.Now().Add(time.Hour))
	t.Cleanup(func() { invalidateCachedInstallationToken(instID) })

	payload := []byte(`{
		"action":"added",
		"installation":{"id":929292,"repository_selection":"selected","account":{"login":"AcmeOrg","type":"Organization"}},
		"repositories_added":[{"id":3003,"name":"repo-added","owner":{"login":"AcmeOrg"}}]
	}`)
	svc := newTestGitHubWebhookService(&mockGitHubWebhookDB{
		execFn: func(_ context.Context, _ string, _ ...any) (pgconn.CommandTag, error) {
			return pgconn.NewCommandTag("INSERT 1"), nil
		},
	}, "webhook-secret")

	err := svc.HandleGitHubWebhook(
		context.Background(),
		uuid.NewString(),
		"installation_repositories",
		signGitHubWebhookForTest(payload, "webhook-secret"),
		payload,
	)
	require.NoError(t, err)
	_, ok := getCachedInstallationToken(instID)
	assert.False(t, ok, "a repository grant change must evict the cached installation token")
}

func TestGitHubWebhookService_HandleGitHubWebhook_InstallationRepositoriesAddedAndRemoved(t *testing.T) {
	t.Parallel()

	addedPayload := []byte(`{
		"action":"added",
		"installation":{"id":321,"repository_selection":"selected","account":{"login":"AcmeOrg","type":"Organization"}},
		"repositories_added":[{"id":2002,"name":"repo-added","owner":{"login":"AcmeOrg"}}]
	}`)
	removedPayload := []byte(`{
		"action":"removed",
		"installation":{"id":321,"account":{"login":"AcmeOrg","type":"Organization"}},
		"repositories_removed":[{"id":2002,"name":"repo-added","owner":{"login":"AcmeOrg"}}]
	}`)

	var callOrder []string
	svc := newTestGitHubWebhookService(&mockGitHubWebhookDB{
		execFn: func(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error) {
			switch {
			case strings.Contains(sql, "INSERT INTO github_app_installations"):
				callOrder = append(callOrder, "upsert-installation")
			case strings.Contains(sql, "INSERT INTO github_app_installation_repositories"):
				callOrder = append(callOrder, "upsert-installation-repo")
			case strings.Contains(sql, "DELETE FROM github_app_installation_repositories"):
				callOrder = append(callOrder, "delete-installation-repo")
			case strings.Contains(sql, "INSERT INTO github_webhook_jobs"):
				callOrder = append(callOrder, "enqueue")
			default:
				t.Fatalf("unexpected SQL: %s", sql)
			}
			return pgconn.NewCommandTag("INSERT 1"), nil
		},
	}, "webhook-secret")

	err := svc.HandleGitHubWebhook(
		context.Background(),
		uuid.NewString(),
		"installation_repositories",
		signGitHubWebhookForTest(addedPayload, "webhook-secret"),
		addedPayload,
	)
	require.NoError(t, err)

	err = svc.HandleGitHubWebhook(
		context.Background(),
		uuid.NewString(),
		"installation_repositories",
		signGitHubWebhookForTest(removedPayload, "webhook-secret"),
		removedPayload,
	)
	require.NoError(t, err)

	assert.Equal(t, []string{
		"enqueue",
		"upsert-installation",
		"upsert-installation-repo",
		"enqueue",
		"delete-installation-repo",
	}, callOrder)
}

func assertGitHubWebhookAPIErrorStatus(t *testing.T, err error, expectedStatus int) {
	t.Helper()
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, expectedStatus, apiErr.Status)
}

func signGitHubWebhookForTest(payload []byte, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(payload)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

// mockTxGitHubWebhookDB is a transaction-capable mockGitHubWebhookDB: Begin
// returns a fake pgx.Tx whose Exec is routed back through execFn.
type mockTxGitHubWebhookDB struct {
	mockGitHubWebhookDB
	tx *fakeGitHubWebhookTx
}

func (m *mockTxGitHubWebhookDB) Begin(ctx context.Context) (pgx.Tx, error) {
	m.tx = &fakeGitHubWebhookTx{execFn: m.execFn}
	return m.tx, nil
}

type fakeGitHubWebhookTx struct {
	pgx.Tx // embedded interface; unstubbed methods panic if called
	execFn func(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)

	execCount  int
	committed  bool
	rolledBack bool
}

func (t *fakeGitHubWebhookTx) Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error) {
	t.execCount++
	if t.execFn != nil {
		return t.execFn(ctx, sql, arguments...)
	}
	return pgconn.NewCommandTag("INSERT 1"), nil
}

func (t *fakeGitHubWebhookTx) Commit(ctx context.Context) error {
	t.committed = true
	return nil
}

func (t *fakeGitHubWebhookTx) Rollback(ctx context.Context) error {
	if !t.committed {
		t.rolledBack = true
	}
	return nil
}

// Regression: the installation_repositories "added" path wrote the
// installation and its repository mappings directly on the pool, so a partial
// failure left inconsistent state. It must run in a transaction like
// applyInstallationCreated.
func TestGitHubWebhookService_InstallationRepositoriesAdded_UsesTransaction(t *testing.T) {
	t.Parallel()

	addedPayload := []byte(`{
		"action":"added",
		"installation":{"id":321,"repository_selection":"selected","account":{"login":"AcmeOrg","type":"Organization"}},
		"repositories_added":[
			{"id":2002,"name":"repo-a","owner":{"login":"AcmeOrg"}},
			{"id":2003,"name":"repo-b","owner":{"login":"AcmeOrg"}}
		]
	}`)

	t.Run("success commits all writes on the transaction", func(t *testing.T) {
		t.Parallel()
		mock := &mockTxGitHubWebhookDB{}
		mock.execFn = func(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error) {
			return pgconn.NewCommandTag("INSERT 1"), nil
		}
		svc := newTestGitHubWebhookService(mock, "webhook-secret")

		err := svc.HandleGitHubWebhook(
			context.Background(),
			uuid.NewString(),
			"installation_repositories",
			signGitHubWebhookForTest(addedPayload, "webhook-secret"),
			addedPayload,
		)
		require.NoError(t, err)
		require.NotNil(t, mock.tx, "the added path must begin a transaction")
		assert.True(t, mock.tx.committed)
		assert.False(t, mock.tx.rolledBack)
		// enqueue guard + upsert installation + 2 repository upserts all on the tx.
		assert.Equal(t, 4, mock.tx.execCount)
	})

	t.Run("mid-way failure rolls back", func(t *testing.T) {
		t.Parallel()
		mock := &mockTxGitHubWebhookDB{}
		call := 0
		mock.execFn = func(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error) {
			call++
			if call == 4 { // fail on the second repository upsert (after enqueue + installation + first repo)
				return pgconn.CommandTag{}, fmt.Errorf("boom")
			}
			return pgconn.NewCommandTag("INSERT 1"), nil
		}
		svc := newTestGitHubWebhookService(mock, "webhook-secret")

		err := svc.HandleGitHubWebhook(
			context.Background(),
			uuid.NewString(),
			"installation_repositories",
			signGitHubWebhookForTest(addedPayload, "webhook-secret"),
			addedPayload,
		)
		require.Error(t, err)
		require.NotNil(t, mock.tx)
		assert.False(t, mock.tx.committed)
		assert.True(t, mock.tx.rolledBack, "a partial failure must roll the transaction back")
	})
}

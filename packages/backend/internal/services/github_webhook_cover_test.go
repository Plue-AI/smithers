package services

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type githubWebhookCovTxDB struct {
	execFn    func(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
	beginErr  error
	commitErr error
	tx        *githubWebhookCovTx
}

func (db *githubWebhookCovTxDB) Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error) {
	if db.execFn != nil {
		return db.execFn(ctx, sql, arguments...)
	}
	return pgconn.NewCommandTag("OK"), nil
}

func (db *githubWebhookCovTxDB) Begin(context.Context) (pgx.Tx, error) {
	if db.beginErr != nil {
		return nil, db.beginErr
	}
	db.tx = &githubWebhookCovTx{execFn: db.execFn, commitErr: db.commitErr}
	return db.tx, nil
}

type githubWebhookCovTx struct {
	pgx.Tx
	execFn     func(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
	commitErr  error
	committed  bool
	rolledBack bool
}

func (tx *githubWebhookCovTx) Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error) {
	if tx.execFn != nil {
		return tx.execFn(ctx, sql, arguments...)
	}
	return pgconn.NewCommandTag("OK"), nil
}

func (tx *githubWebhookCovTx) Commit(context.Context) error {
	tx.committed = true
	return tx.commitErr
}

func (tx *githubWebhookCovTx) Rollback(context.Context) error {
	if !tx.committed {
		tx.rolledBack = true
	}
	return nil
}

func TestGitHubWebhook_Cov_ConfigAndPayloadErrors(t *testing.T) {
	ctx := context.Background()
	payload := []byte(`{"repository":{"id":1},"installation":{"id":2}}`)
	signature := signGitHubWebhookForTest(payload, "secret")

	var nilSvc *GitHubWebhookService
	err := nilSvc.HandleGitHubWebhook(ctx, "delivery", "push", signature, payload)
	require.Error(t, err)
	assertGitHubWebhookAPIErrorStatus(t, err, 500)

	err = newTestGitHubWebhookService(nil, "secret").HandleGitHubWebhook(ctx, "delivery", "push", signature, payload)
	require.Error(t, err)
	assertGitHubWebhookAPIErrorStatus(t, err, 500)

	err = newTestGitHubWebhookService(&mockGitHubWebhookDB{}, " ").HandleGitHubWebhook(ctx, "delivery", "push", signature, payload)
	require.Error(t, err)
	assertGitHubWebhookAPIErrorStatus(t, err, 500)

	svc := newTestGitHubWebhookService(&mockGitHubWebhookDB{}, "secret")
	err = svc.HandleGitHubWebhook(ctx, "delivery", " ", signature, payload)
	require.Error(t, err)
	assertGitHubWebhookAPIErrorStatus(t, err, 400)

	err = svc.HandleGitHubWebhook(ctx, "not-a-uuid", "push", signature, payload)
	require.Error(t, err)
	assertGitHubWebhookAPIErrorStatus(t, err, 400)

	badPayload := []byte(`{`)
	err = svc.HandleGitHubWebhook(ctx, "11111111-1111-1111-1111-111111111111", "push", signGitHubWebhookForTest(badPayload, "secret"), badPayload)
	require.Error(t, err)
	assertGitHubWebhookAPIErrorStatus(t, err, 400)

	enqueueErrSvc := newTestGitHubWebhookService(&mockGitHubWebhookDB{
		execFn: func(context.Context, string, ...any) (pgconn.CommandTag, error) {
			return pgconn.CommandTag{}, assert.AnError
		},
	}, "secret")
	err = enqueueErrSvc.HandleGitHubWebhook(ctx, "11111111-1111-1111-1111-111111111111", "push", signature, payload)
	require.Error(t, err)
	assertGitHubWebhookAPIErrorStatus(t, err, 500)
}

func TestGitHubWebhook_Cov_HelperAndPersistenceBranches(t *testing.T) {
	ctx := context.Background()
	payload := []byte(`{"ok":true}`)
	signature := signGitHubWebhookForTest(payload, "secret")
	assert.True(t, verifyGitHubWebhookSignature(payload, " SHA256="+strings.TrimPrefix(signature, "sha256=")+" ", " secret "))
	assert.False(t, verifyGitHubWebhookSignature(payload, "", "secret"))
	assert.False(t, verifyGitHubWebhookSignature(payload, "sha1=abcd", "secret"))
	assert.False(t, verifyGitHubWebhookSignature(payload, "sha256=not-hex", "secret"))
	assert.False(t, verifyGitHubWebhookSignature(payload, signature, ""))

	assert.Zero(t, gitHubWebhookEnvelope{}.installationID())
	assert.Zero(t, gitHubWebhookEnvelope{}.repositoryID())
	assert.Nil(t, nullableInt64(0))
	assert.Equal(t, int64(7), nullableInt64(7))

	svc := newTestGitHubWebhookService(&mockGitHubWebhookDB{}, "secret")
	err := svc.upsertInstallation(ctx, &mockGitHubWebhookDB{}, 1, gitHubWebhookEnvelope{})
	require.Error(t, err)
	assertGitHubWebhookAPIErrorStatus(t, err, 400)
	err = svc.handleInstallationEvent(ctx, svc.db, "created", gitHubWebhookEnvelope{})
	require.Error(t, err)
	assertGitHubWebhookAPIErrorStatus(t, err, 400)

	execCalls := 0
	captureDB := &mockGitHubWebhookDB{
		execFn: func(_ context.Context, sql string, arguments ...any) (pgconn.CommandTag, error) {
			execCalls++
			assert.Contains(t, sql, "INSERT INTO github_app_installation_repositories")
			assert.Equal(t, int64(99), arguments[1])
			assert.Equal(t, "Acme", arguments[2])
			assert.Equal(t, "acme", arguments[3])
			assert.Equal(t, "Repo", arguments[4])
			assert.Equal(t, "repo", arguments[5])
			assert.Equal(t, true, arguments[6])
			return pgconn.NewCommandTag("INSERT 1"), nil
		},
	}
	require.NoError(t, svc.upsertInstallationRepository(ctx, captureDB, 10, gitHubWebhookRepository{ID: 0}))
	require.NoError(t, svc.upsertInstallationRepository(ctx, captureDB, 10, gitHubWebhookRepository{ID: 98}))
	require.NoError(t, svc.upsertInstallationRepository(ctx, captureDB, 10, gitHubWebhookRepository{ID: 99, FullName: " Acme/Repo ", Private: true}))
	assert.Equal(t, 1, execCalls)

	err = svc.upsertInstallationRepository(ctx, &mockGitHubWebhookDB{
		execFn: func(context.Context, string, ...any) (pgconn.CommandTag, error) {
			return pgconn.CommandTag{}, assert.AnError
		},
	}, 10, gitHubWebhookRepository{ID: 100, Name: "demo", Owner: gitHubWebhookRepoOwner{Login: "Acme"}})
	require.Error(t, err)
	assertGitHubWebhookAPIErrorStatus(t, err, 500)

	deleteSvc := newTestGitHubWebhookService(&mockGitHubWebhookDB{
		execFn: func(context.Context, string, ...any) (pgconn.CommandTag, error) {
			return pgconn.CommandTag{}, assert.AnError
		},
	}, "secret")
	err = deleteSvc.handleInstallationEvent(ctx, deleteSvc.db, "deleted", githubWebhookCovEnvelope(22))
	require.Error(t, err)
	assertGitHubWebhookAPIErrorStatus(t, err, 500)

	err = svc.handleInstallationRepositoriesEvent(ctx, svc.db, "removed", githubWebhookCovEnvelope(33))
	require.NoError(t, err)
	err = deleteSvc.handleInstallationRepositoriesEvent(ctx, deleteSvc.db, "removed", gitHubWebhookEnvelope{
		Installation:        githubWebhookCovEnvelope(33).Installation,
		RepositoriesRemoved: []gitHubWebhookRepository{{ID: 44, Name: "demo", Owner: gitHubWebhookRepoOwner{Login: "Acme"}}},
	})
	require.Error(t, err)
	assertGitHubWebhookAPIErrorStatus(t, err, 500)
}

func TestGitHubWebhook_Cov_TransactionFailures(t *testing.T) {
	ctx := context.Background()
	createdPayload := []byte(`{
		"action":"created",
		"installation":{"id":55,"repository_selection":"selected","account":{"login":"Acme","type":"Organization"}},
		"repositories":[{"id":66,"name":"demo","owner":{"login":"Acme"}}]
	}`)
	createdSig := signGitHubWebhookForTest(createdPayload, "secret")
	insertOK := func(context.Context, string, ...any) (pgconn.CommandTag, error) {
		return pgconn.NewCommandTag("INSERT 1"), nil
	}
	handleCreated := func(db GitHubWebhookDB) error {
		return newTestGitHubWebhookService(db, "secret").HandleGitHubWebhook(ctx, "11111111-1111-1111-1111-111111111111", "installation", createdSig, createdPayload)
	}

	beginDB := &githubWebhookCovTxDB{beginErr: assert.AnError, execFn: insertOK}
	err := handleCreated(beginDB)
	require.Error(t, err)
	assertGitHubWebhookAPIErrorStatus(t, err, 500)

	commitDB := &githubWebhookCovTxDB{commitErr: assert.AnError, execFn: insertOK}
	err = handleCreated(commitDB)
	require.Error(t, err)
	assertGitHubWebhookAPIErrorStatus(t, err, 500)
	require.NotNil(t, commitDB.tx)
	assert.True(t, commitDB.tx.committed)

	failOnRepo := &githubWebhookCovTxDB{}
	call := 0
	failOnRepo.execFn = func(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
		call++
		if strings.Contains(sql, "INSERT INTO github_app_installation_repositories") {
			return pgconn.CommandTag{}, assert.AnError
		}
		return pgconn.NewCommandTag("INSERT 1"), nil
	}
	err = handleCreated(failOnRepo)
	require.Error(t, err)
	assertGitHubWebhookAPIErrorStatus(t, err, 500)
	require.NotNil(t, failOnRepo.tx)
	assert.True(t, failOnRepo.tx.rolledBack)
	assert.Equal(t, 4, call, "enqueue guard, installation upsert, repo reset, repo upsert")

	// Replay/dedup: when the guard row already exists (enqueue affects 0 rows)
	// the delivery is a duplicate and must not run any installation side
	// effects or commit — regression for signed-body replay under a fresh
	// delivery id.
	duplicateDB := &githubWebhookCovTxDB{}
	duplicateCalls := 0
	duplicateDB.execFn = func(context.Context, string, ...any) (pgconn.CommandTag, error) {
		duplicateCalls++
		return pgconn.NewCommandTag("INSERT 0"), nil
	}
	require.NoError(t, handleCreated(duplicateDB))
	assert.Equal(t, 1, duplicateCalls, "duplicate delivery must stop at the guard insert")
	require.NotNil(t, duplicateDB.tx)
	assert.False(t, duplicateDB.tx.committed)
	assert.True(t, duplicateDB.tx.rolledBack)

	addedPayload := []byte(`{
		"action":"added",
		"installation":{"id":55,"repository_selection":"selected","account":{"login":"Acme","type":"Organization"}},
		"repositories_added":[{"id":77,"name":"added","owner":{"login":"Acme"}}]
	}`)
	err = newTestGitHubWebhookService(&mockGitHubWebhookDB{
		execFn: func(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
			if strings.Contains(sql, "INSERT INTO github_app_installations ") {
				return pgconn.CommandTag{}, assert.AnError
			}
			return pgconn.NewCommandTag("INSERT 1"), nil
		},
	}, "secret").HandleGitHubWebhook(ctx, "11111111-1111-1111-1111-111111111111", "installation_repositories", signGitHubWebhookForTest(addedPayload, "secret"), addedPayload)
	require.Error(t, err)
	assertGitHubWebhookAPIErrorStatus(t, err, 500)
}

func githubWebhookCovEnvelope(id int64) gitHubWebhookEnvelope {
	return gitHubWebhookEnvelope{
		Installation: &gitHubWebhookInstallation{
			ID:      id,
			Account: gitHubWebhookAccountInfo{Login: "Acme", Type: "Organization"},
		},
	}
}

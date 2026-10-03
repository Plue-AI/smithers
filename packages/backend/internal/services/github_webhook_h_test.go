package services

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type githubWebhookHBeginDB struct {
	mockGitHubWebhookDB
	beginErr  error
	commitErr error
	tx        *githubWebhookHTx
}

func (db *githubWebhookHBeginDB) Begin(context.Context) (pgx.Tx, error) {
	if db.beginErr != nil {
		return nil, db.beginErr
	}
	db.tx = &githubWebhookHTx{execFn: db.execFn, commitErr: db.commitErr}
	return db.tx, nil
}

type githubWebhookHTx struct {
	pgx.Tx
	execFn    func(context.Context, string, ...any) (pgconn.CommandTag, error)
	commitErr error
}

func (tx *githubWebhookHTx) Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error) {
	if tx.execFn != nil {
		return tx.execFn(ctx, sql, arguments...)
	}
	return pgconn.NewCommandTag("INSERT 1"), nil
}

func (tx *githubWebhookHTx) Commit(context.Context) error   { return tx.commitErr }
func (tx *githubWebhookHTx) Rollback(context.Context) error { return nil }

func TestGitHubWebhook_H_HandleInputAndQueueErrors(t *testing.T) {
	ctx := context.Background()
	payload := []byte(`{"repository":{"id":1},"installation":{"id":2}}`)

	err := (*GitHubWebhookService)(nil).HandleGitHubWebhook(ctx, uuid.NewString(), "push", "sig", payload)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	err = newTestGitHubWebhookService(&mockGitHubWebhookDB{}, "").HandleGitHubWebhook(ctx, uuid.NewString(), "push", "sig", payload)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	svc := newTestGitHubWebhookService(&mockGitHubWebhookDB{}, "secret")
	err = svc.HandleGitHubWebhook(ctx, uuid.NewString(), " ", signGitHubWebhookForTest(payload, "secret"), payload)
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	err = svc.HandleGitHubWebhook(ctx, "not-a-uuid", "push", signGitHubWebhookForTest(payload, "secret"), payload)
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	installationPayload := []byte(`{"action":"deleted","installation":{"id":2}}`)
	err = svc.HandleGitHubWebhook(ctx, uuid.NewString(), "installation", signGitHubWebhookForTest(installationPayload, "secret"), installationPayload)
	require.NoError(t, err)

	badJSON := []byte(`{`)
	err = svc.HandleGitHubWebhook(ctx, uuid.NewString(), "push", signGitHubWebhookForTest(badJSON, "secret"), badJSON)
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	svc = newTestGitHubWebhookService(&mockGitHubWebhookDB{
		execFn: func(context.Context, string, ...any) (pgconn.CommandTag, error) {
			return pgconn.CommandTag{}, errors.New("enqueue failed")
		},
	}, "secret")
	err = svc.HandleGitHubWebhook(ctx, uuid.NewString(), "push", signGitHubWebhookForTest(payload, "secret"), payload)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	assert.False(t, verifyGitHubWebhookSignature(payload, "sha1=abc", "secret"))
	assert.False(t, verifyGitHubWebhookSignature(payload, "sha256=not-hex", "secret"))
}

func TestGitHubWebhook_H_InstallationPersistenceBranches(t *testing.T) {
	ctx := context.Background()
	envelope := gitHubWebhookEnvelope{
		Installation: &gitHubWebhookInstallation{
			ID:                  123,
			RepositorySelection: "selected",
			Account:             gitHubWebhookAccountInfo{Login: "Acme", Type: "Organization"},
		},
		Repositories: []gitHubWebhookRepository{{ID: 1, Name: "repo", Owner: gitHubWebhookRepoOwner{Login: "Acme"}}},
	}

	createdPayload := []byte(`{
		"action":"created",
		"installation":{"id":123,"repository_selection":"selected","account":{"login":"Acme","type":"Organization"}},
		"repositories":[{"id":1,"name":"repo","owner":{"login":"Acme"}}]
	}`)
	handleCreated := func(db GitHubWebhookDB) error {
		return newTestGitHubWebhookService(db, "secret").HandleGitHubWebhook(ctx, uuid.NewString(), "installation", signGitHubWebhookForTest(createdPayload, "secret"), createdPayload)
	}
	insertOK := func(context.Context, string, ...any) (pgconn.CommandTag, error) {
		return pgconn.NewCommandTag("INSERT 1"), nil
	}

	err := handleCreated(&githubWebhookHBeginDB{beginErr: errors.New("begin failed")})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	err = handleCreated(&githubWebhookHBeginDB{
		mockGitHubWebhookDB: mockGitHubWebhookDB{execFn: insertOK},
		commitErr:           errors.New("commit failed"),
	})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	require.NoError(t, handleCreated(&githubWebhookHBeginDB{
		mockGitHubWebhookDB: mockGitHubWebhookDB{execFn: insertOK},
	}))

	svc := newTestGitHubWebhookService(&mockGitHubWebhookDB{}, "secret")
	require.NoError(t, svc.replaceInstallationRepositories(ctx, svc.db, 123, envelope))

	svc = newTestGitHubWebhookService(&mockGitHubWebhookDB{
		execFn: func(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
			if strings.Contains(sql, "DELETE FROM github_app_installation_repositories") {
				return pgconn.CommandTag{}, errors.New("reset failed")
			}
			return pgconn.NewCommandTag("INSERT 1"), nil
		},
	}, "secret")
	err = svc.replaceInstallationRepositories(ctx, svc.db, 123, envelope)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	svc = newTestGitHubWebhookService(&mockGitHubWebhookDB{
		execFn: func(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
			if strings.Contains(sql, "github_app_installation_repositories") && strings.Contains(sql, "INSERT") {
				return pgconn.CommandTag{}, errors.New("repo failed")
			}
			return pgconn.NewCommandTag("INSERT 1"), nil
		},
	}, "secret")
	err = svc.replaceInstallationRepositories(ctx, svc.db, 123, envelope)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	err = svc.upsertInstallation(ctx, svc.db, 123, gitHubWebhookEnvelope{})
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	addedPayload := []byte(`{
		"action":"added",
		"installation":{"id":123,"repository_selection":"selected","account":{"login":"Acme","type":"Organization"}},
		"repositories_added":[{"id":5,"name":"new","owner":{"login":"Acme"}}]
	}`)
	handleAdded := func(db GitHubWebhookDB) error {
		return newTestGitHubWebhookService(db, "secret").HandleGitHubWebhook(ctx, uuid.NewString(), "installation_repositories", signGitHubWebhookForTest(addedPayload, "secret"), addedPayload)
	}

	err = handleAdded(&githubWebhookHBeginDB{beginErr: errors.New("begin failed")})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	err = handleAdded(&githubWebhookHBeginDB{
		mockGitHubWebhookDB: mockGitHubWebhookDB{execFn: insertOK},
		commitErr:           errors.New("commit failed"),
	})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	require.NoError(t, handleAdded(&githubWebhookHBeginDB{
		mockGitHubWebhookDB: mockGitHubWebhookDB{execFn: insertOK},
	}))
}

func TestGitHubWebhook_H_RepositoryEventAndHelperBranches(t *testing.T) {
	ctx := context.Background()
	svc := newTestGitHubWebhookService(&mockGitHubWebhookDB{}, "secret")

	err := svc.handleInstallationRepositoriesEvent(ctx, svc.db, "added", gitHubWebhookEnvelope{})
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	deleteCalls := 0
	svc = newTestGitHubWebhookService(&mockGitHubWebhookDB{
		execFn: func(context.Context, string, ...any) (pgconn.CommandTag, error) {
			deleteCalls++
			return pgconn.CommandTag{}, errors.New("delete failed")
		},
	}, "secret")
	err = svc.handleInstallationRepositoriesEvent(ctx, svc.db, "removed", gitHubWebhookEnvelope{
		Installation:        &gitHubWebhookInstallation{ID: 123},
		RepositoriesRemoved: []gitHubWebhookRepository{{ID: 0}, {ID: 99}},
	})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
	assert.Equal(t, 1, deleteCalls)

	err = svc.handleInstallationRepositoriesEvent(ctx, svc.db, "renamed", gitHubWebhookEnvelope{Installation: &gitHubWebhookInstallation{ID: 123}})
	require.NoError(t, err)

	upserts := 0
	svc = newTestGitHubWebhookService(&mockGitHubWebhookDB{
		execFn: func(context.Context, string, ...any) (pgconn.CommandTag, error) {
			upserts++
			return pgconn.NewCommandTag("INSERT 1"), nil
		},
	}, "secret")
	require.NoError(t, svc.upsertInstallationRepository(ctx, svc.db, 123, gitHubWebhookRepository{ID: 0}))
	require.NoError(t, svc.upsertInstallationRepository(ctx, svc.db, 123, gitHubWebhookRepository{ID: 1}))
	require.NoError(t, svc.upsertInstallationRepository(ctx, svc.db, 123, gitHubWebhookRepository{ID: 2, FullName: "Acme/Repo"}))
	assert.Equal(t, 1, upserts)
}

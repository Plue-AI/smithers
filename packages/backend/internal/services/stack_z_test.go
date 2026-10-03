package services

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

const stackZTooSmallRSAPrivateKey = `-----BEGIN RSA PRIVATE KEY-----
MIGrAgEAAiEAx+vsfPEJbd2hd/GRgjQERudJbzpSn5MQPSruNFMOUCkCAwEAAQIg
GfKa/RRjvui3HlQyKI4Lx9UMEajseZdTSVs2VpzvwmkCEQDLovhYu5/C5dzFN81S
p2RzAhEA+1RmepiMfV+/PwSJscdt8wIRAKx1fdwwMlJuN7Wy16nraC8CECl7f8Ki
ZSXYZNeA5z05nnMCEQCM59wSzPLYCH88FkOwAgXk
-----END RSA PRIVATE KEY-----`

func stackZOwnedRepo(userID int64) db.Repository {
	return db.Repository{ID: 42, Name: "demo", LowerName: "demo", UserID: pgtype.Int8{Int64: userID, Valid: true}}
}

func TestStack_Z_ServiceAccessAndDeleteErrors(t *testing.T) {
	ctx := context.Background()
	actor := &db.User{ID: 7}

	_, err := newTestStackService(t, &mockStackQuerier{}).GetActiveStack(ctx, actor, "", "demo", "main")
	require.Error(t, err)
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))

	privateOrgRepo := db.Repository{ID: 42, OrgID: pgtype.Int8{Int64: 3, Valid: true}}
	_, err = newTestStackService(t, &mockStackQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return privateOrgRepo, nil
		},
		getHighestTeamPermissionForRepoUserFn: func(context.Context, db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
			return "", errors.New("team failed")
		},
	}).GetActiveStack(ctx, actor, "alice", "demo", "main")
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	_, err = newTestStackService(t, &mockStackQuerier{}).UpsertActiveStack(ctx, actor, "", "demo", UpsertActiveStackInput{})
	require.Error(t, err)
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))

	_, err = newTestStackService(t, &mockStackQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{ID: 42, UserID: pgtype.Int8{Int64: 99, Valid: true}}, nil
		},
	}).UpsertActiveStack(ctx, actor, "alice", "demo", UpsertActiveStackInput{Changes: []StackChangeInput{{ChangeID: "c1", BranchName: "b1"}}})
	require.Error(t, err)
	assert.Equal(t, http.StatusForbidden, apiStatus(t, err))

	err = newTestStackService(t, &mockStackQuerier{}).DeleteActiveStack(ctx, nil, "alice", "demo", "main")
	require.Error(t, err)
	assert.Equal(t, http.StatusUnauthorized, apiStatus(t, err))

	err = newTestStackService(t, &mockStackQuerier{}).DeleteActiveStack(ctx, actor, "", "demo", "main")
	require.Error(t, err)
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))

	err = newTestStackService(t, &mockStackQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{ID: 42, UserID: pgtype.Int8{Int64: 99, Valid: true}}, nil
		},
	}).DeleteActiveStack(ctx, actor, "alice", "demo", "main")
	require.Error(t, err)
	assert.Equal(t, http.StatusForbidden, apiStatus(t, err))

	err = newTestStackService(t, &mockStackQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return stackZOwnedRepo(actor.ID), nil
		},
		getActiveStackFn: func(context.Context, db.GetActiveStackParams) (db.Stack, error) {
			return db.Stack{}, errors.New("load failed")
		},
	}).DeleteActiveStack(ctx, actor, "alice", "demo", "main")
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
}

func TestStack_Z_DirectAccessHelpersAndGitHubState(t *testing.T) {
	ctx := context.Background()
	actor := &db.User{ID: 7}
	privateRepo := db.Repository{ID: 42, UserID: pgtype.Int8{Int64: 99, Valid: true}}

	svc := newTestStackService(t, &mockStackQuerier{})
	err := svc.requireReadAccess(ctx, privateRepo, actor)
	require.Error(t, err)
	assert.Equal(t, http.StatusForbidden, apiStatus(t, err))
	err = svc.requireWriteAccess(ctx, privateRepo, nil)
	require.Error(t, err)
	assert.Equal(t, http.StatusUnauthorized, apiStatus(t, err))

	err = newTestStackService(t, &mockStackQuerier{
		getCollaboratorPermissionForRepoUserFn: func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			return "", errors.New("permission failed")
		},
	}).requireWriteAccess(ctx, privateRepo, actor)
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	assert.Equal(t, "pending", aggregateStackCIStatus(nil))

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"message":"missing pull"}`, http.StatusNotFound)
	}))
	t.Cleanup(server.Close)
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)
	_, err = loadStackGitHubState(ctx, "token", "owner", "repo", 12)
	require.ErrorContains(t, err, "missing pull")
}

func TestStack_Z_GitHubTokenAndJSONErrorBranches(t *testing.T) {
	ctx := context.Background()

	setTestCallerCredentials(t, "ID", "123")
	setTestCallerCredentials(t, "PEM", stackZTooSmallRSAPrivateKey)
	_, err := newTestStackGitHubInstallationToken(t, ctx, 1)
	require.Error(t, err)

	setTestCallerCredentials(t, "PEM", generateStackTestRSAPrivateKeyPEM(t))
	t.Setenv(envGitHubAppAPIBaseURL, "http://[::1")
	_, err = newTestStackGitHubInstallationToken(t, ctx, 1)
	require.Error(t, err)

	closed := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	closedURL := closed.URL
	closed.Close()
	t.Setenv(envGitHubAppAPIBaseURL, closedURL)
	_, err = newTestStackGitHubInstallationToken(t, ctx, 1)
	require.Error(t, err)

	emptyMessage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(emptyMessage.Close)
	t.Setenv(envGitHubAppAPIBaseURL, emptyMessage.URL)
	_, err = newTestStackGitHubInstallationToken(t, ctx, 1)
	require.ErrorContains(t, err, "github installation token request failed")

	jsonClosed := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	jsonClosedURL := jsonClosed.URL
	jsonClosed.Close()
	t.Setenv(envGitHubAppAPIBaseURL, jsonClosedURL)
	err = callStackGitHubJSON(ctx, "token", "/path", nil)
	require.Error(t, err)

	jsonEmptyMessage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(jsonEmptyMessage.Close)
	t.Setenv(envGitHubAppAPIBaseURL, jsonEmptyMessage.URL)
	err = callStackGitHubJSON(ctx, "token", "/path", nil)
	require.ErrorContains(t, err, "github request failed: 418")
}

func TestStack_Z_UpsertAndDeleteSuccessAfterDeadPruneRemoval(t *testing.T) {
	ctx := context.Background()
	actor := &db.User{ID: 7}
	stack := stackHStack(actor.ID)
	q := &mockStackQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return stackZOwnedRepo(actor.ID), nil
		},
		upsertActiveStackFn: func(context.Context, db.UpsertActiveStackParams) (db.Stack, error) {
			return stack, nil
		},
		upsertStackChangeFn: func(context.Context, db.UpsertStackChangeParams) (db.StackChange, error) {
			return db.StackChange{}, nil
		},
		listStackChangesByStackFn: func(context.Context, int64) ([]db.StackChange, error) {
			return []db.StackChange{{StackID: stack.ID, ChangeID: "c1", BranchName: "b1"}}, nil
		},
	}
	_, err := newTestStackService(t, q).UpsertActiveStack(ctx, actor, "alice", "demo", UpsertActiveStackInput{
		Changes: []StackChangeInput{{ChangeID: "c1", BranchName: "b1"}},
	})
	require.NoError(t, err)
	assert.Equal(t, []string{"c1"}, q.lastDeleteStackChangesNotInSetArg.ChangeIds)

	q.getActiveStackFn = func(context.Context, db.GetActiveStackParams) (db.Stack, error) {
		return stack, nil
	}
	require.NoError(t, newTestStackService(t, q).DeleteActiveStack(ctx, actor, "alice", "demo", "main"))
	assert.Equal(t, stack.ID, q.lastDeleteAllStackChangesArg)
	assert.Equal(t, stack.ID, q.lastDeleteStackByIDArg)

	q.getActiveStackFn = func(context.Context, db.GetActiveStackParams) (db.Stack, error) {
		return db.Stack{}, pgx.ErrNoRows
	}
	require.NoError(t, newTestStackService(t, q).DeleteActiveStack(ctx, actor, "alice", "demo", "main"))
}

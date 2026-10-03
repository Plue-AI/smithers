package services

import (
	"context"
	"errors"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestStack_Cov_AccessPermissionsAndWriteErrors(t *testing.T) {
	ctx := context.Background()
	actor := &db.User{ID: 7, Username: "alice"}
	privateRepo := db.Repository{ID: 42, UserID: pgtype.Int8{Int64: actor.ID, Valid: true}, IsPublic: false}

	svc := newTestStackService(t, &mockStackQuerier{})
	_, err := svc.resolveRepo(ctx, "", "demo")
	require.Error(t, err)
	stackCovAssertAPIStatus(t, err, http.StatusBadRequest)
	_, err = svc.resolveRepo(ctx, "alice", "")
	require.Error(t, err)
	stackCovAssertAPIStatus(t, err, http.StatusBadRequest)

	svc = newTestStackService(t, &mockStackQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{}, pgx.ErrNoRows
		},
	})
	_, err = svc.resolveRepo(ctx, "alice", "missing")
	require.Error(t, err)
	stackCovAssertAPIStatus(t, err, http.StatusNotFound)

	svc = newTestStackService(t, &mockStackQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{}, errors.New("db down")
		},
	})
	_, err = svc.resolveRepo(ctx, "alice", "demo")
	require.Error(t, err)
	stackCovAssertAPIStatus(t, err, http.StatusInternalServerError)

	q := &mockStackQuerier{
		getCollaboratorPermissionForRepoUserFn: func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			return "", nil
		},
	}
	svc = newTestStackService(t, q)
	require.NoError(t, svc.requireReadAccess(ctx, db.Repository{IsPublic: true}, actor))
	err = svc.requireReadAccess(ctx, privateRepo, nil)
	require.Error(t, err)
	stackCovAssertAPIStatus(t, err, http.StatusUnauthorized)
	require.NoError(t, svc.requireWriteAccess(ctx, privateRepo, actor))
	err = svc.requireWriteAccess(ctx, privateRepo, &db.User{ID: 99})
	require.Error(t, err)
	stackCovAssertAPIStatus(t, err, http.StatusForbidden)

	orgRepo := db.Repository{ID: 99, OrgID: pgtype.Int8{Int64: 5, Valid: true}}
	q = &mockStackQuerier{
		isOrgOwnerForRepoUserFn: func(context.Context, db.IsOrgOwnerForRepoUserParams) (bool, error) {
			return false, nil
		},
		getHighestTeamPermissionForRepoUserFn: func(context.Context, db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
			return "read", nil
		},
		getCollaboratorPermissionForRepoUserFn: func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			return " write ", nil
		},
	}
	svc = newTestStackService(t, q)
	permission, owner, err := repoPermissionForUser(ctx, svc.queries, orgRepo, actor.ID)
	require.NoError(t, err)
	assert.False(t, owner)
	assert.Equal(t, "write", permission)

	err = normalizeStackWriteError(nil, "fallback")
	require.NoError(t, err)
	apiInput := pkgerrors.BadRequest("already api")
	assert.Same(t, apiInput, normalizeStackWriteError(apiInput, "fallback"))
	stackCovAssertAPIStatus(t, normalizeStackWriteError(&pgconn.PgError{Code: "23505"}, "fallback"), http.StatusConflict)
	stackCovAssertAPIStatus(t, normalizeStackWriteError(&pgconn.PgError{Code: "23502"}, "fallback"), http.StatusUnprocessableEntity)
	stackCovAssertAPIStatus(t, normalizeStackWriteError(errors.New("boom"), "fallback"), http.StatusInternalServerError)
}

func TestStack_Cov_NormalizationDefaultsAndGitHubHelpers(t *testing.T) {
	_, err := normalizeStackChanges(nil)
	require.Error(t, err)
	stackCovAssertAPIStatus(t, err, http.StatusUnprocessableEntity)
	_, err = normalizeStackChanges([]StackChangeInput{{BranchName: "b"}})
	require.Error(t, err)
	_, err = normalizeStackChanges([]StackChangeInput{{ChangeID: "c"}})
	require.Error(t, err)
	_, err = normalizeStackChanges([]StackChangeInput{{ChangeID: "c1", BranchName: "b1", Position: 1}, {ChangeID: "c2", BranchName: "b2", Position: 1}})
	require.Error(t, err)
	badPR := int64(0)
	_, err = normalizeStackChanges([]StackChangeInput{{ChangeID: "c1", BranchName: "b1", PRNumber: &badPR}})
	require.Error(t, err)

	prNumber := int64(12)
	changes, err := normalizeStackChanges([]StackChangeInput{{
		ChangeID:     " change-1 ",
		BranchName:   " branch-1 ",
		Position:     -1,
		PRNumber:     &prNumber,
		PRState:      " OPEN ",
		ReviewStatus: " approved ",
		CIStatus:     " success ",
	}})
	require.NoError(t, err)
	require.Len(t, changes, 1)
	assert.Equal(t, 0, changes[0].Position)
	assert.Equal(t, "change-1", changes[0].ChangeID)
	assert.Equal(t, "approved", changes[0].ReviewStatus)

	assert.False(t, trimOptionalText(" ").Valid)
	assert.Equal(t, "value", trimOptionalText(" value ").String)
	assert.Empty(t, stackPullRequestURL("", "repo", 1))
	assert.Empty(t, stackPullRequestURL("owner", "repo", 0))
	assert.Equal(t, "https://github.com/owner/repo/pull/12", stackPullRequestURL("owner", "repo", 12))

	applyStackChangeDefaults(nil, "owner", "repo")
	change := StackChangeResponse{PRNumber: &prNumber, ReviewStatus: "changes requested", CIStatus: "failed"}
	applyStackChangeDefaults(&change, "owner", "repo")
	assert.Equal(t, "open", change.PRState)
	assert.Equal(t, "changes_requested", change.ReviewStatus)
	assert.Equal(t, "failing", change.CIStatus)
	assert.Equal(t, "https://github.com/owner/repo/pull/12", change.PRURL)

	assert.Equal(t, "approved", aggregateStackReviewStatus([]stackGitHubReview{
		stackCovReview("alice", "COMMENTED"),
		stackCovReview("alice", "APPROVED"),
	}))
	assert.Equal(t, "changes_requested", aggregateStackReviewStatus([]stackGitHubReview{
		stackCovReview("", "APPROVED"),
		stackCovReview("", "CHANGES_REQUESTED"),
	}))
	success := "success"
	unknown := "mystery"
	assert.Equal(t, "passing", aggregateStackCIStatus([]stackGitHubCheckRun{{Status: "completed", Conclusion: &success}}))
	assert.Equal(t, "pending", aggregateStackCIStatus([]stackGitHubCheckRun{{Status: "completed", Conclusion: &unknown}}))
	assert.Equal(t, "pending", normalizeStackCIStatus("queued"))
	assert.Equal(t, "", normalizeStackPRState("   "))

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/ok":
			_, _ = w.Write([]byte(`{"message":"ok"}`))
		default:
			http.Error(w, `{"message":"denied"}`, http.StatusForbidden)
		}
	}))
	t.Cleanup(server.Close)
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)

	var out struct {
		Message string `json:"message"`
	}
	require.NoError(t, callStackGitHubJSON(context.Background(), "token", "/ok", &out))
	assert.Equal(t, "ok", out.Message)
	require.NoError(t, callStackGitHubJSON(context.Background(), "token", "/ok", nil))
	err = callStackGitHubJSON(context.Background(), "token", "/denied", &out)
	require.ErrorContains(t, err, "denied")

}

func TestStack_Cov_ServiceFailureBranches(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC)
	actor := &db.User{ID: 7, Username: "alice"}
	repo := db.Repository{ID: 42, UserID: pgtype.Int8{Int64: actor.ID, Valid: true}}

	q := &mockStackQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getActiveStackFn: func(context.Context, db.GetActiveStackParams) (db.Stack, error) {
			return db.Stack{ID: 5, RepositoryID: repo.ID, UserID: actor.ID, TargetRef: "main", State: "active", CreatedAt: now, UpdatedAt: now}, nil
		},
		listStackChangesByStackFn: func(context.Context, int64) ([]db.StackChange, error) {
			return nil, errors.New("changes unavailable")
		},
	}
	resolver := stackInstallationResolverStub(func(context.Context, int64, string, string) (int64, error) {
		return 0, errors.New("install lookup failed")
	})
	svc := newTestStackService(t, q, WithStackGitHubInstallationResolver(resolver))
	_, err := svc.GetActiveStack(ctx, actor, "alice", "demo", "main")
	require.Error(t, err)
	stackCovAssertAPIStatus(t, err, http.StatusInternalServerError)

	q.listStackChangesByStackFn = func(context.Context, int64) ([]db.StackChange, error) {
		return []db.StackChange{{StackID: 5, ChangeID: "c1", BranchName: "b1", Position: 0, PRNumber: pgtype.Int8{Int64: 1, Valid: true}}}, nil
	}
	// An installation lookup failure degrades GitHub fields to defaults.
	stack, err := svc.GetActiveStack(ctx, actor, "alice", "demo", "main")
	require.NoError(t, err)
	require.Len(t, stack.Changes, 1)
	assert.Equal(t, "open", stack.Changes[0].PRState)

	q.upsertActiveStackFn = func(context.Context, db.UpsertActiveStackParams) (db.Stack, error) {
		return db.Stack{ID: 6, RepositoryID: repo.ID, UserID: actor.ID, TargetRef: "main"}, nil
	}
	_, err = svc.UpsertActiveStack(ctx, actor, "alice", "demo", UpsertActiveStackInput{
		Changes: []StackChangeInput{{ChangeID: "c1", BranchName: "b1", Position: math.MaxInt32 + 1}},
	})
	require.Error(t, err)
	stackCovAssertAPIStatus(t, err, http.StatusUnprocessableEntity)

	q.deleteAllStackChangesFn = func(context.Context, int64) error { return errors.New("delete changes") }
	err = svc.DeleteActiveStack(ctx, actor, "alice", "demo", "main")
	require.Error(t, err)
	stackCovAssertAPIStatus(t, err, http.StatusInternalServerError)
}

func stackCovReview(login, state string) stackGitHubReview {
	var review stackGitHubReview
	review.State = state
	review.User.Login = login
	return review
}

func stackCovAssertAPIStatus(t *testing.T, err error, status int) {
	t.Helper()
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, status, apiErr.Status)
}

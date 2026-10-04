package services

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func stackHRepo(actorID int64) db.Repository {
	return db.Repository{ID: 42, Name: "demo", LowerName: "demo", UserID: pgtype.Int8{Int64: actorID, Valid: true}}
}

func stackHStack(actorID int64) db.Stack {
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	return db.Stack{ID: 5, RepositoryID: 42, UserID: actorID, TargetRef: "main", State: "active", CreatedAt: now, UpdatedAt: now}
}

func TestStack_H_ServiceBranches(t *testing.T) {
	ctx := context.Background()
	actor := &db.User{ID: 7, Username: "alice"}
	repo := stackHRepo(actor.ID)
	stack := stackHStack(actor.ID)

	dispatcher := &mockStackWorkflowDispatcher{}
	svc := newTestStackService(t, &mockStackQuerier{}, WithStackWorkflowRunDispatcher(dispatcher))
	assert.Same(t, dispatcher, svc.workflowRunner)

	_, err := svc.GetActiveStack(ctx, nil, "alice", "demo", "main")
	require.Error(t, err)
	assert.Equal(t, 401, apiStatus(t, err))

	svc = newTestStackService(t, &mockStackQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getActiveStackFn: func(context.Context, db.GetActiveStackParams) (db.Stack, error) {
			return db.Stack{}, pgx.ErrNoRows
		},
	})
	_, err = svc.GetActiveStack(ctx, actor, "alice", "demo", "main")
	require.Error(t, err)
	assert.Equal(t, 404, apiStatus(t, err))

	svc = newTestStackService(t, &mockStackQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getActiveStackFn: func(context.Context, db.GetActiveStackParams) (db.Stack, error) {
			return db.Stack{}, errors.New("select failed")
		},
	})
	_, err = svc.GetActiveStack(ctx, actor, "alice", "demo", "main")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	q := &mockStackQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getActiveStackFn: func(context.Context, db.GetActiveStackParams) (db.Stack, error) {
			return stack, nil
		},
		listStackChangesByStackFn: func(context.Context, int64) ([]db.StackChange, error) {
			return []db.StackChange{{StackID: stack.ID, ChangeID: "c1", BranchName: "b1", Position: 0}}, nil
		},
	}
	svc = newTestStackService(t, q)
	got, err := svc.GetActiveStack(ctx, actor, "alice", "demo", " ")
	require.NoError(t, err)
	assert.Equal(t, "main", q.lastGetActiveStackArg.TargetRef)
	assert.Len(t, got.Changes, 1)

	_, err = newTestStackService(t, &mockStackQuerier{}).UpsertActiveStack(ctx, nil, "alice", "demo", UpsertActiveStackInput{})
	require.Error(t, err)
	assert.Equal(t, 401, apiStatus(t, err))

	q = &mockStackQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		upsertActiveStackFn: func(context.Context, db.UpsertActiveStackParams) (db.Stack, error) {
			return db.Stack{}, errors.New("upsert failed")
		},
	}
	_, err = newTestStackService(t, q).UpsertActiveStack(ctx, actor, "alice", "demo", UpsertActiveStackInput{Changes: []StackChangeInput{{ChangeID: "c1", BranchName: "b1"}}})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	q.upsertActiveStackFn = func(context.Context, db.UpsertActiveStackParams) (db.Stack, error) { return stack, nil }
	q.upsertStackChangeFn = func(context.Context, db.UpsertStackChangeParams) (db.StackChange, error) {
		return db.StackChange{}, errors.New("change failed")
	}
	_, err = newTestStackService(t, q).UpsertActiveStack(ctx, actor, "alice", "demo", UpsertActiveStackInput{Changes: []StackChangeInput{{ChangeID: "c1", BranchName: "b1"}}})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	q.upsertStackChangeFn = func(context.Context, db.UpsertStackChangeParams) (db.StackChange, error) {
		return db.StackChange{StackID: stack.ID, ChangeID: "c1", BranchName: "b1"}, nil
	}
	q.deleteStackChangesNotInSetFn = func(context.Context, db.DeleteStackChangesNotInSetParams) error {
		return errors.New("prune failed")
	}
	_, err = newTestStackService(t, q).UpsertActiveStack(ctx, actor, "alice", "demo", UpsertActiveStackInput{Changes: []StackChangeInput{{ChangeID: "c1", BranchName: "b1"}}})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	q.deleteStackChangesNotInSetFn = nil
	q.listStackChangesByStackFn = func(context.Context, int64) ([]db.StackChange, error) {
		return nil, errors.New("list failed")
	}
	_, err = newTestStackService(t, q).UpsertActiveStack(ctx, actor, "alice", "demo", UpsertActiveStackInput{Changes: []StackChangeInput{{ChangeID: "c1", BranchName: "b1"}}})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	q.listStackChangesByStackFn = func(context.Context, int64) ([]db.StackChange, error) {
		return []db.StackChange{{StackID: stack.ID, ChangeID: " c2 ", BranchName: "b2", Position: 1}}, nil
	}
	failingDispatcher := &mockStackWorkflowDispatcher{dispatchForEventFn: func(context.Context, DispatchForEventInput) ([]WorkflowRunResult, error) {
		return nil, errors.New("dispatch failed")
	}}
	upserted, err := newTestStackService(t, q, WithStackWorkflowRunDispatcher(failingDispatcher)).UpsertActiveStack(ctx, actor, "alice", "demo", UpsertActiveStackInput{TargetRef: " feature ", Changes: []StackChangeInput{{ChangeID: "c2", BranchName: "b2", Position: 1}}})
	require.NoError(t, err)
	assert.Equal(t, "main", upserted.TargetRef)
	require.Len(t, failingDispatcher.calls, 1)
	assert.Equal(t, "c2", failingDispatcher.calls[0].Event.ChangeID)

	q.deleteAllStackChangesFn = nil
	q.deleteStackByIDFn = func(context.Context, int64) error { return errors.New("delete stack failed") }
	err = newTestStackService(t, q).DeleteActiveStack(ctx, actor, "alice", "demo", "main")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	q.getActiveStackFn = func(context.Context, db.GetActiveStackParams) (db.Stack, error) {
		return db.Stack{}, pgx.ErrNoRows
	}
	require.NoError(t, newTestStackService(t, q).DeleteActiveStack(ctx, actor, "alice", "demo", "main"))
}

func TestStack_H_AccessMappingAndAggregationBranches(t *testing.T) {
	ctx := context.Background()
	actor := &db.User{ID: 7}
	repo := db.Repository{ID: 42, OrgID: pgtype.Int8{Int64: 3, Valid: true}}

	q := &mockStackQuerier{
		isOrgOwnerForRepoUserFn: func(context.Context, db.IsOrgOwnerForRepoUserParams) (bool, error) {
			return false, nil
		},
		getHighestTeamPermissionForRepoUserFn: func(context.Context, db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
			return "", errors.New("permission failed")
		},
	}
	svc := newTestStackService(t, q)
	err := svc.requireReadAccess(ctx, repo, actor)
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	q.getHighestTeamPermissionForRepoUserFn = func(context.Context, db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
		return "read", nil
	}
	require.NoError(t, svc.requireReadAccess(ctx, repo, actor))
	err = svc.requireWriteAccess(ctx, repo, actor)
	require.Error(t, err)
	assert.Equal(t, 403, apiStatus(t, err))

	row := db.StackChange{
		BranchName:   "branch",
		ChangeID:     "change",
		Position:     4,
		PRNumber:     pgtype.Int8{Int64: 12, Valid: true},
		PRState:      pgtype.Text{String: " CLOSED ", Valid: true},
		ReviewStatus: pgtype.Text{String: "changes requested", Valid: true},
		CiStatus:     pgtype.Text{String: "cancelled", Valid: true},
	}
	mapped := mapStackResponse(stackHStack(actor.ID), []db.StackChange{row})
	require.Len(t, mapped.Changes, 1)
	assert.Equal(t, "closed", mapped.Changes[0].PRState)
	assert.Equal(t, "changes_requested", mapped.Changes[0].ReviewStatus)
	assert.Equal(t, "failing", mapped.Changes[0].CIStatus)

	_, err = normalizeStackChanges([]StackChangeInput{{ChangeID: "c1", BranchName: "b1"}, {ChangeID: "c1", BranchName: "b2", Position: 1}})
	require.Error(t, err)
	assert.Equal(t, 422, apiStatus(t, err))

	assert.Equal(t, "pending", aggregateStackReviewStatus(nil))
	assert.Equal(t, "failing", aggregateStackCIStatus([]stackGitHubCheckRun{{Status: "completed", Conclusion: stackHString("failure")}}))
	assert.Equal(t, "pending", aggregateStackCIStatus([]stackGitHubCheckRun{{Status: "in_progress"}}))
	assert.Equal(t, "failing", normalizeStackCIStatus("error"))
	assert.Equal(t, "pending", normalizeStackReviewStatus("commented"))
	assert.Equal(t, "", normalizeStackPRState("   "))
}

func TestStack_H_GitHubEnrichmentAndHTTPBranches(t *testing.T) {
	ctx := context.Background()

	svc := newTestStackService(t, &mockStackQuerier{})
	require.NoError(t, svc.enrichStackResponseWithGitHub(ctx, 0, "owner", "repo", nil))
	empty := StackResponse{}
	require.NoError(t, svc.enrichStackResponseWithGitHub(ctx, 0, "owner", "repo", &empty))
	withBlankOwner := StackResponse{Changes: []StackChangeResponse{{ChangeID: "c1"}}}
	require.NoError(t, svc.enrichStackResponseWithGitHub(ctx, 0, "", "repo", &withBlankOwner))

	prNumber := int64(12)
	resolver := stackInstallationResolverStub(func(context.Context, int64, string, string) (int64, error) {
		return 123, nil
	})
	response := StackResponse{Changes: []StackChangeResponse{{ChangeID: "c1", PRNumber: &prNumber}}}
	require.NoError(t, newTestStackService(t, &mockStackQuerier{}, WithStackGitHubInstallationResolver(resolver)).enrichStackResponseWithGitHub(ctx, 0, "Owner", "Repo", &response))
	assert.Equal(t, "open", response.Changes[0].PRState)
	assert.Equal(t, "https://github.com/Owner/Repo/pull/12", response.Changes[0].PRURL)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/pulls/12/reviews"):
			_, _ = w.Write([]byte(`[{"state":"APPROVED","user":{"login":"alice"}}]`))
		case strings.Contains(r.URL.Path, "/commits/sha-1/check-runs"):
			_, _ = w.Write([]byte(`{"check_runs":[{"status":"completed","conclusion":"success"}]}`))
		case strings.Contains(r.URL.Path, "/pulls/12"):
			_, _ = w.Write([]byte(`{"head":{"sha":"sha-1"},"html_url":"https://github.test/pr/12","state":"open"}`))
		default:
			http.Error(w, `{"message":"missing"}`, http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)

	state, err := loadStackGitHubState(ctx, http.DefaultClient, "token", "owner", "repo", 12)
	require.NoError(t, err)
	assert.Equal(t, "open", state.PRState)
	assert.Equal(t, "approved", state.ReviewStatus)
	assert.Equal(t, "passing", state.CIStatus)

	badJSONServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{not-json`))
	}))
	t.Cleanup(badJSONServer.Close)
	t.Setenv(envGitHubAppAPIBaseURL, badJSONServer.URL)
	var out struct{}
	err = callStackGitHubJSON(ctx, http.DefaultClient, "token", "/bad-json", &out)
	require.Error(t, err)

	t.Setenv(envGitHubAppAPIBaseURL, "://bad")
	err = callStackGitHubJSON(ctx, http.DefaultClient, "token", "/path", &out)
	require.Error(t, err)
}

func stackHString(value string) *string {
	return &value
}

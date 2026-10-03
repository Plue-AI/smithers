package services

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
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
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type mockStackQuerier struct {
	getRepoByOwnerAndLowerNameFn           func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	isOrgOwnerForRepoUserFn                func(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	getHighestTeamPermissionForRepoUserFn  func(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	getCollaboratorPermissionForRepoUserFn func(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)
	getActiveStackFn                       func(ctx context.Context, arg db.GetActiveStackParams) (db.Stack, error)
	upsertActiveStackFn                    func(ctx context.Context, arg db.UpsertActiveStackParams) (db.Stack, error)
	upsertStackChangeFn                    func(ctx context.Context, arg db.UpsertStackChangeParams) (db.StackChange, error)
	listStackChangesByStackFn              func(ctx context.Context, stackID int64) ([]db.StackChange, error)
	deleteStackChangesNotInSetFn           func(ctx context.Context, arg db.DeleteStackChangesNotInSetParams) error
	deleteAllStackChangesFn                func(ctx context.Context, stackID int64) error
	deleteStackByIDFn                      func(ctx context.Context, id int64) error

	lastGetActiveStackArg             db.GetActiveStackParams
	lastUpsertActiveStackArg          db.UpsertActiveStackParams
	upsertStackChangeArgs             []db.UpsertStackChangeParams
	lastDeleteStackChangesNotInSetArg db.DeleteStackChangesNotInSetParams
	lastDeleteAllStackChangesArg      int64
	lastDeleteStackByIDArg            int64
}

type stackInstallationResolverStub func(ctx context.Context, userID int64, owner, repo string) (int64, error)

func (f stackInstallationResolverStub) GetGitHubInstallationIDForUserRepo(ctx context.Context, userID int64, owner, repo string) (int64, error) {
	return f(ctx, userID, owner, repo)
}

type mockStackWorkflowDispatcher struct {
	dispatchForEventFn func(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error)
	calls              []DispatchForEventInput
}

func (m *mockStackWorkflowDispatcher) DispatchForEvent(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error) {
	m.calls = append(m.calls, input)
	if m.dispatchForEventFn != nil {
		return m.dispatchForEventFn(ctx, input)
	}
	return nil, nil
}

func (m *mockStackQuerier) GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	if m.getRepoByOwnerAndLowerNameFn != nil {
		return m.getRepoByOwnerAndLowerNameFn(ctx, arg)
	}
	return db.Repository{}, nil
}

func (m *mockStackQuerier) IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error) {
	if m.isOrgOwnerForRepoUserFn != nil {
		return m.isOrgOwnerForRepoUserFn(ctx, arg)
	}
	return false, nil
}

func (m *mockStackQuerier) GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error) {
	if m.getHighestTeamPermissionForRepoUserFn != nil {
		return m.getHighestTeamPermissionForRepoUserFn(ctx, arg)
	}
	return "", nil
}

func (m *mockStackQuerier) GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
	if m.getCollaboratorPermissionForRepoUserFn != nil {
		return m.getCollaboratorPermissionForRepoUserFn(ctx, arg)
	}
	return "", nil
}

func (m *mockStackQuerier) GetActiveStack(ctx context.Context, arg db.GetActiveStackParams) (db.Stack, error) {
	m.lastGetActiveStackArg = arg
	if m.getActiveStackFn != nil {
		return m.getActiveStackFn(ctx, arg)
	}
	return db.Stack{}, nil
}

func (m *mockStackQuerier) UpsertActiveStack(ctx context.Context, arg db.UpsertActiveStackParams) (db.Stack, error) {
	m.lastUpsertActiveStackArg = arg
	if m.upsertActiveStackFn != nil {
		return m.upsertActiveStackFn(ctx, arg)
	}
	return db.Stack{}, nil
}

func (m *mockStackQuerier) UpsertStackChange(ctx context.Context, arg db.UpsertStackChangeParams) (db.StackChange, error) {
	m.upsertStackChangeArgs = append(m.upsertStackChangeArgs, arg)
	if m.upsertStackChangeFn != nil {
		return m.upsertStackChangeFn(ctx, arg)
	}
	return db.StackChange{}, nil
}

func (m *mockStackQuerier) ListStackChangesByStack(ctx context.Context, stackID int64) ([]db.StackChange, error) {
	if m.listStackChangesByStackFn != nil {
		return m.listStackChangesByStackFn(ctx, stackID)
	}
	return []db.StackChange{}, nil
}

func (m *mockStackQuerier) DeleteStackChangesNotInSet(ctx context.Context, arg db.DeleteStackChangesNotInSetParams) error {
	m.lastDeleteStackChangesNotInSetArg = arg
	if m.deleteStackChangesNotInSetFn != nil {
		return m.deleteStackChangesNotInSetFn(ctx, arg)
	}
	return nil
}

func (m *mockStackQuerier) DeleteAllStackChanges(ctx context.Context, stackID int64) error {
	m.lastDeleteAllStackChangesArg = stackID
	if m.deleteAllStackChangesFn != nil {
		return m.deleteAllStackChangesFn(ctx, stackID)
	}
	return nil
}

func (m *mockStackQuerier) DeleteStackByID(ctx context.Context, id int64) error {
	m.lastDeleteStackByIDArg = id
	if m.deleteStackByIDFn != nil {
		return m.deleteStackByIDFn(ctx, id)
	}
	return nil
}

func TestStackService_UpsertActiveStack_PersistsAndReturnsChanges(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 4, 26, 0, 0, 0, 0, time.UTC)
	repo := db.Repository{
		ID:       99,
		IsPublic: false,
		UserID:   pgtype.Int8{Int64: 1, Valid: true},
	}
	actor := &db.User{ID: 1, Username: "alice"}
	prOne := int64(41)
	prTwo := int64(42)

	q := &mockStackQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		upsertActiveStackFn: func(ctx context.Context, arg db.UpsertActiveStackParams) (db.Stack, error) {
			return db.Stack{
				ID:           7,
				RepositoryID: arg.RepositoryID,
				UserID:       arg.UserID,
				TargetRef:    arg.TargetRef,
				State:        "active",
				CreatedAt:    now,
				UpdatedAt:    now,
			}, nil
		},
		upsertStackChangeFn: func(ctx context.Context, arg db.UpsertStackChangeParams) (db.StackChange, error) {
			return db.StackChange{
				ID:           1,
				StackID:      arg.StackID,
				ChangeID:     arg.ChangeID,
				Position:     arg.Position,
				BranchName:   arg.BranchName,
				PRNumber:     arg.PRNumber,
				PRState:      arg.PRState,
				ReviewStatus: arg.ReviewStatus,
				CiStatus:     arg.CiStatus,
				CreatedAt:    now,
				UpdatedAt:    now,
			}, nil
		},
		listStackChangesByStackFn: func(ctx context.Context, stackID int64) ([]db.StackChange, error) {
			return []db.StackChange{
				{
					ID:           1,
					StackID:      stackID,
					ChangeID:     "qabc1234",
					Position:     0,
					BranchName:   "smithers/qabc1234",
					PRNumber:     pgtype.Int8{Int64: 41, Valid: true},
					PRState:      pgtype.Text{String: "open", Valid: true},
					ReviewStatus: pgtype.Text{String: "pending", Valid: true},
					CiStatus:     pgtype.Text{String: "pending", Valid: true},
					CreatedAt:    now,
					UpdatedAt:    now,
				},
				{
					ID:           2,
					StackID:      stackID,
					ChangeID:     "qdef5678",
					Position:     1,
					BranchName:   "smithers/qdef5678",
					PRNumber:     pgtype.Int8{Int64: 42, Valid: true},
					PRState:      pgtype.Text{String: "open", Valid: true},
					ReviewStatus: pgtype.Text{String: "pending", Valid: true},
					CiStatus:     pgtype.Text{String: "pending", Valid: true},
					CreatedAt:    now,
					UpdatedAt:    now,
				},
			}, nil
		},
	}
	svc := newTestStackService(t, q)

	result, err := svc.UpsertActiveStack(context.Background(), actor, "alice", "demo", UpsertActiveStackInput{
		Changes: []StackChangeInput{
			{
				BranchName:   "smithers/qabc1234",
				ChangeID:     "qabc1234",
				CIStatus:     "pending",
				Position:     0,
				PRNumber:     &prOne,
				PRState:      "open",
				ReviewStatus: "pending",
			},
			{
				BranchName:   "smithers/qdef5678",
				ChangeID:     "qdef5678",
				CIStatus:     "pending",
				Position:     1,
				PRNumber:     &prTwo,
				PRState:      "open",
				ReviewStatus: "pending",
			},
		},
	})
	require.NoError(t, err)

	assert.Equal(t, int64(99), q.lastUpsertActiveStackArg.RepositoryID)
	assert.Equal(t, int64(1), q.lastUpsertActiveStackArg.UserID)
	assert.Equal(t, "main", q.lastUpsertActiveStackArg.TargetRef)
	require.Len(t, q.upsertStackChangeArgs, 2)
	assert.Equal(t, "qabc1234", q.upsertStackChangeArgs[0].ChangeID)
	assert.Equal(t, int32(0), q.upsertStackChangeArgs[0].Position)
	assert.True(t, q.upsertStackChangeArgs[0].PRNumber.Valid)
	assert.Equal(t, int64(41), q.upsertStackChangeArgs[0].PRNumber.Int64)
	assert.Equal(t, []string{"qabc1234", "qdef5678"}, q.lastDeleteStackChangesNotInSetArg.ChangeIds)

	assert.Equal(t, int64(7), result.ID)
	assert.Equal(t, "main", result.TargetRef)
	assert.Equal(t, "active", result.State)
	require.Len(t, result.Changes, 2)
	require.NotNil(t, result.Changes[0].PRNumber)
	assert.Equal(t, int64(41), *result.Changes[0].PRNumber)
}

func TestStackService_UpsertActiveStack_DispatchesStackSubmitEvent(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 4, 26, 0, 0, 0, 0, time.UTC)
	repo := db.Repository{
		ID:       99,
		IsPublic: false,
		UserID:   pgtype.Int8{Int64: 1, Valid: true},
	}
	actor := &db.User{ID: 1, Username: "alice"}
	prNumber := int64(41)

	queries := &mockStackQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		upsertActiveStackFn: func(ctx context.Context, arg db.UpsertActiveStackParams) (db.Stack, error) {
			return db.Stack{
				ID:           7,
				RepositoryID: arg.RepositoryID,
				UserID:       arg.UserID,
				TargetRef:    arg.TargetRef,
				State:        "active",
				CreatedAt:    now,
				UpdatedAt:    now,
			}, nil
		},
		upsertStackChangeFn: func(ctx context.Context, arg db.UpsertStackChangeParams) (db.StackChange, error) {
			return db.StackChange{
				ID:         1,
				StackID:    arg.StackID,
				ChangeID:   arg.ChangeID,
				Position:   arg.Position,
				BranchName: arg.BranchName,
				CreatedAt:  now,
				UpdatedAt:  now,
			}, nil
		},
		listStackChangesByStackFn: func(ctx context.Context, stackID int64) ([]db.StackChange, error) {
			return []db.StackChange{
				{
					ID:         1,
					StackID:    stackID,
					ChangeID:   "qabc1234",
					Position:   0,
					BranchName: "smithers/qabc1234",
					CreatedAt:  now,
					UpdatedAt:  now,
				},
			}, nil
		},
	}
	dispatcher := &mockStackWorkflowDispatcher{}
	svc := newTestStackService(t, queries, WithStackWorkflowRunDispatcher(dispatcher))

	_, err := svc.UpsertActiveStack(context.Background(), actor, "alice", "demo", UpsertActiveStackInput{
		Changes: []StackChangeInput{
			{
				BranchName:   "smithers/qabc1234",
				ChangeID:     "qabc1234",
				CIStatus:     "pending",
				Position:     0,
				PRNumber:     &prNumber,
				PRState:      "open",
				ReviewStatus: "pending",
			},
		},
	})
	require.NoError(t, err)
	require.Len(t, dispatcher.calls, 1)
	assert.Equal(t, int64(99), dispatcher.calls[0].RepositoryID)
	assert.Equal(t, int64(1), dispatcher.calls[0].UserID)
	assert.Equal(t, "stack_submit", dispatcher.calls[0].Event.Type)
	assert.Equal(t, "main", dispatcher.calls[0].Event.Ref)
	assert.Equal(t, "qabc1234", dispatcher.calls[0].Event.ChangeID)
}

func TestStackService_UpsertActiveStack_DispatchFailureDoesNotFailSubmit(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 4, 26, 0, 0, 0, 0, time.UTC)
	repo := db.Repository{
		ID:       99,
		IsPublic: false,
		UserID:   pgtype.Int8{Int64: 1, Valid: true},
	}
	actor := &db.User{ID: 1, Username: "alice"}
	prNumber := int64(41)

	queries := &mockStackQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		upsertActiveStackFn: func(ctx context.Context, arg db.UpsertActiveStackParams) (db.Stack, error) {
			return db.Stack{
				ID:           7,
				RepositoryID: arg.RepositoryID,
				UserID:       arg.UserID,
				TargetRef:    arg.TargetRef,
				State:        "active",
				CreatedAt:    now,
				UpdatedAt:    now,
			}, nil
		},
		upsertStackChangeFn: func(ctx context.Context, arg db.UpsertStackChangeParams) (db.StackChange, error) {
			return db.StackChange{
				ID:         1,
				StackID:    arg.StackID,
				ChangeID:   arg.ChangeID,
				Position:   arg.Position,
				BranchName: arg.BranchName,
				CreatedAt:  now,
				UpdatedAt:  now,
			}, nil
		},
		listStackChangesByStackFn: func(ctx context.Context, stackID int64) ([]db.StackChange, error) {
			return []db.StackChange{
				{
					ID:         1,
					StackID:    stackID,
					ChangeID:   "qabc1234",
					Position:   0,
					BranchName: "smithers/qabc1234",
					CreatedAt:  now,
					UpdatedAt:  now,
				},
			}, nil
		},
	}
	dispatcher := &mockStackWorkflowDispatcher{
		dispatchForEventFn: func(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error) {
			return nil, errors.New("boom")
		},
	}
	svc := newTestStackService(t, queries, WithStackWorkflowRunDispatcher(dispatcher))

	_, err := svc.UpsertActiveStack(context.Background(), actor, "alice", "demo", UpsertActiveStackInput{
		Changes: []StackChangeInput{
			{
				BranchName:   "smithers/qabc1234",
				ChangeID:     "qabc1234",
				CIStatus:     "pending",
				Position:     0,
				PRNumber:     &prNumber,
				PRState:      "open",
				ReviewStatus: "pending",
			},
		},
	})
	require.NoError(t, err)
	require.Len(t, dispatcher.calls, 1)
}

func TestStackService_GetActiveStack_NotFound(t *testing.T) {
	t.Parallel()

	repo := db.Repository{
		ID:       99,
		IsPublic: false,
		UserID:   pgtype.Int8{Int64: 1, Valid: true},
	}
	q := &mockStackQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getActiveStackFn: func(ctx context.Context, arg db.GetActiveStackParams) (db.Stack, error) {
			return db.Stack{}, pgx.ErrNoRows
		},
	}
	svc := newTestStackService(t, q)

	_, err := svc.GetActiveStack(context.Background(), &db.User{ID: 1}, "alice", "demo", "main")
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 404, apiErr.Status)
}

func TestStackService_UpsertActiveStack_RequiresAuth(t *testing.T) {
	t.Parallel()

	svc := newTestStackService(t, &mockStackQuerier{})
	_, err := svc.UpsertActiveStack(context.Background(), nil, "alice", "demo", UpsertActiveStackInput{})
	require.Error(t, err)

	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 401, apiErr.Status)
}

func TestStackService_DeleteActiveStack_DeletesActiveMapping(t *testing.T) {
	t.Parallel()

	repo := db.Repository{
		ID:       99,
		IsPublic: false,
		UserID:   pgtype.Int8{Int64: 1, Valid: true},
	}
	q := &mockStackQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getActiveStackFn: func(ctx context.Context, arg db.GetActiveStackParams) (db.Stack, error) {
			return db.Stack{
				ID:           777,
				RepositoryID: arg.RepositoryID,
				UserID:       arg.UserID,
				TargetRef:    arg.TargetRef,
				State:        "active",
			}, nil
		},
	}
	svc := newTestStackService(t, q)

	err := svc.DeleteActiveStack(context.Background(), &db.User{ID: 1, Username: "alice"}, "alice", "demo", "main")
	require.NoError(t, err)
	assert.Equal(t, int64(99), q.lastGetActiveStackArg.RepositoryID)
	assert.Equal(t, int64(1), q.lastGetActiveStackArg.UserID)
	assert.Equal(t, "main", q.lastGetActiveStackArg.TargetRef)
	assert.Equal(t, int64(777), q.lastDeleteAllStackChangesArg)
	assert.Equal(t, int64(777), q.lastDeleteStackByIDArg)
}

func TestStackService_DeleteActiveStack_IsIdempotentWhenMissing(t *testing.T) {
	t.Parallel()

	repo := db.Repository{
		ID:       99,
		IsPublic: false,
		UserID:   pgtype.Int8{Int64: 1, Valid: true},
	}
	q := &mockStackQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getActiveStackFn: func(ctx context.Context, arg db.GetActiveStackParams) (db.Stack, error) {
			return db.Stack{}, pgx.ErrNoRows
		},
	}
	svc := newTestStackService(t, q)

	err := svc.DeleteActiveStack(context.Background(), &db.User{ID: 1, Username: "alice"}, "alice", "demo", "main")
	require.NoError(t, err)
	assert.Equal(t, int64(0), q.lastDeleteAllStackChangesArg)
	assert.Equal(t, int64(0), q.lastDeleteStackByIDArg)
}

func TestStackService_UpsertActiveStack_RejectsDuplicateChangeID(t *testing.T) {
	t.Parallel()

	repo := db.Repository{
		ID:       99,
		IsPublic: false,
		UserID:   pgtype.Int8{Int64: 1, Valid: true},
	}
	q := &mockStackQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
	}
	svc := newTestStackService(t, q)
	actor := &db.User{ID: 1, Username: "alice"}

	_, err := svc.UpsertActiveStack(context.Background(), actor, "alice", "demo", UpsertActiveStackInput{
		Changes: []StackChangeInput{
			{ChangeID: "qabc1234", BranchName: "smithers/qabc1234", Position: 0},
			{ChangeID: "qabc1234", BranchName: "smithers/qabc1234", Position: 1},
		},
		TargetRef: "main",
	})
	require.Error(t, err)

	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 422, apiErr.Status)
}

func TestStackService_GetActiveStack_EnrichesGitHubState(t *testing.T) {
	now := time.Date(2026, 4, 26, 0, 0, 0, 0, time.UTC)
	repo := db.Repository{
		ID:       99,
		IsPublic: false,
		UserID:   pgtype.Int8{Int64: 1, Valid: true},
	}
	privateKey := generateStackTestRSAPrivateKeyPEM(t)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/app/installations/777/access_tokens":
			_, _ = w.Write([]byte(`{"token":"ghs_stack_token","expires_at":"2026-04-27T00:00:00Z"}`))
		case r.Method == http.MethodGet && r.URL.Path == "/repos/alice/demo/pulls/41":
			_, _ = w.Write([]byte(`{"state":"open","html_url":"https://github.com/alice/demo/pull/41","head":{"sha":"sha-41"}}`))
		case r.Method == http.MethodGet && r.URL.Path == "/repos/alice/demo/pulls/41/reviews":
			_, _ = w.Write([]byte(`[{"state":"APPROVED","user":{"login":"reviewer"}}]`))
		case r.Method == http.MethodGet && r.URL.Path == "/repos/alice/demo/commits/sha-41/check-runs":
			_, _ = w.Write([]byte(`{"check_runs":[{"status":"completed","conclusion":"success"}]}`))
		case r.Method == http.MethodGet && r.URL.Path == "/repos/alice/demo/pulls/42":
			_, _ = w.Write([]byte(`{"state":"open","html_url":"https://github.com/alice/demo/pull/42","head":{"sha":"sha-42"}}`))
		case r.Method == http.MethodGet && r.URL.Path == "/repos/alice/demo/pulls/42/reviews":
			_, _ = w.Write([]byte(`[{"state":"APPROVED","user":{"login":"maintainer"}},{"state":"CHANGES_REQUESTED","user":{"login":"maintainer"}}]`))
		case r.Method == http.MethodGet && r.URL.Path == "/repos/alice/demo/commits/sha-42/check-runs":
			_, _ = w.Write([]byte(`{"check_runs":[{"status":"completed","conclusion":"failure"}]}`))
		default:
			http.Error(w, `{"message":"not found"}`, http.StatusNotFound)
		}
	}))
	defer server.Close()

	setTestCallerCredentials(t, "ID", "123")
	setTestCallerCredentials(t, "PEM", privateKey)
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)

	q := &mockStackQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getActiveStackFn: func(ctx context.Context, arg db.GetActiveStackParams) (db.Stack, error) {
			return db.Stack{
				ID:           7,
				RepositoryID: arg.RepositoryID,
				UserID:       arg.UserID,
				TargetRef:    arg.TargetRef,
				State:        "active",
				CreatedAt:    now,
				UpdatedAt:    now,
			}, nil
		},
		listStackChangesByStackFn: func(ctx context.Context, stackID int64) ([]db.StackChange, error) {
			return []db.StackChange{
				{
					ID:           1,
					StackID:      stackID,
					ChangeID:     "qabc1234",
					Position:     0,
					BranchName:   "smithers/qabc1234",
					PRNumber:     pgtype.Int8{Int64: 41, Valid: true},
					PRState:      pgtype.Text{String: "open", Valid: true},
					ReviewStatus: pgtype.Text{String: "pending", Valid: true},
					CiStatus:     pgtype.Text{String: "pending", Valid: true},
					CreatedAt:    now,
					UpdatedAt:    now,
				},
				{
					ID:           2,
					StackID:      stackID,
					ChangeID:     "qdef5678",
					Position:     1,
					BranchName:   "smithers/qdef5678",
					PRNumber:     pgtype.Int8{Int64: 42, Valid: true},
					PRState:      pgtype.Text{String: "open", Valid: true},
					ReviewStatus: pgtype.Text{String: "pending", Valid: true},
					CiStatus:     pgtype.Text{String: "pending", Valid: true},
					CreatedAt:    now,
					UpdatedAt:    now,
				},
			}, nil
		},
	}

	resolver := stackInstallationResolverStub(func(_ context.Context, userID int64, owner, repo string) (int64, error) {
		assert.Equal(t, int64(1), userID)
		assert.Equal(t, "alice", owner)
		assert.Equal(t, "demo", repo)
		return 777, nil
	})
	svc := newTestStackService(t, q, WithStackGitHubInstallationResolver(resolver))
	result, err := svc.GetActiveStack(context.Background(), &db.User{ID: 1, Username: "alice"}, "alice", "demo", "main")
	require.NoError(t, err)

	require.Len(t, result.Changes, 2)
	assert.Equal(t, "approved", result.Changes[0].ReviewStatus)
	assert.Equal(t, "passing", result.Changes[0].CIStatus)
	assert.Equal(t, "https://github.com/alice/demo/pull/41", result.Changes[0].PRURL)
	assert.Equal(t, "changes_requested", result.Changes[1].ReviewStatus)
	assert.Equal(t, "failing", result.Changes[1].CIStatus)
	assert.Equal(t, "https://github.com/alice/demo/pull/42", result.Changes[1].PRURL)
}

func TestStackService_GetActiveStack_FallsBackWithoutGitHubInstallation(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 4, 26, 0, 0, 0, 0, time.UTC)
	repo := db.Repository{
		ID:       99,
		IsPublic: false,
		UserID:   pgtype.Int8{Int64: 1, Valid: true},
	}
	q := &mockStackQuerier{
		getRepoByOwnerAndLowerNameFn: func(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repo, nil
		},
		getActiveStackFn: func(ctx context.Context, arg db.GetActiveStackParams) (db.Stack, error) {
			return db.Stack{
				ID:           7,
				RepositoryID: arg.RepositoryID,
				UserID:       arg.UserID,
				TargetRef:    arg.TargetRef,
				State:        "active",
				CreatedAt:    now,
				UpdatedAt:    now,
			}, nil
		},
		listStackChangesByStackFn: func(ctx context.Context, stackID int64) ([]db.StackChange, error) {
			return []db.StackChange{
				{
					ID:           1,
					StackID:      stackID,
					ChangeID:     "qabc1234",
					Position:     0,
					BranchName:   "smithers/qabc1234",
					PRNumber:     pgtype.Int8{Int64: 41, Valid: true},
					PRState:      pgtype.Text{String: "open", Valid: true},
					ReviewStatus: pgtype.Text{String: "pending", Valid: true},
					CiStatus:     pgtype.Text{String: "pending", Valid: true},
					CreatedAt:    now,
					UpdatedAt:    now,
				},
			}, nil
		},
	}

	resolver := stackInstallationResolverStub(func(context.Context, int64, string, string) (int64, error) {
		return 0, nil
	})
	svc := newTestStackService(t, q, WithStackGitHubInstallationResolver(resolver))
	result, err := svc.GetActiveStack(context.Background(), &db.User{ID: 1, Username: "alice"}, "alice", "demo", "main")
	require.NoError(t, err)
	require.Len(t, result.Changes, 1)
	assert.Equal(t, "pending", result.Changes[0].ReviewStatus)
	assert.Equal(t, "pending", result.Changes[0].CIStatus)
	assert.Equal(t, "https://github.com/alice/demo/pull/41", result.Changes[0].PRURL)
}

func generateStackTestRSAPrivateKeyPEM(t *testing.T) string {
	t.Helper()
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	pemBytes := pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(privateKey),
	})
	require.NotEmpty(t, pemBytes)
	return strings.TrimSpace(string(pemBytes))
}

package services

import (
	"context"
	"errors"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

type commitStatusDispatchCall struct {
	repoID    int64
	eventType webhooks.EventType
	payload   any
}

type mockCommitStatusDispatcher struct {
	calls []commitStatusDispatchCall
}

func (m *mockCommitStatusDispatcher) DispatchEvent(ctx context.Context, repoID int64, eventType webhooks.EventType, payload any) error {
	m.calls = append(m.calls, commitStatusDispatchCall{repoID: repoID, eventType: eventType, payload: payload})
	return nil
}

func (m *mockCommitStatusDispatcher) DispatchOrgEvent(_ context.Context, _ int64, _ webhooks.EventType, _ any) error {
	return nil
}

type mockCommitStatusQuerier struct {
	getRepoOwnerFn                 func(ctx context.Context, id int64) (db.GetRepoOwnerSlugAndNameByIDRow, error)
	getWorkspaceIncludingDeletedFn func(ctx context.Context, id string) (db.Workspace, error)
	getWorkflowRunFn               func(ctx context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error)
	createCommitStatusFn           func(ctx context.Context, arg db.CreateCommitStatusParams) (db.CommitStatus, error)
	updateByWorkflowRunFn          func(ctx context.Context, arg db.UpdateLatestCommitStatusByWorkflowRunIDParams) (db.CommitStatus, error)
	listCommitStatusesByRefFn      func(ctx context.Context, arg db.ListCommitStatusesByRefParams) ([]db.CommitStatus, error)
	countCommitStatusesByRefFn     func(ctx context.Context, arg db.CountCommitStatusesByRefParams) (int64, error)

	lastCreateArg       db.CreateCommitStatusParams
	lastUpdateArg       db.UpdateLatestCommitStatusByWorkflowRunIDParams
	lastListByRefArg    db.ListCommitStatusesByRefParams
	lastCountByRefArg   db.CountCommitStatusesByRefParams
	createCallCount     int
	updateCallCount     int
	listByRefCallCount  int
	countByRefCallCount int
}

func (m *mockCommitStatusQuerier) GetWorkspaceIncludingDeleted(ctx context.Context, id string) (db.Workspace, error) {
	if m.getWorkspaceIncludingDeletedFn != nil {
		return m.getWorkspaceIncludingDeletedFn(ctx, id)
	}
	return db.Workspace{}, pgx.ErrNoRows
}

func (m *mockCommitStatusQuerier) GetRepoOwnerSlugAndNameByID(ctx context.Context, id int64) (db.GetRepoOwnerSlugAndNameByIDRow, error) {
	if m.getRepoOwnerFn != nil {
		return m.getRepoOwnerFn(ctx, id)
	}
	return db.GetRepoOwnerSlugAndNameByIDRow{OwnerSlug: "alice", RepoName: "demo"}, nil
}

func (m *mockCommitStatusQuerier) GetWorkflowRun(ctx context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error) {
	if m.getWorkflowRunFn != nil {
		return m.getWorkflowRunFn(ctx, arg)
	}
	// Default: the run belongs to the queried repository (repo-scoped lookup ok).
	return db.WorkflowRun{ID: arg.ID, RepositoryID: arg.RepositoryID}, nil
}

func (m *mockCommitStatusQuerier) CreateCommitStatus(ctx context.Context, arg db.CreateCommitStatusParams) (db.CommitStatus, error) {
	m.lastCreateArg = arg
	m.createCallCount++
	if m.createCommitStatusFn != nil {
		return m.createCommitStatusFn(ctx, arg)
	}
	return sampleCommitStatus(), nil
}

func (m *mockCommitStatusQuerier) UpdateLatestCommitStatusByWorkflowRunID(ctx context.Context, arg db.UpdateLatestCommitStatusByWorkflowRunIDParams) (db.CommitStatus, error) {
	m.lastUpdateArg = arg
	m.updateCallCount++
	if m.updateByWorkflowRunFn != nil {
		return m.updateByWorkflowRunFn(ctx, arg)
	}
	status := sampleCommitStatus()
	status.Status = arg.Status
	status.Description = arg.Description
	status.TargetUrl = arg.TargetUrl
	status.WorkflowRunID = arg.WorkflowRunID
	return status, nil
}

func (m *mockCommitStatusQuerier) ListCommitStatusesByRef(ctx context.Context, arg db.ListCommitStatusesByRefParams) ([]db.CommitStatus, error) {
	m.lastListByRefArg = arg
	m.listByRefCallCount++
	if m.listCommitStatusesByRefFn != nil {
		return m.listCommitStatusesByRefFn(ctx, arg)
	}
	return []db.CommitStatus{}, nil
}

func (m *mockCommitStatusQuerier) CountCommitStatusesByRef(ctx context.Context, arg db.CountCommitStatusesByRefParams) (int64, error) {
	m.lastCountByRefArg = arg
	m.countByRefCallCount++
	if m.countCommitStatusesByRefFn != nil {
		return m.countCommitStatusesByRefFn(ctx, arg)
	}
	return 0, nil
}

func sampleCommitStatus() db.CommitStatus {
	now := time.Now().UTC().Truncate(time.Second)
	return db.CommitStatus{
		ID:           1,
		RepositoryID: 10,
		ChangeID: pgtype.Text{
			String: "change-123",
			Valid:  true,
		},
		CommitSha: pgtype.Text{
			String: "deadbeef",
			Valid:  true,
		},
		Context:       "ci/build",
		Status:        "success",
		Description:   "all checks passed",
		TargetUrl:     "https://ci.example.com/run/123",
		WorkflowRunID: pgtype.Int8{Int64: 99, Valid: true},
		CreatedAt:     now,
		UpdatedAt:     now,
	}
}

func commitStatusAPIStatus(t *testing.T, err error) int {
	t.Helper()
	require.Error(t, err)
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok, "expected *pkgerrors.APIError, got %T", err)
	return apiErr.Status
}

func TestCommitStatusService_CreateCommitStatus(t *testing.T) {
	t.Parallel()

	t.Run("creates status for valid input", func(t *testing.T) {
		const workspaceID = "11111111-1111-4111-8111-111111111111"
		mock := &mockCommitStatusQuerier{
			getWorkspaceIncludingDeletedFn: func(ctx context.Context, id string) (db.Workspace, error) {
				assert.Equal(t, workspaceID, id)
				return db.Workspace{ID: workspaceID, RepositoryID: 10, Kind: "vm"}, nil
			},
		}
		svc := NewCommitStatusService(mock)
		changeID := "change-abc"
		workflowRunID := int64(42)

		created, err := svc.CreateCommitStatus(context.Background(), 10, "deadbeef", CreateCommitStatusInput{
			Context:         "  ci/build  ",
			Status:          "success",
			Description:     "ok",
			TargetURL:       "https://ci.example.com/run/1",
			ChangeID:        &changeID,
			WorkflowRunID:   &workflowRunID,
			TargetsAffected: 12,
			TargetsRan:      4,
			TargetsCached:   8,
			DurationMS:      12_000,
			WorkspaceID:     stringPtr(workspaceID),
		})
		require.NoError(t, err)
		assert.Equal(t, int64(1), created.ID)
		assert.Equal(t, 1, mock.createCallCount)
		assert.Equal(t, int64(10), mock.lastCreateArg.RepositoryID)
		assert.Equal(t, "ci/build", mock.lastCreateArg.Context)
		assert.Equal(t, "success", mock.lastCreateArg.Status)
		assert.Equal(t, "ok", mock.lastCreateArg.Description)
		assert.Equal(t, "https://ci.example.com/run/1", mock.lastCreateArg.TargetUrl)
		assert.True(t, mock.lastCreateArg.ChangeID.Valid)
		assert.Equal(t, "change-abc", mock.lastCreateArg.ChangeID.String)
		assert.True(t, mock.lastCreateArg.CommitSha.Valid)
		assert.Equal(t, "deadbeef", mock.lastCreateArg.CommitSha.String)
		assert.True(t, mock.lastCreateArg.WorkflowRunID.Valid)
		assert.Equal(t, int64(42), mock.lastCreateArg.WorkflowRunID.Int64)
		assert.Equal(t, int64(12), mock.lastCreateArg.TargetsAffected)
		assert.Equal(t, int64(4), mock.lastCreateArg.TargetsRan)
		assert.Equal(t, int64(8), mock.lastCreateArg.TargetsCached)
		assert.Equal(t, int64(12_000), mock.lastCreateArg.DurationMs)
		assert.True(t, mock.lastCreateArg.WorkspaceID.Valid)
	})

	t.Run("rejects negative work counts and duration", func(t *testing.T) {
		for _, tc := range []struct {
			name  string
			field string
			input CreateCommitStatusInput
		}{
			{name: "affected", field: "targets_affected", input: CreateCommitStatusInput{TargetsAffected: -1}},
			{name: "ran", field: "targets_ran", input: CreateCommitStatusInput{TargetsRan: -1}},
			{name: "cached", field: "targets_cached", input: CreateCommitStatusInput{TargetsCached: -1}},
			{name: "duration", field: "duration_ms", input: CreateCommitStatusInput{DurationMS: -1}},
		} {
			t.Run(tc.name, func(t *testing.T) {
				mock := &mockCommitStatusQuerier{}
				tc.input.Context = "ci/build"
				tc.input.Status = "success"
				_, err := NewCommitStatusService(mock).CreateCommitStatus(context.Background(), 10, "deadbeef", tc.input)
				var apiErr *pkgerrors.APIError
				require.ErrorAs(t, err, &apiErr)
				require.Len(t, apiErr.Errors, 1)
				assert.Equal(t, tc.field, apiErr.Errors[0].Field)
				assert.Zero(t, mock.createCallCount)
			})
		}
	})

	t.Run("rejects invalid or cross-repository workspace", func(t *testing.T) {
		const workspaceID = "22222222-2222-4222-8222-222222222222"
		for _, tc := range []struct {
			name string
			id   string
			repo int64
		}{
			{name: "malformed", id: "not-a-uuid", repo: 10},
			{name: "other repository", id: workspaceID, repo: 11},
		} {
			t.Run(tc.name, func(t *testing.T) {
				mock := &mockCommitStatusQuerier{
					getWorkspaceIncludingDeletedFn: func(context.Context, string) (db.Workspace, error) {
						return db.Workspace{ID: tc.id, RepositoryID: tc.repo}, nil
					},
				}
				_, err := NewCommitStatusService(mock).CreateCommitStatus(context.Background(), 10, "deadbeef", CreateCommitStatusInput{
					Context: "ci/build", Status: "success", WorkspaceID: &tc.id,
				})
				var apiErr *pkgerrors.APIError
				require.ErrorAs(t, err, &apiErr)
				require.Len(t, apiErr.Errors, 1)
				assert.Equal(t, "workspace_id", apiErr.Errors[0].Field)
				assert.Zero(t, mock.createCallCount)
			})
		}
	})

	t.Run("creates status for change id without commit sha", func(t *testing.T) {
		mock := &mockCommitStatusQuerier{}
		svc := NewCommitStatusService(mock)
		changeID := "change-only"

		_, err := svc.CreateCommitStatus(context.Background(), 10, "   ", CreateCommitStatusInput{
			Context:  "ci/build",
			Status:   "pending",
			ChangeID: &changeID,
		})
		require.NoError(t, err)
		assert.True(t, mock.lastCreateArg.ChangeID.Valid)
		assert.Equal(t, "change-only", mock.lastCreateArg.ChangeID.String)
		assert.False(t, mock.lastCreateArg.CommitSha.Valid)
	})

	t.Run("missing context returns 422 validation error", func(t *testing.T) {
		mock := &mockCommitStatusQuerier{}
		svc := NewCommitStatusService(mock)
		_, err := svc.CreateCommitStatus(context.Background(), 10, "deadbeef", CreateCommitStatusInput{Status: "success"})
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 422, apiErr.Status)
		require.Len(t, apiErr.Errors, 1)
		assert.Equal(t, pkgerrors.FieldError{Resource: "CommitStatus", Field: "context", Code: "missing_field"}, apiErr.Errors[0])
	})

	t.Run("empty context whitespace returns 422", func(t *testing.T) {
		mock := &mockCommitStatusQuerier{}
		svc := NewCommitStatusService(mock)
		_, err := svc.CreateCommitStatus(context.Background(), 10, "deadbeef", CreateCommitStatusInput{
			Context: "   ",
			Status:  "success",
		})
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 422, apiErr.Status)
		require.Len(t, apiErr.Errors, 1)
		assert.Equal(t, pkgerrors.FieldError{Resource: "CommitStatus", Field: "context", Code: "missing_field"}, apiErr.Errors[0])
	})

	t.Run("context exceeding 255 chars returns 422", func(t *testing.T) {
		mock := &mockCommitStatusQuerier{}
		svc := NewCommitStatusService(mock)
		_, err := svc.CreateCommitStatus(context.Background(), 10, "deadbeef", CreateCommitStatusInput{
			Context: strings.Repeat("a", 256),
			Status:  "success",
		})
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 422, apiErr.Status)
		require.Len(t, apiErr.Errors, 1)
		assert.Equal(t, pkgerrors.FieldError{Resource: "CommitStatus", Field: "context", Code: "invalid"}, apiErr.Errors[0])
	})

	t.Run("invalid status value returns 422", func(t *testing.T) {
		mock := &mockCommitStatusQuerier{}
		svc := NewCommitStatusService(mock)
		_, err := svc.CreateCommitStatus(context.Background(), 10, "deadbeef", CreateCommitStatusInput{
			Context: "ci/build",
			Status:  "done",
		})
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 422, apiErr.Status)
		require.Len(t, apiErr.Errors, 1)
		assert.Equal(t, pkgerrors.FieldError{Resource: "CommitStatus", Field: "status", Code: "invalid"}, apiErr.Errors[0])
	})

	t.Run("missing status returns 422", func(t *testing.T) {
		mock := &mockCommitStatusQuerier{}
		svc := NewCommitStatusService(mock)
		_, err := svc.CreateCommitStatus(context.Background(), 10, "deadbeef", CreateCommitStatusInput{
			Context: "ci/build",
			Status:  "",
		})
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 422, apiErr.Status)
		require.Len(t, apiErr.Errors, 1)
		assert.Equal(t, pkgerrors.FieldError{Resource: "CommitStatus", Field: "status", Code: "missing_field"}, apiErr.Errors[0])
	})

	t.Run("missing sha and change id returns 422", func(t *testing.T) {
		mock := &mockCommitStatusQuerier{}
		svc := NewCommitStatusService(mock)
		_, err := svc.CreateCommitStatus(context.Background(), 10, "   ", CreateCommitStatusInput{
			Context: "ci/build",
			Status:  "pending",
		})
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 422, apiErr.Status)
		require.Len(t, apiErr.Errors, 1)
		assert.Equal(t, pkgerrors.FieldError{Resource: "CommitStatus", Field: "change_id", Code: "missing_field"}, apiErr.Errors[0])
	})

	t.Run("change_id containing NUL returns 422 (#238)", func(t *testing.T) {
		mock := &mockCommitStatusQuerier{}
		svc := NewCommitStatusService(mock)
		changeID := "bad\x00change"
		_, err := svc.CreateCommitStatus(context.Background(), 10, "deadbeef", CreateCommitStatusInput{
			Context:  "ci/build",
			Status:   "success",
			ChangeID: &changeID,
		})
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 422, apiErr.Status)
		require.Len(t, apiErr.Errors, 1)
		assert.Equal(t, pkgerrors.FieldError{Resource: "CommitStatus", Field: "change_id", Code: "invalid"}, apiErr.Errors[0])
		assert.Equal(t, 0, mock.createCallCount)
	})

	t.Run("change_id exceeding 255 chars returns 422 (#238)", func(t *testing.T) {
		mock := &mockCommitStatusQuerier{}
		svc := NewCommitStatusService(mock)
		changeID := strings.Repeat("a", 256)
		_, err := svc.CreateCommitStatus(context.Background(), 10, "deadbeef", CreateCommitStatusInput{
			Context:  "ci/build",
			Status:   "success",
			ChangeID: &changeID,
		})
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 422, apiErr.Status)
		require.Len(t, apiErr.Errors, 1)
		assert.Equal(t, pkgerrors.FieldError{Resource: "CommitStatus", Field: "change_id", Code: "invalid"}, apiErr.Errors[0])
		assert.Equal(t, 0, mock.createCallCount)
	})

	t.Run("sha exceeding 255 chars returns 422 (#238)", func(t *testing.T) {
		mock := &mockCommitStatusQuerier{}
		svc := NewCommitStatusService(mock)
		_, err := svc.CreateCommitStatus(context.Background(), 10, strings.Repeat("a", 256), CreateCommitStatusInput{
			Context: "ci/build",
			Status:  "success",
		})
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 422, apiErr.Status)
		require.Len(t, apiErr.Errors, 1)
		assert.Equal(t, pkgerrors.FieldError{Resource: "CommitStatus", Field: "sha", Code: "invalid"}, apiErr.Errors[0])
		assert.Equal(t, 0, mock.createCallCount)
	})

	t.Run("sha with invalid UTF-8 returns 422 (#238)", func(t *testing.T) {
		mock := &mockCommitStatusQuerier{}
		svc := NewCommitStatusService(mock)
		_, err := svc.CreateCommitStatus(context.Background(), 10, "dead\xffbeef", CreateCommitStatusInput{
			Context: "ci/build",
			Status:  "success",
		})
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 422, apiErr.Status)
		require.Len(t, apiErr.Errors, 1)
		assert.Equal(t, pkgerrors.FieldError{Resource: "CommitStatus", Field: "sha", Code: "invalid"}, apiErr.Errors[0])
		assert.Equal(t, 0, mock.createCallCount)
	})

	t.Run("valid 40-char hex sha and change_id still succeeds (#238)", func(t *testing.T) {
		mock := &mockCommitStatusQuerier{}
		svc := NewCommitStatusService(mock)
		changeID := "qpvuntsm"
		sha := strings.Repeat("a", 40)
		created, err := svc.CreateCommitStatus(context.Background(), 10, sha, CreateCommitStatusInput{
			Context:  "ci/build",
			Status:   "success",
			ChangeID: &changeID,
		})
		require.NoError(t, err)
		assert.Equal(t, int64(1), created.ID)
		assert.Equal(t, sha, mock.lastCreateArg.CommitSha.String)
		assert.Equal(t, changeID, mock.lastCreateArg.ChangeID.String)
	})

	t.Run("valid status values accepted", func(t *testing.T) {
		validStatuses := []string{"pending", "success", "failure", "error", "cancelled"}
		for _, status := range validStatuses {
			status := status
			t.Run(status, func(t *testing.T) {
				mock := &mockCommitStatusQuerier{}
				svc := NewCommitStatusService(mock)
				_, err := svc.CreateCommitStatus(context.Background(), 10, "deadbeef", CreateCommitStatusInput{
					Context: "ci/build",
					Status:  status,
				})
				require.NoError(t, err)
				assert.Equal(t, status, mock.lastCreateArg.Status)
			})
		}
	})

	t.Run("empty description defaults to empty string", func(t *testing.T) {
		mock := &mockCommitStatusQuerier{}
		svc := NewCommitStatusService(mock)
		_, err := svc.CreateCommitStatus(context.Background(), 10, "deadbeef", CreateCommitStatusInput{
			Context:     "ci/build",
			Status:      "success",
			Description: "",
		})
		require.NoError(t, err)
		assert.Equal(t, "", mock.lastCreateArg.Description)
	})

	t.Run("empty target_url defaults to empty string", func(t *testing.T) {
		mock := &mockCommitStatusQuerier{}
		svc := NewCommitStatusService(mock)
		_, err := svc.CreateCommitStatus(context.Background(), 10, "deadbeef", CreateCommitStatusInput{
			Context:   "ci/build",
			Status:    "success",
			TargetURL: "",
		})
		require.NoError(t, err)
		assert.Equal(t, "", mock.lastCreateArg.TargetUrl)
	})

	t.Run("valid http and https target_url values accepted", func(t *testing.T) {
		for _, targetURL := range []string{
			"http://ci.example.com/run/1",
			"https://ci.example.com/run/1?job=unit#logs",
		} {
			targetURL := targetURL
			t.Run(targetURL, func(t *testing.T) {
				mock := &mockCommitStatusQuerier{}
				svc := NewCommitStatusService(mock)
				_, err := svc.CreateCommitStatus(context.Background(), 10, "deadbeef", CreateCommitStatusInput{
					Context:   "ci/build",
					Status:    "success",
					TargetURL: targetURL,
				})
				require.NoError(t, err)
				assert.Equal(t, targetURL, mock.lastCreateArg.TargetUrl)
			})
		}
	})

	t.Run("invalid target_url returns 422 without creating status", func(t *testing.T) {
		for _, targetURL := range []string{
			"javascript:alert(document.cookie)",
			"data:text/html,hello",
			"ftp://ci.example.com/run/1",
			"https:ci.example.com/run/1",
			"http://:8080/run/1",
			"://ci.example.com/run/1",
			strings.Repeat("a", maxCommitStatusURLLength+1),
		} {
			targetURL := targetURL
			t.Run(targetURL, func(t *testing.T) {
				mock := &mockCommitStatusQuerier{}
				svc := NewCommitStatusService(mock)
				_, err := svc.CreateCommitStatus(context.Background(), 10, "deadbeef", CreateCommitStatusInput{
					Context:   "ci/build",
					Status:    "success",
					TargetURL: targetURL,
				})
				require.Error(t, err)
				var apiErr *pkgerrors.APIError
				require.ErrorAs(t, err, &apiErr)
				assert.Equal(t, 422, apiErr.Status)
				require.Len(t, apiErr.Errors, 1)
				assert.Equal(t, pkgerrors.FieldError{Resource: "CommitStatus", Field: "target_url", Code: "invalid"}, apiErr.Errors[0])
				assert.Equal(t, 0, mock.createCallCount)
			})
		}
	})

	t.Run("description exceeding length limit returns 422 without creating status", func(t *testing.T) {
		mock := &mockCommitStatusQuerier{}
		svc := NewCommitStatusService(mock)
		_, err := svc.CreateCommitStatus(context.Background(), 10, "deadbeef", CreateCommitStatusInput{
			Context:     "ci/build",
			Status:      "success",
			Description: strings.Repeat("a", maxCommitStatusDescriptionLength+1),
		})
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 422, apiErr.Status)
		require.Len(t, apiErr.Errors, 1)
		assert.Equal(t, pkgerrors.FieldError{Resource: "CommitStatus", Field: "description", Code: "invalid"}, apiErr.Errors[0])
		assert.Equal(t, 0, mock.createCallCount)
	})

	t.Run("change_id passed through to querier", func(t *testing.T) {
		mock := &mockCommitStatusQuerier{}
		svc := NewCommitStatusService(mock)
		changeID := "change-xyz"
		_, err := svc.CreateCommitStatus(context.Background(), 10, "deadbeef", CreateCommitStatusInput{
			Context:  "ci/build",
			Status:   "success",
			ChangeID: &changeID,
		})
		require.NoError(t, err)
		assert.True(t, mock.lastCreateArg.ChangeID.Valid)
		assert.Equal(t, "change-xyz", mock.lastCreateArg.ChangeID.String)
	})

	t.Run("nil change_id passed as pgtype.Text invalid", func(t *testing.T) {
		mock := &mockCommitStatusQuerier{}
		svc := NewCommitStatusService(mock)
		_, err := svc.CreateCommitStatus(context.Background(), 10, "deadbeef", CreateCommitStatusInput{
			Context: "ci/build",
			Status:  "success",
		})
		require.NoError(t, err)
		assert.False(t, mock.lastCreateArg.ChangeID.Valid)
	})

	t.Run("db error returns 500", func(t *testing.T) {
		mock := &mockCommitStatusQuerier{
			createCommitStatusFn: func(ctx context.Context, arg db.CreateCommitStatusParams) (db.CommitStatus, error) {
				return db.CommitStatus{}, assert.AnError
			},
		}
		svc := NewCommitStatusService(mock)
		_, err := svc.CreateCommitStatus(context.Background(), 10, "deadbeef", CreateCommitStatusInput{
			Context: "ci/build",
			Status:  "success",
		})
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 500, apiErr.Status)
		assert.Equal(t, "failed to create commit status", apiErr.Message)
	})
}

func TestCommitStatusService_UpdateCommitStatusForWorkflowRun(t *testing.T) {
	t.Parallel()

	t.Run("updates latest status row for workflow run", func(t *testing.T) {
		mock := &mockCommitStatusQuerier{}
		svc := NewCommitStatusService(mock)

		updated, err := svc.UpdateCommitStatusForWorkflowRun(context.Background(), 42, "success", "Workflow completed successfully", "https://smithers.example/runs/42")
		require.NoError(t, err)
		assert.Equal(t, "success", updated.Status)
		assert.Equal(t, int64(42), mock.lastUpdateArg.WorkflowRunID.Int64)
		assert.Equal(t, "Workflow completed successfully", mock.lastUpdateArg.Description)
	})

	t.Run("invalid target_url returns 422 without updating status", func(t *testing.T) {
		mock := &mockCommitStatusQuerier{}
		svc := NewCommitStatusService(mock)

		_, err := svc.UpdateCommitStatusForWorkflowRun(context.Background(), 42, "success", "done", "javascript:alert(1)")
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 422, apiErr.Status)
		require.Len(t, apiErr.Errors, 1)
		assert.Equal(t, pkgerrors.FieldError{Resource: "CommitStatus", Field: "target_url", Code: "invalid"}, apiErr.Errors[0])
		assert.Equal(t, 0, mock.updateCallCount)
	})

	t.Run("description exceeding length limit returns 422 without updating status", func(t *testing.T) {
		mock := &mockCommitStatusQuerier{}
		svc := NewCommitStatusService(mock)

		_, err := svc.UpdateCommitStatusForWorkflowRun(context.Background(), 42, "success", strings.Repeat("a", maxCommitStatusDescriptionLength+1), "")
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 422, apiErr.Status)
		require.Len(t, apiErr.Errors, 1)
		assert.Equal(t, pkgerrors.FieldError{Resource: "CommitStatus", Field: "description", Code: "invalid"}, apiErr.Errors[0])
		assert.Equal(t, 0, mock.updateCallCount)
	})

	t.Run("returns 404 when no status row exists", func(t *testing.T) {
		mock := &mockCommitStatusQuerier{
			updateByWorkflowRunFn: func(ctx context.Context, arg db.UpdateLatestCommitStatusByWorkflowRunIDParams) (db.CommitStatus, error) {
				return db.CommitStatus{}, pgx.ErrNoRows
			},
		}
		svc := NewCommitStatusService(mock)

		_, err := svc.UpdateCommitStatusForWorkflowRun(context.Background(), 42, "success", "done", "")
		assert.Equal(t, 404, commitStatusAPIStatus(t, err))
	})
}

func TestCommitStatusService_ListCommitStatuses(t *testing.T) {
	t.Parallel()

	t.Run("returns statuses and total count for ref", func(t *testing.T) {
		status := sampleCommitStatus()
		mock := &mockCommitStatusQuerier{
			listCommitStatusesByRefFn: func(ctx context.Context, arg db.ListCommitStatusesByRefParams) ([]db.CommitStatus, error) {
				assert.Equal(t, int64(10), arg.RepositoryID)
				assert.True(t, arg.Ref.Valid)
				assert.Equal(t, "change-123", arg.Ref.String)
				assert.Equal(t, int32(30), arg.PageSize)
				assert.Equal(t, int32(0), arg.PageOffset)
				return []db.CommitStatus{status}, nil
			},
			countCommitStatusesByRefFn: func(ctx context.Context, arg db.CountCommitStatusesByRefParams) (int64, error) {
				assert.Equal(t, int64(10), arg.RepositoryID)
				assert.True(t, arg.Ref.Valid)
				assert.Equal(t, "change-123", arg.Ref.String)
				return 5, nil
			},
		}
		svc := NewCommitStatusService(mock)
		statuses, total, err := svc.ListCommitStatuses(context.Background(), 10, "change-123", 1, 30)
		require.NoError(t, err)
		require.Len(t, statuses, 1)
		assert.Equal(t, status.ID, statuses[0].ID)
		assert.Equal(t, int64(5), total)
		assert.Equal(t, 1, mock.countByRefCallCount)
	})

	t.Run("pagination params passed through", func(t *testing.T) {
		mock := &mockCommitStatusQuerier{
			countCommitStatusesByRefFn: func(ctx context.Context, arg db.CountCommitStatusesByRefParams) (int64, error) {
				return 25, nil
			},
		}
		svc := NewCommitStatusService(mock)
		_, total, err := svc.ListCommitStatuses(context.Background(), 10, "deadbeef", 2, 10)
		require.NoError(t, err)
		assert.Equal(t, int32(10), mock.lastListByRefArg.PageSize)
		assert.Equal(t, int32(10), mock.lastListByRefArg.PageOffset)
		assert.Equal(t, int64(25), total)
	})

	t.Run("large page offset clamps instead of overflowing negative", func(t *testing.T) {
		mock := &mockCommitStatusQuerier{
			countCommitStatusesByRefFn: func(ctx context.Context, arg db.CountCommitStatusesByRefParams) (int64, error) {
				return 0, nil
			},
		}
		svc := NewCommitStatusService(mock)
		_, total, err := svc.ListCommitStatuses(context.Background(), 10, "deadbeef", math.MaxInt32+2, 1)
		require.NoError(t, err)
		assert.Equal(t, int32(1), mock.lastListByRefArg.PageSize)
		assert.Equal(t, int32(math.MaxInt32), mock.lastListByRefArg.PageOffset)
		assert.GreaterOrEqual(t, mock.lastListByRefArg.PageOffset, int32(0))
		assert.Equal(t, int64(0), total)
	})

	t.Run("empty results returns empty slice and zero total", func(t *testing.T) {
		mock := &mockCommitStatusQuerier{
			listCommitStatusesByRefFn: func(ctx context.Context, arg db.ListCommitStatusesByRefParams) ([]db.CommitStatus, error) {
				return nil, nil
			},
			countCommitStatusesByRefFn: func(ctx context.Context, arg db.CountCommitStatusesByRefParams) (int64, error) {
				return 0, nil
			},
		}
		svc := NewCommitStatusService(mock)
		statuses, total, err := svc.ListCommitStatuses(context.Background(), 10, "deadbeef", 1, 30)
		require.NoError(t, err)
		assert.NotNil(t, statuses)
		assert.Len(t, statuses, 0)
		assert.Equal(t, int64(0), total)
	})

	t.Run("count db error returns 500", func(t *testing.T) {
		mock := &mockCommitStatusQuerier{
			countCommitStatusesByRefFn: func(ctx context.Context, arg db.CountCommitStatusesByRefParams) (int64, error) {
				return 0, assert.AnError
			},
		}
		svc := NewCommitStatusService(mock)
		_, _, err := svc.ListCommitStatuses(context.Background(), 10, "deadbeef", 1, 30)
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 500, apiErr.Status)
		assert.Equal(t, "failed to count commit statuses", apiErr.Message)
	})

	t.Run("list db error returns 500", func(t *testing.T) {
		mock := &mockCommitStatusQuerier{
			listCommitStatusesByRefFn: func(ctx context.Context, arg db.ListCommitStatusesByRefParams) ([]db.CommitStatus, error) {
				return nil, assert.AnError
			},
			countCommitStatusesByRefFn: func(ctx context.Context, arg db.CountCommitStatusesByRefParams) (int64, error) {
				return 5, nil
			},
		}
		svc := NewCommitStatusService(mock)
		_, _, err := svc.ListCommitStatuses(context.Background(), 10, "deadbeef", 1, 30)
		require.Error(t, err)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr)
		assert.Equal(t, 500, apiErr.Status)
		assert.Equal(t, "failed to list commit statuses", apiErr.Message)
	})
}

func TestCommitStatusService_DispatchesStatusWebhookOnCreate(t *testing.T) {
	t.Parallel()

	dispatcher := &mockCommitStatusDispatcher{}
	changeID := "change-abc"
	mock := &mockCommitStatusQuerier{
		createCommitStatusFn: func(ctx context.Context, arg db.CreateCommitStatusParams) (db.CommitStatus, error) {
			// Return a record that mirrors what was passed in, so the payload reflects inputs.
			return db.CommitStatus{
				ID:           55,
				RepositoryID: arg.RepositoryID,
				ChangeID:     arg.ChangeID,
				CommitSha:    arg.CommitSha,
				Context:      arg.Context,
				Status:       arg.Status,
				Description:  arg.Description,
				TargetUrl:    arg.TargetUrl,
			}, nil
		},
	}

	svc := NewCommitStatusService(mock, WithCommitStatusWebhookDispatcher(dispatcher))
	_, err := svc.CreateCommitStatus(context.Background(), 10, "deadbeef", CreateCommitStatusInput{
		Context:   "ci/test",
		Status:    "success",
		ChangeID:  &changeID,
		TargetURL: "https://ci.example.com/run/99",
		Actor:     &db.User{ID: 7, Username: "alice"},
	})
	require.NoError(t, err)

	// Dispatcher should have been called once with "status" event type.
	require.Len(t, dispatcher.calls, 1)
	call := dispatcher.calls[0]
	assert.Equal(t, int64(10), call.repoID)
	assert.Equal(t, webhooks.EventTypeStatus, call.eventType)

	payload, ok := call.payload.(webhooks.CommitStatusEventPayload)
	require.True(t, ok, "payload should be CommitStatusEventPayload")
	assert.Equal(t, "deadbeef", payload.CommitStatus.SHA)
	assert.Equal(t, "change-abc", payload.CommitStatus.ChangeID)
	assert.Equal(t, "ci/test", payload.CommitStatus.Context)
	assert.Equal(t, "success", payload.CommitStatus.Status)
	assert.Equal(t, "https://ci.example.com/run/99", payload.CommitStatus.TargetURL)
	assert.Equal(t, int64(10), payload.Repository.ID)
	assert.Equal(t, "demo", payload.Repository.Name)
	assert.Equal(t, "alice/demo", payload.Repository.FullName)
	assert.Equal(t, int64(7), payload.Sender.ID)
	assert.Equal(t, "alice", payload.Sender.Login)
}

func TestCommitStatusService_NoDispatchWithoutDispatcher(t *testing.T) {
	t.Parallel()
	// With no dispatcher wired, CreateCommitStatus succeeds without panicking.
	mock := &mockCommitStatusQuerier{}
	svc := NewCommitStatusService(mock)
	_, err := svc.CreateCommitStatus(context.Background(), 10, "abc123", CreateCommitStatusInput{
		Context: "ci/lint",
		Status:  "pending",
	})
	require.NoError(t, err)
	assert.Equal(t, 1, mock.createCallCount)
}

// github-sync matches a status event to its mirror by full_name, so the
// payload names the repository owner resolved from the repository row.
func TestCommitStatusService_CreateCommitStatus_NamesRepositoryByFullName(t *testing.T) {
	t.Parallel()

	dispatcher := &mockCommitStatusDispatcher{}
	mock := &mockCommitStatusQuerier{
		getRepoOwnerFn: func(ctx context.Context, id int64) (db.GetRepoOwnerSlugAndNameByIDRow, error) {
			require.Equal(t, int64(10), id)
			return db.GetRepoOwnerSlugAndNameByIDRow{OwnerSlug: "acme", RepoName: "resolved-repo"}, nil
		},
	}
	svc := NewCommitStatusService(mock, WithCommitStatusWebhookDispatcher(dispatcher))

	_, err := svc.CreateCommitStatus(context.Background(), 10, "abc123", CreateCommitStatusInput{
		Context: "ci/build",
		Status:  "pending",
	})
	require.NoError(t, err)
	require.Len(t, dispatcher.calls, 1)
	payload := dispatcher.calls[0].payload.(webhooks.CommitStatusEventPayload)
	assert.Equal(t, "resolved-repo", payload.Repository.Name)
	assert.Equal(t, "acme/resolved-repo", payload.Repository.FullName)
}

func TestCommitStatusService_CreateCommitStatus_SkipsWebhookWhenRepositoryLookupFails(t *testing.T) {
	t.Parallel()

	dispatcher := &mockCommitStatusDispatcher{}
	mock := &mockCommitStatusQuerier{
		getRepoOwnerFn: func(context.Context, int64) (db.GetRepoOwnerSlugAndNameByIDRow, error) {
			return db.GetRepoOwnerSlugAndNameByIDRow{}, errors.New("repo failed")
		},
	}
	svc := NewCommitStatusService(mock, WithCommitStatusWebhookDispatcher(dispatcher))

	_, err := svc.CreateCommitStatus(context.Background(), 10, "abc123", CreateCommitStatusInput{
		Context: "ci/build",
		Status:  "pending",
	})
	require.NoError(t, err)
	assert.Empty(t, dispatcher.calls)
}

func TestCommitStatusService_UpdateCommitStatusForWorkflowRun_DispatchesWebhook(t *testing.T) {
	t.Parallel()

	dispatcher := &mockCommitStatusDispatcher{}
	mock := &mockCommitStatusQuerier{
		updateByWorkflowRunFn: func(ctx context.Context, arg db.UpdateLatestCommitStatusByWorkflowRunIDParams) (db.CommitStatus, error) {
			return db.CommitStatus{
				ID:           55,
				RepositoryID: 10,
				CommitSha:    pgtype.Text{String: "deadbeef", Valid: true},
				Context:      "ci/build",
				Status:       arg.Status,
				Description:  arg.Description,
				TargetUrl:    arg.TargetUrl,
				WorkflowRunID: pgtype.Int8{
					Int64: 42,
					Valid: true,
				},
			}, nil
		},
	}
	svc := NewCommitStatusService(mock, WithCommitStatusWebhookDispatcher(dispatcher))

	_, err := svc.UpdateCommitStatusForWorkflowRun(context.Background(), 42, "success", "done", "")
	require.NoError(t, err)
	require.Len(t, dispatcher.calls, 1)
	payload := dispatcher.calls[0].payload.(webhooks.CommitStatusEventPayload)
	assert.Equal(t, "success", payload.CommitStatus.Status)
	assert.Equal(t, "demo", payload.Repository.Name)
}

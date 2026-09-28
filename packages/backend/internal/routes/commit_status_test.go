package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type mockCommitStatusRouteService struct {
	listCommitStatusesFn func(ctx context.Context, repositoryID int64, ref string, page, perPage int) ([]db.CommitStatus, int64, error)
	createCommitStatusFn func(ctx context.Context, repositoryID int64, sha string, input services.CreateCommitStatusInput) (db.CommitStatus, error)
}

func (m *mockCommitStatusRouteService) ListCommitStatuses(ctx context.Context, repositoryID int64, ref string, page, perPage int) ([]db.CommitStatus, int64, error) {
	if m.listCommitStatusesFn != nil {
		return m.listCommitStatusesFn(ctx, repositoryID, ref, page, perPage)
	}
	return []db.CommitStatus{}, 0, nil
}

func (m *mockCommitStatusRouteService) CreateCommitStatus(ctx context.Context, repositoryID int64, sha string, input services.CreateCommitStatusInput) (db.CommitStatus, error) {
	if m.createCommitStatusFn != nil {
		return m.createCommitStatusFn(ctx, repositoryID, sha, input)
	}
	return db.CommitStatus{}, nil
}

func sampleCommitStatusDB() db.CommitStatus {
	now := time.Now().UTC().Truncate(time.Second)
	workspaceID := pgtype.UUID{}
	_ = workspaceID.Scan("11111111-1111-4111-8111-111111111111")
	return db.CommitStatus{
		ID:           1,
		RepositoryID: 101,
		ChangeID: pgtype.Text{
			String: "change-123",
			Valid:  true,
		},
		CommitSha: pgtype.Text{
			String: "deadbeef",
			Valid:  true,
		},
		Context:         "ci/build",
		Status:          "success",
		Description:     "all checks passed",
		TargetUrl:       "https://ci.example.com/run/123",
		WorkflowRunID:   pgtype.Int8{Int64: 17, Valid: true},
		TargetsAffected: 12,
		TargetsRan:      4,
		TargetsCached:   8,
		DurationMs:      12_000,
		WorkspaceID:     workspaceID,
		CreatedAt:       now,
		UpdatedAt:       now,
	}
}

func TestToCommitStatusResponse(t *testing.T) {
	t.Parallel()

	t.Run("maps valid pgtype text and int8 fields to pointers", func(t *testing.T) {
		status := sampleCommitStatusDB()

		got := toCommitStatusResponse(status)

		require.NotNil(t, got.ChangeID)
		assert.Equal(t, "change-123", *got.ChangeID)
		require.NotNil(t, got.CommitSHA)
		assert.Equal(t, "deadbeef", *got.CommitSHA)
		require.NotNil(t, got.WorkflowRunID)
		assert.Equal(t, int64(17), *got.WorkflowRunID)
		assert.Equal(t, int64(12), got.TargetsAffected)
		assert.Equal(t, int64(4), got.TargetsRan)
		assert.Equal(t, int64(8), got.TargetsCached)
		assert.Equal(t, int64(12_000), got.DurationMS)
		require.NotNil(t, got.WorkspaceID)
		assert.Equal(t, "11111111-1111-4111-8111-111111111111", *got.WorkspaceID)
	})

	t.Run("maps invalid pgtype text and int8 fields to nil", func(t *testing.T) {
		status := sampleCommitStatusDB()
		status.ChangeID = pgtype.Text{}
		status.CommitSha = pgtype.Text{}
		status.WorkflowRunID = pgtype.Int8{}
		status.WorkspaceID = pgtype.UUID{}

		got := toCommitStatusResponse(status)

		assert.Nil(t, got.ChangeID)
		assert.Nil(t, got.CommitSHA)
		assert.Nil(t, got.WorkflowRunID)
		assert.Nil(t, got.WorkspaceID)
	})
}

func withCommitStatusRepoContext(req *http.Request, repoID int64) *http.Request {
	repository := &db.Repository{ID: repoID, Name: "demo", LowerName: "demo"}
	ctx := middleware.ContextWithRepoContext(req.Context(), &middleware.RepoContext{
		Owner:      "alice",
		Repository: repository,
	}, middleware.PermissionRead)
	return req.WithContext(ctx)
}

func withCommitStatusRouteParams(req *http.Request, params map[string]string) *http.Request {
	rctx := chi.NewRouteContext()
	for k, v := range params {
		rctx.URLParams.Add(k, v)
	}
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
}

func withCommitStatusAuth(req *http.Request, userID int64, username string) *http.Request {
	return req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User: &db.User{ID: userID, Username: username, LowerUsername: username},
	}))
}

func TestCommitStatusHandler_GetCommitStatuses(t *testing.T) {
	t.Parallel()

	t.Run("returns statuses array as JSON with 200", func(t *testing.T) {
		status := sampleCommitStatusDB()
		h := CommitStatusHandler{Service: &mockCommitStatusRouteService{
			listCommitStatusesFn: func(ctx context.Context, repositoryID int64, ref string, page, perPage int) ([]db.CommitStatus, int64, error) {
				assert.Equal(t, int64(101), repositoryID)
				assert.Equal(t, "change-123", ref)
				assert.Equal(t, 1, page)
				assert.Equal(t, 30, perPage)
				return []db.CommitStatus{status}, 1, nil
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/commits/change-123/statuses", nil)
		req = withCommitStatusRouteParams(req, map[string]string{"ref": "change-123"})
		req = withCommitStatusRepoContext(req, 101)
		rec := httptest.NewRecorder()
		h.GetCommitStatuses(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)

		var body []map[string]any
		require.NoError(t, json.NewDecoder(rec.Body).Decode(&body))
		require.Len(t, body, 1)
		assert.Equal(t, "ci/build", body[0]["context"])
		assert.Equal(t, "change-123", body[0]["change_id"])
		assert.Equal(t, "deadbeef", body[0]["commit_sha"])
		assert.Equal(t, float64(17), body[0]["workflow_run_id"])
	})

	t.Run("serializes nullable fields as null in response JSON", func(t *testing.T) {
		status := sampleCommitStatusDB()
		status.ChangeID = pgtype.Text{}
		status.CommitSha = pgtype.Text{}
		status.WorkflowRunID = pgtype.Int8{}

		h := CommitStatusHandler{Service: &mockCommitStatusRouteService{
			listCommitStatusesFn: func(ctx context.Context, repositoryID int64, ref string, page, perPage int) ([]db.CommitStatus, int64, error) {
				return []db.CommitStatus{status}, 1, nil
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/commits/deadbeef/statuses", nil)
		req = withCommitStatusRouteParams(req, map[string]string{"ref": "deadbeef"})
		req = withCommitStatusRepoContext(req, 101)
		rec := httptest.NewRecorder()
		h.GetCommitStatuses(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)

		var body []map[string]any
		require.NoError(t, json.NewDecoder(rec.Body).Decode(&body))
		require.Len(t, body, 1)
		assert.Nil(t, body[0]["change_id"])
		assert.Nil(t, body[0]["commit_sha"])
		assert.Nil(t, body[0]["workflow_run_id"])
	})

	t.Run("ref route param extracted correctly", func(t *testing.T) {
		h := CommitStatusHandler{Service: &mockCommitStatusRouteService{
			listCommitStatusesFn: func(ctx context.Context, repositoryID int64, ref string, page, perPage int) ([]db.CommitStatus, int64, error) {
				assert.Equal(t, "deadbeef", ref)
				return []db.CommitStatus{}, 0, nil
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/commits/deadbeef/statuses", nil)
		req = withCommitStatusRouteParams(req, map[string]string{"ref": "deadbeef"})
		req = withCommitStatusRepoContext(req, 101)
		rec := httptest.NewRecorder()
		h.GetCommitStatuses(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
	})

	t.Run("pagination query params parsed", func(t *testing.T) {
		h := CommitStatusHandler{Service: &mockCommitStatusRouteService{
			listCommitStatusesFn: func(ctx context.Context, repositoryID int64, ref string, page, perPage int) ([]db.CommitStatus, int64, error) {
				assert.Equal(t, 2, page)
				assert.Equal(t, 10, perPage)
				return []db.CommitStatus{}, 0, nil
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/commits/deadbeef/statuses?page=2&per_page=10", nil)
		req = withCommitStatusRouteParams(req, map[string]string{"ref": "deadbeef"})
		req = withCommitStatusRepoContext(req, 101)
		rec := httptest.NewRecorder()
		h.GetCommitStatuses(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
	})

	t.Run("invalid pagination returns 400", func(t *testing.T) {
		h := CommitStatusHandler{Service: &mockCommitStatusRouteService{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/commits/deadbeef/statuses?page=-1", nil)
		req = withCommitStatusRouteParams(req, map[string]string{"ref": "deadbeef"})
		req = withCommitStatusRepoContext(req, 101)
		rec := httptest.NewRecorder()
		h.GetCommitStatuses(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("service error propagated", func(t *testing.T) {
		h := CommitStatusHandler{Service: &mockCommitStatusRouteService{
			listCommitStatusesFn: func(ctx context.Context, repositoryID int64, ref string, page, perPage int) ([]db.CommitStatus, int64, error) {
				return nil, 0, pkgerrors.NotFound("repository not found")
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/commits/deadbeef/statuses", nil)
		req = withCommitStatusRouteParams(req, map[string]string{"ref": "deadbeef"})
		req = withCommitStatusRepoContext(req, 101)
		rec := httptest.NewRecorder()
		h.GetCommitStatuses(rec, req)
		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("sets X-Total-Count header", func(t *testing.T) {
		h := CommitStatusHandler{Service: &mockCommitStatusRouteService{
			listCommitStatusesFn: func(ctx context.Context, repositoryID int64, ref string, page, perPage int) ([]db.CommitStatus, int64, error) {
				return []db.CommitStatus{sampleCommitStatusDB()}, 42, nil
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/commits/deadbeef/statuses", nil)
		req = withCommitStatusRouteParams(req, map[string]string{"ref": "deadbeef"})
		req = withCommitStatusRepoContext(req, 101)
		rec := httptest.NewRecorder()
		h.GetCommitStatuses(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "42", rec.Header().Get("X-Total-Count"))
	})

	t.Run("sets Link header with pagination links", func(t *testing.T) {
		h := CommitStatusHandler{Service: &mockCommitStatusRouteService{
			listCommitStatusesFn: func(ctx context.Context, repositoryID int64, ref string, page, perPage int) ([]db.CommitStatus, int64, error) {
				return []db.CommitStatus{sampleCommitStatusDB()}, 50, nil
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/commits/deadbeef/statuses?page=1&per_page=10", nil)
		req = withCommitStatusRouteParams(req, map[string]string{"ref": "deadbeef"})
		req = withCommitStatusRepoContext(req, 101)
		rec := httptest.NewRecorder()
		h.GetCommitStatuses(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		link := rec.Header().Get("Link")
		assert.Contains(t, link, `rel="first"`)
		assert.Contains(t, link, `rel="last"`)
		assert.Contains(t, link, `rel="next"`)
	})
}

func TestCommitStatusHandler_CreateCommitStatus(t *testing.T) {
	t.Parallel()

	t.Run("creates status returns 201 with JSON body", func(t *testing.T) {
		status := sampleCommitStatusDB()
		h := CommitStatusHandler{Service: &mockCommitStatusRouteService{
			createCommitStatusFn: func(ctx context.Context, repositoryID int64, sha string, input services.CreateCommitStatusInput) (db.CommitStatus, error) {
				assert.Equal(t, int64(101), repositoryID)
				assert.Equal(t, "deadbeef", sha)
				assert.Equal(t, "ci/build", input.Context)
				assert.Equal(t, "success", input.Status)
				assert.Equal(t, int64(12), input.TargetsAffected)
				assert.Equal(t, int64(4), input.TargetsRan)
				assert.Equal(t, int64(8), input.TargetsCached)
				assert.Equal(t, int64(12_000), input.DurationMS)
				require.NotNil(t, input.WorkspaceID)
				assert.Equal(t, "11111111-1111-4111-8111-111111111111", *input.WorkspaceID)
				return status, nil
			},
		}}
		body := `{"context":"ci/build","status":"success","description":"ok","target_url":"https://ci.example.com/run/123","targets_affected":12,"targets_ran":4,"targets_cached":8,"duration_ms":12000,"workspace_id":"11111111-1111-4111-8111-111111111111"}`
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/statuses/deadbeef", strings.NewReader(body))
		req = withCommitStatusRouteParams(req, map[string]string{"sha": "deadbeef"})
		req = withCommitStatusRepoContext(req, 101)
		req = withCommitStatusAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.CreateCommitStatus(rec, req)
		require.Equal(t, http.StatusCreated, rec.Code)

		var got map[string]any
		require.NoError(t, json.NewDecoder(rec.Body).Decode(&got))
		assert.Equal(t, "ci/build", got["context"])
		assert.Equal(t, "success", got["status"])
		assert.Equal(t, "change-123", got["change_id"])
		assert.Equal(t, "deadbeef", got["commit_sha"])
		assert.Equal(t, float64(17), got["workflow_run_id"])
		assert.Equal(t, float64(12), got["targets_affected"])
		assert.Equal(t, float64(4), got["targets_ran"])
		assert.Equal(t, float64(8), got["targets_cached"])
		assert.Equal(t, float64(12_000), got["duration_ms"])
		assert.Equal(t, "11111111-1111-4111-8111-111111111111", got["workspace_id"])
	})

	t.Run("serializes nullable fields as null in create response JSON", func(t *testing.T) {
		status := sampleCommitStatusDB()
		status.ChangeID = pgtype.Text{}
		status.CommitSha = pgtype.Text{}
		status.WorkflowRunID = pgtype.Int8{}
		status.WorkspaceID = pgtype.UUID{}

		h := CommitStatusHandler{Service: &mockCommitStatusRouteService{
			createCommitStatusFn: func(ctx context.Context, repositoryID int64, sha string, input services.CreateCommitStatusInput) (db.CommitStatus, error) {
				return status, nil
			},
		}}
		body := `{"context":"ci/build","status":"success","description":"ok","target_url":"https://ci.example.com/run/123"}`
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/statuses/deadbeef", strings.NewReader(body))
		req = withCommitStatusRouteParams(req, map[string]string{"sha": "deadbeef"})
		req = withCommitStatusRepoContext(req, 101)
		req = withCommitStatusAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.CreateCommitStatus(rec, req)
		require.Equal(t, http.StatusCreated, rec.Code)

		var got map[string]any
		require.NoError(t, json.NewDecoder(rec.Body).Decode(&got))
		assert.Nil(t, got["change_id"])
		assert.Nil(t, got["commit_sha"])
		assert.Nil(t, got["workflow_run_id"])
		assert.Nil(t, got["workspace_id"])
	})

	t.Run("sha route param extracted correctly", func(t *testing.T) {
		h := CommitStatusHandler{Service: &mockCommitStatusRouteService{
			createCommitStatusFn: func(ctx context.Context, repositoryID int64, sha string, input services.CreateCommitStatusInput) (db.CommitStatus, error) {
				assert.Equal(t, "feedface", sha)
				return sampleCommitStatusDB(), nil
			},
		}}
		body := `{"context":"ci/build","status":"success"}`
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/statuses/feedface", strings.NewReader(body))
		req = withCommitStatusRouteParams(req, map[string]string{"sha": "feedface"})
		req = withCommitStatusRepoContext(req, 101)
		req = withCommitStatusAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.CreateCommitStatus(rec, req)
		require.Equal(t, http.StatusCreated, rec.Code)
	})

	t.Run("sha with control chars returns 400 before reaching the service (#238)", func(t *testing.T) {
		serviceCalled := false
		h := CommitStatusHandler{Service: &mockCommitStatusRouteService{
			createCommitStatusFn: func(ctx context.Context, repositoryID int64, sha string, input services.CreateCommitStatusInput) (db.CommitStatus, error) {
				serviceCalled = true
				return sampleCommitStatusDB(), nil
			},
		}}
		body := `{"context":"ci/build","status":"success"}`
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/statuses/dead%0Abeef", strings.NewReader(body))
		req = withCommitStatusRouteParams(req, map[string]string{"sha": "dead\nbeef"})
		req = withCommitStatusRepoContext(req, 101)
		req = withCommitStatusAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.CreateCommitStatus(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)

		var respBody map[string]any
		require.NoError(t, json.NewDecoder(rec.Body).Decode(&respBody))
		assert.Equal(t, "ref contains invalid characters", respBody["message"])
		assert.False(t, serviceCalled, "service must not be called for an invalid sha")
	})

	t.Run("invalid JSON body returns 400", func(t *testing.T) {
		h := CommitStatusHandler{Service: &mockCommitStatusRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/statuses/deadbeef", strings.NewReader("not-json"))
		req = withCommitStatusRouteParams(req, map[string]string{"sha": "deadbeef"})
		req = withCommitStatusRepoContext(req, 101)
		req = withCommitStatusAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.CreateCommitStatus(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)

		var body map[string]any
		require.NoError(t, json.NewDecoder(rec.Body).Decode(&body))
		assert.Equal(t, "invalid request body", body["message"])
	})

	t.Run("no auth returns 401", func(t *testing.T) {
		h := CommitStatusHandler{Service: &mockCommitStatusRouteService{}}
		body := `{"context":"ci/build","status":"success"}`
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/statuses/deadbeef", strings.NewReader(body))
		req = withCommitStatusRouteParams(req, map[string]string{"sha": "deadbeef"})
		req = withCommitStatusRepoContext(req, 101)
		rec := httptest.NewRecorder()
		h.CreateCommitStatus(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("service validation error propagated as 422", func(t *testing.T) {
		h := CommitStatusHandler{Service: &mockCommitStatusRouteService{
			createCommitStatusFn: func(ctx context.Context, repositoryID int64, sha string, input services.CreateCommitStatusInput) (db.CommitStatus, error) {
				return db.CommitStatus{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "CommitStatus", Field: "context", Code: "missing_field"})
			},
		}}
		body := `{"context":"","status":"success"}`
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/statuses/deadbeef", strings.NewReader(body))
		req = withCommitStatusRouteParams(req, map[string]string{"sha": "deadbeef"})
		req = withCommitStatusRepoContext(req, 101)
		req = withCommitStatusAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.CreateCommitStatus(rec, req)
		require.Equal(t, http.StatusUnprocessableEntity, rec.Code)
	})

	t.Run("service error propagated", func(t *testing.T) {
		h := CommitStatusHandler{Service: &mockCommitStatusRouteService{
			createCommitStatusFn: func(ctx context.Context, repositoryID int64, sha string, input services.CreateCommitStatusInput) (db.CommitStatus, error) {
				return db.CommitStatus{}, pkgerrors.Internal("failed to create commit status")
			},
		}}
		body := `{"context":"ci/build","status":"success"}`
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/statuses/deadbeef", strings.NewReader(body))
		req = withCommitStatusRouteParams(req, map[string]string{"sha": "deadbeef"})
		req = withCommitStatusRepoContext(req, 101)
		req = withCommitStatusAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.CreateCommitStatus(rec, req)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})
}

func TestCommitStatusHandler_GetCommitStatuses_ForwardsRefAndPagination(t *testing.T) {
	t.Parallel()

	var called bool
	h := CommitStatusHandler{Service: &mockCommitStatusRouteService{
		listCommitStatusesFn: func(ctx context.Context, repositoryID int64, ref string, page, perPage int) ([]db.CommitStatus, int64, error) {
			called = true
			assert.Equal(t, int64(101), repositoryID)
			assert.Equal(t, "ref-from-route", ref)
			assert.Equal(t, 3, page)
			assert.Equal(t, 15, perPage)
			return []db.CommitStatus{}, 0, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/commits/ref-from-route/statuses?page=3&per_page=15", nil)
	req = withCommitStatusRouteParams(req, map[string]string{"ref": "ref-from-route"})
	req = withCommitStatusRepoContext(req, 101)
	rec := httptest.NewRecorder()
	h.GetCommitStatuses(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.True(t, called)
}

func TestCommitStatusHandler_CreateCommitStatus_ForwardsSHAAndPayload(t *testing.T) {
	t.Parallel()

	var called bool
	h := CommitStatusHandler{Service: &mockCommitStatusRouteService{
		createCommitStatusFn: func(ctx context.Context, repositoryID int64, sha string, input services.CreateCommitStatusInput) (db.CommitStatus, error) {
			called = true
			assert.Equal(t, int64(101), repositoryID)
			assert.Equal(t, "feedface", sha)
			assert.Equal(t, "ci/unit", input.Context)
			assert.Equal(t, "pending", input.Status)
			assert.Equal(t, "build running", input.Description)
			assert.Equal(t, "https://ci.example.com/runs/42", input.TargetURL)
			require.NotNil(t, input.ChangeID)
			assert.Equal(t, "change-xyz", *input.ChangeID)
			require.NotNil(t, input.WorkflowRunID)
			assert.Equal(t, int64(42), *input.WorkflowRunID)
			assert.Equal(t, int64(20), input.TargetsAffected)
			assert.Equal(t, int64(7), input.TargetsRan)
			assert.Equal(t, int64(13), input.TargetsCached)
			assert.Equal(t, int64(9_500), input.DurationMS)
			require.NotNil(t, input.WorkspaceID)
			assert.Equal(t, "33333333-3333-4333-8333-333333333333", *input.WorkspaceID)
			require.NotNil(t, input.Actor)
			assert.Equal(t, int64(1), input.Actor.ID)
			assert.Equal(t, "alice", input.Actor.Username)
			return sampleCommitStatusDB(), nil
		},
	}}

	body := `{"context":"ci/unit","status":"pending","description":"build running","target_url":"https://ci.example.com/runs/42","change_id":"change-xyz","workflow_run_id":42,"targets_affected":20,"targets_ran":7,"targets_cached":13,"duration_ms":9500,"workspace_id":"33333333-3333-4333-8333-333333333333"}`
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/statuses/feedface", strings.NewReader(body))
	req = withCommitStatusRouteParams(req, map[string]string{"sha": "feedface"})
	req = withCommitStatusRepoContext(req, 101)
	req = withCommitStatusAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.CreateCommitStatus(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
	assert.True(t, called)
}

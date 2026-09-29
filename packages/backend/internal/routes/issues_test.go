package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type mockIssueRouteService struct {
	listIssuesFn         func(ctx context.Context, viewer *db.User, owner, repo string, afterNumber int64, limit int, state string) ([]services.IssueResponse, string, int64, error)
	createIssueFn        func(ctx context.Context, actor *db.User, owner, repo string, req services.CreateIssueInput) (services.IssueResponse, error)
	getIssueFn           func(ctx context.Context, viewer *db.User, owner, repo string, number int64) (services.IssueResponse, error)
	updateIssueFn        func(ctx context.Context, actor *db.User, owner, repo string, number int64, req services.UpdateIssueInput) (services.IssueResponse, error)
	createIssueCommentFn func(ctx context.Context, actor *db.User, owner, repo string, number int64, req services.CreateIssueCommentInput) (services.IssueCommentResponse, error)
	listIssueCommentsFn  func(ctx context.Context, viewer *db.User, owner, repo string, number int64, afterID int64, limit int) ([]services.IssueCommentResponse, string, int64, error)
	getIssueCommentFn    func(ctx context.Context, viewer *db.User, owner, repo string, commentID int64) (services.IssueCommentResponse, error)
	updateCommentFn      func(ctx context.Context, actor *db.User, owner, repo string, commentID int64, req services.UpdateIssueCommentInput) (services.IssueCommentResponse, error)
	deleteCommentFn      func(ctx context.Context, actor *db.User, owner, repo string, commentID int64) error
}

func (m *mockIssueRouteService) ListIssues(ctx context.Context, viewer *db.User, owner, repo string, afterNumber int64, limit int, state string) ([]services.IssueResponse, string, int64, error) {
	if m.listIssuesFn != nil {
		return m.listIssuesFn(ctx, viewer, owner, repo, afterNumber, limit, state)
	}
	return nil, "", 0, nil
}

func (m *mockIssueRouteService) CreateIssue(ctx context.Context, actor *db.User, owner, repo string, req services.CreateIssueInput) (services.IssueResponse, error) {
	if m.createIssueFn != nil {
		return m.createIssueFn(ctx, actor, owner, repo, req)
	}
	return services.IssueResponse{}, nil
}

func (m *mockIssueRouteService) GetIssue(ctx context.Context, viewer *db.User, owner, repo string, number int64) (services.IssueResponse, error) {
	if m.getIssueFn != nil {
		return m.getIssueFn(ctx, viewer, owner, repo, number)
	}
	return services.IssueResponse{}, nil
}

func (m *mockIssueRouteService) UpdateIssue(ctx context.Context, actor *db.User, owner, repo string, number int64, req services.UpdateIssueInput) (services.IssueResponse, error) {
	if m.updateIssueFn != nil {
		return m.updateIssueFn(ctx, actor, owner, repo, number, req)
	}
	return services.IssueResponse{}, nil
}

func (m *mockIssueRouteService) CreateIssueComment(ctx context.Context, actor *db.User, owner, repo string, number int64, req services.CreateIssueCommentInput) (services.IssueCommentResponse, error) {
	if m.createIssueCommentFn != nil {
		return m.createIssueCommentFn(ctx, actor, owner, repo, number, req)
	}
	return services.IssueCommentResponse{}, nil
}

func (m *mockIssueRouteService) ListIssueComments(ctx context.Context, viewer *db.User, owner, repo string, number int64, afterID int64, limit int) ([]services.IssueCommentResponse, string, int64, error) {
	if m.listIssueCommentsFn != nil {
		return m.listIssueCommentsFn(ctx, viewer, owner, repo, number, afterID, limit)
	}
	return nil, "", 0, nil
}

func (m *mockIssueRouteService) GetIssueComment(ctx context.Context, viewer *db.User, owner, repo string, commentID int64) (services.IssueCommentResponse, error) {
	if m.getIssueCommentFn != nil {
		return m.getIssueCommentFn(ctx, viewer, owner, repo, commentID)
	}
	return services.IssueCommentResponse{}, nil
}

func (m *mockIssueRouteService) UpdateIssueComment(ctx context.Context, actor *db.User, owner, repo string, commentID int64, req services.UpdateIssueCommentInput) (services.IssueCommentResponse, error) {
	if m.updateCommentFn != nil {
		return m.updateCommentFn(ctx, actor, owner, repo, commentID, req)
	}
	return services.IssueCommentResponse{}, nil
}

func (m *mockIssueRouteService) DeleteIssueComment(ctx context.Context, actor *db.User, owner, repo string, commentID int64) error {
	if m.deleteCommentFn != nil {
		return m.deleteCommentFn(ctx, actor, owner, repo, commentID)
	}
	return nil
}

func sampleIssueResponse() services.IssueResponse {
	now := time.Now().UTC().Truncate(time.Second)
	return services.IssueResponse{
		ID:           11,
		Number:       3,
		Title:        "bug",
		Body:         "details",
		State:        "open",
		Author:       services.IssueUserSummary{ID: 1, Login: "alice"},
		Assignees:    []services.IssueUserSummary{{ID: 2, Login: "bob"}},
		Labels:       []services.LabelSummary{{ID: 10, Name: "bug", Color: "#d73a4a", Description: "bug"}},
		CommentCount: 4,
		ClosedAt:     pgtype.Timestamptz{},
		CreatedAt:    now,
		UpdatedAt:    now,
	}
}

func sampleIssueCommentResponse() services.IssueCommentResponse {
	now := time.Now().UTC().Truncate(time.Second)
	return services.IssueCommentResponse{
		ID:        31,
		IssueID:   11,
		UserID:    1,
		Commenter: "alice",
		Body:      "hello",
		Type:      "comment",
		CreatedAt: now,
		UpdatedAt: now,
	}
}

func TestIssueHandler_ListIssues(t *testing.T) {
	t.Parallel()

	t.Run("cursor pagination headers", func(t *testing.T) {
		t.Parallel()
		h := IssueHandler{Service: &mockIssueRouteService{
			listIssuesFn: func(ctx context.Context, viewer *db.User, owner, repo string, afterNumber int64, limit int, state string) ([]services.IssueResponse, string, int64, error) {
				assert.Nil(t, viewer)
				assert.Equal(t, "alice", owner)
				assert.Equal(t, "demo", repo)
				assert.Equal(t, int64(0), afterNumber) // first page
				assert.Equal(t, 5, limit)
				assert.Equal(t, "open", state)
				// Return a full page to signal more results exist.
				items := make([]services.IssueResponse, 5)
				for i := range items {
					items[i] = sampleIssueResponse()
					items[i].Number = int64(10 - i)
				}
				return items, "6", 12, nil
			},
		}}

		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/issues?limit=5&state=open", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()
		h.ListIssues(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "12", rec.Header().Get("X-Total-Count"))
		assert.Equal(t, "5", rec.Header().Get("X-Per-Page"))
		assert.Contains(t, rec.Header().Get("Link"), `rel="next"`)
		assert.Contains(t, rec.Header().Get("Link"), `rel="first"`)
	})

	t.Run("later legacy pages are rejected", func(t *testing.T) {
		t.Parallel()
		h := IssueHandler{Service: &mockIssueRouteService{
			listIssuesFn: func(ctx context.Context, viewer *db.User, owner, repo string, afterNumber int64, limit int, state string) ([]services.IssueResponse, string, int64, error) {
				t.Fatal("service must not receive a legacy offset as an issue number")
				return nil, "", 0, nil
			},
		}}

		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/issues?page=2&per_page=5&state=open", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()
		h.ListIssues(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Contains(t, rec.Body.String(), "page-based pagination is not supported")
	})

	t.Run("legacy decimal cursor is accepted", func(t *testing.T) {
		t.Parallel()
		h := IssueHandler{Service: &mockIssueRouteService{
			listIssuesFn: func(ctx context.Context, viewer *db.User, owner, repo string, afterNumber int64, limit int, state string) ([]services.IssueResponse, string, int64, error) {
				assert.Equal(t, int64(71), afterNumber)
				assert.Equal(t, 5, limit)
				return []services.IssueResponse{sampleIssueResponse()}, "", 12, nil
			},
		}}

		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/issues?cursor=71&limit=5", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()
		h.ListIssues(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
	})
}

func TestIssueHandler_CreateIssue(t *testing.T) {
	t.Parallel()

	t.Run("requires auth", func(t *testing.T) {
		h := IssueHandler{Service: &mockIssueRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/issues", strings.NewReader(`{"title":"x"}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()
		h.CreateIssue(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("invalid json", func(t *testing.T) {
		h := IssueHandler{Service: &mockIssueRouteService{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/issues", strings.NewReader("not-json"))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.CreateIssue(rec, req)
		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("created", func(t *testing.T) {
		milestoneID := int64(12)
		h := IssueHandler{Service: &mockIssueRouteService{
			createIssueFn: func(ctx context.Context, actor *db.User, owner, repo string, req services.CreateIssueInput) (services.IssueResponse, error) {
				assert.Equal(t, int64(1), actor.ID)
				assert.Equal(t, "new", req.Title)
				assert.Equal(t, []string{"bob"}, req.Assignees)
				assert.Equal(t, []string{"bug", "docs"}, req.Labels)
				require.NotNil(t, req.Milestone)
				assert.Equal(t, milestoneID, *req.Milestone)
				resp := sampleIssueResponse()
				resp.Number = 9
				return resp, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/issues", strings.NewReader(`{"title":"new","body":"desc","assignees":["bob"],"labels":["bug","docs"],"milestone":12}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.CreateIssue(rec, req)

		require.Equal(t, http.StatusCreated, rec.Code)
		var payload services.IssueResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
		assert.Equal(t, int64(9), payload.Number)
	})
}

func TestIssueHandler_GetAndPatchIssue(t *testing.T) {
	t.Parallel()

	t.Run("get parses number", func(t *testing.T) {
		h := IssueHandler{Service: &mockIssueRouteService{
			getIssueFn: func(ctx context.Context, viewer *db.User, owner, repo string, number int64) (services.IssueResponse, error) {
				assert.Equal(t, int64(7), number)
				response := sampleIssueResponse()
				response.LinkedChanges = []services.IssueLinkedChange{{ChangeID: "change-1", CommitID: "commit-1", LinkType: "issue"}}
				return response, nil
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/issues/7", nil)
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
		rec := httptest.NewRecorder()
		h.GetIssue(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		var response services.IssueResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &response))
		require.Len(t, response.LinkedChanges, 1)
		assert.Equal(t, "change-1", response.LinkedChanges[0].ChangeID)
	})

	t.Run("patch requires auth", func(t *testing.T) {
		h := IssueHandler{Service: &mockIssueRouteService{}}
		req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo/issues/7", strings.NewReader(`{"title":"x"}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
		rec := httptest.NewRecorder()
		h.PatchIssue(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("patch calls service", func(t *testing.T) {
		milestoneID := int64(3)
		h := IssueHandler{Service: &mockIssueRouteService{
			updateIssueFn: func(ctx context.Context, actor *db.User, owner, repo string, number int64, req services.UpdateIssueInput) (services.IssueResponse, error) {
				assert.Equal(t, int64(1), actor.ID)
				assert.Equal(t, int64(7), number)
				require.NotNil(t, req.Title)
				assert.Equal(t, "new", *req.Title)
				require.NotNil(t, req.Labels)
				assert.Equal(t, []string{"bug"}, *req.Labels)
				require.NotNil(t, req.Milestone)
				require.NotNil(t, req.Milestone.Value)
				assert.Equal(t, milestoneID, *req.Milestone.Value)
				return sampleIssueResponse(), nil
			},
		}}
		req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo/issues/7", strings.NewReader(`{"title":"new","labels":["bug"],"milestone":3}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.PatchIssue(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
	})

	t.Run("patch null milestone clears association", func(t *testing.T) {
		h := IssueHandler{Service: &mockIssueRouteService{
			updateIssueFn: func(ctx context.Context, actor *db.User, owner, repo string, number int64, req services.UpdateIssueInput) (services.IssueResponse, error) {
				require.NotNil(t, req.Milestone)
				assert.Nil(t, req.Milestone.Value)
				return sampleIssueResponse(), nil
			},
		}}
		req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo/issues/7", strings.NewReader(`{"milestone":null}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()
		h.PatchIssue(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
	})

	t.Run("patch forwards verified state and returns verifier", func(t *testing.T) {
		verifiedAt := time.Now().UTC().Truncate(time.Second)
		h := IssueHandler{Service: &mockIssueRouteService{
			updateIssueFn: func(_ context.Context, _ *db.User, _, _ string, _ int64, req services.UpdateIssueInput) (services.IssueResponse, error) {
				require.NotNil(t, req.State)
				assert.Equal(t, "verified", *req.State)
				response := sampleIssueResponse()
				response.State = "verified"
				response.VerifiedBy = &services.IssueUserSummary{ID: 2, Login: "reviewer", AgentSessionID: "agent-session-2"}
				response.VerifiedAt = pgtype.Timestamptz{Time: verifiedAt, Valid: true}
				return response, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo/issues/7", strings.NewReader(`{"state":"verified"}`))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
		req = withAuth(req, 1, "alice")
		rec := httptest.NewRecorder()

		h.PatchIssue(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		var payload services.IssueResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
		require.NotNil(t, payload.VerifiedBy)
		assert.Equal(t, "reviewer", payload.VerifiedBy.Login)
		assert.Equal(t, "agent-session-2", payload.VerifiedBy.AgentSessionID)
		assert.Equal(t, verifiedAt, payload.VerifiedAt.Time)
	})
}

func TestIssueHandler_Comments(t *testing.T) {
	t.Parallel()

	h := IssueHandler{Service: &mockIssueRouteService{
		createIssueCommentFn: func(ctx context.Context, actor *db.User, owner, repo string, number int64, req services.CreateIssueCommentInput) (services.IssueCommentResponse, error) {
			assert.Equal(t, int64(3), number)
			assert.Equal(t, "new comment", req.Body)
			return sampleIssueCommentResponse(), nil
		},
		listIssueCommentsFn: func(ctx context.Context, viewer *db.User, owner, repo string, number int64, afterID int64, limit int) ([]services.IssueCommentResponse, string, int64, error) {
			t.Fatal("service must not receive a legacy offset as a comment ID")
			return nil, "", 0, nil
		},
		getIssueCommentFn: func(ctx context.Context, viewer *db.User, owner, repo string, commentID int64) (services.IssueCommentResponse, error) {
			assert.Equal(t, int64(31), commentID)
			return sampleIssueCommentResponse(), nil
		},
		updateCommentFn: func(ctx context.Context, actor *db.User, owner, repo string, commentID int64, req services.UpdateIssueCommentInput) (services.IssueCommentResponse, error) {
			assert.Equal(t, int64(31), commentID)
			assert.Equal(t, "edited", req.Body)
			return sampleIssueCommentResponse(), nil
		},
		deleteCommentFn: func(ctx context.Context, actor *db.User, owner, repo string, commentID int64) error {
			assert.Equal(t, int64(31), commentID)
			return nil
		},
	}}

	postReq := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/issues/3/comments", strings.NewReader(`{"body":"new comment"}`))
	postReq = withRouteParams(postReq, map[string]string{"owner": "alice", "repo": "demo", "number": "3"})
	postReq = withAuth(postReq, 1, "alice")
	postRec := httptest.NewRecorder()
	h.PostIssueComment(postRec, postReq)
	require.Equal(t, http.StatusCreated, postRec.Code)

	listReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/issues/3/comments?page=2&per_page=10", nil)
	listReq = withRouteParams(listReq, map[string]string{"owner": "alice", "repo": "demo", "number": "3"})
	listRec := httptest.NewRecorder()
	h.ListIssueComments(listRec, listReq)
	require.Equal(t, http.StatusBadRequest, listRec.Code)
	assert.Contains(t, listRec.Body.String(), "page-based pagination is not supported")

	getReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/issues/comments/31", nil)
	getReq = withRouteParams(getReq, map[string]string{"owner": "alice", "repo": "demo", "id": "31"})
	getRec := httptest.NewRecorder()
	h.GetIssueComment(getRec, getReq)
	require.Equal(t, http.StatusOK, getRec.Code)

	patchReq := httptest.NewRequest(http.MethodPatch, "/api/repos/alice/demo/issues/comments/31", strings.NewReader(`{"body":"edited"}`))
	patchReq = withRouteParams(patchReq, map[string]string{"owner": "alice", "repo": "demo", "id": "31"})
	patchReq = withAuth(patchReq, 1, "alice")
	patchRec := httptest.NewRecorder()
	h.PatchIssueComment(patchRec, patchReq)
	require.Equal(t, http.StatusOK, patchRec.Code)

	delReq := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/issues/comments/31", nil)
	delReq = withRouteParams(delReq, map[string]string{"owner": "alice", "repo": "demo", "id": "31"})
	delReq = withAuth(delReq, 1, "alice")
	delRec := httptest.NewRecorder()
	h.DeleteIssueComment(delRec, delReq)
	require.Equal(t, http.StatusNoContent, delRec.Code)
}

func TestIssueHandler_ListIssueCommentsLegacyDecimalCursor(t *testing.T) {
	t.Parallel()

	h := IssueHandler{Service: &mockIssueRouteService{
		listIssueCommentsFn: func(ctx context.Context, viewer *db.User, owner, repo string, number int64, afterID int64, limit int) ([]services.IssueCommentResponse, string, int64, error) {
			assert.Equal(t, int64(3), number)
			assert.Equal(t, int64(100), afterID)
			assert.Equal(t, 10, limit)
			return []services.IssueCommentResponse{sampleIssueCommentResponse()}, "", 1, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/issues/3/comments?cursor=100&limit=10", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "3"})
	rec := httptest.NewRecorder()
	h.ListIssueComments(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
}

func TestIssueHandler_PropagatesServiceErrors(t *testing.T) {
	t.Parallel()

	h := IssueHandler{Service: &mockIssueRouteService{
		getIssueFn: func(ctx context.Context, viewer *db.User, owner, repo string, number int64) (services.IssueResponse, error) {
			return services.IssueResponse{}, pkgerrors.NotFound("issue not found")
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/issues/7", nil)
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
	rec := httptest.NewRecorder()
	h.GetIssue(rec, req)
	require.Equal(t, http.StatusNotFound, rec.Code)
}

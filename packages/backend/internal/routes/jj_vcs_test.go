package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/diffview"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

// --- Helpers for jj VCS handler tests ---

type jjVCSLegacyResolver struct{}

func (jjVCSLegacyResolver) GetRepoByOwnerAndName(ctx context.Context, arg db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error) {
	return db.GetRepoByOwnerAndNameRow{
		ID:   1,
		Name: arg.Name,
	}, nil
}

func (jjVCSLegacyResolver) ListAllProtectedBookmarksByRepo(ctx context.Context, repositoryID int64) ([]db.ProtectedBookmark, error) {
	return nil, nil
}

type jjVCSNoopDispatcher struct{}

type mockChangeDetailService struct {
	getChangeFn func(context.Context, int64, string, string, string) (services.ChangeDetailResponse, error)
	getDiffFn   func(context.Context, int64, string, string, string, services.ChangeDiffRequest) (repohost.ChangeDiff, error)
}

func (m mockChangeDetailService) GetChangeDiff(ctx context.Context, repositoryID int64, owner, repo, changeID string, request services.ChangeDiffRequest) (repohost.ChangeDiff, error) {
	if m.getDiffFn != nil {
		return m.getDiffFn(ctx, repositoryID, owner, repo, changeID, request)
	}
	return repohost.ChangeDiff{}, nil
}

type mockChangeFindingsService struct {
	getFindingsFn     func(context.Context, int64, string, string, string, string, int64) (services.ChangeFindingsResponse, error)
	submitFeedbackFn  func(context.Context, services.SubmitFindingFeedbackInput) (services.FindingFeedbackResponse, error)
	dispatchFindingFn func(context.Context, services.DispatchFindingInput) (services.AgentSessionResponse, error)
}

func (m mockChangeFindingsService) GetFindings(ctx context.Context, repositoryID int64, owner, repo, changeID, revision string, userID int64) (services.ChangeFindingsResponse, error) {
	return m.getFindingsFn(ctx, repositoryID, owner, repo, changeID, revision, userID)
}

func (m mockChangeFindingsService) SubmitFindingFeedback(ctx context.Context, input services.SubmitFindingFeedbackInput) (services.FindingFeedbackResponse, error) {
	return m.submitFeedbackFn(ctx, input)
}

func (m mockChangeFindingsService) DispatchFinding(ctx context.Context, input services.DispatchFindingInput) (services.AgentSessionResponse, error) {
	return m.dispatchFindingFn(ctx, input)
}

type mockChangeConflictResolver struct {
	resolveFn func(context.Context, services.ResolveChangeConflictInput) (services.ResolveChangeConflictResponse, error)
}

func (m mockChangeConflictResolver) ResolveConflict(ctx context.Context, input services.ResolveChangeConflictInput) (services.ResolveChangeConflictResponse, error) {
	return m.resolveFn(ctx, input)
}

type mockChangeRevertService struct {
	revertFn func(context.Context, *db.User, int64, string, string, string) (services.ChangeRevertResponse, error)
}

type mockChangeSplitService struct {
	splitFn func(context.Context, int64, string, string, string, services.SplitChangeInput) (services.SplitChangeResponse, error)
}

func (m mockChangeSplitService) SplitChange(ctx context.Context, repositoryID int64, owner, repo, changeID string, input services.SplitChangeInput) (services.SplitChangeResponse, error) {
	return m.splitFn(ctx, repositoryID, owner, repo, changeID, input)
}

func (m mockChangeRevertService) RevertChange(ctx context.Context, actor *db.User, repositoryID int64, owner, repo, changeID string) (services.ChangeRevertResponse, error) {
	return m.revertFn(ctx, actor, repositoryID, owner, repo, changeID)
}

func (m mockChangeDetailService) GetChange(ctx context.Context, repositoryID int64, owner, repo, changeID string) (services.ChangeDetailResponse, error) {
	if m.getChangeFn != nil {
		return m.getChangeFn(ctx, repositoryID, owner, repo, changeID)
	}
	return services.ChangeDetailResponse{}, nil
}

func (jjVCSNoopDispatcher) DispatchEvent(ctx context.Context, repoID int64, eventType webhooks.EventType, payload any) error {
	return nil
}

func (jjVCSNoopDispatcher) DispatchOrgEvent(ctx context.Context, orgID int64, eventType webhooks.EventType, payload any) error {
	return nil
}

func newJJVCSHandler(fakeServer *httptest.Server) *JJVCSHandler {
	client := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: fakeServer.URL}, "test-token", nil)
	return &JJVCSHandler{
		RepoHost:          client,
		ChangeService:     jjVCSTestChangeService{client: client},
		RepoResolver:      jjVCSLegacyResolver{},
		WebhookDispatcher: jjVCSNoopDispatcher{},
	}
}

type jjVCSTestChangeService struct{ client *repohost.Client }

func (s jjVCSTestChangeService) GetChange(ctx context.Context, _ int64, owner, repo, changeID string) (services.ChangeDetailResponse, error) {
	change, err := s.client.GetChange(ctx, owner, repo, changeID)
	if err != nil {
		return services.ChangeDetailResponse{}, repohostErrToAPIErr(ctx, err, "failed to get change")
	}
	return services.ChangeDetailResponse{
		ChangeID: change.ChangeID, CommitID: change.CommitID, Description: change.Description,
		AuthorName: change.AuthorName, AuthorEmail: change.AuthorEmail, Timestamp: change.Timestamp,
		HasConflict: change.HasConflict, IsEmpty: change.IsEmpty, ParentChangeIDs: change.ParentChangeIDs,
	}, nil
}

func (s jjVCSTestChangeService) GetChangeDiff(ctx context.Context, _ int64, owner, repo, changeID string, request services.ChangeDiffRequest) (repohost.ChangeDiff, error) {
	diff, err := diffview.BuildChangeDiff(ctx, s.client, owner, repo, changeID, diffview.BuildOptions{IgnoreWhitespace: request.IgnoreWhitespace})
	if err != nil {
		return repohost.ChangeDiff{}, repohostErrToAPIErr(ctx, err, "failed to get change diff")
	}
	return diff, nil
}

type jjVCSStaticChangeService struct{ response services.ChangeDetailResponse }

func (s jjVCSStaticChangeService) GetChange(context.Context, int64, string, string, string) (services.ChangeDetailResponse, error) {
	return s.response, nil
}

func (s jjVCSStaticChangeService) GetChangeDiff(context.Context, int64, string, string, string, services.ChangeDiffRequest) (repohost.ChangeDiff, error) {
	return repohost.ChangeDiff{}, nil
}

func TestJJVCSHandler_GetChange_EmitsOwnershipResolution(t *testing.T) {
	t.Parallel()
	h := &JJVCSHandler{RepoResolver: jjVCSLegacyResolver{}, ChangeService: jjVCSStaticChangeService{response: services.ChangeDetailResponse{
		ChangeID: "c1", RevisionSeq: 3,
		Owners: services.ChangeOwnership{
			RequiredApprovers:  []string{"team:data"},
			SuggestedReviewers: []string{"sage"},
			MissingApprovals:   []services.MissingOwnershipApproval{{Path: "data/schema.graphql", Candidates: []string{"team:data"}}},
		},
	}}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/acme/demo/changes/c1", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "acme", "repo": "demo", "change_id": "c1"})
	rec := httptest.NewRecorder()
	h.GetChange(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	var body map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, float64(3), body["revision_seq"])
	owners := body["owners"].(map[string]any)
	assert.Equal(t, []any{"team:data"}, owners["required_approvers"])
	assert.Equal(t, []any{"sage"}, owners["suggested_reviewers"])
	require.Len(t, owners["missing_approvals"], 1)
}

func TestJJVCSHandler_GetChangeFindingsForwardsRevisionAndAnalyzerState(t *testing.T) {
	t.Parallel()

	var gotRevision string
	h := &JJVCSHandler{
		RepoResolver: jjVCSLegacyResolver{},
		FindingsService: mockChangeFindingsService{getFindingsFn: func(_ context.Context, repositoryID int64, owner, repo, changeID, revision string, userID int64) (services.ChangeFindingsResponse, error) {
			assert.Equal(t, int64(1), repositoryID)
			assert.Equal(t, "acme", owner)
			assert.Equal(t, "demo", repo)
			assert.Equal(t, "change-1", changeID)
			gotRevision = revision
			assert.Zero(t, userID)
			pausedBy := "sage"
			pausedReason := "manual pause"
			return services.ChangeFindingsResponse{
				ChangeID: "change-1", CurrentSeq: 2,
				Findings:  []services.ChangeFindingResponse{},
				Analyzers: []services.AnalyzerRunResponse{{Name: "security", State: "paused", Seq: 2, PausedBy: &pausedBy, PausedReason: &pausedReason}},
			}, nil
		}},
	}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/acme/demo/changes/change-1/findings?rev=2", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "acme", "repo": "demo", "change_id": "change-1"})
	rec := httptest.NewRecorder()

	h.GetChangeFindings(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "2", gotRevision)
	var response services.ChangeFindingsResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &response))
	require.Len(t, response.Analyzers, 1)
	assert.Equal(t, "paused", response.Analyzers[0].State)
	assert.Equal(t, "manual pause", *response.Analyzers[0].PausedReason)
}

func TestJJVCSHandler_GetChangeFindingsPropagatesServiceError(t *testing.T) {
	t.Parallel()

	h := &JJVCSHandler{
		RepoResolver: jjVCSLegacyResolver{},
		FindingsService: mockChangeFindingsService{getFindingsFn: func(context.Context, int64, string, string, string, string, int64) (services.ChangeFindingsResponse, error) {
			return services.ChangeFindingsResponse{}, pkgerrors.BadRequest("rev must be a positive integer")
		}},
	}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/acme/demo/changes/change-1/findings?rev=nope", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "acme", "repo": "demo", "change_id": "change-1"})
	rec := httptest.NewRecorder()

	h.GetChangeFindings(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestJJVCSHandler_SubmitFindingFeedback(t *testing.T) {
	t.Parallel()

	note := "Please avoid this pattern."
	h := &JJVCSHandler{FindingsService: mockChangeFindingsService{
		submitFeedbackFn: func(_ context.Context, input services.SubmitFindingFeedbackInput) (services.FindingFeedbackResponse, error) {
			assert.Equal(t, services.SubmitFindingFeedbackInput{
				RepositoryID: 42, ChangeID: "change-1", FindingID: 12, UserID: 7, Useful: false, Note: &note,
			}, input)
			return services.FindingFeedbackResponse{Useful: false, Note: &note, ByUserID: 7}, nil
		},
	}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/acme/demo/changes/change-1/findings/12/feedback", strings.NewReader(`{"useful":false,"note":"Please avoid this pattern."}`))
	req = withJJRouteParams(req, map[string]string{"owner": "acme", "repo": "demo", "change_id": "change-1", "finding_id": "12"})
	ctx := middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{User: &db.User{ID: 7}})
	ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{Owner: "acme", Repository: &db.Repository{ID: 42, Name: "demo"}}, middleware.PermissionWrite)
	req = req.WithContext(ctx)
	recorder := httptest.NewRecorder()

	h.SubmitFindingFeedback(recorder, req)

	require.Equal(t, http.StatusOK, recorder.Code)
	assert.JSONEq(t, `{"useful":false,"note":"Please avoid this pattern.","by_user_id":7}`, recorder.Body.String())
}

func TestJJVCSHandler_SubmitFindingFeedbackRequiresUseful(t *testing.T) {
	t.Parallel()

	h := &JJVCSHandler{FindingsService: mockChangeFindingsService{}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/acme/demo/changes/change-1/findings/12/feedback", strings.NewReader(`{"note":"missing verdict"}`))
	req = withJJRouteParams(req, map[string]string{"change_id": "change-1", "finding_id": "12"})
	ctx := middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{User: &db.User{ID: 7}})
	ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{Repository: &db.Repository{ID: 42}}, middleware.PermissionWrite)
	req = req.WithContext(ctx)
	recorder := httptest.NewRecorder()

	h.SubmitFindingFeedback(recorder, req)

	assert.Equal(t, http.StatusBadRequest, recorder.Code)
}

func TestJJVCSHandler_DispatchFindingReturnsAgentSession(t *testing.T) {
	t.Parallel()

	h := &JJVCSHandler{FindingsService: mockChangeFindingsService{
		dispatchFindingFn: func(_ context.Context, input services.DispatchFindingInput) (services.AgentSessionResponse, error) {
			assert.Equal(t, services.DispatchFindingInput{
				RepositoryID: 42, UserID: 7, Owner: "acme", Repo: "demo", ChangeID: "change-1", FindingID: 12,
			}, input)
			return services.AgentSessionResponse{ID: "session-12", RepositoryID: 42, UserID: 7, Status: "active", Metadata: json.RawMessage(`{"finding_id":12}`)}, nil
		},
	}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/acme/demo/changes/change-1/findings/12/dispatch", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "acme", "repo": "demo", "change_id": "change-1", "finding_id": "12"})
	ctx := middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{User: &db.User{ID: 7}})
	ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{Owner: "acme", Repository: &db.Repository{ID: 42, Name: "demo"}}, middleware.PermissionWrite)
	req = req.WithContext(ctx)
	recorder := httptest.NewRecorder()

	h.DispatchFinding(recorder, req)

	require.Equal(t, http.StatusAccepted, recorder.Code)
	assert.Contains(t, recorder.Body.String(), `"id":"session-12"`)
	assert.Contains(t, recorder.Body.String(), `"finding_id":12`)
}

func withJJRouteParams(req *http.Request, params map[string]string) *http.Request {
	routeCtx := chi.NewRouteContext()
	for key, value := range params {
		routeCtx.URLParams.Add(key, value)
	}
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))
}

func decodeCursorItems[T any](t *testing.T, body []byte) ([]T, string) {
	t.Helper()

	var resp struct {
		Items      []T    `json:"items"`
		NextCursor string `json:"next_cursor"`
	}
	require.NoError(t, json.Unmarshal(body, &resp))
	return resp.Items, resp.NextCursor
}

// --- ListBookmarks ---

func TestJJVCSHandler_ListBookmarks_Success(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodGet, r.Method)
		assert.Contains(t, r.URL.Path, "bookmarks")

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []repohost.Bookmark{
				{Name: "main", TargetChangeID: "abc123", TargetCommitID: "def456", IsTrackingRemote: true},
				{Name: "feature", TargetChangeID: "xyz789", TargetCommitID: "uvw012", IsTrackingRemote: false},
			},
			"total_count": int64(2),
		})
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/bookmarks", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	rec := httptest.NewRecorder()

	h.ListBookmarks(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	resp, nextCursor := decodeCursorItems[BookmarkResponse](t, rec.Body.Bytes())
	require.Len(t, resp, 2)
	assert.Empty(t, nextCursor)
	assert.Equal(t, "main", resp[0].Name)
	assert.Equal(t, "abc123", resp[0].TargetChangeID)
	assert.True(t, resp[0].IsTrackingRemote)
	assert.Equal(t, "feature", resp[1].Name)
	assert.False(t, resp[1].IsTrackingRemote)
}

func TestJJVCSHandler_ListBookmarks_Empty(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items":       []repohost.Bookmark{},
			"total_count": int64(0),
		})
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/bookmarks", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	rec := httptest.NewRecorder()

	h.ListBookmarks(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	resp, nextCursor := decodeCursorItems[BookmarkResponse](t, rec.Body.Bytes())
	assert.Empty(t, nextCursor)
	assert.Empty(t, resp)
}

func TestJJVCSHandler_ListBookmarks_MissingOwner(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("should not call repohost when route params are missing")
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodGet, "/api/repos//demo/bookmarks", nil)
	// No route params set — simulates missing owner
	rec := httptest.NewRecorder()

	h.ListBookmarks(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestJJVCSHandler_ListBookmarks_PaginationHeadersAndParamForwarding(t *testing.T) {
	t.Parallel()

	var gotPage string
	var gotPerPage string
	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPage = r.URL.Query().Get("page")
		gotPerPage = r.URL.Query().Get("per_page")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []repohost.Bookmark{
				{Name: "main", TargetChangeID: "abc123", TargetCommitID: "def456", IsTrackingRemote: true},
			},
			"total_count": int64(3),
		})
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/bookmarks?page=2&per_page=1", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	rec := httptest.NewRecorder()

	h.ListBookmarks(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "2", gotPage)
	assert.Equal(t, "1", gotPerPage)
	link := rec.Header().Get("Link")
	assert.Contains(t, link, `rel="first"`)
	assert.Contains(t, link, `rel="next"`)
	assert.NotContains(t, link, `rel="last"`)
	assert.NotContains(t, link, `rel="prev"`)

	resp, nextCursor := decodeCursorItems[BookmarkResponse](t, rec.Body.Bytes())
	require.Len(t, resp, 1)
	assert.Equal(t, "2", nextCursor)
	assert.Equal(t, "main", resp[0].Name)
}

// --- CreateBookmark ---

func TestJJVCSHandler_CreateBookmark_Success(t *testing.T) {
	t.Parallel()

	var gotBody repohost.CreateBookmarkRequest
	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPost, r.Method)
		require.NoError(t, json.NewDecoder(r.Body).Decode(&gotBody))
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(repohost.Bookmark{
			Name:             gotBody.Name,
			TargetChangeID:   gotBody.TargetChangeID,
			TargetCommitID:   "commit-sha",
			IsTrackingRemote: false,
		})
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	body := `{"name":"release","target_change_id":"chg-abc"}`
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/bookmarks", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	req = withRepoAuth(req, 1, "alice")
	rec := httptest.NewRecorder()

	h.CreateBookmark(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
	var resp BookmarkResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	assert.Equal(t, "release", resp.Name)
	assert.Equal(t, "chg-abc", resp.TargetChangeID)
	assert.Equal(t, "release", gotBody.Name)
	assert.Equal(t, "chg-abc", gotBody.TargetChangeID)
}

func TestJJVCSHandler_CreateBookmark_MissingName(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("should not call repohost when name is missing")
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	body := `{"name":"","target_change_id":"chg-abc"}`
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/bookmarks", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	req = withRepoAuth(req, 1, "alice")
	rec := httptest.NewRecorder()

	h.CreateBookmark(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
	body2 := rec.Body.String()
	assert.Contains(t, body2, "name")
}

func TestJJVCSHandler_CreateBookmark_MissingChangeID(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("should not call repohost when change ID is missing")
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	body := `{"name":"main","target_change_id":""}`
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/bookmarks", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	req = withRepoAuth(req, 1, "alice")
	rec := httptest.NewRecorder()

	h.CreateBookmark(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestJJVCSHandler_CreateBookmark_Unauthenticated(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("should not call repohost when not authenticated")
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	body := `{"name":"main","target_change_id":"chg-abc"}`
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/bookmarks", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	// No auth set
	rec := httptest.NewRecorder()

	h.CreateBookmark(rec, req)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

// --- DeleteBookmark ---

func TestJJVCSHandler_DeleteBookmark_Success(t *testing.T) {
	t.Parallel()

	var gotPath string
	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodDelete, r.Method)
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/bookmarks/main", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "name": "main"})
	req = withRepoAuth(req, 1, "alice")
	rec := httptest.NewRecorder()

	h.DeleteBookmark(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Contains(t, gotPath, "main")
}

func TestJJVCSHandler_DeleteBookmark_MissingName(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("should not call repohost when bookmark name is missing")
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/bookmarks/", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"}) // no "name"
	req = withRepoAuth(req, 1, "alice")
	rec := httptest.NewRecorder()

	h.DeleteBookmark(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestJJVCSHandler_DeleteBookmark_NotFound(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"message":"bookmark not found"}`))
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/bookmarks/nonexistent", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "name": "nonexistent"})
	req = withRepoAuth(req, 1, "alice")
	rec := httptest.NewRecorder()

	h.DeleteBookmark(rec, req)

	assert.Equal(t, http.StatusNotFound, rec.Code)
	assert.Contains(t, rec.Body.String(), "bookmark not found")
}

// --- ListChanges ---

func TestJJVCSHandler_ListChanges_Success(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodGet, r.Method)
		assert.Contains(t, r.URL.Path, "/changes")

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []repohost.Change{
				{
					ChangeID:        "chg-abc123",
					CommitID:        "commit-sha1",
					Description:     "Add feature",
					AuthorName:      "Alice",
					AuthorEmail:     "alice@example.com",
					Timestamp:       "2024-01-02T00:00:00Z",
					HasConflict:     false,
					IsEmpty:         false,
					ParentChangeIDs: []string{"chg-parent"},
				},
				{
					ChangeID:        "chg-parent",
					CommitID:        "commit-sha0",
					Description:     "Initial commit",
					AuthorName:      "Bob",
					AuthorEmail:     "bob@example.com",
					Timestamp:       "2024-01-01T00:00:00Z",
					HasConflict:     false,
					IsEmpty:         false,
					ParentChangeIDs: []string{},
				},
			},
			"total_count": int64(2),
		})
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/changes", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	rec := httptest.NewRecorder()

	h.ListChanges(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	resp, nextCursor := decodeCursorItems[ChangeResponse](t, rec.Body.Bytes())
	require.Len(t, resp, 2)
	assert.Empty(t, nextCursor)
	assert.Equal(t, "chg-abc123", resp[0].ChangeID)
	assert.Equal(t, "Add feature", resp[0].Description)
	assert.Equal(t, "Alice", resp[0].AuthorName)
	assert.Equal(t, []string{"chg-parent"}, resp[0].ParentChangeIDs)
	assert.Equal(t, "chg-parent", resp[1].ChangeID)
}

func TestJJVCSHandler_ListChanges_Empty(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items":       []repohost.Change{},
			"total_count": int64(0),
		})
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/changes", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	rec := httptest.NewRecorder()

	h.ListChanges(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	resp, nextCursor := decodeCursorItems[ChangeResponse](t, rec.Body.Bytes())
	assert.Empty(t, nextCursor)
	assert.Empty(t, resp)
}

func TestJJVCSHandler_ListChanges_MissingOwner(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("should not call repohost when route params are missing")
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodGet, "/api/repos//demo/changes", nil)
	// No route params set — simulates missing owner
	rec := httptest.NewRecorder()

	h.ListChanges(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestJJVCSHandler_ListChanges_RepohostError(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"message":"repository not found"}`))
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/nonexistent/changes", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "nonexistent"})
	rec := httptest.NewRecorder()

	h.ListChanges(rec, req)

	assert.Equal(t, http.StatusNotFound, rec.Code)
	assert.Contains(t, rec.Body.String(), "repository not found")
}

func TestJJVCSHandler_ListChanges_PaginationHeadersAndParamForwarding(t *testing.T) {
	t.Parallel()

	var gotPage string
	var gotPerPage string
	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPage = r.URL.Query().Get("page")
		gotPerPage = r.URL.Query().Get("per_page")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []repohost.Change{
				{
					ChangeID:        "chg-abc123",
					CommitID:        "commit-sha1",
					Description:     "Add feature",
					AuthorName:      "Alice",
					AuthorEmail:     "alice@example.com",
					Timestamp:       "2024-01-02T00:00:00Z",
					HasConflict:     false,
					IsEmpty:         false,
					ParentChangeIDs: []string{"chg-parent"},
				},
				{
					ChangeID:        "chg-parent",
					CommitID:        "commit-sha0",
					Description:     "Base change",
					AuthorName:      "Bob",
					AuthorEmail:     "bob@example.com",
					Timestamp:       "2024-01-01T00:00:00Z",
					HasConflict:     false,
					IsEmpty:         false,
					ParentChangeIDs: []string{},
				},
			},
			"total_count": int64(5),
		})
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/changes?page=1&per_page=2", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	rec := httptest.NewRecorder()

	h.ListChanges(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "1", gotPage)
	assert.Equal(t, "2", gotPerPage)
	link := rec.Header().Get("Link")
	assert.Contains(t, link, `rel="first"`)
	assert.Contains(t, link, `rel="next"`)
	assert.NotContains(t, link, `rel="prev"`)
	assert.NotContains(t, link, `rel="last"`)
}

// --- CountChanges ---

func TestJJVCSHandler_CountChanges_Success(t *testing.T) {
	t.Parallel()

	var gotRev, gotSince string
	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodGet, r.Method)
		assert.Equal(t, "/repos/alice:demo/changes/count", r.URL.EscapedPath())
		gotRev = r.URL.Query().Get("rev")
		gotSince = r.URL.Query().Get("since")
		_ = json.NewEncoder(w).Encode(map[string]any{"count": int64(13452)})
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	rev := strings.Repeat("a", 40)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/changes/count?rev="+rev+"&since=2026-09-22T12%3A00%3A00Z", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	rec := httptest.NewRecorder()

	h.CountChanges(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{"count":13452}`, rec.Body.String())
	assert.Equal(t, rev, gotRev)
	assert.Equal(t, "2026-09-22T12:00:00Z", gotSince)
}

func TestJJVCSHandler_CountChanges_RejectsBadInput(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("should not call repohost for invalid query input")
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	for name, target := range map[string]string{
		"missing_rev":   "/api/repos/alice/demo/changes/count?since=2026-09-22T12%3A00%3A00Z",
		"missing_since": "/api/repos/alice/demo/changes/count?rev=" + strings.Repeat("a", 40),
		"bad_since":     "/api/repos/alice/demo/changes/count?rev=" + strings.Repeat("a", 40) + "&since=last+week",
	} {
		t.Run(name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, target, nil)
			req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
			rec := httptest.NewRecorder()

			h.CountChanges(rec, req)

			assert.Equal(t, http.StatusBadRequest, rec.Code)
		})
	}
}

func TestJJVCSHandler_CountChanges_RepohostError(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"message":"unknown revision"}`))
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/changes/count?rev="+strings.Repeat("f", 40)+"&since=2026-09-22T12%3A00%3A00Z", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	rec := httptest.NewRecorder()

	h.CountChanges(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), "unknown revision")
}

// --- GetChange ---

func TestJJVCSHandler_GetChange_Success(t *testing.T) {
	t.Parallel()

	landedAt := time.Date(2026, 9, 2, 16, 30, 0, 0, time.UTC)
	fakeServer := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(fakeServer.Close)
	highConfidence := "high"
	h := newJJVCSHandler(fakeServer)
	h.ChangeService = mockChangeDetailService{getChangeFn: func(_ context.Context, repositoryID int64, owner, repo, changeID string) (services.ChangeDetailResponse, error) {
		assert.Equal(t, int64(1), repositoryID)
		assert.Equal(t, "alice", owner)
		assert.Equal(t, "demo", repo)
		assert.Equal(t, "chg-abc123", changeID)
		return services.ChangeDetailResponse{
			ChangeID:        "chg-abc123",
			CommitID:        "commit-sha",
			Description:     "Add feature",
			AuthorName:      "Alice",
			AuthorEmail:     "alice@example.com",
			Timestamp:       "2024-01-01T00:00:00Z",
			HasConflict:     false,
			IsEmpty:         false,
			ParentChangeIDs: []string{"chg-parent"},
			ParentChangeID:  "chg-parent",
			CurrentSeq:      2,
			Revisions: []services.ChangeRevisionResponse{
				{Seq: 1, CommitID: "commit-old", ParentCommitID: "parent-old", Source: "push", OperationIDs: []string{}},
				{Seq: 2, CommitID: "commit-sha", ParentCommitID: "parent-at-rev-2", Source: "agent", AgentSessionID: "session-1", OperationIDs: []string{"op-1"}},
			},
			Reviews: []services.ChangeReviewResponse{
				{Reviewer: "session-reviewer", ReviewerLogin: "Review agent", ReviewerKind: "agent", Type: "approve", Verdict: "lgtm", ConfidenceBucket: &highConfidence, Summary: "Safe to land", CommitID: "commit-sha", Seq: 2, LastReviewedSeq: 2},
				{Reviewer: "bob", ReviewerLogin: "bob", ReviewerKind: "human", Type: "approve", Verdict: "approve", Summary: "LGTM", CommitID: "commit-old", Seq: 1, LastReviewedSeq: 1},
			},
			Conflicts: []services.ChangeConflictSummary{{Path: "main.go", State: "unresolved"}},
			Stack: &services.ChangeStackSummary{LandingRequestID: 9, LandingRequestNumber: 14, Position: 2, Size: 3, Turn: services.LandingRequestTurn{
				Party: "author", ActorID: "7", ActorLogin: "carol", Reason: "comment",
			}},
			Turn: &services.LandingRequestTurn{Party: "author", ActorID: "7", ActorLogin: "carol", Reason: "comment"},
			Landed: &services.ChangeLandingProvenance{
				LandingRequestID:     71,
				LandingRequestNumber: 23,
				At:                   landedAt,
				By:                   "maintainer",
				ApprovedBy: []services.ChangeLandingApprover{
					{Login: "reviewer", Seq: 2},
				},
			},
			LinkedIssues: []services.ChangeLinkedIssue{{ID: 41, Number: 7, Title: "bug", State: "fixed", LinkType: "closes"}},
		}, nil
	}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/changes/chg-abc123", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "change_id": "chg-abc123"})
	rec := httptest.NewRecorder()

	h.GetChange(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var resp services.ChangeDetailResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	assert.Equal(t, "chg-abc123", resp.ChangeID)
	assert.Equal(t, "commit-sha", resp.CommitID)
	assert.Equal(t, "Add feature", resp.Description)
	assert.Equal(t, "Alice", resp.AuthorName)
	assert.False(t, resp.HasConflict)
	assert.False(t, resp.IsEmpty)
	assert.Equal(t, []string{"chg-parent"}, resp.ParentChangeIDs)
	assert.Equal(t, "chg-parent", resp.ParentChangeID)
	assert.Equal(t, int64(2), resp.CurrentSeq)
	require.Len(t, resp.Revisions, 2)
	assert.Equal(t, "parent-at-rev-2", resp.Revisions[1].ParentCommitID)
	require.Len(t, resp.Reviews, 2)
	assert.Equal(t, "session-reviewer", resp.Reviews[0].Reviewer)
	assert.Equal(t, "Review agent", resp.Reviews[0].ReviewerLogin)
	assert.Equal(t, "agent", resp.Reviews[0].ReviewerKind)
	assert.Equal(t, "approve", resp.Reviews[0].Type)
	assert.Equal(t, "lgtm", resp.Reviews[0].Verdict)
	require.NotNil(t, resp.Reviews[0].ConfidenceBucket)
	assert.Equal(t, "high", *resp.Reviews[0].ConfidenceBucket)
	assert.Nil(t, resp.Reviews[1].ConfidenceBucket)
	assert.Equal(t, "bob", resp.Reviews[1].Reviewer)
	assert.Equal(t, "bob", resp.Reviews[1].ReviewerLogin)
	assert.Equal(t, int64(1), resp.Reviews[1].LastReviewedSeq)
	require.Len(t, resp.Conflicts, 1)
	require.NotNil(t, resp.Stack)
	assert.Equal(t, int64(9), resp.Stack.LandingRequestID)
	assert.Equal(t, int64(14), resp.Stack.LandingRequestNumber)
	assert.Equal(t, int64(2), resp.Stack.Position)
	assert.Equal(t, "author", resp.Stack.Turn.Party)
	assert.Equal(t, "carol", resp.Stack.Turn.ActorLogin)
	require.NotNil(t, resp.Turn)
	assert.Equal(t, "comment", resp.Turn.Reason)
	require.NotNil(t, resp.Landed)
	assert.Equal(t, int64(71), resp.Landed.LandingRequestID)
	assert.Equal(t, int64(23), resp.Landed.LandingRequestNumber)
	assert.Equal(t, landedAt, resp.Landed.At)
	assert.Equal(t, "maintainer", resp.Landed.By)
	assert.Equal(t, []services.ChangeLandingApprover{{Login: "reviewer", Seq: 2}}, resp.Landed.ApprovedBy)
	require.Equal(t, []services.ChangeLinkedIssue{{ID: 41, Number: 7, Title: "bug", State: "fixed", LinkType: "closes"}}, resp.LinkedIssues)
	var body map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	reviews := body["reviews"].([]any)
	assert.Equal(t, "session-reviewer", reviews[0].(map[string]any)["reviewer"])
	assert.Equal(t, "Review agent", reviews[0].(map[string]any)["reviewer_login"])
	assert.Equal(t, "bob", reviews[1].(map[string]any)["reviewer"])
	assert.Equal(t, "bob", reviews[1].(map[string]any)["reviewer_login"])
	stack := body["stack"].(map[string]any)
	assert.Equal(t, float64(9), stack["landing_request_id"])
	assert.Equal(t, float64(14), stack["landing_request_number"])
	landed := body["landed"].(map[string]any)
	assert.Equal(t, float64(71), landed["landing_request_id"])
	assert.Equal(t, float64(23), landed["landing_request_number"])
	assert.Equal(t, "maintainer", landed["by"])
	approvedBy := landed["approved_by"].([]any)
	assert.Equal(t, "reviewer", approvedBy[0].(map[string]any)["login"])
	assert.Equal(t, float64(2), approvedBy[0].(map[string]any)["seq"])
}

func TestJJVCSHandler_GetChange_MissingChangeID(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("should not call repohost when change_id is missing")
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/changes/", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"}) // no change_id
	rec := httptest.NewRecorder()

	h.GetChange(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestJJVCSHandler_RevertChange_CreatesReviewableChange(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(fakeServer.Close)
	h := newJJVCSHandler(fakeServer)
	h.ChangeReverter = mockChangeRevertService{revertFn: func(_ context.Context, actor *db.User, repositoryID int64, owner, repo, changeID string) (services.ChangeRevertResponse, error) {
		assert.Equal(t, int64(7), actor.ID)
		assert.Equal(t, int64(1), repositoryID)
		assert.Equal(t, "alice", owner)
		assert.Equal(t, "demo", repo)
		assert.Equal(t, "original-change", changeID)
		return services.ChangeRevertResponse{ChangeID: "reverting-change", LandingRequestID: 91, LandingRequestNumber: 17}, nil
	}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/changes/original-change/revert", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "change_id": "original-change"})
	req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{User: &db.User{ID: 7}}))
	rec := httptest.NewRecorder()

	h.RevertChange(rec, req)
	require.Equal(t, http.StatusCreated, rec.Code)
	var response services.ChangeRevertResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &response))
	assert.Equal(t, services.ChangeRevertResponse{ChangeID: "reverting-change", LandingRequestID: 91, LandingRequestNumber: 17}, response)
	var body map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, float64(91), body["landing_request_id"])
	assert.Equal(t, float64(17), body["landing_request_number"])
}

func TestJJVCSHandler_RevertChange_RequiresAuthentication(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(fakeServer.Close)
	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/changes/original/revert", nil)
	rec := httptest.NewRecorder()
	h.RevertChange(rec, req)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestJJVCSHandler_SplitChange_ReturnsBothChanges(t *testing.T) {
	t.Parallel()

	h := &JJVCSHandler{
		RepoResolver: jjVCSLegacyResolver{},
		ChangeSplitter: mockChangeSplitService{splitFn: func(_ context.Context, repositoryID int64, owner, repo, changeID string, input services.SplitChangeInput) (services.SplitChangeResponse, error) {
			assert.Equal(t, int64(1), repositoryID)
			assert.Equal(t, "alice", owner)
			assert.Equal(t, "demo", repo)
			assert.Equal(t, "original", changeID)
			assert.Equal(t, services.SplitChangeInput{Paths: []string{"src/a.go"}, Description: "Extract a"}, input)
			return services.SplitChangeResponse{
				Original: repohost.Change{ChangeID: "original", CommitID: "original-2"},
				Split:    repohost.Change{ChangeID: "split", CommitID: "split-1"},
			}, nil
		}},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/changes/original/split", strings.NewReader(`{"paths":["src/a.go"],"description":"Extract a"}`))
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "change_id": "original"})
	req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{User: &db.User{ID: 7}}))
	rec := httptest.NewRecorder()

	h.SplitChange(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	var response services.SplitChangeResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &response))
	assert.Equal(t, "original", response.Original.ChangeID)
	assert.Equal(t, "split", response.Split.ChangeID)
}

func TestJJVCSHandler_SplitChange_ValidatesRequestAndAuthentication(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		body       string
		auth       bool
		wantStatus int
	}{
		{name: "authentication", body: `{"paths":["a.go"]}`, wantStatus: http.StatusUnauthorized},
		{name: "invalid JSON", body: `{`, auth: true, wantStatus: http.StatusBadRequest},
		{name: "missing paths", body: `{}`, auth: true, wantStatus: http.StatusBadRequest},
		{name: "empty path", body: `{"paths":[""]}`, auth: true, wantStatus: http.StatusBadRequest},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := &JJVCSHandler{RepoResolver: jjVCSLegacyResolver{}, ChangeSplitter: mockChangeSplitService{splitFn: func(context.Context, int64, string, string, string, services.SplitChangeInput) (services.SplitChangeResponse, error) {
				t.Fatal("service should not be called")
				return services.SplitChangeResponse{}, nil
			}}}
			req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/changes/original/split", strings.NewReader(tt.body))
			req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "change_id": "original"})
			if tt.auth {
				req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{User: &db.User{ID: 7}}))
			}
			rec := httptest.NewRecorder()
			h.SplitChange(rec, req)
			assert.Equal(t, tt.wantStatus, rec.Code)
		})
	}
}

func TestJJVCSHandler_SplitChange_PropagatesConflictAndUnprocessable(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name       string
		err        error
		wantStatus int
	}{
		{name: "landed", err: pkgerrors.Conflict("landed changes cannot be split"), wantStatus: http.StatusConflict},
		{name: "no matching path", err: pkgerrors.UnprocessableEntity("no listed path is in the change"), wantStatus: http.StatusUnprocessableEntity},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := &JJVCSHandler{RepoResolver: jjVCSLegacyResolver{}, ChangeSplitter: mockChangeSplitService{splitFn: func(context.Context, int64, string, string, string, services.SplitChangeInput) (services.SplitChangeResponse, error) {
				return services.SplitChangeResponse{}, tc.err
			}}}
			req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/changes/original/split", strings.NewReader(`{"paths":["missing.go"]}`))
			req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "change_id": "original"})
			req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{User: &db.User{ID: 7}}))
			rec := httptest.NewRecorder()
			h.SplitChange(rec, req)
			assert.Equal(t, tc.wantStatus, rec.Code)
		})
	}
}

// --- GetChangeDiff ---

func TestJJVCSHandler_GetChangeDiff_Success(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodGet, r.Method)
		w.Header().Set("Content-Type", "application/json")

		switch r.URL.Path {
		case "/repos/alice:demo/changes/chg-abc123/diff":
			_ = json.NewEncoder(w).Encode(repohost.ChangeDiff{
				ChangeID: "chg-abc123",
				FileDiffs: []repohost.FileDiff{
					{Path: "README.md", ChangeType: "added"},
					{Path: "src/main.go", ChangeType: "modified"},
				},
			})
		case "/repos/alice:demo/changes/chg-abc123":
			_ = json.NewEncoder(w).Encode(repohost.Change{
				ChangeID:        "chg-abc123",
				ParentChangeIDs: []string{"chg-parent"},
			})
		case "/repos/alice:demo/file/chg-abc123/README.md":
			_ = json.NewEncoder(w).Encode(repohost.FileContent{Path: "README.md", Content: "# hello\n"})
		case "/repos/alice:demo/file/chg-parent/src/main.go":
			_ = json.NewEncoder(w).Encode(repohost.FileContent{Path: "src/main.go", Content: "package main\n\nfunc main() {}\n"})
		case "/repos/alice:demo/file/chg-abc123/src/main.go":
			_ = json.NewEncoder(w).Encode(repohost.FileContent{Path: "src/main.go", Content: "package main\n\nfunc main() { println(\"hi\") }\n"})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/changes/chg-abc123/diff", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "change_id": "chg-abc123"})
	rec := httptest.NewRecorder()

	h.GetChangeDiff(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var resp ChangeDiffResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	assert.Equal(t, "chg-abc123", resp.ChangeID)
	require.Len(t, resp.FileDiffs, 2)
	assert.Equal(t, "README.md", resp.FileDiffs[0].Path)
	assert.Equal(t, "added", resp.FileDiffs[0].ChangeType)
	assert.Equal(t, 1, resp.FileDiffs[0].Additions)
	assert.Equal(t, "markdown", resp.FileDiffs[0].Language)
	assert.NotEmpty(t, resp.FileDiffs[0].Patch)
	assert.Equal(t, "# hello\n", resp.FileDiffs[0].NewContent)
	assert.Equal(t, "src/main.go", resp.FileDiffs[1].Path)
	assert.Equal(t, "modified", resp.FileDiffs[1].ChangeType)
	assert.Equal(t, 1, resp.FileDiffs[1].Additions)
	assert.Equal(t, 1, resp.FileDiffs[1].Deletions)
	assert.Equal(t, "go", resp.FileDiffs[1].Language)
	assert.Contains(t, resp.FileDiffs[1].Patch, "@@")
}

func TestJJVCSHandler_GetChangeDiff_ForwardsRevisionSelectors(t *testing.T) {
	t.Parallel()

	var gotRepositoryID int64
	var gotOwner, gotRepo, gotChangeID string
	var gotRequest services.ChangeDiffRequest
	h := &JJVCSHandler{
		RepoResolver: jjVCSLegacyResolver{},
		ChangeService: mockChangeDetailService{getDiffFn: func(_ context.Context, repositoryID int64, owner, repo, changeID string, request services.ChangeDiffRequest) (repohost.ChangeDiff, error) {
			gotRepositoryID = repositoryID
			gotOwner, gotRepo, gotChangeID, gotRequest = owner, repo, changeID, request
			return repohost.ChangeDiff{ChangeID: "change-one", FileDiffs: []repohost.FileDiff{{
				Path: "src/main.go", ChangeType: "modified", TooLarge: true,
			}}}, nil
		}},
	}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/changes/change-one/diff?from=2&to=4&path=src%2Fmain.go&whitespace=ignore", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "change_id": "change-one"})
	rec := httptest.NewRecorder()

	h.GetChangeDiff(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, int64(1), gotRepositoryID)
	assert.Equal(t, "alice", gotOwner)
	assert.Equal(t, "demo", gotRepo)
	assert.Equal(t, "change-one", gotChangeID)
	assert.Equal(t, services.ChangeDiffRequest{From: "2", To: "4", Path: "src/main.go", IgnoreWhitespace: true}, gotRequest)
	var response ChangeDiffResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &response))
	require.Len(t, response.FileDiffs, 1)
	assert.True(t, response.FileDiffs[0].TooLarge)
}

func TestJJVCSHandler_GetChangeDiff_EmptyDiff(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/repos/alice:demo/changes/chg-empty/diff":
			_ = json.NewEncoder(w).Encode(repohost.ChangeDiff{
				ChangeID:  "chg-empty",
				FileDiffs: []repohost.FileDiff{},
			})
		case "/repos/alice:demo/changes/chg-empty":
			_ = json.NewEncoder(w).Encode(repohost.Change{ChangeID: "chg-empty"})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/changes/chg-empty/diff", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "change_id": "chg-empty"})
	rec := httptest.NewRecorder()

	h.GetChangeDiff(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var resp ChangeDiffResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	assert.Equal(t, "chg-empty", resp.ChangeID)
	assert.Empty(t, resp.FileDiffs)
}

func TestJJVCSHandler_GetChangeDiff_MissingChangeID(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("should not call repohost when change_id is missing")
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/changes//diff", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"}) // no change_id
	rec := httptest.NewRecorder()

	h.GetChangeDiff(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestJJVCSHandler_GetChangeDiff_WhitespaceQueryForwarded(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/repos/alice:demo/changes/chg-whitespace/diff":
			_ = json.NewEncoder(w).Encode(repohost.ChangeDiff{
				ChangeID: "chg-whitespace",
				FileDiffs: []repohost.FileDiff{
					{Path: "README.md", ChangeType: "modified"},
				},
			})
		case "/repos/alice:demo/changes/chg-whitespace":
			_ = json.NewEncoder(w).Encode(repohost.Change{
				ChangeID:        "chg-whitespace",
				ParentChangeIDs: []string{"chg-parent"},
			})
		case "/repos/alice:demo/file/chg-parent/README.md":
			_ = json.NewEncoder(w).Encode(repohost.FileContent{Path: "README.md", Content: "hello\n"})
		case "/repos/alice:demo/file/chg-whitespace/README.md":
			_ = json.NewEncoder(w).Encode(repohost.FileContent{Path: "README.md", Content: "hello \n"})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/changes/chg-whitespace/diff?whitespace=ignore", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "change_id": "chg-whitespace"})
	rec := httptest.NewRecorder()

	h.GetChangeDiff(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var resp ChangeDiffResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	assert.Empty(t, resp.FileDiffs)
}

// --- GetChangeFiles ---

func TestJJVCSHandler_GetChangeFiles_Success(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode([]repohost.ChangeFile{
			{Path: "README.md"},
			{Path: "src/main.go"},
			{Path: "go.mod"},
		})
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/changes/chg-abc/files", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "change_id": "chg-abc"})
	rec := httptest.NewRecorder()

	h.GetChangeFiles(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var resp []ChangeFileResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	require.Len(t, resp, 3)
	assert.Equal(t, "README.md", resp[0].Path)
	assert.Equal(t, "src/main.go", resp[1].Path)
	assert.Equal(t, "go.mod", resp[2].Path)
}

func TestJJVCSHandler_GetChangeFiles_MissingChangeID(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("should not call repohost when change_id is missing")
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/changes//files", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"}) // no change_id
	rec := httptest.NewRecorder()

	h.GetChangeFiles(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

// --- GetChangeConflicts ---

func TestJJVCSHandler_GetChangeConflicts_Success(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode([]repohost.Conflict{
			{FilePath: "README.md", ConflictType: "content"},
		})
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/changes/chg-abc/conflicts", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "change_id": "chg-abc"})
	rec := httptest.NewRecorder()

	h.GetChangeConflicts(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var resp []ChangeConflictResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	require.Len(t, resp, 1)
	assert.Equal(t, "README.md", resp[0].FilePath)
	assert.Equal(t, "content", resp[0].ConflictType)
}

// TestJJVCSHandler_GetChangeConflicts_HunksIsString verifies that Conflict.Hunks is
// serialized as a plain string (not []string) matching the repo-host response shape.
func TestJJVCSHandler_GetChangeConflicts_HunksIsString(t *testing.T) {
	t.Parallel()

	conflictHunks := "<<<<<<< Conflict\nversion A\n=======\nversion B\n>>>>>>> Conflict"

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode([]repohost.Conflict{
			{
				FilePath:         "shared.txt",
				ConflictType:     "content",
				BaseContent:      "base\n",
				LeftContent:      "version A\n",
				RightContent:     "version B\n",
				Hunks:            conflictHunks,
				ResolutionStatus: "unresolved",
			},
		})
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/changes/chg-conflict/conflicts", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "change_id": "chg-conflict"})
	rec := httptest.NewRecorder()

	h.GetChangeConflicts(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	// Verify the raw JSON has "hunks" as a string, not an array.
	var rawJSON []map[string]interface{}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &rawJSON))
	require.Len(t, rawJSON, 1)

	hunksRaw, ok := rawJSON[0]["hunks"]
	require.True(t, ok, "hunks field must be present in JSON response")
	_, isString := hunksRaw.(string)
	assert.True(t, isString, "hunks must be a JSON string, not %T: %v", hunksRaw, hunksRaw)

	// Also verify via typed struct deserialization.
	var resp []ChangeConflictResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	require.Len(t, resp, 1)
	assert.Equal(t, "shared.txt", resp[0].FilePath)
	assert.Equal(t, conflictHunks, resp[0].Hunks)
	assert.Equal(t, "base\n", resp[0].BaseContent)
	assert.Equal(t, "unresolved", resp[0].ResolutionStatus)
}

func TestJJVCSHandler_GetChangeConflicts_MissingChangeID(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("should not call repohost when change_id is missing")
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/changes//conflicts", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"}) // no change_id
	rec := httptest.NewRecorder()

	h.GetChangeConflicts(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestJJVCSHandler_GetChangeConflicts_NoConflicts(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode([]repohost.Conflict{})
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/changes/chg-clean/conflicts", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "change_id": "chg-clean"})
	rec := httptest.NewRecorder()

	h.GetChangeConflicts(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var resp []ChangeConflictResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	assert.Empty(t, resp)
}

func TestJJVCSHandler_ResolveChangeConflict_AcceptsAgentDispatch(t *testing.T) {
	t.Parallel()

	var got services.ResolveChangeConflictInput
	handler := &JJVCSHandler{ConflictResolver: mockChangeConflictResolver{resolveFn: func(_ context.Context, input services.ResolveChangeConflictInput) (services.ResolveChangeConflictResponse, error) {
		got = input
		return services.ResolveChangeConflictResponse{AgentSessionID: "session-123"}, nil
	}}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/changes/change-1/conflicts/resolve", strings.NewReader(`{"path":"src/conflicted.go"}`))
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "change_id": "change-1"})
	req = withAuth(req, 7, "alice")
	req = withRepoCtx(req, 42, "alice", "demo")
	recorder := httptest.NewRecorder()

	handler.ResolveChangeConflict(recorder, req)

	require.Equal(t, http.StatusAccepted, recorder.Code)
	assert.Equal(t, services.ResolveChangeConflictInput{
		RepositoryID: 42,
		UserID:       7,
		Owner:        "alice",
		Repo:         "demo",
		ChangeID:     "change-1",
		Path:         "src/conflicted.go",
	}, got)
	assert.JSONEq(t, `{"agent_session_id":"session-123"}`, recorder.Body.String())
}

func TestJJVCSHandler_ResolveChangeConflict_PropagatesServiceError(t *testing.T) {
	t.Parallel()

	handler := &JJVCSHandler{ConflictResolver: mockChangeConflictResolver{resolveFn: func(_ context.Context, _ services.ResolveChangeConflictInput) (services.ResolveChangeConflictResponse, error) {
		return services.ResolveChangeConflictResponse{}, pkgerrors.NotFound("conflict not found")
	}}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/changes/change-1/conflicts/resolve", strings.NewReader(`{"path":"missing.go"}`))
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "change_id": "change-1"})
	req = withAuth(req, 7, "alice")
	req = withRepoCtx(req, 42, "alice", "demo")
	recorder := httptest.NewRecorder()

	handler.ResolveChangeConflict(recorder, req)

	assert.Equal(t, http.StatusNotFound, recorder.Code)
	assert.JSONEq(t, `{"code":"not_found","fault":"user","message":"conflict not found"}`, recorder.Body.String())
}

// --- ListOperations ---

func TestJJVCSHandler_ListOperations_Success(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodGet, r.Method)
		assert.Contains(t, r.URL.Path, "operations")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []map[string]any{
				{"operation_id": "op-1", "description": "bookmark create main", "timestamp": "2024-01-01T00:00:01Z"},
				{"operation_id": "op-2", "description": "new empty commit", "timestamp": "2024-01-01T00:00:02Z"},
			},
			"total_count": int64(2),
		})
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/operations", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	rec := httptest.NewRecorder()

	h.ListOperations(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	resp, nextCursor := decodeCursorItems[OperationResponse](t, rec.Body.Bytes())
	require.Len(t, resp, 2)
	assert.Empty(t, nextCursor)
	assert.Equal(t, "op-1", resp[0].OperationID)
	assert.Equal(t, "bookmark create main", resp[0].Description)
	assert.Equal(t, "2024-01-01T00:00:01Z", resp[0].Timestamp)
	assert.Equal(t, "op-2", resp[1].OperationID)
	assert.Equal(t, "2024-01-01T00:00:02Z", resp[1].Timestamp)
}

func TestJJVCSHandler_ListOperations_Empty(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items":       []map[string]any{},
			"total_count": int64(0),
		})
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/operations", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	rec := httptest.NewRecorder()

	h.ListOperations(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	resp, nextCursor := decodeCursorItems[OperationResponse](t, rec.Body.Bytes())
	assert.Empty(t, nextCursor)
	assert.Empty(t, resp)
}

func TestJJVCSHandler_ListOperations_MissingOwner(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("should not call repohost when route params are missing")
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodGet, "/api/repos//demo/operations", nil)
	// No route params set
	rec := httptest.NewRecorder()

	h.ListOperations(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestJJVCSHandler_ListOperations_PaginationHeadersAndParamForwarding(t *testing.T) {
	t.Parallel()

	var gotPage string
	var gotPerPage string
	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPage = r.URL.Query().Get("page")
		gotPerPage = r.URL.Query().Get("per_page")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []map[string]any{
				{"operation_id": "op-1", "description": "bookmark create main", "timestamp": "2024-01-01T00:00:01Z"},
			},
			"total_count": int64(5),
		})
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/operations?page=3&per_page=2", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	rec := httptest.NewRecorder()

	h.ListOperations(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "3", gotPage)
	assert.Equal(t, "2", gotPerPage)
	link := rec.Header().Get("Link")
	assert.Contains(t, link, `rel="first"`)
	assert.NotContains(t, link, `rel="last"`)
	assert.NotContains(t, link, `rel="prev"`)
	assert.NotContains(t, link, `rel="next"`)
}

func TestJJVCSHandler_ListEndpoints_InvalidPaginationParams(t *testing.T) {
	t.Parallel()

	endpoints := []struct {
		name   string
		path   string
		invoke func(*JJVCSHandler, http.ResponseWriter, *http.Request)
	}{
		{
			name: "bookmarks",
			path: "/api/repos/alice/demo/bookmarks",
			invoke: func(h *JJVCSHandler, w http.ResponseWriter, r *http.Request) {
				h.ListBookmarks(w, r)
			},
		},
		{
			name: "changes",
			path: "/api/repos/alice/demo/changes",
			invoke: func(h *JJVCSHandler, w http.ResponseWriter, r *http.Request) {
				h.ListChanges(w, r)
			},
		},
		{
			name: "operations",
			path: "/api/repos/alice/demo/operations",
			invoke: func(h *JJVCSHandler, w http.ResponseWriter, r *http.Request) {
				h.ListOperations(w, r)
			},
		},
	}

	queries := []string{
		"?page=0",
		"?page=not-a-number",
		"?per_page=0",
		"?per_page=101",
		"?per_page=not-a-number",
	}

	for _, endpoint := range endpoints {
		endpoint := endpoint
		for _, rawQuery := range queries {
			rawQuery := rawQuery
			t.Run(endpoint.name+rawQuery, func(t *testing.T) {
				t.Parallel()

				var called atomic.Bool
				fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					called.Store(true)
					w.Header().Set("Content-Type", "application/json")
					_ = json.NewEncoder(w).Encode(map[string]any{
						"items":       []any{},
						"total_count": int64(0),
					})
				}))
				t.Cleanup(fakeServer.Close)

				h := newJJVCSHandler(fakeServer)
				req := httptest.NewRequest(http.MethodGet, endpoint.path+rawQuery, nil)
				req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
				rec := httptest.NewRecorder()

				endpoint.invoke(h, rec, req)

				assert.Equal(t, http.StatusBadRequest, rec.Code)
				assert.False(t, called.Load())
			})
		}
	}
}

// --- GetWorkingTreeStatus ---

func TestJJVCSHandler_GetWorkingTreeStatus_Success(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodGet, r.Method)
		assert.True(t, strings.HasSuffix(r.URL.Path, "/status"), "path was %s", r.URL.Path)

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(repohost.WorkingTreeStatus{
			Backend: "git",
			Branch:  "main",
			Head:    "deadbeef",
			Changes: []repohost.WorkingTreeChange{
				{Path: "added.txt", Status: "added", Staged: true, Add: 2, Del: 0},
				{Path: "keep.txt", Status: "modified", Staged: true, Add: 1, Del: 0},
			},
		})
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/status", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	rec := httptest.NewRecorder()

	h.GetWorkingTreeStatus(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var resp WorkingTreeStatusResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	assert.Equal(t, "git", resp.Backend)
	assert.Equal(t, "main", resp.Branch)
	assert.Equal(t, "deadbeef", resp.Head)
	require.Len(t, resp.Changes, 2)
	assert.Equal(t, "added.txt", resp.Changes[0].Path)
	assert.Equal(t, "added", resp.Changes[0].Status)
	assert.True(t, resp.Changes[0].Staged)
	assert.Equal(t, uint32(2), resp.Changes[0].Add)
	assert.Equal(t, "modified", resp.Changes[1].Status)
}

func TestJJVCSHandler_GetWorkingTreeStatus_MissingOwner(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodGet, "/api/repos//demo/status", nil)
	req = withJJRouteParams(req, map[string]string{"repo": "demo"})
	rec := httptest.NewRecorder()

	h.GetWorkingTreeStatus(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
}

// --- GetFileAtChange ---

func TestJJVCSHandler_GetFileAtChange_Success(t *testing.T) {
	t.Parallel()

	var gotPath string
	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodGet, r.Method)
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(repohost.FileContent{
			Path:    "README.md",
			Content: "# Hello\n",
		})
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/file/chg-abc/README.md", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "change_id": "chg-abc", "*": "README.md"})
	rec := httptest.NewRecorder()

	h.GetFileAtChange(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var resp repohost.FileContent
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	assert.Equal(t, "README.md", resp.Path)
	assert.Equal(t, "# Hello\n", resp.Content)
	assert.Contains(t, gotPath, "README.md")
}

func TestJJVCSHandler_GetFileAtChange_MissingChangeID(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("should not call repohost when change_id is missing")
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/file//README.md", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "path": "README.md"}) // no change_id
	rec := httptest.NewRecorder()

	h.GetFileAtChange(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestJJVCSHandler_GetFileAtChange_MissingPath(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("should not call repohost when path is missing")
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/file/chg-abc/", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "change_id": "chg-abc"}) // no path
	rec := httptest.NewRecorder()

	h.GetFileAtChange(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestJJVCSHandler_GetFileAtChange_NotFound(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"message":"file not found"}`))
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/file/chg-abc/nonexistent.txt", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "change_id": "chg-abc", "*": "nonexistent.txt"})
	rec := httptest.NewRecorder()

	h.GetFileAtChange(rec, req)

	assert.Equal(t, http.StatusNotFound, rec.Code)
}

func TestJJVCSHandler_GetFileAtChange_NestedPath(t *testing.T) {
	t.Parallel()

	var gotPath string
	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(repohost.FileContent{
			Path:    "src/main.go",
			Content: "package main\n",
		})
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/file/chg-abc/src/main.go", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "change_id": "chg-abc", "*": "src/main.go"})
	rec := httptest.NewRecorder()

	h.GetFileAtChange(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var resp repohost.FileContent
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	assert.Equal(t, "src/main.go", resp.Path)
	assert.Contains(t, gotPath, "src")
	assert.Contains(t, gotPath, "main.go")
}

// TestJJVCSHandler_GetFileAtChange_RouterNestedPathMatches is the regression
// guard for the production 404 on nested file paths. It mounts the ACTUAL chi
// route pattern (not injected params) and proves a deeply nested path both
// matches the route and is forwarded to the repohost intact. Under the old
// "{path:.*}" regex param, chi only matched a single segment, so any nested
// path (e.g. apps/cli/package.json) fell through to a 404.
func TestJJVCSHandler_GetFileAtChange_RouterNestedPathMatches(t *testing.T) {
	t.Parallel()

	nestedPath := "apps/cli/package.json"

	var gotPath string
	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(repohost.FileContent{
			Path:    nestedPath,
			Content: "{}\n",
		})
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)

	router := chi.NewRouter()
	router.Get("/api/repos/{owner}/{repo}/file/{change_id}/*", h.GetFileAtChange)

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/file/chg-abc/"+nestedPath, nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, "nested path must match the route, not 404")
	var resp repohost.FileContent
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	assert.Equal(t, nestedPath, resp.Path)
	// The full nested path (all three segments) must reach the repohost intact.
	assert.Contains(t, gotPath, "apps")
	assert.Contains(t, gotPath, "cli")
	assert.Contains(t, gotPath, "package.json")
}

func TestJJVCSHandler_GetFileAtChange_RouterPreservesTrailingSpacePath(t *testing.T) {
	t.Parallel()

	filePath := "docs/report "

	var gotPath string
	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(repohost.FileContent{
			Path:    filePath,
			Content: "report\n",
		})
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)

	router := chi.NewRouter()
	router.Get("/api/repos/{owner}/{repo}/file/{change_id}/*", h.GetFileAtChange)

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/file/chg-abc/docs/report%20", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var resp repohost.FileContent
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	assert.Equal(t, filePath, resp.Path)
	assert.True(t, strings.HasSuffix(gotPath, "/docs/report "), "repohost path = %q", gotPath)
}

// --- Error propagation ---

func TestJJVCSHandler_ListBookmarks_RepohostError(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/bookmarks", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	rec := httptest.NewRecorder()

	h.ListBookmarks(rec, req)

	// Should return 500 when repohost fails
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
}

func TestJJVCSHandler_GetChange_RepohostError(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	h.ChangeService = mockChangeDetailService{getChangeFn: func(context.Context, int64, string, string, string) (services.ChangeDetailResponse, error) {
		return services.ChangeDetailResponse{}, pkgerrors.NotFound("not found")
	}}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/changes/nonexistent", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "change_id": "nonexistent"})
	rec := httptest.NewRecorder()

	h.GetChange(rec, req)

	// Repohost 404 is propagated as a 404
	assert.Equal(t, http.StatusNotFound, rec.Code)
}

// --- Unauthenticated write operations ---

func TestJJVCSHandler_DeleteBookmark_Unauthenticated(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("should not call repohost when not authenticated")
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodDelete, "/api/repos/alice/demo/bookmarks/main", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "name": "main"})
	// No auth — simulates unauthenticated request
	rec := httptest.NewRecorder()

	h.DeleteBookmark(rec, req)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

// --- Error message shape ---

func TestJJVCSHandler_RepohostConflict_Returns409(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"message":"bookmark already exists"}`))
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	body := `{"name":"main","target_change_id":"chg-abc"}`
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/bookmarks", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	req = withRepoAuth(req, 1, "alice")
	rec := httptest.NewRecorder()

	h.CreateBookmark(rec, req)

	assert.Equal(t, http.StatusConflict, rec.Code)
	assert.Contains(t, rec.Body.String(), "bookmark already exists")
}

func TestJJVCSHandler_RepohostBadRequest_Returns400(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"message":"invalid change id"}`))
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	body := `{"name":"bm","target_change_id":"bad"}`
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/bookmarks", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo"})
	req = withRepoAuth(req, 1, "alice")
	rec := httptest.NewRecorder()

	h.CreateBookmark(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), "invalid change id")
}

// --- RepohostNotFound error mapping tests (jj-vcs-003) ---

func TestJJVCSHandler_GetChangeFiles_RepohostNotFound(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"message":"change not found"}`))
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/changes/nonexistent/files", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "change_id": "nonexistent"})
	rec := httptest.NewRecorder()

	h.GetChangeFiles(rec, req)

	// Should return 404 (not 500) when repohost returns 404
	assert.Equal(t, http.StatusNotFound, rec.Code)
	body := rec.Body.String()
	assert.Contains(t, body, "change not found")
	// Should NOT include the internal fallback prefix
	assert.NotContains(t, body, "failed to get change files:")
}

func TestJJVCSHandler_GetChangeConflicts_RepohostNotFound(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"message":"change not found"}`))
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/changes/nonexistent/conflicts", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "demo", "change_id": "nonexistent"})
	rec := httptest.NewRecorder()

	h.GetChangeConflicts(rec, req)

	// Should return 404 (not 500) when repohost returns 404
	assert.Equal(t, http.StatusNotFound, rec.Code)
	body := rec.Body.String()
	assert.Contains(t, body, "change not found")
	// Should NOT include the internal fallback prefix
	assert.NotContains(t, body, "failed to get change conflicts:")
}

func TestJJVCSHandler_ListOperations_RepohostNotFound(t *testing.T) {
	t.Parallel()

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"message":"repository not found"}`))
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSHandler(fakeServer)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/nonexistent/operations", nil)
	req = withJJRouteParams(req, map[string]string{"owner": "alice", "repo": "nonexistent"})
	rec := httptest.NewRecorder()

	h.ListOperations(rec, req)

	// Should return 404 (not 500) when repohost returns 404
	assert.Equal(t, http.StatusNotFound, rec.Code)
	body := rec.Body.String()
	assert.Contains(t, body, "repository not found")
	// Should NOT include the internal fallback prefix
	assert.NotContains(t, body, "failed to list operations:")
}

// --- repohostErrToAPIErr mapper unit tests ---

func TestRepohostErrToAPIErr_NotFoundStatus(t *testing.T) {
	t.Parallel()

	// Test that 404 StatusError maps to NotFound with upstream message preserved
	statusErr := &repohost.StatusError{
		StatusCode: http.StatusNotFound,
		Message:    "upstream not found message",
	}

	apiErr := repohostErrToAPIErr(context.Background(), statusErr, "fallback message")

	require.NotNil(t, apiErr)
	assert.Equal(t, http.StatusNotFound, apiErr.Status)
	assert.Equal(t, "upstream not found message", apiErr.Message)
	// Should NOT include fallback message when upstream message exists
	assert.NotContains(t, apiErr.Message, "fallback message")
}

func TestRepohostErrToAPIErr_NotFoundStatus_EmptyMessage(t *testing.T) {
	t.Parallel()

	// Test that 404 with empty message uses fallback
	statusErr := &repohost.StatusError{
		StatusCode: http.StatusNotFound,
		Message:    "",
	}

	apiErr := repohostErrToAPIErr(context.Background(), statusErr, "custom fallback")

	require.NotNil(t, apiErr)
	assert.Equal(t, http.StatusNotFound, apiErr.Status)
	assert.Equal(t, "custom fallback", apiErr.Message)
}

func TestRepohostErrToAPIErr_BadRequestStatus(t *testing.T) {
	t.Parallel()

	statusErr := &repohost.StatusError{
		StatusCode: http.StatusBadRequest,
		Message:    "invalid input",
	}

	apiErr := repohostErrToAPIErr(context.Background(), statusErr, "fallback message")

	require.NotNil(t, apiErr)
	assert.Equal(t, http.StatusBadRequest, apiErr.Status)
	assert.Equal(t, "invalid input", apiErr.Message)
}

func TestRepohostErrToAPIErr_ConflictStatus(t *testing.T) {
	t.Parallel()

	statusErr := &repohost.StatusError{
		StatusCode: http.StatusConflict,
		Message:    "resource conflict",
	}

	apiErr := repohostErrToAPIErr(context.Background(), statusErr, "fallback message")

	require.NotNil(t, apiErr)
	assert.Equal(t, http.StatusConflict, apiErr.Status)
	assert.Equal(t, "resource conflict", apiErr.Message)
}

func TestRepohostErrToAPIErr_NonStatusError(t *testing.T) {
	t.Parallel()

	// Non-StatusError falls back to Internal with the sanitized fallback message
	// only; the original error is logged server-side and never exposed to the
	// caller to avoid leaking internal implementation details.
	normalErr := &testError{msg: "some network error"}

	apiErr := repohostErrToAPIErr(context.Background(), normalErr, "operation failed")

	require.NotNil(t, apiErr)
	assert.Equal(t, http.StatusInternalServerError, apiErr.Status)
	assert.Equal(t, "operation failed", apiErr.Message)
}

// testError is a simple error type for testing
type testError struct {
	msg string
}

func (e *testError) Error() string {
	return e.msg
}

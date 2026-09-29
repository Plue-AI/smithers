package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// --- mock service implementations for handler benchmarks ---

type benchRepoRouteService struct {
	repo db.Repository
}

func (m *benchRepoRouteService) CreateRepo(_ context.Context, _ *db.User, _, _ string, _ bool, _ string, _ bool) (db.Repository, error) {
	return m.repo, nil
}

func (m *benchRepoRouteService) CreateOrgRepo(_ context.Context, _ *db.User, _, _, _ string, _ bool, _ string, _ bool) (db.Repository, error) {
	return m.repo, nil
}

func (m *benchRepoRouteService) GetRepo(_ context.Context, _ *db.User, _, _ string) (db.Repository, error) {
	return m.repo, nil
}

func (m *benchRepoRouteService) UpdateRepo(_ context.Context, _ *db.User, _, _ string, _ services.UpdateRepoRequest) (db.Repository, error) {
	return m.repo, nil
}

func (m *benchRepoRouteService) DeleteRepo(_ context.Context, _ *db.User, _, _ string) error {
	return nil
}

func (m *benchRepoRouteService) GetRepoTopics(_ context.Context, _ *db.User, _, _ string) ([]string, error) {
	return []string{"go", "jj", "testing"}, nil
}

func (m *benchRepoRouteService) ReplaceRepoTopics(_ context.Context, _ *db.User, _, _ string, _ []string) ([]string, error) {
	return []string{"go", "jj", "testing"}, nil
}

func (m *benchRepoRouteService) ListRepoStargazers(_ context.Context, _ *db.User, _, _ string, _, _ int) ([]db.User, int64, error) {
	return nil, 0, nil
}

func (m *benchRepoRouteService) StarRepo(_ context.Context, _ *db.User, _, _ string) error {
	return nil
}

func (m *benchRepoRouteService) UnstarRepo(_ context.Context, _ *db.User, _, _ string) error {
	return nil
}

func (m *benchRepoRouteService) GetRepoContents(_ context.Context, _ *db.User, _, _, _, _ string) (services.RepoContent, error) {
	return services.RepoContent{}, nil
}

func (m *benchRepoRouteService) ListRepoContents(_ context.Context, _ *db.User, _, _, _, _ string) ([]services.RepoContent, error) {
	return nil, nil
}

func (m *benchRepoRouteService) ListGitRefs(_ context.Context, _ *db.User, _, _ string) ([]services.GitRef, error) {
	return nil, nil
}

func (m *benchRepoRouteService) ArchiveRepo(_ context.Context, _ *db.User, _, _ string) (db.Repository, error) {
	return m.repo, nil
}

func (m *benchRepoRouteService) UnarchiveRepo(_ context.Context, _ *db.User, _, _ string) (db.Repository, error) {
	return m.repo, nil
}

func (m *benchRepoRouteService) TransferRepo(_ context.Context, _ *db.User, _, _, _ string) (services.RepoTransferResult, error) {
	return services.RepoTransferResult{Repository: m.repo}, nil
}
func (m *benchRepoRouteService) ListRepoTransfers(context.Context, *db.User) ([]db.RepositoryTransferRequest, error) {
	return nil, nil
}
func (m *benchRepoRouteService) AcceptRepoTransfer(context.Context, *db.User, int64) (db.Repository, error) {
	return m.repo, nil
}
func (m *benchRepoRouteService) DeclineRepoTransfer(context.Context, *db.User, int64) error {
	return nil
}
func (m *benchRepoRouteService) CancelRepoTransfer(context.Context, *db.User, int64) error {
	return nil
}

func (m *benchRepoRouteService) ForkRepo(_ context.Context, _ *db.User, _, _, _, _ string) (services.ForkOutcome, error) {
	return services.ForkOutcome{Repository: m.repo, Created: true}, nil
}

func (m *benchRepoRouteService) GetRepoView(_ context.Context, _ *db.User, _, _ string) (services.RepoView, error) {
	return services.RepoView{Repository: m.repo}, nil
}

func (m *benchRepoRouteService) CheckRepoStarred(_ context.Context, _ *db.User, _, _ string) (bool, error) {
	return false, nil
}

type benchIssueRouteService struct {
	issue   services.IssueResponse
	issues  []services.IssueResponse
	comment services.IssueCommentResponse
}

func (m *benchIssueRouteService) ListIssues(_ context.Context, _ *db.User, _, _ string, _ int64, _ int, _ string) ([]services.IssueResponse, string, int64, error) {
	return m.issues, "", int64(len(m.issues)), nil
}

func (m *benchIssueRouteService) CreateIssue(_ context.Context, _ *db.User, _, _ string, _ services.CreateIssueInput) (services.IssueResponse, error) {
	return m.issue, nil
}

func (m *benchIssueRouteService) GetIssue(_ context.Context, _ *db.User, _, _ string, _ int64) (services.IssueResponse, error) {
	return m.issue, nil
}

func (m *benchIssueRouteService) UpdateIssue(_ context.Context, _ *db.User, _, _ string, _ int64, _ services.UpdateIssueInput) (services.IssueResponse, error) {
	return m.issue, nil
}

func (m *benchIssueRouteService) CreateIssueComment(_ context.Context, _ *db.User, _, _ string, _ int64, _ services.CreateIssueCommentInput) (services.IssueCommentResponse, error) {
	return m.comment, nil
}

func (m *benchIssueRouteService) ListIssueComments(_ context.Context, _ *db.User, _, _ string, _ int64, _ int64, _ int) ([]services.IssueCommentResponse, string, int64, error) {
	return nil, "", 0, nil
}

func (m *benchIssueRouteService) GetIssueComment(_ context.Context, _ *db.User, _, _ string, _ int64) (services.IssueCommentResponse, error) {
	return m.comment, nil
}

func (m *benchIssueRouteService) UpdateIssueComment(_ context.Context, _ *db.User, _, _ string, _ int64, _ services.UpdateIssueCommentInput) (services.IssueCommentResponse, error) {
	return m.comment, nil
}

func (m *benchIssueRouteService) DeleteIssueComment(_ context.Context, _ *db.User, _, _ string, _ int64) error {
	return nil
}

// --- helpers ---

func benchRequestWithUser(method, path string, body []byte) *http.Request {
	var req *http.Request
	if body != nil {
		req = httptest.NewRequest(method, path, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
	} else {
		req = httptest.NewRequest(method, path, nil)
	}

	user := &db.User{ID: 1, Username: "testuser", IsAdmin: false}
	authInfo := &middleware.AuthInfo{
		User:        user,
		IsTokenAuth: true,
		Scopes:      middleware.ParseTokenScopes("all"),
	}
	ctx := middleware.ContextWithAuthInfo(req.Context(), authInfo)
	return req.WithContext(ctx)
}

func benchRepoResponse() db.Repository {
	return db.Repository{
		ID:              1,
		Name:            "test-repo",
		LowerName:       "test-repo",
		Description:     "A test repository for benchmarking",
		IsPublic:        true,
		DefaultBookmark: "main",
		CreatedAt:       time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC),
		UpdatedAt:       time.Date(2024, 6, 15, 12, 30, 0, 0, time.UTC),
	}
}

// --- handler benchmarks ---

func BenchmarkRepoHandler_CreateRepo(b *testing.B) {
	handler := &RepoHandler{
		Service: &benchRepoRouteService{repo: benchRepoResponse()},
		SSHHost: "ssh.smithers.sh",
	}

	body, _ := json.Marshal(CreateRepoRequest{
		Name:        "test-repo",
		Description: "A benchmark test repository",
		Private:     false,
	})

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		req := benchRequestWithUser(http.MethodPost, "/api/user/repos", body)
		rec := httptest.NewRecorder()
		handler.CreateRepo(rec, req)
		if rec.Code != http.StatusCreated {
			b.Fatalf("unexpected status: %d, body: %s", rec.Code, rec.Body.String())
		}
	}
}

func BenchmarkIssueHandler_CreateIssue(b *testing.B) {
	issue := services.IssueResponse{
		ID:        1,
		Number:    1,
		Title:     "Benchmark issue",
		Body:      "This is a benchmark issue",
		State:     "open",
		Author:    services.IssueUserSummary{ID: 1, Login: "testuser"},
		Assignees: []services.IssueUserSummary{},
		Labels:    []services.LabelSummary{},
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}

	handler := &IssueHandler{
		Service: &benchIssueRouteService{issue: issue},
	}

	body, _ := json.Marshal(createIssueRequest{
		Title: "Benchmark issue",
		Body:  "This is a benchmark issue",
	})

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		req := benchRequestWithUser(http.MethodPost, "/api/repos/testuser/test-repo/issues", body)
		// Set route params via Chi's URL params.
		req = setRouteParams(req, "owner", "testuser", "repo", "test-repo")
		rec := httptest.NewRecorder()
		handler.CreateIssue(rec, req)
		if rec.Code != http.StatusCreated {
			b.Fatalf("unexpected status: %d, body: %s", rec.Code, rec.Body.String())
		}
	}
}

func BenchmarkRepoResponseJSON_Marshal(b *testing.B) {
	resp := RepoResponse{
		ID:              1,
		Owner:           "testuser",
		Name:            "test-repo",
		FullName:        "testuser/test-repo",
		Description:     "A test repository for benchmarking JSON serialization",
		Private:         false,
		IsPublic:        true,
		DefaultBookmark: "main",
		Topics:          []string{"go", "benchmark", "testing", "json", "performance"},
		IsArchived:      false,
		IsFork:          false,
		NumStars:        42,
		NumWatches:      10,
		NumIssues:       5,
		CloneURL:        "https://smithers.sh/testuser/test-repo.git",
		CreatedAt:       time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC),
		UpdatedAt:       time.Date(2024, 6, 15, 12, 30, 0, 0, time.UTC),
	}

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		data, err := json.Marshal(resp)
		if err != nil {
			b.Fatal(err)
		}
		if len(data) == 0 {
			b.Fatal("empty JSON output")
		}
	}
}

func BenchmarkIssueResponseJSON_Marshal(b *testing.B) {
	resp := services.IssueResponse{
		ID:     1,
		Number: 42,
		Title:  "Benchmark test issue with a realistic title",
		Body:   "This is the body of a benchmark test issue. It contains multiple sentences to simulate realistic payload sizes that would be seen in production usage.",
		State:  "open",
		Author: services.IssueUserSummary{ID: 1, Login: "testuser"},
		Assignees: []services.IssueUserSummary{
			{ID: 1, Login: "testuser"},
			{ID: 2, Login: "reviewer"},
		},
		Labels: []services.LabelSummary{
			{ID: 1, Name: "bug", Color: "#ff0000", Description: "Bug report"},
			{ID: 2, Name: "priority:high", Color: "#ff8800", Description: "High priority"},
		},
		CommentCount: 5,
		CreatedAt:    time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC),
		UpdatedAt:    time.Date(2024, 6, 15, 12, 30, 0, 0, time.UTC),
	}

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		data, err := json.Marshal(resp)
		if err != nil {
			b.Fatal(err)
		}
		if len(data) == 0 {
			b.Fatal("empty JSON output")
		}
	}
}

func BenchmarkLandingResponseJSON_Marshal(b *testing.B) {
	resp := services.LandingRequestResponse{
		Number: 7,
		Title:  "Stack: Add auth middleware and scope enforcement",
		Body:   "This landing request includes three stacked changes implementing scope-based authorization for the API token system.",
		State:  "open",
		Author: services.LandingRequestAuthor{ID: 1, Login: "testuser"},
		ChangeIDs: []string{
			"abc123def456",
			"789ghi012jkl",
			"345mno678pqr",
		},
		TargetBookmark: "main",
		ConflictStatus: "clean",
		StackSize:      3,
		CreatedAt:      time.Date(2024, 3, 10, 9, 0, 0, 0, time.UTC),
		UpdatedAt:      time.Date(2024, 3, 10, 14, 30, 0, 0, time.UTC),
	}

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		data, err := json.Marshal(resp)
		if err != nil {
			b.Fatal(err)
		}
		if len(data) == 0 {
			b.Fatal("empty JSON output")
		}
	}
}

// setRouteParams injects chi URL params into the request context.
// This is needed because chi handler functions read params via chi.URLParam.
func setRouteParams(r *http.Request, kvs ...string) *http.Request {
	rctx := chi.NewRouteContext()
	for i := 0; i+1 < len(kvs); i += 2 {
		rctx.URLParams.Add(kvs[i], kvs[i+1])
	}
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
}

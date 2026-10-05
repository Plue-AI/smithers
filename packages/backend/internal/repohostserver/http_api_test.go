package repohostserver

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/hostexec"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
)

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

func TestHealthEndpoint(t *testing.T) {
	srv := newTestServer(t)
	handler := srv.Handler()

	tests := []struct {
		name       string
		method     string
		wantStatus int
		wantBody   string
	}{
		{
			name:       "health_returns_200_ok",
			method:     http.MethodGet,
			wantStatus: http.StatusOK,
			wantBody:   "ok",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(tt.method, "/health", nil)
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)

			if w.Code != tt.wantStatus {
				t.Fatalf("expected status %d, got %d", tt.wantStatus, w.Code)
			}
			if tt.wantBody != "" && w.Body.String() != tt.wantBody {
				t.Fatalf("expected body %q, got %q", tt.wantBody, w.Body.String())
			}
		})
	}
}

func TestNewWithFFIRejectsEmptyAuthToken(t *testing.T) {
	for _, token := range []string{"", "  "} {
		if _, err := NewWithFFI(Config{AuthToken: token}, &mockFFI{}); err == nil {
			t.Fatalf("accepted empty auth token %q", token)
		}
	}
}

// ---------------------------------------------------------------------------
// Unauthorized requests
// ---------------------------------------------------------------------------

func TestUnauthorizedRequestsReturn401(t *testing.T) {
	srv := newTestServer(t)
	handler := srv.Handler()

	tests := []struct {
		name   string
		method string
		path   string
	}{
		{name: "init_repo", method: http.MethodPost, path: "/repos/init"},
		{name: "fork_repo", method: http.MethodPost, path: "/repos/fork"},
		{name: "move_repo", method: http.MethodPost, path: "/repos/move"},
		{name: "delete_repo", method: http.MethodDelete, path: "/repos/alice/demo"},
		{name: "list_bookmarks", method: http.MethodGet, path: "/repos/alice%3Ademo/bookmarks"},
		{name: "create_bookmark", method: http.MethodPost, path: "/repos/alice%3Ademo/bookmarks"},
		{name: "delete_bookmark", method: http.MethodDelete, path: "/repos/alice%3Ademo/bookmarks/main"},
		{name: "list_changes", method: http.MethodGet, path: "/repos/alice%3Ademo/changes"},
		{name: "get_change", method: http.MethodGet, path: "/repos/alice%3Ademo/changes/abc123"},
		{name: "split_change", method: http.MethodPost, path: "/repos/alice%3Ademo/changes/abc123/split"},
		{name: "get_diff", method: http.MethodGet, path: "/repos/alice%3Ademo/changes/abc123/diff"},
		{name: "get_files", method: http.MethodGet, path: "/repos/alice%3Ademo/changes/abc123/files"},
		{name: "get_file_at_change", method: http.MethodGet, path: "/repos/alice%3Ademo/file/abc123/README.md"},
		{name: "land_changes", method: http.MethodPost, path: "/repos/alice%3Ademo/land"},
		{name: "list_operations", method: http.MethodGet, path: "/repos/alice%3Ademo/operations"},
		{name: "import_refs", method: http.MethodPost, path: "/repos/alice/demo/git/import-refs"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(tt.method, tt.path, nil)
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)

			if w.Code != http.StatusUnauthorized {
				t.Fatalf("expected 401 for %s %s, got %d; body=%s", tt.method, tt.path, w.Code, w.Body.String())
			}

			assertGiteaErrorJSON(t, w.Body.Bytes())
		})
	}
}

// ---------------------------------------------------------------------------
// Repository storage operations
// ---------------------------------------------------------------------------

func TestForkRepoRouteCopiesRepositoryStorage(t *testing.T) {
	srv := newTestServer(t)
	handler := srv.Handler()

	srcPath := srv.config.RepoPath("alice", "demo")
	if err := os.MkdirAll(filepath.Join(srcPath, "objects"), 0o755); err != nil {
		t.Fatalf("mkdir source repo: %v", err)
	}
	if err := os.WriteFile(filepath.Join(srcPath, "objects", "pack"), []byte("git-data"), 0o644); err != nil {
		t.Fatalf("write source repo data: %v", err)
	}

	body, _ := json.Marshal(map[string]string{
		"src_owner": "alice",
		"src_repo":  "demo",
		"dst_owner": "bob",
		"dst_repo":  "demo-fork",
	})
	req := httptest.NewRequest(http.MethodPost, "/repos/fork", bytes.NewReader(body))
	req.Header.Set("Authorization", validAuth())
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d; body=%s", w.Code, w.Body.String())
	}
	got, err := os.ReadFile(filepath.Join(srv.config.RepoPath("bob", "demo-fork"), "objects", "pack"))
	if err != nil {
		t.Fatalf("read copied repo data: %v", err)
	}
	if string(got) != "git-data" {
		t.Fatalf("unexpected copied data %q", got)
	}
}

func TestForkRepoRoutePreservesSymlinksWithoutDereferencing(t *testing.T) {
	srv := newTestServer(t)
	handler := srv.Handler()

	srcPath := srv.config.RepoPath("alice", "demo")
	if err := os.MkdirAll(filepath.Join(srcPath, "objects"), 0o755); err != nil {
		t.Fatalf("mkdir source repo: %v", err)
	}
	secretPath := filepath.Join(t.TempDir(), "host-secret")
	if err := os.WriteFile(secretPath, []byte("do-not-copy"), 0o600); err != nil {
		t.Fatalf("write secret target: %v", err)
	}
	if err := os.Symlink(secretPath, filepath.Join(srcPath, "objects", "leak")); err != nil {
		t.Fatalf("create source symlink: %v", err)
	}
	if err := os.WriteFile(filepath.Join(srcPath, "objects", "pack"), []byte("git-data"), 0o644); err != nil {
		t.Fatalf("write source repo data: %v", err)
	}

	body, _ := json.Marshal(map[string]string{
		"src_owner": "alice",
		"src_repo":  "demo",
		"dst_owner": "bob",
		"dst_repo":  "demo-fork",
	})
	req := httptest.NewRequest(http.MethodPost, "/repos/fork", bytes.NewReader(body))
	req.Header.Set("Authorization", validAuth())
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d; body=%s", w.Code, w.Body.String())
	}
	dstLeak := filepath.Join(srv.config.RepoPath("bob", "demo-fork"), "objects", "leak")
	info, err := os.Lstat(dstLeak)
	if err != nil {
		t.Fatalf("lstat copied symlink: %v", err)
	}
	if info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("copied path mode = %v, want symlink", info.Mode())
	}
	linkTarget, err := os.Readlink(dstLeak)
	if err != nil {
		t.Fatalf("read copied symlink: %v", err)
	}
	if linkTarget != secretPath {
		t.Fatalf("copied symlink target = %q, want %q", linkTarget, secretPath)
	}
	got, err := os.ReadFile(filepath.Join(srv.config.RepoPath("bob", "demo-fork"), "objects", "pack"))
	if err != nil {
		t.Fatalf("read copied repo data: %v", err)
	}
	if string(got) != "git-data" {
		t.Fatalf("unexpected copied data %q", got)
	}
}

func TestMoveRepoRouteRenamesRepositoryStorage(t *testing.T) {
	srv := newTestServer(t)
	handler := srv.Handler()

	srcPath := srv.config.RepoPath("alice", "demo")
	if err := os.MkdirAll(srcPath, 0o755); err != nil {
		t.Fatalf("mkdir source repo: %v", err)
	}
	if err := os.WriteFile(filepath.Join(srcPath, "HEAD"), []byte("ref: refs/heads/main\n"), 0o644); err != nil {
		t.Fatalf("write source repo data: %v", err)
	}

	body, _ := json.Marshal(map[string]string{
		"src_owner": "alice",
		"src_repo":  "demo",
		"dst_owner": "acme",
		"dst_repo":  "renamed",
	})
	req := httptest.NewRequest(http.MethodPost, "/repos/move", bytes.NewReader(body))
	req.Header.Set("Authorization", validAuth())
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d; body=%s", w.Code, w.Body.String())
	}
	if _, err := os.Stat(srcPath); !os.IsNotExist(err) {
		t.Fatalf("expected source repo to be removed, stat err=%v", err)
	}
	got, err := os.ReadFile(filepath.Join(srv.config.RepoPath("acme", "renamed"), "HEAD"))
	if err != nil {
		t.Fatalf("read moved repo data: %v", err)
	}
	if string(got) != "ref: refs/heads/main\n" {
		t.Fatalf("unexpected moved data %q", got)
	}
}

// ---------------------------------------------------------------------------
// Bookmarks
// ---------------------------------------------------------------------------

func TestListBookmarksReturnsPaginatedJSON(t *testing.T) {
	mock := &mockFFI{
		listBookmarksFn: func(storePath string, page, perPage uint32) (repohostffi.Paginated[repohost.Bookmark], error) {
			return repohostffi.Paginated[repohost.Bookmark]{
				Items: []repohost.Bookmark{
					{Name: "main", TargetChangeID: "aaa", TargetCommitID: "bbb"},
					{Name: "dev", TargetChangeID: "ccc", TargetCommitID: "ddd"},
				},
				TotalCount: 2,
			}, nil
		},
	}
	srv := newTestServerWithMock(t, mock)
	handler := srv.Handler()

	req := httptest.NewRequest(http.MethodGet, "/repos/alice%3Ademo/bookmarks?page=1&per_page=10", nil)
	req.Header.Set("Authorization", validAuth())
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d; body=%s", w.Code, w.Body.String())
	}

	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	items, ok := body["items"].([]any)
	if !ok {
		t.Fatalf("expected items array, got %#v", body)
	}
	if len(items) != 2 {
		t.Fatalf("expected 2 bookmarks, got %d", len(items))
	}
	if total, ok := body["total_count"].(float64); !ok || total != 2 {
		t.Fatalf("expected total_count=2, got %v", body["total_count"])
	}
}

func TestGetBookmarkResolvesOneBookmarkByName(t *testing.T) {
	bookmarks := make(map[string]repohost.Bookmark, 602)
	for i := 0; i < 601; i++ {
		name := fmt.Sprintf("bookmark-%04d", i)
		bookmarks[name] = repohost.Bookmark{Name: name, TargetCommitID: "other"}
	}
	bookmarks["feature/x"] = repohost.Bookmark{Name: "feature/x", TargetChangeID: "want-change", TargetCommitID: "want-commit"}
	var lookups []string
	mock := &mockFFI{
		getBookmarkFn: func(storePath, name string) (*repohost.Bookmark, error) {
			lookups = append(lookups, name)
			if bookmark, found := bookmarks[name]; found {
				return &bookmark, nil
			}
			return nil, nil
		},
		listBookmarksFn: func(string, uint32, uint32) (repohostffi.Paginated[repohost.Bookmark], error) {
			t.Fatal("bookmark lookup must not enumerate pages")
			return repohostffi.Paginated[repohost.Bookmark]{}, nil
		},
	}
	handler := newTestServerWithMock(t, mock).Handler()

	get := func(path string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Authorization", validAuth())
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		return w
	}

	w := get("/repos/alice%3Ademo/bookmarks/feature%2Fx")
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d; body=%s", w.Code, w.Body.String())
	}
	var got repohost.Bookmark
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	want := repohost.Bookmark{Name: "feature/x", TargetChangeID: "want-change", TargetCommitID: "want-commit"}
	if got != want {
		t.Fatalf("expected %+v, got %+v", want, got)
	}
	if !reflect.DeepEqual(lookups, []string{"feature/x"}) {
		t.Fatalf("expected one exact lookup, got %v", lookups)
	}

	missing := get("/repos/alice%3Ademo/bookmarks/absent")
	if missing.Code != http.StatusNotFound || !strings.Contains(missing.Body.String(), `"code":"bookmark_not_found"`) {
		t.Fatalf("absent bookmark: expected specific 404, got %d; body=%s", missing.Code, missing.Body.String())
	}
}

func TestPublicBookmarkLookupPreservesEscapedNames(t *testing.T) {
	names := []string{"feature/deep", "feature%2Fdeep", "feature%252Fdeep", "literal%20space", "literal%ZZ"}
	var calls []string
	mock := &mockFFI{getBookmarkFn: func(_ string, name string) (*repohost.Bookmark, error) {
		calls = append(calls, name)
		for _, stored := range names {
			if name == stored {
				return &repohost.Bookmark{Name: stored, TargetCommitID: "commit:" + stored}, nil
			}
		}
		return nil, nil
	}, listBookmarksFn: func(string, uint32, uint32) (repohostffi.Paginated[repohost.Bookmark], error) {
		t.Fatal("must not enumerate bookmarks")
		return repohostffi.Paginated[repohost.Bookmark]{}, nil
	}}
	server := httptest.NewServer(newTestServerWithMock(t, mock).Handler())
	defer server.Close()
	client := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: server.URL}, testAuthToken)
	for _, name := range names {
		got, err := client.GetBookmark(context.Background(), "alice", "demo", name)
		if err != nil || got.Name != name || got.TargetCommitID != "commit:"+name {
			t.Fatalf("lookup %q got=%+v err=%v", name, got, err)
		}
	}
	if !reflect.DeepEqual(calls, names) {
		t.Fatalf("calls=%v want=%v", calls, names)
	}
}

func TestConditionalBookmarkUsesOneExactLookup(t *testing.T) {
	for _, tc := range []struct {
		name     string
		bookmark *repohost.Bookmark
		expected string
		status   int
	}{
		{"absent-create", nil, "", http.StatusCreated},
		{"absent-conflict", nil, "old", http.StatusConflict},
		{"matching", &repohost.Bookmark{TargetCommitID: "old"}, "old", http.StatusCreated},
		{"changed", &repohost.Bookmark{TargetCommitID: "new"}, "old", http.StatusConflict},
	} {
		t.Run(tc.name, func(t *testing.T) {
			lookups, creates := 0, 0
			mock := &mockFFI{getBookmarkFn: func(string, string) (*repohost.Bookmark, error) { lookups++; return tc.bookmark, nil },
				listBookmarksFn: func(string, uint32, uint32) (repohostffi.Paginated[repohost.Bookmark], error) {
					t.Fatal("must not enumerate")
					return repohostffi.Paginated[repohost.Bookmark]{}, nil
				},
				createBookmarkFn: func(_ string, name, _ string) (repohost.Bookmark, error) {
					creates++
					return repohost.Bookmark{Name: name}, nil
				}}
			body, _ := json.Marshal(map[string]string{"name": "feature", "target_change_id": "change", "expected_commit_id": tc.expected})
			req := httptest.NewRequest(http.MethodPost, "/repos/alice%3Ademo/bookmarks", bytes.NewReader(body))
			req.Header.Set("Authorization", validAuth())
			w := httptest.NewRecorder()
			newTestServerWithMock(t, mock).Handler().ServeHTTP(w, req)
			if w.Code != tc.status || lookups != 1 {
				t.Fatalf("status=%d lookups=%d body=%s", w.Code, lookups, w.Body.String())
			}
			wantCreates := 0
			if tc.status == http.StatusCreated {
				wantCreates = 1
			}
			if creates != wantCreates {
				t.Fatalf("creates=%d, want %d", creates, wantCreates)
			}
		})
	}
}

func TestCreateDeleteBookmarkLifecycle(t *testing.T) {
	created := false
	deleted := false

	mock := &mockFFI{
		createBookmarkFn: func(storePath, name, changeID string) (repohost.Bookmark, error) {
			created = true
			if name != "feature" {
				t.Fatalf("expected bookmark name 'feature', got %q", name)
			}
			if changeID != "change-123" {
				t.Fatalf("expected changeID 'change-123', got %q", changeID)
			}
			return repohost.Bookmark{
				Name:           name,
				TargetChangeID: changeID,
				TargetCommitID: "commit-abc",
			}, nil
		},
		deleteBookmarkFn: func(storePath, name string) error {
			deleted = true
			if name != "feature" {
				t.Fatalf("expected bookmark name 'feature', got %q", name)
			}
			return nil
		},
	}

	srv := newTestServerWithMock(t, mock)
	handler := srv.Handler()

	// Create bookmark
	createBody, _ := json.Marshal(map[string]string{
		"name":             "feature",
		"target_change_id": "change-123",
	})
	req := httptest.NewRequest(http.MethodPost, "/repos/alice%3Ademo/bookmarks", bytes.NewReader(createBody))
	req.Header.Set("Authorization", validAuth())
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("create: expected 201, got %d; body=%s", w.Code, w.Body.String())
	}
	if !created {
		t.Fatal("createBookmarkFn was not called")
	}

	var bookmark map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &bookmark); err != nil {
		t.Fatalf("unmarshal create response: %v", err)
	}
	if bookmark["name"] != "feature" {
		t.Fatalf("unexpected bookmark name: %v", bookmark["name"])
	}
	if bookmark["target_change_id"] != "change-123" {
		t.Fatalf("unexpected target_change_id: %v", bookmark["target_change_id"])
	}

	// Delete bookmark
	req = httptest.NewRequest(http.MethodDelete, "/repos/alice%3Ademo/bookmarks/feature", nil)
	req.Header.Set("Authorization", validAuth())
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusNoContent {
		t.Fatalf("delete: expected 204, got %d; body=%s", w.Code, w.Body.String())
	}
	if !deleted {
		t.Fatal("deleteBookmarkFn was not called")
	}
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

func TestListChangesReturnsPaginatedJSON(t *testing.T) {
	mock := &mockFFI{
		listChangesFn: func(storePath string, page, perPage uint32) (repohostffi.Paginated[repohost.Change], error) {
			return repohostffi.Paginated[repohost.Change]{
				Items: []repohost.Change{
					{
						ChangeID:    "change-aaa",
						CommitID:    "commit-bbb",
						Description: "first change",
						AuthorName:  "Alice",
						AuthorEmail: "alice@example.com",
						Timestamp:   "2025-01-01T00:00:00Z",
					},
					{
						ChangeID:    "change-ccc",
						CommitID:    "commit-ddd",
						Description: "second change",
						AuthorName:  "Bob",
						AuthorEmail: "bob@example.com",
						Timestamp:   "2025-01-02T00:00:00Z",
					},
				},
				TotalCount: 5,
			}, nil
		},
	}
	srv := newTestServerWithMock(t, mock)
	handler := srv.Handler()

	req := httptest.NewRequest(http.MethodGet, "/repos/alice%3Ademo/changes?page=1&per_page=2", nil)
	req.Header.Set("Authorization", validAuth())
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d; body=%s", w.Code, w.Body.String())
	}

	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	items, ok := body["items"].([]any)
	if !ok {
		t.Fatalf("expected items array, got %#v", body)
	}
	if len(items) != 2 {
		t.Fatalf("expected 2 changes, got %d", len(items))
	}
	if total, ok := body["total_count"].(float64); !ok || total != 5 {
		t.Fatalf("expected total_count=5, got %v", body["total_count"])
	}

	// Verify change fields are present
	first := items[0].(map[string]any)
	for _, field := range []string{"change_id", "commit_id", "description", "author_name", "timestamp"} {
		if _, ok := first[field]; !ok {
			t.Fatalf("missing field %q in change %#v", field, first)
		}
	}
}

func TestGetSingleChangeReturnsDetail(t *testing.T) {
	mock := &mockFFI{
		getChangeFn: func(storePath, changeID string) (repohost.Change, error) {
			if changeID != "my-change-id" {
				t.Fatalf("unexpected changeID %q", changeID)
			}
			return repohost.Change{
				ChangeID:        "my-change-id",
				CommitID:        "my-commit-id",
				Description:     "test change description",
				AuthorName:      "Alice",
				AuthorEmail:     "alice@example.com",
				Timestamp:       "2025-06-15T12:00:00Z",
				HasConflict:     false,
				IsEmpty:         false,
				ParentChangeIDs: []string{"parent-1"},
			}, nil
		},
	}
	srv := newTestServerWithMock(t, mock)
	handler := srv.Handler()

	req := httptest.NewRequest(http.MethodGet, "/repos/alice%3Ademo/changes/my-change-id", nil)
	req.Header.Set("Authorization", validAuth())
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d; body=%s", w.Code, w.Body.String())
	}

	var change map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &change); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if change["change_id"] != "my-change-id" {
		t.Fatalf("unexpected change_id: %v", change["change_id"])
	}
	if change["commit_id"] != "my-commit-id" {
		t.Fatalf("unexpected commit_id: %v", change["commit_id"])
	}
	if change["description"] != "test change description" {
		t.Fatalf("unexpected description: %v", change["description"])
	}
	if change["author_name"] != "Alice" {
		t.Fatalf("unexpected author_name: %v", change["author_name"])
	}

	ts := change["timestamp"].(string)
	if _, err := time.Parse(time.RFC3339, ts); err != nil {
		t.Fatalf("timestamp %q is not RFC3339: %v", ts, err)
	}

	parents, ok := change["parent_change_ids"].([]any)
	if !ok || len(parents) != 1 || parents[0] != "parent-1" {
		t.Fatalf("unexpected parent_change_ids: %v", change["parent_change_ids"])
	}
}

func TestGetChangeNotFound(t *testing.T) {
	mock := &mockFFI{
		getChangeFn: func(storePath, changeID string) (repohost.Change, error) {
			return repohost.Change{}, notFound("change not found")
		},
	}
	srv := newTestServerWithMock(t, mock)
	handler := srv.Handler()

	req := httptest.NewRequest(http.MethodGet, "/repos/alice%3Ademo/changes/nonexistent", nil)
	req.Header.Set("Authorization", validAuth())
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d; body=%s", w.Code, w.Body.String())
	}
	assertGiteaErrorJSON(t, w.Body.Bytes())
}

func TestBackoutChangeValidatesAndForwardsExactRevision(t *testing.T) {
	var gotChangeID, gotRevision, gotTarget, gotBase string
	mock := &mockFFI{
		backoutChangeFn: func(_ string, changeID, revision, targetBookmark, base string) (repohost.Change, error) {
			gotChangeID, gotRevision, gotTarget, gotBase = changeID, revision, targetBookmark, base
			return repohost.Change{ChangeID: "reverting-change", CommitID: "reverting-commit"}, nil
		},
	}
	handler := newTestServerWithMock(t, mock).Handler()
	body := strings.NewReader(`{"revision":"landed-commit","target_bookmark":"main","base":"previous-head"}`)
	req := httptest.NewRequest(http.MethodPost, "/repos/alice%3Ademo/changes/original-change/backout", body)
	req.Header.Set("Authorization", validAuth())
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d; body=%s", w.Code, w.Body.String())
	}
	if gotChangeID != "original-change" || gotRevision != "landed-commit" || gotTarget != "main" || gotBase != "previous-head" {
		t.Fatalf("unexpected backout args: %q %q %q %q", gotChangeID, gotRevision, gotTarget, gotBase)
	}
	var got repohost.Change
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.ChangeID != "reverting-change" {
		t.Fatalf("unexpected response: %#v", got)
	}
}

func TestBackoutChangeRejectsMissingRevisionAndInvalidBookmark(t *testing.T) {
	handler := newTestServerWithMock(t, &mockFFI{}).Handler()
	for _, body := range []string{
		`{"target_bookmark":"main"}`,
		`{"revision":"commit","target_bookmark":"bad..bookmark"}`,
	} {
		req := httptest.NewRequest(http.MethodPost, "/repos/alice%3Ademo/changes/original/backout", strings.NewReader(body))
		req.Header.Set("Authorization", validAuth())
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("body %s: expected 400, got %d; response=%s", body, w.Code, w.Body.String())
		}
	}
}

func TestSplitChangeValidatesAndForwardsRequest(t *testing.T) {
	var gotChangeID, gotDescription string
	var gotPaths []string
	mock := &mockFFI{splitChangeFn: func(_ string, changeID string, paths []string, description string) (repohost.SplitChangeResult, error) {
		gotChangeID, gotPaths, gotDescription = changeID, paths, description
		return repohost.SplitChangeResult{
			Original: repohost.Change{ChangeID: changeID, CommitID: "original-2"},
			Split:    repohost.Change{ChangeID: "split-1", CommitID: "split-commit"},
		}, nil
	}}
	srv := newTestServerWithMock(t, mock)

	req := httptest.NewRequest(http.MethodPost, "/repos/alice%3Ademo/changes/original/split", strings.NewReader(`{"paths":["src/a.go"],"description":"Extract a"}`))
	req.Header.Set("Authorization", validAuth())
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if gotChangeID != "original" || gotDescription != "Extract a" || !reflect.DeepEqual(gotPaths, []string{"src/a.go"}) {
		t.Fatalf("unexpected split call: change=%q paths=%v description=%q", gotChangeID, gotPaths, gotDescription)
	}
}

func TestSplitChangeRejectsEmptyPaths(t *testing.T) {
	srv := newTestServerWithMock(t, &mockFFI{})
	req := httptest.NewRequest(http.MethodPost, "/repos/alice%3Ademo/changes/original/split", strings.NewReader(`{"paths":[]}`))
	req.Header.Set("Authorization", validAuth())
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

func TestGetDiffReturnsDiffJSON(t *testing.T) {
	mock := &mockFFI{
		getDiffFn: func(storePath, changeID string) (repohost.ChangeDiff, error) {
			return repohost.ChangeDiff{
				ChangeID: changeID,
				FileDiffs: []repohost.FileDiff{
					{Path: "README.md", ChangeType: "added"},
					{Path: "main.go", ChangeType: "modified"},
				},
			}, nil
		},
	}
	srv := newTestServerWithMock(t, mock)
	handler := srv.Handler()

	req := httptest.NewRequest(http.MethodGet, "/repos/alice%3Ademo/changes/diff-change/diff", nil)
	req.Header.Set("Authorization", validAuth())
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d; body=%s", w.Code, w.Body.String())
	}

	var diff map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &diff); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if diff["change_id"] != "diff-change" {
		t.Fatalf("unexpected change_id: %v", diff["change_id"])
	}

	fileDiffs, ok := diff["file_diffs"].([]any)
	if !ok {
		t.Fatalf("expected file_diffs array, got %#v", diff)
	}
	if len(fileDiffs) != 2 {
		t.Fatalf("expected 2 file diffs, got %d", len(fileDiffs))
	}

	first := fileDiffs[0].(map[string]any)
	if first["path"] != "README.md" || first["change_type"] != "added" {
		t.Fatalf("unexpected first file diff: %#v", first)
	}
}

func TestGetDiffForwardsRevisionQueryToFFI(t *testing.T) {
	var gotFrom, gotTo, gotPath string
	mock := &mockFFI{
		getRevisionDiffFn: func(_ string, fromCommitID, toCommitID, path string) (repohost.ChangeDiff, error) {
			gotFrom, gotTo, gotPath = fromCommitID, toCommitID, path
			return repohost.ChangeDiff{ChangeID: "change-one", FileDiffs: []repohost.FileDiff{}}, nil
		},
	}
	srv := newTestServerWithMock(t, mock)
	req := httptest.NewRequest(http.MethodGet, "/repos/alice%3Ademo/changes/change-one/diff?from=commit-a&to=commit-b&path=src%2Fmain.go", nil)
	req.Header.Set("Authorization", validAuth())
	w := httptest.NewRecorder()

	srv.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d; body=%s", w.Code, w.Body.String())
	}
	if gotFrom != "commit-a" || gotTo != "commit-b" || gotPath != "src/main.go" {
		t.Fatalf("unexpected revision diff arguments: from=%q to=%q path=%q", gotFrom, gotTo, gotPath)
	}
}

// ---------------------------------------------------------------------------
// Land change
// ---------------------------------------------------------------------------

func TestLandChangeSuccess(t *testing.T) {
	var landedChanges []string
	mock := &mockFFI{
		getChangeFn: func(storePath, changeID string) (repohost.Change, error) {
			return repohost.Change{ChangeID: changeID, CommitID: "commit-" + changeID}, nil
		},
		landChangesFn: func(storePath string, request repohost.LandRequest) (repohost.LandResult, error) {
			landedChanges = append(landedChanges, request.ChangeIDs...)
			if request.TargetBookmark != "main" {
				t.Fatalf("expected target main, got %q", request.TargetBookmark)
			}
			return repohost.LandResult{
				LandedCount:    len(request.ChangeIDs),
				TargetBookmark: "main",
				TargetCommitID: "new-tip-commit",
			}, nil
		},
	}
	srv := newTestServerWithMock(t, mock)
	handler := srv.Handler()

	body, _ := json.Marshal(map[string]any{
		"change_ids":      []string{"base-change", "tip-change"},
		"target_bookmark": "main",
	})
	req := httptest.NewRequest(http.MethodPost, "/repos/alice%3Ademo/land", bytes.NewReader(body))
	req.Header.Set("Authorization", validAuth())
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d; body=%s", w.Code, w.Body.String())
	}
	// Both changes must be landed in base-first order.
	if len(landedChanges) != 2 {
		t.Fatalf("expected 2 land calls, got %d", len(landedChanges))
	}
	if landedChanges[0] != "base-change" {
		t.Fatalf("expected base-change to be landed first, got %q", landedChanges[0])
	}
	if landedChanges[1] != "tip-change" {
		t.Fatalf("expected tip-change to be landed second, got %q", landedChanges[1])
	}

	var result map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if result["target_bookmark"] != "main" {
		t.Fatalf("unexpected target_bookmark: %v", result["target_bookmark"])
	}
	if result["target_commit_id"] != "new-tip-commit" {
		t.Fatalf("unexpected target_commit_id: %v", result["target_commit_id"])
	}
	// landed_count should reflect the full stack size
	if landedCount, ok := result["landed_count"].(float64); !ok || landedCount != 2 {
		t.Fatalf("expected landed_count=2, got %v", result["landed_count"])
	}
}

func TestLandChangeStack_ThreeChanges_AllLandedInOrder(t *testing.T) {
	var landedChanges []string
	mock := &mockFFI{
		getChangeFn: func(storePath, changeID string) (repohost.Change, error) {
			return repohost.Change{ChangeID: changeID, CommitID: "commit-" + changeID}, nil
		},
		landChangesFn: func(storePath string, request repohost.LandRequest) (repohost.LandResult, error) {
			landedChanges = append(landedChanges, request.ChangeIDs...)
			return repohost.LandResult{
				LandedCount:    len(request.ChangeIDs),
				TargetBookmark: request.TargetBookmark,
				TargetCommitID: "commit-after-" + request.ChangeIDs[len(request.ChangeIDs)-1],
			}, nil
		},
	}
	srv := newTestServerWithMock(t, mock)
	handler := srv.Handler()

	stack := []string{"change-1", "change-2", "change-3"}
	body, _ := json.Marshal(map[string]any{
		"change_ids":      stack,
		"target_bookmark": "main",
	})
	req := httptest.NewRequest(http.MethodPost, "/repos/alice%3Ademo/land", bytes.NewReader(body))
	req.Header.Set("Authorization", validAuth())
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d; body=%s", w.Code, w.Body.String())
	}
	// All three changes must be landed in the submitted order.
	if len(landedChanges) != 3 {
		t.Fatalf("expected 3 land calls, got %d: %v", len(landedChanges), landedChanges)
	}
	for i, want := range stack {
		if landedChanges[i] != want {
			t.Fatalf("position %d: expected %q, got %q", i, want, landedChanges[i])
		}
	}

	var result map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if landedCount, ok := result["landed_count"].(float64); !ok || landedCount != 3 {
		t.Fatalf("expected landed_count=3, got %v", result["landed_count"])
	}
}

func TestLandChangeStack_MiddleChangeFailsAbortsRemainder(t *testing.T) {
	var landedChanges []string
	mock := &mockFFI{
		getChangeFn: func(storePath, changeID string) (repohost.Change, error) {
			return repohost.Change{ChangeID: changeID, CommitID: "commit-" + changeID}, nil
		},
		landChangesFn: func(storePath string, request repohost.LandRequest) (repohost.LandResult, error) {
			// The storage operation rejects the whole stack before publication.
			return repohost.LandResult{}, conflict("merge conflict on change-2")
		},
	}
	srv := newTestServerWithMock(t, mock)
	handler := srv.Handler()

	body, _ := json.Marshal(map[string]any{
		"change_ids":      []string{"change-1", "change-2", "change-3"},
		"target_bookmark": "main",
	})
	req := httptest.NewRequest(http.MethodPost, "/repos/alice%3Ademo/land", bytes.NewReader(body))
	req.Header.Set("Authorization", validAuth())
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	// The second change conflicts — expect a 409.
	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d; body=%s", w.Code, w.Body.String())
	}
	assertGiteaErrorJSON(t, w.Body.Bytes())

	// change-3 must NOT have been attempted after change-2 failed.
	for _, id := range landedChanges {
		if id == "change-3" {
			t.Fatal("change-3 should not be landed after change-2 failed")
		}
	}
}

func TestLandChangeConflict(t *testing.T) {
	mock := &mockFFI{
		getChangeFn: func(storePath, changeID string) (repohost.Change, error) {
			return repohost.Change{ChangeID: changeID, CommitID: "commit-" + changeID}, nil
		},
		landChangeFn: func(storePath, changeID, targetBookmark string) (repohost.LandResult, error) {
			return repohost.LandResult{}, conflict("merge conflict")
		},
	}
	srv := newTestServerWithMock(t, mock)
	handler := srv.Handler()

	body, _ := json.Marshal(map[string]any{
		"change_ids":      []string{"conflict-change"},
		"target_bookmark": "main",
	})
	req := httptest.NewRequest(http.MethodPost, "/repos/alice%3Ademo/land", bytes.NewReader(body))
	req.Header.Set("Authorization", validAuth())
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d; body=%s", w.Code, w.Body.String())
	}
	assertGiteaErrorJSON(t, w.Body.Bytes())
}

func TestLandChangeEmptyIDsReturns400(t *testing.T) {
	srv := newTestServer(t)
	handler := srv.Handler()

	body, _ := json.Marshal(map[string]any{
		"change_ids":      []string{},
		"target_bookmark": "main",
	})
	req := httptest.NewRequest(http.MethodPost, "/repos/alice%3Ademo/land", bytes.NewReader(body))
	req.Header.Set("Authorization", validAuth())
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d; body=%s", w.Code, w.Body.String())
	}
	assertGiteaErrorJSON(t, w.Body.Bytes())
}

func TestLandChangeValidatesAllIDsBeforeLanding(t *testing.T) {
	getChangeCallCount := 0
	mock := &mockFFI{
		getChangeFn: func(storePath, changeID string) (repohost.Change, error) {
			getChangeCallCount++
			if changeID == "missing-id" {
				return repohost.Change{}, notFound("change not found")
			}
			return repohost.Change{ChangeID: changeID, CommitID: "commit-" + changeID}, nil
		},
		landChangeFn: func(storePath, changeID, targetBookmark string) (repohost.LandResult, error) {
			t.Fatal("landChangeFn should not be called when validation fails")
			return repohost.LandResult{}, nil
		},
	}
	srv := newTestServerWithMock(t, mock)
	handler := srv.Handler()

	body, _ := json.Marshal(map[string]any{
		"change_ids":      []string{"missing-id", "good-change"},
		"target_bookmark": "main",
	})
	req := httptest.NewRequest(http.MethodPost, "/repos/alice%3Ademo/land", bytes.NewReader(body))
	req.Header.Set("Authorization", validAuth())
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d; body=%s", w.Code, w.Body.String())
	}
}

// ---------------------------------------------------------------------------
// File content
// ---------------------------------------------------------------------------

func TestGetFileContentRetrieval(t *testing.T) {
	mock := &mockFFI{
		getFileContentFn: func(storePath, changeID, path string) (repohost.FileContent, error) {
			if changeID != "file-change" {
				t.Fatalf("unexpected changeID %q", changeID)
			}
			if path != "src/main.go" {
				t.Fatalf("unexpected path %q", path)
			}
			return repohost.FileContent{
				Path:    "src/main.go",
				Content: "package main\n\nfunc main() {}\n",
			}, nil
		},
	}
	srv := newTestServerWithMock(t, mock)
	handler := srv.Handler()

	req := httptest.NewRequest(http.MethodGet, "/repos/alice%3Ademo/file/file-change/src/main.go", nil)
	req.Header.Set("Authorization", validAuth())
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d; body=%s", w.Code, w.Body.String())
	}

	var fc map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &fc); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if fc["path"] != "src/main.go" {
		t.Fatalf("unexpected path: %v", fc["path"])
	}
	if fc["content"] != "package main\n\nfunc main() {}\n" {
		t.Fatalf("unexpected content: %v", fc["content"])
	}
}

func TestFileMissingCodeRequiresNativeMissingPath(t *testing.T) {
	for _, tc := range []struct {
		code     string
		path     string
		wantCode string
	}{{"file_not_found", "absent", "file_not_found"}, {"not_found", "directory", ""}} {
		t.Run(tc.code, func(t *testing.T) {
			mock := &mockFFI{getFileContentFn: func(string, string, string) (repohost.FileContent, error) {
				return repohost.FileContent{}, &repohostffi.Error{Code: tc.code, Message: "missing"}
			}}
			req := httptest.NewRequest(http.MethodGet, "/repos/alice%3Ademo/file/commit/"+tc.path, nil)
			req.Header.Set("Authorization", validAuth())
			w := httptest.NewRecorder()
			newTestServerWithMock(t, mock).Handler().ServeHTTP(w, req)
			var body struct {
				Code string `json:"code"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if w.Code != http.StatusNotFound || body.Code != tc.wantCode {
				t.Fatalf("status=%d code=%q body=%s", w.Code, body.Code, w.Body.String())
			}
		})
	}
}

func TestGetFileContentNotFoundForMissingFile(t *testing.T) {
	mock := &mockFFI{
		getFileContentFn: func(storePath, changeID, path string) (repohost.FileContent, error) {
			return repohost.FileContent{}, notFound("file not found")
		},
	}
	srv := newTestServerWithMock(t, mock)
	handler := srv.Handler()

	req := httptest.NewRequest(http.MethodGet, "/repos/alice%3Ademo/file/some-change/no-such-file.txt", nil)
	req.Header.Set("Authorization", validAuth())
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d; body=%s", w.Code, w.Body.String())
	}
	assertGiteaErrorJSON(t, w.Body.Bytes())
}

// ---------------------------------------------------------------------------
// Unknown route
// ---------------------------------------------------------------------------

func TestUnknownRouteReturns404(t *testing.T) {
	srv := newTestServer(t)
	handler := srv.Handler()

	req := httptest.NewRequest(http.MethodGet, "/no-such-route", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d; body=%s", w.Code, w.Body.String())
	}
	assertGiteaErrorJSON(t, w.Body.Bytes())
}

// ---------------------------------------------------------------------------
// Error response shape (Gitea-compatible)
// ---------------------------------------------------------------------------

func TestErrorResponseHasGiteaCompatibleShape(t *testing.T) {
	srv := newTestServer(t)
	handler := srv.Handler()

	tests := []struct {
		name   string
		method string
		path   string
		auth   string
		want   int
	}{
		{
			name:   "404_unknown_route",
			method: http.MethodGet,
			path:   "/no-such-route",
			want:   http.StatusNotFound,
		},
		{
			name:   "401_unauthorized",
			method: http.MethodGet,
			path:   "/repos/alice%3Ademo/bookmarks",
			want:   http.StatusUnauthorized,
		},
		{
			name:   "400_bad_owner",
			method: http.MethodPost,
			path:   "/repos/init",
			auth:   validAuth(),
			want:   http.StatusBadRequest,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var body *bytes.Reader
			if tt.want == http.StatusBadRequest {
				b, _ := json.Marshal(map[string]string{"owner": "../evil", "repo": "demo"})
				body = bytes.NewReader(b)
			}
			var req *http.Request
			if body != nil {
				req = httptest.NewRequest(tt.method, tt.path, body)
				req.Header.Set("Content-Type", "application/json")
			} else {
				req = httptest.NewRequest(tt.method, tt.path, nil)
			}
			if tt.auth != "" {
				req.Header.Set("Authorization", tt.auth)
			}

			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)

			if w.Code != tt.want {
				t.Fatalf("expected %d, got %d; body=%s", tt.want, w.Code, w.Body.String())
			}

			assertGiteaErrorJSON(t, w.Body.Bytes())
		})
	}
}

// ---------------------------------------------------------------------------
// Pagination edge cases
// ---------------------------------------------------------------------------

func TestPaginationInvalidPageZero(t *testing.T) {
	srv := newTestServer(t)
	handler := srv.Handler()

	req := httptest.NewRequest(http.MethodGet, "/repos/alice%3Ademo/bookmarks?page=0", nil)
	req.Header.Set("Authorization", validAuth())
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d; body=%s", w.Code, w.Body.String())
	}
}

func TestPaginationInvalidPerPageZero(t *testing.T) {
	srv := newTestServer(t)
	handler := srv.Handler()

	req := httptest.NewRequest(http.MethodGet, "/repos/alice%3Ademo/bookmarks?per_page=0", nil)
	req.Header.Set("Authorization", validAuth())
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d; body=%s", w.Code, w.Body.String())
	}
}

func TestPaginationPerPageOverMaxReturns400(t *testing.T) {
	srv := newTestServer(t)
	handler := srv.Handler()

	req := httptest.NewRequest(http.MethodGet, "/repos/alice%3Ademo/bookmarks?per_page=101", nil)
	req.Header.Set("Authorization", validAuth())
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d; body=%s", w.Code, w.Body.String())
	}
}

func TestPaginationLegacyLimitAccepted(t *testing.T) {
	srv := newTestServer(t)
	handler := srv.Handler()

	req := httptest.NewRequest(http.MethodGet, "/repos/alice%3Ademo/operations?limit=50", nil)
	req.Header.Set("Authorization", validAuth())
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d; body=%s", w.Code, w.Body.String())
	}

	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := body["items"]; !ok {
		t.Fatalf("missing items in %v", body)
	}
	if _, ok := body["total_count"]; !ok {
		t.Fatalf("missing total_count in %v", body)
	}
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

func TestListOperationsReturnsJSON(t *testing.T) {
	mock := &mockFFI{
		listOperationsFn: func(storePath string, page, perPage uint32) (repohostffi.Paginated[repohost.Operation], error) {
			return repohostffi.Paginated[repohost.Operation]{
				Items: []repohost.Operation{
					{OperationID: "op-1", Description: "init", Timestamp: "2025-06-15T00:00:00Z"},
					{OperationID: "op-2", Description: "import refs", Timestamp: "2025-06-15T00:01:00Z"},
				},
				TotalCount: 2,
			}, nil
		},
	}
	srv := newTestServerWithMock(t, mock)
	handler := srv.Handler()

	req := httptest.NewRequest(http.MethodGet, "/repos/alice%3Ademo/operations", nil)
	req.Header.Set("Authorization", validAuth())
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d; body=%s", w.Code, w.Body.String())
	}

	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	items := body["items"].([]any)
	if len(items) != 2 {
		t.Fatalf("expected 2 operations, got %d", len(items))
	}
	op := items[0].(map[string]any)
	if op["operation_id"] != "op-1" {
		t.Fatalf("unexpected operation_id: %v", op["operation_id"])
	}
	ts := op["timestamp"].(string)
	if _, err := time.Parse(time.RFC3339, ts); err != nil {
		t.Fatalf("timestamp %q is not RFC3339: %v", ts, err)
	}
}

// ---------------------------------------------------------------------------
// Working-tree status
// ---------------------------------------------------------------------------

func TestGetWorkingTreeStatusReturnsJSON(t *testing.T) {
	var gotStorePath string
	mock := &mockFFI{
		getWorkingTreeStatusFn: func(storePath string) (repohost.WorkingTreeStatus, error) {
			gotStorePath = storePath
			return repohost.WorkingTreeStatus{
				Backend: "git",
				Branch:  "main",
				Head:    "deadbeef",
				Changes: []repohost.WorkingTreeChange{
					{Path: "added.txt", Status: "added", Staged: true, Add: 2, Del: 0},
					{Path: "keep.txt", Status: "modified", Staged: true, Add: 1, Del: 0},
				},
			}, nil
		},
	}
	srv := newTestServerWithMock(t, mock)
	handler := srv.Handler()

	req := httptest.NewRequest(http.MethodGet, "/repos/alice%3Ademo/status", nil)
	req.Header.Set("Authorization", validAuth())
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d; body=%s", w.Code, w.Body.String())
	}
	if gotStorePath == "" {
		t.Fatalf("expected store path to be resolved and passed to FFI")
	}

	var body repohost.WorkingTreeStatus
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if body.Backend != "git" {
		t.Fatalf("unexpected backend: %q", body.Backend)
	}
	if body.Branch != "main" {
		t.Fatalf("unexpected branch: %q", body.Branch)
	}
	if body.Head != "deadbeef" {
		t.Fatalf("unexpected head: %q", body.Head)
	}
	if len(body.Changes) != 2 {
		t.Fatalf("expected 2 changes, got %d", len(body.Changes))
	}
	if body.Changes[0].Path != "added.txt" || body.Changes[0].Status != "added" || body.Changes[0].Add != 2 {
		t.Fatalf("unexpected first change: %+v", body.Changes[0])
	}
	if !body.Changes[1].Staged || body.Changes[1].Status != "modified" {
		t.Fatalf("unexpected second change: %+v", body.Changes[1])
	}
}

func TestGetWorkingTreeStatusPropagatesFFIError(t *testing.T) {
	mock := &mockFFI{
		getWorkingTreeStatusFn: func(storePath string) (repohost.WorkingTreeStatus, error) {
			return repohost.WorkingTreeStatus{}, &repohostffi.Error{Code: "not_found", Message: "repository not found"}
		},
	}
	srv := newTestServerWithMock(t, mock)
	handler := srv.Handler()

	req := httptest.NewRequest(http.MethodGet, "/repos/alice%3Ademo/status", nil)
	req.Header.Set("Authorization", validAuth())
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d; body=%s", w.Code, w.Body.String())
	}
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

func TestGetConflictsEmptyForCleanChange(t *testing.T) {
	mock := &mockFFI{
		getConflictsFn: func(storePath, changeID string) ([]repohost.Conflict, error) {
			return []repohost.Conflict{}, nil
		},
	}
	srv := newTestServerWithMock(t, mock)
	handler := srv.Handler()

	req := httptest.NewRequest(http.MethodGet, "/repos/alice%3Ademo/changes/clean-change/conflicts", nil)
	req.Header.Set("Authorization", validAuth())
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d; body=%s", w.Code, w.Body.String())
	}

	var conflicts []any
	if err := json.Unmarshal(w.Body.Bytes(), &conflicts); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(conflicts) != 0 {
		t.Fatalf("expected empty conflicts, got %d", len(conflicts))
	}
}

// ---------------------------------------------------------------------------
// Tree listing
// ---------------------------------------------------------------------------

func TestListFilesAtChangeReturnsTreeJSON(t *testing.T) {
	mock := &mockFFI{
		listTreeFilesFn: func(storePath, changeID, prefix string) ([]repohost.ChangeFile, error) {
			files := []repohost.ChangeFile{
				{Path: "src/main.go"},
				{Path: "src/util.go"},
				{Path: "README.md"},
			}
			if prefix != "" {
				var filtered []repohost.ChangeFile
				for _, f := range files {
					if strings.HasPrefix(f.Path, prefix) {
						filtered = append(filtered, f)
					}
				}
				return filtered, nil
			}
			return files, nil
		},
	}
	srv := newTestServerWithMock(t, mock)
	handler := srv.Handler()

	t.Run("full_tree", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/repos/alice%3Ademo/changes/tree-change/tree", nil)
		req.Header.Set("Authorization", validAuth())
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d; body=%s", w.Code, w.Body.String())
		}
		var files []any
		if err := json.Unmarshal(w.Body.Bytes(), &files); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if len(files) != 3 {
			t.Fatalf("expected 3 files, got %d", len(files))
		}
	})

	t.Run("filtered_by_prefix", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/repos/alice%3Ademo/changes/tree-change/tree?prefix=src", nil)
		req.Header.Set("Authorization", validAuth())
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d; body=%s", w.Code, w.Body.String())
		}
		var files []any
		if err := json.Unmarshal(w.Body.Bytes(), &files); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if len(files) != 2 {
			t.Fatalf("expected 2 files with src prefix, got %d", len(files))
		}
	})
}

func TestListDirectoryRejectsInvalidPageLimit(t *testing.T) {
	srv := newTestServerWithMock(t, &mockFFI{})
	for _, limit := range []string{"0", "1002", "oops"} {
		req := httptest.NewRequest(http.MethodGet, "/repos/alice%3Ademo/changes/change/tree?depth=1&limit="+limit, nil)
		req.Header.Set("Authorization", validAuth())
		w := httptest.NewRecorder()
		srv.Handler().ServeHTTP(w, req)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("limit %s: got %d, body %s", limit, w.Code, w.Body.String())
		}
	}
}

func TestListDirectoryReturnsImmediateChildren(t *testing.T) {
	srv := newTestServerWithMock(t, &mockFFI{listDirectoryFn: func(_, changeID, prefix, after string, limit uint32) ([]repohost.TreeEntry, error) {
		if changeID != "change" || prefix != "apps" || after != "apps/app" || limit != 1000 {
			t.Fatalf("wrong directory request: %s %s %s %d", changeID, prefix, after, limit)
		}
		return []repohost.TreeEntry{{Path: "apps/cli", Kind: "dir"}}, nil
	}})
	req := httptest.NewRequest(http.MethodGet, "/repos/alice%3Ademo/changes/change/tree?depth=1&prefix=apps&after=apps%2Fapp&limit=1000", nil)
	req.Header.Set("Authorization", validAuth())
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d: %s", w.Code, w.Body.String())
	}
	var entries []repohost.TreeEntry
	if err := json.Unmarshal(w.Body.Bytes(), &entries); err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Path != "apps/cli" || entries[0].Kind != "dir" {
		t.Fatalf("unexpected entries: %+v", entries)
	}
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

func TestCreateSnapshotReturnsJSON(t *testing.T) {
	mock := &mockFFI{
		createSnapshotFn: func(storePath, changeID string) (repohost.SnapshotResult, error) {
			return repohost.SnapshotResult{
				ChangeID:     changeID,
				SnapshotPath: "/snapshots/" + changeID,
			}, nil
		},
	}
	srv := newTestServerWithMock(t, mock)
	handler := srv.Handler()

	body, _ := json.Marshal(map[string]string{"change_id": "snap-change"})
	req := httptest.NewRequest(http.MethodPost, "/repos/alice%3Ademo/snapshot", bytes.NewReader(body))
	req.Header.Set("Authorization", validAuth())
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d; body=%s", w.Code, w.Body.String())
	}

	var result map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if result["change_id"] != "snap-change" {
		t.Fatalf("unexpected change_id: %v", result["change_id"])
	}
	if result["snapshot_path"] != "/snapshots/snap-change" {
		t.Fatalf("unexpected snapshot_path: %v", result["snapshot_path"])
	}
}

// ---------------------------------------------------------------------------
// Init repo
// ---------------------------------------------------------------------------

func TestInitRepoCreatesRepo(t *testing.T) {
	initCalls := 0
	autoInitCalls := 0
	mock := &mockFFI{
		initRepoFn: func(storePath string) (repohostffi.InitRepoResult, error) {
			initCalls++
			return repohostffi.InitRepoResult{Status: "ok", Path: storePath}, nil
		},
		autoInitRepoFn: func(storePath, bookmarkName, repoName string) (repohostffi.InitRepoResult, error) {
			autoInitCalls++
			return repohostffi.InitRepoResult{}, nil
		},
	}
	srv := newTestServerWithMock(t, mock)
	handler := srv.Handler()

	body, _ := json.Marshal(map[string]string{"owner": "alice", "repo": "demo"})
	req := httptest.NewRequest(http.MethodPost, "/repos/init", bytes.NewReader(body))
	req.Header.Set("Authorization", validAuth())
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d; body=%s", w.Code, w.Body.String())
	}

	var result map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if result["owner"] != "alice" {
		t.Fatalf("unexpected owner: %v", result["owner"])
	}
	if result["repo"] != "demo" {
		t.Fatalf("unexpected repo: %v", result["repo"])
	}
	if initCalls != 1 {
		t.Fatalf("expected init repo to be called once, got %d", initCalls)
	}
	if autoInitCalls != 0 {
		t.Fatalf("expected auto-init repo not to be called, got %d", autoInitCalls)
	}
}

func TestInitRepoAutoInitCreatesInitialCommit(t *testing.T) {
	initCalls := 0
	autoInitCalls := 0
	mock := &mockFFI{
		initRepoFn: func(storePath string) (repohostffi.InitRepoResult, error) {
			initCalls++
			return repohostffi.InitRepoResult{}, nil
		},
		autoInitRepoFn: func(storePath, bookmarkName, repoName string) (repohostffi.InitRepoResult, error) {
			autoInitCalls++
			if bookmarkName != "trunk" {
				t.Fatalf("unexpected bookmark name: %s", bookmarkName)
			}
			if repoName != "demo" {
				t.Fatalf("unexpected repo name: %s", repoName)
			}
			return repohostffi.InitRepoResult{Status: "ok", Path: storePath}, nil
		},
	}
	srv := newTestServerWithMock(t, mock)
	handler := srv.Handler()

	body, _ := json.Marshal(map[string]any{
		"owner":            "alice",
		"repo":             "demo",
		"auto_init":        true,
		"default_bookmark": "trunk",
		"repo_name":        "demo",
	})
	req := httptest.NewRequest(http.MethodPost, "/repos/init", bytes.NewReader(body))
	req.Header.Set("Authorization", validAuth())
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d; body=%s", w.Code, w.Body.String())
	}
	if autoInitCalls != 1 {
		t.Fatalf("expected auto-init repo to be called once, got %d", autoInitCalls)
	}
	if initCalls != 0 {
		t.Fatalf("expected init repo not to be called, got %d", initCalls)
	}
}

func TestInitRepoRejectsPathTraversal(t *testing.T) {
	srv := newTestServer(t)
	handler := srv.Handler()

	tests := []struct {
		name  string
		owner string
		repo  string
	}{
		{name: "traversal_in_owner", owner: "../evil", repo: "demo"},
		{name: "traversal_in_repo", owner: "alice", repo: "../evil"},
		{name: "dot_dot_owner", owner: "..", repo: "demo"},
		{name: "empty_owner", owner: "", repo: "demo"},
		{name: "empty_repo", owner: "alice", repo: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body, _ := json.Marshal(map[string]string{"owner": tt.owner, "repo": tt.repo})
			req := httptest.NewRequest(http.MethodPost, "/repos/init", bytes.NewReader(body))
			req.Header.Set("Authorization", validAuth())
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)

			if w.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d; body=%s", w.Code, w.Body.String())
			}
		})
	}
}

func TestSetDefaultBookmarkUpdatesGitHEAD(t *testing.T) {
	srv := newTestServer(t)
	gitDir := srv.config.GitBackendPath("alice", "demo")
	if err := os.MkdirAll(filepath.Dir(gitDir), 0o755); err != nil {
		t.Fatalf("mkdir repository: %v", err)
	}
	if output, err := exec.Command("git", "init", "--bare", gitDir).CombinedOutput(); err != nil {
		t.Fatalf("git init --bare: %v\n%s", err, output)
	}

	req := httptest.NewRequest(http.MethodPut, "/repos/alice%3Ademo/default-bookmark", bytes.NewBufferString(`{"name":"trunk"}`))
	req.Header.Set("Authorization", validAuth())
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d; body=%s", rec.Code, rec.Body.String())
	}
	head, err := os.ReadFile(filepath.Join(gitDir, "HEAD"))
	if err != nil {
		t.Fatalf("read HEAD: %v", err)
	}
	if string(head) != "ref: refs/heads/trunk\n" {
		t.Fatalf("HEAD = %q, want trunk symref", head)
	}
}

// ---------------------------------------------------------------------------
// Delete repo
// ---------------------------------------------------------------------------

func TestDeleteRepoSuccess(t *testing.T) {
	deleted := false
	mock := &mockFFI{
		deleteRepoFn: func(storePath string) error {
			deleted = true
			return nil
		},
	}
	srv := newTestServerWithMock(t, mock)
	handler := srv.Handler()

	req := httptest.NewRequest(http.MethodDelete, "/repos/alice/demo", nil)
	req.Header.Set("Authorization", validAuth())
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d; body=%s", w.Code, w.Body.String())
	}
	if !deleted {
		t.Fatal("deleteRepoFn was not called")
	}
}

func TestDeleteRepoNotFound(t *testing.T) {
	mock := &mockFFI{
		deleteRepoFn: func(storePath string) error {
			return notFound("repository not found")
		},
	}
	srv := newTestServerWithMock(t, mock)
	handler := srv.Handler()

	req := httptest.NewRequest(http.MethodDelete, "/repos/alice/nonexistent", nil)
	req.Header.Set("Authorization", validAuth())
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d; body=%s", w.Code, w.Body.String())
	}
}

// ---------------------------------------------------------------------------
// Content-Type validation
// ---------------------------------------------------------------------------

func TestReceivePackFailsWhenImportRefsFails(t *testing.T) {
	installGitStub(t, "#!/bin/sh\ncat >/dev/null\nprintf 'receive-pack-response'\n")

	mock := &mockFFI{
		importGitRefsFn: func(string) error {
			return assertError("import failed")
		},
	}
	srv := newTestServerWithMock(t, mock)
	handler := srv.Handler()

	gitDir := srv.config.GitBackendPath("alice", "demo")
	if err := os.MkdirAll(gitDir, 0o755); err != nil {
		t.Fatalf("mkdir git dir: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/repos/alice/demo/git/receive-pack", bytes.NewBufferString("0000"))
	req.Header.Set("Authorization", validAuth())
	req.Header.Set("Content-Type", "application/x-git-receive-pack-request")
	req.Header.Set("Accept", "application/x-git-receive-pack-result")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d; body=%s", w.Code, w.Body.String())
	}
	if got := w.Header().Get("Content-Type"); got != "text/plain; charset=utf-8" {
		t.Fatalf("expected a plain-text error git shows, got %q", got)
	}
	if strings.Contains(w.Body.String(), "receive-pack-response") {
		t.Fatalf("unexpected git receive-pack success response in error body: %q", w.Body.String())
	}
}

func TestReceivePackPushHooksUseAcceptedRefDiff(t *testing.T) {
	t.Setenv("STUB_GIT_STATE_FILE", filepath.Join(t.TempDir(), "receive-pack-state"))
	installGitStub(t, "#!/bin/sh\nset -eu\nif [ \"$#\" -ge 4 ] && [ \"$1\" = \"--git-dir\" ] && [ \"$3\" = \"for-each-ref\" ]; then\n  if [ -f \"$STUB_GIT_STATE_FILE\" ]; then\n    printf 'refs/heads/main\\000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\n'\n    printf 'refs/heads/release\\000cccccccccccccccccccccccccccccccccccccccc\\n'\n  else\n    printf 'refs/heads/main\\000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n'\n  fi\n  exit 0\nfi\nif [ \"$#\" -ge 3 ] && [ \"$3\" = \"merge-base\" ]; then\n  exit 0\nfi\nif [ \"$1\" = \"receive-pack\" ]; then\n  cat >/dev/null\n  : > \"$STUB_GIT_STATE_FILE\"\n  printf 'receive-pack-response'\n  exit 0\nfi\necho \"unexpected git invocation: $*\" >&2\nexit 1\n")

	type callbackRequest struct {
		Auth    string
		Payload PushHookPayload
	}

	var (
		mu        sync.Mutex
		callbacks []callbackRequest
	)
	callbackSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload PushHookPayload
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		mu.Lock()
		callbacks = append(callbacks, callbackRequest{
			Auth:    r.Header.Get("Authorization"),
			Payload: payload,
		})
		mu.Unlock()

		w.WriteHeader(http.StatusAccepted)
	}))
	defer callbackSrv.Close()

	srv := newTestServerWithMock(t, &mockFFI{})
	srv.config.PushHookCallbackURL = callbackSrv.URL
	srv.config.PushHookCallbackToken = "secret"
	srv.httpClient = callbackSrv.Client()
	handler := srv.Handler()

	gitDir := srv.config.GitBackendPath("alice", "demo")
	if err := os.MkdirAll(gitDir, 0o755); err != nil {
		t.Fatalf("mkdir git dir: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/repos/alice/demo/git/receive-pack", bytes.NewBufferString("0000"))
	req.Header.Set("Authorization", validAuth())
	req.Header.Set("Content-Type", "application/x-git-receive-pack-request")
	req.Header.Set("Accept", "application/x-git-receive-pack-result")
	req.Header.Set("X-Smithers-Push-Ref", "refs/heads/rejected")
	req.Header.Set("X-Smithers-Push-Commit-Sha", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")
	req.Header.Set("X-Smithers-Pusher-Id", "42")
	req.Header.Set("X-Smithers-Pusher-Login", "alice")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d; body=%s", w.Code, w.Body.String())
	}
	if got := w.Body.String(); got != "receive-pack-response" {
		t.Fatalf("expected git receive-pack response to be preserved, got %q", got)
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		t.Fatalf("shutdown server: %v", err)
	}

	mu.Lock()
	gotCallbacks := append([]callbackRequest(nil), callbacks...)
	mu.Unlock()

	if len(gotCallbacks) != 2 {
		t.Fatalf("expected 2 push hook callbacks, got %d (%#v)", len(gotCallbacks), gotCallbacks)
	}

	want := []callbackRequest{
		{
			Auth: "Bearer secret",
			Payload: PushHookPayload{
				Owner:       "alice",
				Repo:        "demo",
				RefName:     "refs/heads/main",
				BeforeSHA:   "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				CommitSHA:   "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
				PusherID:    42,
				PusherLogin: "alice",
			},
		},
		{
			Auth: "Bearer secret",
			Payload: PushHookPayload{
				Owner:       "alice",
				Repo:        "demo",
				RefName:     "refs/heads/release",
				CommitSHA:   "cccccccccccccccccccccccccccccccccccccccc",
				PusherID:    42,
				PusherLogin: "alice",
			},
		},
	}
	for i := range gotCallbacks {
		if gotCallbacks[i].Payload.DeliveryID == "" {
			t.Fatalf("callback %d has no delivery id", i)
		}
		gotCallbacks[i].Payload.DeliveryID = ""
	}
	if !reflect.DeepEqual(gotCallbacks, want) {
		t.Fatalf("unexpected callbacks: %#v", gotCallbacks)
	}
	if files := outboxFiles(t, srv.pushOutbox.root()); len(files) != 0 {
		t.Fatalf("acknowledged push events must leave the outbox: %v", files)
	}
}

func TestJSONResponsesHaveCorrectContentType(t *testing.T) {
	srv := newTestServer(t)
	handler := srv.Handler()

	tests := []struct {
		name            string
		method          string
		path            string
		wantContentType string
	}{
		{
			name:            "health_returns_text",
			method:          http.MethodGet,
			path:            "/health",
			wantContentType: "text/plain; charset=utf-8",
		},
		{
			name:            "bookmarks_returns_json",
			method:          http.MethodGet,
			path:            "/repos/alice%3Ademo/bookmarks",
			wantContentType: "application/json",
		},
		{
			name:            "changes_returns_json",
			method:          http.MethodGet,
			path:            "/repos/alice%3Ademo/changes",
			wantContentType: "application/json",
		},
		{
			name:            "operations_returns_json",
			method:          http.MethodGet,
			path:            "/repos/alice%3Ademo/operations",
			wantContentType: "application/json",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(tt.method, tt.path, nil)
			req.Header.Set("Authorization", validAuth())
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)

			if w.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d: %s", w.Code, http.StatusOK, w.Body.String())
			}

			ct := w.Header().Get("Content-Type")
			if !strings.HasPrefix(ct, tt.wantContentType) {
				t.Fatalf("expected Content-Type starting with %q, got %q", tt.wantContentType, ct)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Metrics endpoint
// ---------------------------------------------------------------------------

func TestMetricsEndpointIsPublic(t *testing.T) {
	srv := newTestServer(t)
	handler := srv.Handler()

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	ct := w.Header().Get("Content-Type")
	if !strings.HasPrefix(ct, "text/plain") {
		t.Fatalf("expected text/plain content-type, got %q", ct)
	}

	body := w.Body.String()
	if !strings.Contains(body, "# HELP") {
		t.Fatalf("expected prometheus HELP metadata in body")
	}
	if !strings.Contains(body, "smithers_repo_host_service_up") {
		t.Fatalf("expected smithers_repo_host_service_up metric")
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// assertGiteaErrorJSON verifies that the body is a JSON object with a
// "message" field, matching the Gitea-compatible error envelope format.
func assertGiteaErrorJSON(t *testing.T, body []byte) {
	t.Helper()
	var envelope map[string]any
	if err := json.Unmarshal(body, &envelope); err != nil {
		t.Fatalf("expected JSON error body, got: %s", string(body))
	}
	if _, ok := envelope["message"]; !ok {
		t.Fatalf("error envelope missing 'message' field: %v", envelope)
	}
	// If "errors" field present, it must be an array
	if errsField, ok := envelope["errors"]; ok {
		if _, ok := errsField.([]any); !ok {
			t.Fatalf("expected errors to be an array, got %T", errsField)
		}
	}
}

type assertError string

func (e assertError) Error() string {
	return string(e)
}

func installGitStub(t *testing.T, script string) {
	t.Helper()
	stubDir := t.TempDir()
	stubPath := filepath.Join(stubDir, "git")
	// The stub sees the arguments a caller passed: the hooks pin every
	// backend git run starts with (hostexec) is dropped first.
	body := strings.TrimPrefix(script, "#!/bin/sh\n")
	wrapped := "#!/bin/sh\nif [ \"$1\" = -c ] && [ \"$2\" = core.hooksPath=/dev/null ]; then shift 2; fi\n" + body
	if err := os.WriteFile(stubPath, []byte(wrapped), 0o755); err != nil {
		t.Fatalf("write git stub: %v", err)
	}
	useGitProgram(t, stubPath)
}

// useGitProgram makes program the git every backend git run starts, for the
// test (hostexec's Go option; never PATH).
func useGitProgram(t *testing.T, program string) {
	t.Helper()
	restore, err := hostexec.Configure(hostexec.Config{Git: program, Environment: hostexec.Environment()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(restore)
}

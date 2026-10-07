package repohost

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestClient_ListBookmarks_UsesRepoIDRoute(t *testing.T) {
	t.Parallel()

	var gotPath string
	var gotPage string
	var gotPerPage string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		gotPage = r.URL.Query().Get("page")
		gotPerPage = r.URL.Query().Get("per_page")
		require.Equal(t, http.MethodGet, r.Method)

		_ = json.NewEncoder(w).Encode(map[string]any{
			"items":       []Bookmark{{Name: "main", TargetChangeID: "abc", TargetCommitID: "def"}},
			"total_count": int64(1),
		})
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	bookmarks, nextCursor, err := client.ListBookmarks(context.Background(), "alice", "demo", cursorForPage(2, 25), 25)
	require.NoError(t, err)

	assert.Equal(t, "/repos/alice:demo/bookmarks", gotPath)
	assert.Equal(t, "2", gotPage)
	assert.Equal(t, "25", gotPerPage)
	require.Len(t, bookmarks, 1)
	assert.Equal(t, "main", bookmarks[0].Name)
	assert.Empty(t, nextCursor)
}

func TestClient_SetDefaultBookmark_UsesRepoIDRoute(t *testing.T) {
	t.Parallel()

	var gotPath string
	var gotRequest setDefaultBookmarkRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		require.Equal(t, http.MethodPut, r.Method)
		require.NoError(t, json.NewDecoder(r.Body).Decode(&gotRequest))
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	require.NoError(t, client.SetDefaultBookmark(context.Background(), "alice", "demo", "trunk"))
	assert.Equal(t, "/repos/alice:demo/default-bookmark", gotPath)
	assert.Equal(t, "trunk", gotRequest.Name)
}

func TestClient_CreateBookmark_UsesRepoIDRoute(t *testing.T) {
	t.Parallel()

	var gotPath string
	var gotReq CreateBookmarkRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		require.Equal(t, http.MethodPost, r.Method)
		require.NoError(t, json.NewDecoder(r.Body).Decode(&gotReq))
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(Bookmark{Name: gotReq.Name, TargetChangeID: gotReq.TargetChangeID, TargetCommitID: "c1"})
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	bookmark, err := client.CreateBookmark(context.Background(), "alice", "demo", CreateBookmarkRequest{Name: "main", TargetChangeID: "abc"})
	require.NoError(t, err)

	assert.Equal(t, "/repos/alice:demo/bookmarks", gotPath)
	assert.Equal(t, "main", gotReq.Name)
	assert.Equal(t, "abc", bookmark.TargetChangeID)
}

func TestClient_DeleteBookmark_UsesRepoIDRoute(t *testing.T) {
	t.Parallel()

	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		require.Equal(t, http.MethodDelete, r.Method)
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	err := client.DeleteBookmark(context.Background(), "alice", "demo", "main")
	require.NoError(t, err)
	assert.Equal(t, "/repos/alice:demo/bookmarks/main", gotPath)
}

func TestClient_ListChanges_UsesRepoIDRoute(t *testing.T) {
	t.Parallel()

	var gotPath string
	var gotPage string
	var gotPerPage string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		gotPage = r.URL.Query().Get("page")
		gotPerPage = r.URL.Query().Get("per_page")
		require.Equal(t, http.MethodGet, r.Method)

		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []Change{
				{ChangeID: "chg-abc", CommitID: "c1", Description: "Initial"},
			},
			"total_count": int64(1),
		})
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	changes, nextCursor, err := client.ListChanges(context.Background(), "alice", "demo", cursorForPage(1, 30), 30)
	require.NoError(t, err)

	assert.Equal(t, "/repos/alice:demo/changes", gotPath)
	assert.Equal(t, "1", gotPage)
	assert.Equal(t, "30", gotPerPage)
	require.Len(t, changes, 1)
	assert.Equal(t, "chg-abc", changes[0].ChangeID)
	assert.Empty(t, nextCursor)
}

func TestClient_GetChange_UsesRepoIDRoute(t *testing.T) {
	t.Parallel()

	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		_ = json.NewEncoder(w).Encode(Change{ChangeID: "abc", CommitID: "c1"})
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	change, err := client.GetChange(context.Background(), "alice", "demo", "abc")
	require.NoError(t, err)

	assert.Equal(t, "/repos/alice:demo/changes/abc", gotPath)
	assert.Equal(t, "abc", change.ChangeID)
}

func TestClient_BackoutChange_UsesRepoIDRouteAndBody(t *testing.T) {
	t.Parallel()

	var gotPath string
	var gotRequest BackoutChangeRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		require.Equal(t, http.MethodPost, r.Method)
		require.NoError(t, json.NewDecoder(r.Body).Decode(&gotRequest))
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(Change{ChangeID: "revert-1", CommitID: "commit-2"})
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	change, err := client.BackoutChange(context.Background(), "alice", "demo", "original", BackoutChangeRequest{
		Revision: "landed-commit", TargetBookmark: "main",
	})
	require.NoError(t, err)
	assert.Equal(t, "/repos/alice:demo/changes/original/backout", gotPath)
	assert.Equal(t, BackoutChangeRequest{Revision: "landed-commit", TargetBookmark: "main"}, gotRequest)
	assert.Equal(t, "revert-1", change.ChangeID)
}

func TestClient_SplitChange_UsesChangeRouteAndBody(t *testing.T) {
	t.Parallel()

	var gotPath string
	var gotRequest SplitChangeRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		require.Equal(t, http.MethodPost, r.Method)
		require.NoError(t, json.NewDecoder(r.Body).Decode(&gotRequest))
		_ = json.NewEncoder(w).Encode(SplitChangeResult{
			Original: Change{ChangeID: "original", CommitID: "original-2"},
			Split:    Change{ChangeID: "split", CommitID: "split-1"},
		})
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	result, err := client.SplitChange(context.Background(), "alice", "demo", "original", SplitChangeRequest{
		Paths: []string{"src/a.go"}, Description: "Extract a",
	})
	require.NoError(t, err)
	assert.Equal(t, "/repos/alice:demo/changes/original/split", gotPath)
	assert.Equal(t, SplitChangeRequest{Paths: []string{"src/a.go"}, Description: "Extract a"}, gotRequest)
	assert.Equal(t, "original", result.Original.ChangeID)
	assert.Equal(t, "split", result.Split.ChangeID)
}

func TestClient_SplitChange_PreservesUnprocessableStatus(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnprocessableEntity)
		_ = json.NewEncoder(w).Encode(map[string]string{"message": "no listed path is in the change"})
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	_, err := client.SplitChange(context.Background(), "alice", "demo", "original", SplitChangeRequest{Paths: []string{"missing.go"}})
	statusErr, ok := IsStatusError(err)
	require.True(t, ok)
	assert.Equal(t, http.StatusUnprocessableEntity, statusErr.StatusCode)
	assert.Equal(t, "no listed path is in the change", statusErr.Message)
}

func TestClient_GetChangeDiff_UsesRepoIDRoute(t *testing.T) {
	t.Parallel()

	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		_ = json.NewEncoder(w).Encode(ChangeDiff{
			ChangeID: "abc",
			FileDiffs: []FileDiff{{
				Path:       "README.md",
				ChangeType: "modified",
				Patch:      "@@ -1 +1 @@\n-old\n+new\n",
				Additions:  1,
				Deletions:  1,
				Language:   "markdown",
			}},
		})
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	diff, err := client.GetChangeDiff(context.Background(), "alice", "demo", "abc")
	require.NoError(t, err)

	assert.Equal(t, "/repos/alice:demo/changes/abc/diff", gotPath)
	require.Len(t, diff.FileDiffs, 1)
	assert.Equal(t, 1, diff.FileDiffs[0].Additions)
	assert.Equal(t, "markdown", diff.FileDiffs[0].Language)
}

func TestClient_GetRevisionDiff_ForwardsCommitsAndPath(t *testing.T) {
	t.Parallel()

	var gotPath string
	var gotQuery url.Values
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		gotQuery = r.URL.Query()
		_ = json.NewEncoder(w).Encode(ChangeDiff{ChangeID: "abc", FileDiffs: []FileDiff{}})
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	_, err := client.GetRevisionDiff(context.Background(), "alice", "demo", "abc", "commit-1", "commit-2", "src/main.go")
	require.NoError(t, err)

	assert.Equal(t, "/repos/alice:demo/changes/abc/diff", gotPath)
	assert.Equal(t, "commit-1", gotQuery.Get("from"))
	assert.Equal(t, "commit-2", gotQuery.Get("to"))
	assert.Equal(t, "src/main.go", gotQuery.Get("path"))
}

func TestClient_GetChangeFiles_UsesRepoIDRoute(t *testing.T) {
	t.Parallel()

	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		_ = json.NewEncoder(w).Encode([]ChangeFile{{Path: "README.md"}})
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	files, err := client.GetChangeFiles(context.Background(), "alice", "demo", "abc")
	require.NoError(t, err)

	assert.Equal(t, "/repos/alice:demo/changes/abc/files", gotPath)
	require.Len(t, files, 1)
}

func TestClient_ListFilesAtChange_UsesRepoIDRouteAndPrefixQuery(t *testing.T) {
	t.Parallel()

	var gotPath string
	var gotPrefix string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		gotPrefix = r.URL.Query().Get("prefix")
		_ = json.NewEncoder(w).Encode([]ChangeFile{{Path: ".smithers/workflows/build.tsx"}})
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	files, err := client.ListFilesAtChange(context.Background(), "alice", "demo", "abc", ".smithers/workflows")
	require.NoError(t, err)

	assert.Equal(t, "/repos/alice:demo/changes/abc/tree", gotPath)
	assert.Equal(t, ".smithers/workflows", gotPrefix)
	require.Len(t, files, 1)
	assert.Equal(t, ".smithers/workflows/build.tsx", files[0].Path)
}

func TestClient_ListDirectory_UsesBoundedQuery(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/repos/alice:demo/changes/abc/tree", r.URL.EscapedPath())
		assert.Equal(t, "1", r.URL.Query().Get("depth"))
		assert.Equal(t, "apps", r.URL.Query().Get("prefix"))
		assert.Equal(t, "apps/app", r.URL.Query().Get("after"))
		assert.Equal(t, "1000", r.URL.Query().Get("limit"))
		_ = json.NewEncoder(w).Encode([]TreeEntry{{Path: "apps/cli", Kind: "dir"}})
	}))
	t.Cleanup(server.Close)
	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	entries, err := client.ListDirectory(context.Background(), "alice", "demo", "abc", "apps", "apps/app", 1000)
	require.NoError(t, err)
	assert.Equal(t, []TreeEntry{{Path: "apps/cli", Kind: "dir"}}, entries)
}

func TestClient_GetChangeConflicts_UsesRepoIDRoute(t *testing.T) {
	t.Parallel()

	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		_ = json.NewEncoder(w).Encode([]Conflict{{FilePath: "README.md", ConflictType: "content"}})
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	conflicts, err := client.GetChangeConflicts(context.Background(), "alice", "demo", "abc")
	require.NoError(t, err)

	assert.Equal(t, "/repos/alice:demo/changes/abc/conflicts", gotPath)
	require.Len(t, conflicts, 1)
}

// TestClient_GetChangeConflicts_HunksDeserializesAsString verifies that the Hunks
// field on Conflict is a plain string, matching Rust's Option<String> (not []string).
func TestClient_GetChangeConflicts_HunksDeserializesAsString(t *testing.T) {
	t.Parallel()

	conflictHunks := "<<<<<<< Conflict\nversion A\n=======\nversion B\n>>>>>>> Conflict"

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Simulate the repo-host response shape: hunks is a JSON string.
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{
				"file_path":         "shared.txt",
				"conflict_type":     "content",
				"base_content":      "base\n",
				"left_content":      "version A\n",
				"right_content":     "version B\n",
				"hunks":             conflictHunks, // JSON string, not array
				"resolution_status": "unresolved",
			},
		})
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	conflicts, err := client.GetChangeConflicts(context.Background(), "alice", "demo", "chg-1")
	require.NoError(t, err)
	require.Len(t, conflicts, 1)

	c := conflicts[0]
	assert.Equal(t, "shared.txt", c.FilePath)
	assert.Equal(t, conflictHunks, c.Hunks, "Hunks must deserialize as plain string")
	assert.Equal(t, "base\n", c.BaseContent)
	assert.Equal(t, "version A\n", c.LeftContent)
	assert.Equal(t, "version B\n", c.RightContent)
	assert.Equal(t, "unresolved", c.ResolutionStatus)
}

func TestClient_GetFileAtChange_UsesRepoIDRouteAndEscapesPath(t *testing.T) {
	t.Parallel()

	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		_ = json.NewEncoder(w).Encode(FileContent{Path: "dir/read me.md", Content: "hello"})
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	file, err := client.GetFileAtChange(context.Background(), "alice", "demo", "abc", "dir/read me.md")
	require.NoError(t, err)

	assert.Equal(t, "/repos/alice:demo/file/abc/dir/read%20me.md", gotPath)
	assert.Equal(t, "hello", file.Content)
}

func TestClient_LandChanges_UsesRepoIDRoute(t *testing.T) {
	t.Parallel()

	var gotPath string
	var gotReq LandRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		require.NoError(t, json.NewDecoder(r.Body).Decode(&gotReq))
		_ = json.NewEncoder(w).Encode(LandResult{LandedCount: len(gotReq.ChangeIDs), TargetBookmark: gotReq.TargetBookmark, TargetCommitID: "c1"})
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	result, err := client.LandChanges(context.Background(), "alice", "demo", LandRequest{ChangeIDs: []string{"a", "b"}, TargetBookmark: "main"})
	require.NoError(t, err)

	assert.Equal(t, "/repos/alice:demo/land", gotPath)
	assert.Equal(t, 2, result.LandedCount)
}

func TestClient_ListOperations_UsesRepoIDRoute(t *testing.T) {
	t.Parallel()

	var gotPath string
	var gotPage string
	var gotPerPage string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		gotPage = r.URL.Query().Get("page")
		gotPerPage = r.URL.Query().Get("per_page")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []map[string]any{{
				"operation_id": "op1",
				"description":  "test op",
				"timestamp":    "2024-01-01T00:00:01Z",
			}},
			"total_count": int64(1),
		})
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	ops, nextCursor, err := client.ListOperations(context.Background(), "alice", "demo", cursorForPage(4, 5), 5)
	require.NoError(t, err)

	assert.Equal(t, "/repos/alice:demo/operations", gotPath)
	assert.Equal(t, "4", gotPage)
	assert.Equal(t, "5", gotPerPage)
	require.Len(t, ops, 1)
	assert.Equal(t, "op1", ops[0].OperationID)
	assert.Equal(t, "2024-01-01T00:00:01Z", ops[0].Timestamp)
	assert.Empty(t, nextCursor)
	_, err = time.Parse(time.RFC3339, ops[0].Timestamp)
	require.NoError(t, err)
}

func TestClient_CreateSnapshot_UsesRepoIDRoute(t *testing.T) {
	t.Parallel()

	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		_ = json.NewEncoder(w).Encode(SnapshotResult{ChangeID: "abc", SnapshotPath: "/tmp/snap"})
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	result, err := client.CreateSnapshot(context.Background(), "alice", "demo", SnapshotRequest{ChangeID: "abc"})
	require.NoError(t, err)

	assert.Equal(t, "/repos/alice:demo/snapshot", gotPath)
	assert.Equal(t, "/tmp/snap", result.SnapshotPath)
}

func TestClient_InitWikiRepo_UsesRepoIDRoute(t *testing.T) {
	t.Parallel()

	var gotPath string
	var gotMethod string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		gotMethod = r.Method
		w.WriteHeader(http.StatusCreated)
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	err := client.InitWikiRepo(context.Background(), "alice", "demo")
	require.NoError(t, err)

	assert.Equal(t, "/repos/alice:demo/wiki", gotPath)
	assert.Equal(t, http.MethodPut, gotMethod)
}

func TestClient_InitDocsRepo_UsesRepoIDRoute(t *testing.T) {
	t.Parallel()

	var gotPath string
	var gotMethod string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		gotMethod = r.Method
		w.WriteHeader(http.StatusCreated)
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	err := client.InitDocsRepo(context.Background(), "alice", "demo")
	require.NoError(t, err)

	assert.Equal(t, "/repos/alice:demo/docs", gotPath)
	assert.Equal(t, http.MethodPut, gotMethod)
}

func TestClient_CommitWikiPage_UsesRepoIDRoute(t *testing.T) {
	t.Parallel()

	var gotPath string
	var gotReq map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		require.NoError(t, json.NewDecoder(r.Body).Decode(&gotReq))
		_ = json.NewEncoder(w).Encode(map[string]string{"commit_sha": "c0ffee"})
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	commitSHA, err := client.CommitWikiPage(
		context.Background(),
		"alice",
		"demo",
		"Home",
		"# Welcome",
		"alice",
		"alice@example.com",
		"Create Home page",
	)
	require.NoError(t, err)

	assert.Equal(t, "/repos/alice:demo/wiki/pages/Home", gotPath)
	assert.Equal(t, "# Welcome", gotReq["content"])
	assert.Equal(t, "alice", gotReq["author_name"])
	assert.Equal(t, "Create Home page", gotReq["message"])
	assert.Equal(t, "c0ffee", commitSHA)
}

func TestClient_CommitDoc_UsesRepoIDRoute(t *testing.T) {
	t.Parallel()

	var gotPath string
	var gotReq map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		require.NoError(t, json.NewDecoder(r.Body).Decode(&gotReq))
		_ = json.NewEncoder(w).Encode(map[string]string{"commit_sha": "c0ffee"})
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	commitSHA, err := client.CommitDoc(
		context.Background(),
		"alice",
		"demo",
		"notion/Engineering/Architecture.md",
		"# Welcome",
		"alice",
		"alice@example.com",
		"Sync Architecture page",
	)
	require.NoError(t, err)

	assert.Equal(t, "/repos/alice:demo/docs/files/notion/Engineering/Architecture.md", gotPath)
	assert.Equal(t, "# Welcome", gotReq["content"])
	assert.Equal(t, "alice", gotReq["author_name"])
	assert.Equal(t, "Sync Architecture page", gotReq["message"])
	assert.Equal(t, "c0ffee", commitSHA)
}

func TestClient_GetWikiPageContent_UsesRepoIDRoute(t *testing.T) {
	t.Parallel()

	var gotPath string
	var gotCommitSHA string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		gotCommitSHA = r.URL.Query().Get("commit_sha")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"content":    "# Welcome",
			"commit_sha": "deadbeef",
		})
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	content, err := client.GetWikiPageContent(context.Background(), "alice", "demo", "Home", "deadbeef")
	require.NoError(t, err)

	assert.Equal(t, "/repos/alice:demo/wiki/pages/Home", gotPath)
	assert.Equal(t, "deadbeef", gotCommitSHA)
	assert.Equal(t, "# Welcome", content)
}

func TestClient_GetDocContent_UsesRepoIDRoute(t *testing.T) {
	t.Parallel()

	var gotPath string
	var gotCommitSHA string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		gotCommitSHA = r.URL.Query().Get("commit_sha")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"content":    "# Welcome",
			"commit_sha": "deadbeef",
		})
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	content, err := client.GetDocContent(context.Background(), "alice", "demo", "notion/Engineering/Architecture.md", "deadbeef")
	require.NoError(t, err)

	assert.Equal(t, "/repos/alice:demo/docs/files/notion/Engineering/Architecture.md", gotPath)
	assert.Equal(t, "deadbeef", gotCommitSHA)
	assert.Equal(t, "# Welcome", content)
}

func TestClient_ListWikiPageHistory_UsesRepoIDRoute(t *testing.T) {
	t.Parallel()

	var gotPath string
	var gotLimit string
	now := time.Now().UTC().Truncate(time.Second)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		gotLimit = r.URL.Query().Get("limit")
		_ = json.NewEncoder(w).Encode([]map[string]any{{
			"commit_sha": "abc123",
			"message":    "Create Home page",
			"author":     "alice",
			"email":      "alice@example.com",
			"timestamp":  now.Format(time.RFC3339),
		}})
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	revisions, err := client.ListWikiPageHistory(context.Background(), "alice", "demo", "Home", 30)
	require.NoError(t, err)

	assert.Equal(t, "/repos/alice:demo/wiki/pages/Home/history", gotPath)
	assert.Equal(t, "30", gotLimit)
	require.Len(t, revisions, 1)
	assert.Equal(t, "abc123", revisions[0].CommitSHA)
	assert.Equal(t, now, revisions[0].Timestamp)
}

func TestClient_ListDocHistory_UsesRepoIDRoute(t *testing.T) {
	t.Parallel()

	var gotPath string
	var gotLimit string
	now := time.Now().UTC().Truncate(time.Second)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		gotLimit = r.URL.Query().Get("limit")
		_ = json.NewEncoder(w).Encode([]map[string]any{{
			"commit_sha": "abc123",
			"message":    "Sync Architecture page",
			"author":     "alice",
			"email":      "alice@example.com",
			"timestamp":  now.Format(time.RFC3339),
		}})
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	revisions, err := client.ListDocHistory(context.Background(), "alice", "demo", "notion/Engineering/Architecture.md", 30)
	require.NoError(t, err)

	assert.Equal(t, "/repos/alice:demo/docs/history/notion/Engineering/Architecture.md", gotPath)
	assert.Equal(t, "30", gotLimit)
	require.Len(t, revisions, 1)
	assert.Equal(t, "abc123", revisions[0].CommitSHA)
	assert.Equal(t, now, revisions[0].Timestamp)
}

func TestClient_DeleteWikiPage_UsesRepoIDRoute(t *testing.T) {
	t.Parallel()

	var gotPath string
	var gotReq map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		require.Equal(t, http.MethodDelete, r.Method)
		require.NoError(t, json.NewDecoder(r.Body).Decode(&gotReq))
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	err := client.DeleteWikiPage(context.Background(), "alice", "demo", "Home", "alice", "alice@example.com")
	require.NoError(t, err)

	assert.Equal(t, "/repos/alice:demo/wiki/pages/Home", gotPath)
	assert.Equal(t, "alice", gotReq["author_name"])
	assert.Equal(t, "alice@example.com", gotReq["author_email"])
}

func TestClient_DeleteDoc_UsesRepoIDRoute(t *testing.T) {
	t.Parallel()

	var gotPath string
	var gotReq map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		require.Equal(t, http.MethodDelete, r.Method)
		require.NoError(t, json.NewDecoder(r.Body).Decode(&gotReq))
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	err := client.DeleteDoc(context.Background(), "alice", "demo", "notion/Engineering/Architecture.md", "alice", "alice@example.com")
	require.NoError(t, err)

	assert.Equal(t, "/repos/alice:demo/docs/files/notion/Engineering/Architecture.md", gotPath)
	assert.Equal(t, "alice", gotReq["author_name"])
	assert.Equal(t, "alice@example.com", gotReq["author_email"])
}

func TestClient_JJMethods_Non2xxReturnsStatusError(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		// JSON error body — message field is extracted into StatusError.Message.
		_, _ = w.Write([]byte(`{"message":"upstream failure"}`))
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	_, _, err := client.ListBookmarks(context.Background(), "alice", "demo", cursorForPage(1, 30), 30)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "502")
	assert.Contains(t, err.Error(), "upstream failure")
}

func TestClient_JJMethods_Non2xxNonJSONBodyIncludedInError(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		// Non-JSON body: readErrorMessage uses raw text verbatim.
		_, _ = w.Write([]byte("service unavailable"))
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	_, _, err := client.ListBookmarks(context.Background(), "alice", "demo", cursorForPage(1, 30), 30)
	require.Error(t, err)
	se, ok := IsStatusError(err)
	require.True(t, ok, "expected StatusError, got %T: %v", err, err)
	assert.Equal(t, 503, se.StatusCode)
	// Raw body is used verbatim as the message when body is not JSON.
	assert.Equal(t, "service unavailable", se.Message)
}

func TestClient_ListBookmarks_RespectsCanceledContext(t *testing.T) {
	t.Parallel()

	var sawRequest atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawRequest.Store(true)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items":       []Bookmark{},
			"total_count": int64(0),
		})
	}))
	t.Cleanup(server.Close)

	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, _, err := client.ListBookmarks(ctx, "alice", "demo", cursorForPage(1, 30), 30)
	require.Error(t, err)
	assert.ErrorIs(t, err, context.Canceled)
	assert.False(t, sawRequest.Load())
}

func TestClientListDirectoryPreservesOptionalRegularFileMetadata(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"path":"regular","kind":"file","regular_file":true},{"path":"link","kind":"file","regular_file":false},{"path":"legacy","kind":"file"}]`))
	}))
	defer server.Close()
	entries, err := NewClient(&StaticStorageSetResolver{URL: server.URL}, "test-token").ListDirectory(t.Context(), "owner", "repo", "abc", "", "", 1000)
	require.NoError(t, err)
	require.Len(t, entries, 3)
	require.NotNil(t, entries[0].RegularFile)
	require.True(t, *entries[0].RegularFile)
	require.NotNil(t, entries[1].RegularFile)
	require.False(t, *entries[1].RegularFile)
	require.Nil(t, entries[2].RegularFile)
}

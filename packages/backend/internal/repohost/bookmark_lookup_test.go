package repohost

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/stretchr/testify/require"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestGetBookmarkOneLookupBeyond500Bookmarks(t *testing.T) {
	bookmarks := make(map[string]Bookmark)
	for i := 0; i < 601; i++ {
		name := fmt.Sprintf("branch-%03d", i)
		bookmarks[name] = Bookmark{Name: name, TargetCommitID: fmt.Sprintf("commit-%d", i)}
	}
	bookmarks["feature/deep"] = Bookmark{Name: "feature/deep", TargetCommitID: "wanted"}
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		require.Equal(t, "/repos/alice:demo/bookmarks/feature%2Fdeep", r.URL.EscapedPath())
		require.Empty(t, r.URL.RawQuery)
		require.Equal(t, http.MethodGet, r.Method)
		require.NoError(t, json.NewEncoder(w).Encode(bookmarks["feature/deep"]))
	}))
	defer server.Close()
	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "token")
	bookmark, err := client.GetBookmark(context.Background(), "alice", "demo", "feature/deep")
	require.NoError(t, err)
	require.Equal(t, "wanted", bookmark.TargetCommitID)
	require.Equal(t, 1, calls)
}

func TestLookupBookmarkMissingAndStorageErrors(t *testing.T) {
	for _, tc := range []struct {
		name         string
		status       int
		code         string
		found, fails bool
	}{
		{"missing bookmark", 404, "bookmark_not_found", false, false},
		{"missing repository", 404, "repository_not_found", false, true},
		{"uncoded missing repository", 404, "", false, true},
		{"unauthorized", 401, "unauthorized", false, true},
		{"unavailable", 503, "repository_held", false, true},
		{"found", 200, "", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				w.WriteHeader(tc.status)
				if tc.status == 200 {
					_ = json.NewEncoder(w).Encode(Bookmark{Name: "main", TargetCommitID: "commit"})
				} else {
					_ = json.NewEncoder(w).Encode(map[string]string{"code": tc.code, "message": tc.name})
				}
			}))
			defer server.Close()
			client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "token")
			bookmark, found, err := LookupBookmark(context.Background(), client, "alice", "demo", "main")
			require.Equal(t, tc.found, found)
			if tc.fails {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
			}
			if found {
				require.Equal(t, "commit", bookmark.TargetCommitID)
			}
			require.Equal(t, 1, calls)
		})
	}
}

func TestGetBookmarkCanceledContext(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(http.StatusOK) }))
	defer server.Close()
	client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "token")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := client.GetBookmark(ctx, "alice", "demo", "main")
	require.ErrorIs(t, err, context.Canceled)
	require.Zero(t, calls)
}

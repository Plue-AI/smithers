package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// Committed names that differ only by leading/trailing whitespace are distinct
// files and directories. The contents route, RepoService and the native
// repository read must keep the exact path bytes. Only the database lookup is
// substituted; both HTTP hops and the Rust/jj reads are real.
func TestContentsWhitespacePathsIntegration(t *testing.T) {
	library := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	if library == "" {
		t.Skip("set SMITHERS_FFI_LIBRARY_PATH to the built smithers-ffi library")
	}
	cfg := repohostserver.Config{StoragePath: t.TempDir(), AuthToken: "contents-test", FFILibraryPath: library}
	ffi := repohostffi.New(library)
	require.NoError(t, ffi.Load())
	_, err := ffi.InitRepo(cfg.RepoPath("alice", "demo"))
	require.NoError(t, err)
	gitDir := cfg.GitBackendPath("alice", "demo")
	git := func(stdin string, env []string, args ...string) string {
		cmd := exec.Command("git", append([]string{"--git-dir", gitDir}, args...)...)
		cmd.Env = append(append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.invalid", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.invalid"), env...)
		cmd.Stdin = strings.NewReader(stdin)
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, "git %v: %s", args, out)
		return strings.TrimSpace(string(out))
	}
	files := map[string]string{
		"report":       "plain file",
		" report ":     "spaced file",
		"dir/plain":    "plain dir",
		" dir /spaced": "spaced dir",
		"   /OWNERS":   "whitespace-only dir",
		"  ":           "whitespace-only file",
	}
	index := []string{"GIT_INDEX_FILE=" + filepath.Join(t.TempDir(), "index")}
	for path, body := range files {
		blob := git(body, nil, "hash-object", "-w", "--stdin")
		git("", index, "update-index", "--add", "--cacheinfo", "100644,"+blob+","+path)
	}
	tree := git("", index, "write-tree")
	commit := git("", nil, "commit-tree", tree, "-m", "whitespace paths")
	git("", nil, "update-ref", "refs/heads/main", commit)
	require.NoError(t, ffi.ImportGitRefs(cfg.RepoPath("alice", "demo")))

	backend, err := repohostserver.NewWithFFI(cfg, ffi)
	require.NoError(t, err)
	host := httptest.NewServer(backend.Handler())
	defer host.Close()
	client := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: host.URL}, cfg.AuthToken)
	q := &notesIntegrationQueries{repository: db.Repository{ID: 1, Name: "demo", IsPublic: true, DefaultBookmark: "main"}}
	handler := RepoHandler{Service: services.NewRepoService(q, client, "s1")}
	router := chi.NewRouter()
	router.With(middleware.RequireTokenScope(middleware.ScopeReadRepository)).Get("/api/repos/{owner}/{repo}/contents/*", handler.GetRepoContents)
	get := func(path, query string) *httptest.ResponseRecorder {
		t.Helper()
		target := (&url.URL{Path: "/api/repos/alice/demo/contents/" + path, RawQuery: query}).String()
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
		return rec
	}
	readFile := func(path string) services.RepoContent {
		t.Helper()
		rec := get(path, "")
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var content services.RepoContent
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &content))
		return content
	}
	list := func(path, query string) ([]services.RepoContent, string) {
		t.Helper()
		rec := get(path, query)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var entries []services.RepoContent
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &entries))
		return entries, rec.Header().Get("X-Next-Cursor")
	}

	t.Run("file_reads_keep_exact_names", func(t *testing.T) {
		spaced := readFile(" report ")
		require.Equal(t, " report ", spaced.Path)
		require.Equal(t, " report ", spaced.Name)
		require.Equal(t, "spaced file", spaced.Content)
		plain := readFile("report")
		require.Equal(t, "report", plain.Path)
		require.Equal(t, "plain file", plain.Content)
		require.Equal(t, "whitespace-only dir", readFile("   /OWNERS").Content)
		blank := readFile("  ")
		require.Equal(t, services.RepoContent{Name: "  ", Path: "  ", Type: "file", Encoding: "utf-8", Content: "whitespace-only file", Size: 20}, blank)
	})

	t.Run("directory_paging_keeps_exact_names", func(t *testing.T) {
		spaced, next := list(" dir ", "limit=1")
		require.Equal(t, []services.RepoContent{{Name: "spaced", Path: " dir /spaced", Type: "file"}}, spaced)
		require.Empty(t, next)
		plain, _ := list("dir", "limit=1")
		require.Equal(t, []services.RepoContent{{Name: "plain", Path: "dir/plain", Type: "file"}}, plain)
		blank, _ := list("   ", "")
		require.Equal(t, []services.RepoContent{{Name: "OWNERS", Path: "   /OWNERS", Type: "file"}}, blank)
		_, cursor := list("", "limit=1")
		require.NotEmpty(t, cursor)
	})

	t.Run("directory_cursor_round_trips_whitespace_edged_names", func(t *testing.T) {
		var names []string
		query := url.Values{"limit": {"1"}}
		for page := 0; ; page++ {
			require.Less(t, page, 10, "cursor did not advance")
			entries, next := list("", query.Encode())
			require.Len(t, entries, 1)
			names = append(names, entries[0].Name)
			if next == "" {
				break
			}
			require.Equal(t, strings.TrimSpace(next), next, "header value must not rely on edge whitespace")
			after, err := url.PathUnescape(next)
			require.NoError(t, err)
			require.Equal(t, entries[0].Path, after)
			query.Set("after", after)
		}
		require.ElementsMatch(t, []string{"  ", "   ", " dir ", " report ", "dir", "report"}, names)
	})

	t.Run("listed_paths_open_the_listed_item", func(t *testing.T) {
		root, _ := list("", "")
		names := make([]string, 0, len(root))
		for _, entry := range root {
			names = append(names, entry.Name)
		}
		require.ElementsMatch(t, []string{"  ", "   ", " dir ", " report ", "dir", "report"}, names)
		for _, entry := range root {
			if entry.Type == "file" {
				require.Equal(t, files[entry.Path], readFile(entry.Path).Content, entry.Path)
				continue
			}
			children, _ := list(entry.Path, "")
			require.Len(t, children, 1, entry.Path)
			require.Equal(t, files[children[0].Path], readFile(children[0].Path).Content, children[0].Path)
		}
	})
}

package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// backfillRepoHost serves a fixed default-bookmark head and README per
// repository and counts bookmark reads, i.e. index attempts. Mock exception:
// a real repo host needs the Rust FFI library (SMITHERS_FFI_LIBRARY_PATH),
// absent from the default integration run, and repohost's own suites cover
// these reads. Postgres, the indexer, and the HTTP search handler are real.
type backfillRepoHost struct {
	mu     sync.Mutex
	heads  map[string]string
	files  map[string]string
	visits map[string]int
}

func (h *backfillRepoHost) ListBookmarks(_ context.Context, owner, repo, _ string, _ int) ([]repohost.Bookmark, string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.visits[owner+"/"+repo]++
	if head := h.heads[owner+"/"+repo]; head != "" {
		return []repohost.Bookmark{{Name: "main", TargetCommitID: head}}, "", nil
	}
	return nil, "", nil
}

func (h *backfillRepoHost) GetRevisionDiff(context.Context, string, string, string, string, string, string) (repohost.ChangeDiff, error) {
	return repohost.ChangeDiff{}, nil
}

func (h *backfillRepoHost) ListFilesAtChange(_ context.Context, owner, repo, _, _ string) ([]repohost.ChangeFile, error) {
	if h.files[owner+"/"+repo] == "" {
		return nil, nil
	}
	return []repohost.ChangeFile{{Path: "README.md"}}, nil
}

func (h *backfillRepoHost) GetFileAtChange(_ context.Context, owner, repo, _, path string) (repohost.FileContent, error) {
	return repohost.FileContent{Path: path, Content: h.files[owner+"/"+repo], Encoding: "utf8"}, nil
}

func (h *backfillRepoHost) visitCount() map[string]int {
	h.mu.Lock()
	defer h.mu.Unlock()
	counts := make(map[string]int, len(h.visits))
	for key, n := range h.visits {
		counts[key] = n
	}
	return counts
}

// #1866: a repository that existed before push-time indexing is searchable
// through /api/search/code once the backfill runs, and a rerun indexes nothing.
func TestCodeSearchBackfillMakesPreexistingRepositorySearchable(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	var userID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users (username, lower_username, email, lower_email, display_name)
		VALUES ('canary', 'canary', 'canary@example.com', 'canary@example.com', 'Canary') RETURNING id`).Scan(&userID))
	repoIDs := map[string]int64{}
	for _, name := range []string{"hello-world", "empty", "indexed"} {
		var id int64
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories (user_id, name, lower_name, is_public, default_bookmark, created_at)
			VALUES ($1, $2, $2, TRUE, 'main', NOW() - interval '1 day') RETURNING id`, userID, name).Scan(&id))
		repoIDs[name] = id
	}
	// A repository indexed by a push keeps its watermark and documents.
	require.NoError(t, q.SetCodeSearchIndexedCommit(ctx, db.SetCodeSearchIndexedCommitParams{RepositoryID: repoIDs["indexed"], CommitID: "indexed-head"}))

	search := func(query string) services.CodeSearchResultPage {
		t.Helper()
		rec := httptest.NewRecorder()
		(&SearchHandler{Service: services.NewSearchService(q)}).SearchCode(rec, httptest.NewRequest(http.MethodGet, "/api/search/code?q="+query, nil))
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var page services.CodeSearchResultPage
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &page))
		return page
	}
	require.Zero(t, search("World").TotalCount, "push-only indexing never saw the repository")
	backlog, err := q.GetCodeSearchBacklog(ctx)
	require.NoError(t, err)
	require.Equal(t, int64(2), backlog.Repositories)
	require.InDelta(t, 86400, backlog.OldestAgeSeconds, 60)

	host := &backfillRepoHost{
		heads:  map[string]string{"canary/hello-world": "head-1", "canary/indexed": "newer-head"},
		files:  map[string]string{"canary/hello-world": "Hello, World!\n", "canary/indexed": "Hello, World!\n"},
		visits: map[string]int{},
	}
	indexer := services.NewSearchIndexer(q, host, pool)
	result, err := indexer.Backfill(ctx)
	require.NoError(t, err)
	require.Equal(t, services.SearchIndexBackfillResult{Indexed: 2}, result)

	page := search("World")
	require.Equal(t, int64(1), page.TotalCount)
	require.Len(t, page.Items, 1)
	require.Equal(t, repoIDs["hello-world"], page.Items[0].RepositoryID)
	require.Equal(t, "canary", page.Items[0].RepositoryOwner)
	require.Equal(t, "README.md", page.Items[0].Path)
	for name, want := range map[string]string{"hello-world": "head-1", "empty": "", "indexed": "indexed-head"} {
		commit, err := q.GetCodeSearchIndexedCommit(ctx, repoIDs[name])
		require.NoError(t, err, name)
		require.Equal(t, want, commit, name)
	}
	backlog, err = q.GetCodeSearchBacklog(ctx)
	require.NoError(t, err)
	require.Equal(t, db.GetCodeSearchBacklogRow{}, backlog)

	result, err = indexer.Backfill(ctx)
	require.NoError(t, err)
	require.Equal(t, services.SearchIndexBackfillResult{}, result)
	require.Equal(t, map[string]int{"canary/hello-world": 1, "canary/empty": 1}, host.visitCount(), "a rerun enqueues nothing")
}

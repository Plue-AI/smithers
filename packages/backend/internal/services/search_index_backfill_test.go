package services

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// backfillQueries models repositories, per-repository watermarks and
// documents, and the id-cursor listing of repositories without a watermark.
type backfillQueries struct {
	mu         sync.Mutex
	repos      []db.ListCodeSearchUnindexedRepositoriesRow
	watermarks map[int64]string
	defaults   map[int64]string
	documents  map[int64]map[string]string
	listCalls  []db.ListCodeSearchUnindexedRepositoriesParams
	listErr    error
}

func newBackfillQueries(repos ...db.ListCodeSearchUnindexedRepositoriesRow) *backfillQueries {
	return &backfillQueries{repos: repos, watermarks: map[int64]string{}, defaults: map[int64]string{}, documents: map[int64]map[string]string{}}
}

func (q *backfillQueries) ListCodeSearchUnindexedRepositories(_ context.Context, arg db.ListCodeSearchUnindexedRepositoriesParams) ([]db.ListCodeSearchUnindexedRepositoriesRow, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.listCalls = append(q.listCalls, arg)
	if q.listErr != nil {
		return nil, q.listErr
	}
	rows := []db.ListCodeSearchUnindexedRepositoriesRow{}
	for _, repo := range q.repos {
		if _, indexed := q.watermarks[repo.ID]; indexed || repo.ID <= arg.AfterID {
			continue
		}
		rows = append(rows, repo)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].ID < rows[j].ID })
	if len(rows) > int(arg.RowLimit) {
		rows = rows[:arg.RowLimit]
	}
	return rows, nil
}

func (q *backfillQueries) GetCodeSearchIndexedCommit(_ context.Context, id int64) (string, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.watermarks[id], nil
}

func (q *backfillQueries) SetCodeSearchIndexedCommit(_ context.Context, arg db.SetCodeSearchIndexedCommitParams) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.watermarks[arg.RepositoryID] = arg.CommitID
	return nil
}

func (q *backfillQueries) DeleteCodeSearchDocumentsExceptPaths(context.Context, db.DeleteCodeSearchDocumentsExceptPathsParams) error {
	return nil
}

func (q *backfillQueries) GetRepoByID(_ context.Context, id int64) (db.Repository, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	bookmark := q.defaults[id]
	if bookmark == "" {
		bookmark = "trunk"
	}
	return db.Repository{ID: id, DefaultBookmark: bookmark}, nil
}

func (q *backfillQueries) UpsertCodeSearchDocument(_ context.Context, arg db.UpsertCodeSearchDocumentParams) (db.UpsertCodeSearchDocumentRow, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.documents[arg.RepositoryID] == nil {
		q.documents[arg.RepositoryID] = map[string]string{}
	}
	q.documents[arg.RepositoryID][arg.FilePath] = arg.Content
	return db.UpsertCodeSearchDocumentRow{}, nil
}

func (q *backfillQueries) DeleteCodeSearchDocumentByPath(context.Context, db.DeleteCodeSearchDocumentByPathParams) error {
	return nil
}

func (q *backfillQueries) watermark(id int64) (string, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	commit, ok := q.watermarks[id]
	return commit, ok
}

// backfillHost serves one README per repository at head "<name>-head". A
// repository listed in empty has no bookmark; one in failing errors.
type backfillHost struct {
	mu        sync.Mutex
	empty     map[string]bool
	failing   map[string]bool
	bookmarks []string
	block     chan struct{}
}

func (h *backfillHost) ListBookmarks(ctx context.Context, owner, repo, _ string, _ int) ([]repohost.Bookmark, string, error) {
	h.mu.Lock()
	h.bookmarks = append(h.bookmarks, owner+"/"+repo)
	block, failing, empty := h.block, h.failing[repo], h.empty[repo]
	h.mu.Unlock()
	if block != nil {
		select {
		case <-block:
		case <-ctx.Done():
			return nil, "", ctx.Err()
		}
	}
	if failing {
		return nil, "", errors.New("repository storage unavailable")
	}
	if empty {
		return nil, "", nil
	}
	return []repohost.Bookmark{{Name: "trunk", TargetCommitID: repo + "-head"}, {Name: "release", TargetCommitID: repo + "-release"}}, "", nil
}

func (h *backfillHost) GetRevisionDiff(context.Context, string, string, string, string, string, string) (repohost.ChangeDiff, error) {
	return repohost.ChangeDiff{}, errors.New("backfill of an unindexed repository must walk the tree")
}

func (h *backfillHost) ListFilesAtChange(context.Context, string, string, string, string) ([]repohost.ChangeFile, error) {
	return []repohost.ChangeFile{{Path: "README.md"}}, nil
}

func (h *backfillHost) GetFileAtChange(_ context.Context, owner, repo, changeID, path string) (repohost.FileContent, error) {
	return repohost.FileContent{Path: path, Content: fmt.Sprintf("%s/%s@%s", owner, repo, changeID), Encoding: "utf8"}, nil
}

func (h *backfillHost) visited() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.bookmarks...)
}

func backfillRepo(id int64, name string) db.ListCodeSearchUnindexedRepositoriesRow {
	return db.ListCodeSearchUnindexedRepositoriesRow{ID: id, Name: name, OwnerSlug: "acme"}
}

func TestSearchIndexBackfill_IndexesUnindexedHeadsOnce(t *testing.T) {
	q := newBackfillQueries(backfillRepo(3, "gamma"), backfillRepo(1, "alpha"), backfillRepo(2, "empty"))
	q.watermarks[4] = "delta-head"
	q.repos = append(q.repos, backfillRepo(4, "delta"))
	host := &backfillHost{empty: map[string]bool{"empty": true}}
	indexer := NewSearchIndexer(q, host)

	result, err := indexer.Backfill(context.Background())
	require.NoError(t, err)
	require.Equal(t, SearchIndexBackfillResult{Indexed: 3}, result)
	require.Equal(t, []string{"acme/alpha", "acme/empty", "acme/empty", "acme/gamma"}, host.visited(), "id order; the indexed repository is skipped")
	require.Equal(t, map[string]string{"README.md": "acme/alpha@alpha-head"}, q.documents[1])
	require.Equal(t, map[string]string{"README.md": "acme/gamma@gamma-head"}, q.documents[3])
	require.Empty(t, q.documents[2])
	commit, ok := q.watermark(2)
	require.True(t, ok, "an empty repository gets a watermark so it leaves the backlog")
	require.Empty(t, commit)
	require.Nil(t, q.documents[4])

	result, err = indexer.Backfill(context.Background())
	require.NoError(t, err)
	require.Equal(t, SearchIndexBackfillResult{}, result)
	require.Len(t, host.visited(), 4, "a rerun indexes nothing")
}

func TestSearchIndexBackfill_IndexesTheDefaultBookmarkCurrentAtIndexTime(t *testing.T) {
	q := newBackfillQueries(backfillRepo(1, "alpha"))
	q.defaults[1] = "release" // changed after the repository was listed
	result, err := NewSearchIndexer(q, &backfillHost{}).Backfill(context.Background())
	require.NoError(t, err)
	require.Equal(t, SearchIndexBackfillResult{Indexed: 1}, result)
	commit, _ := q.watermark(1)
	require.Equal(t, "alpha-release", commit)
	require.Equal(t, map[string]string{"README.md": "acme/alpha@alpha-release"}, q.documents[1])
}

func TestSearchIndexBackfill_MissingDefaultBookmarkStaysInBacklog(t *testing.T) {
	q := newBackfillQueries(backfillRepo(1, "alpha"))
	q.defaults[1] = "MAIN-awaiting-repair"
	result, err := NewSearchIndexer(q, &backfillHost{}).Backfill(context.Background())
	require.ErrorContains(t, err, `default bookmark "MAIN-awaiting-repair" not found`)
	require.Equal(t, SearchIndexBackfillResult{Failed: 1}, result)
	_, ok := q.watermark(1)
	require.False(t, ok, "a repository with bookmarks is not recorded as empty")
	require.Empty(t, q.documents[1])
}

func TestSearchIndexBackfill_FailureStaysInBacklogWithoutBlockingOthers(t *testing.T) {
	q := newBackfillQueries(backfillRepo(1, "broken"), backfillRepo(2, "healthy"), backfillRepo(3, "also-broken"))
	host := &backfillHost{failing: map[string]bool{"broken": true, "also-broken": true}}
	indexer := NewSearchIndexer(q, host)

	result, err := indexer.Backfill(context.Background())
	require.ErrorContains(t, err, "2 code search backfills failed (first: repository 1: repository storage unavailable)")
	require.Equal(t, SearchIndexBackfillResult{Indexed: 1, Failed: 2}, result)
	_, ok := q.watermark(1)
	require.False(t, ok)
	_, ok = q.watermark(2)
	require.True(t, ok)

	host.mu.Lock()
	host.failing = nil
	host.mu.Unlock()
	result, err = indexer.Backfill(context.Background())
	require.NoError(t, err)
	require.Equal(t, SearchIndexBackfillResult{Indexed: 2}, result, "the next sweep retries only the failed repositories")
	require.Equal(t, map[string]string{"README.md": "acme/broken@broken-head"}, q.documents[1])
}

func TestSearchIndexBackfill_PagesPastFailuresByCursor(t *testing.T) {
	var repos []db.ListCodeSearchUnindexedRepositoriesRow
	failing := map[string]bool{}
	for id := int64(1); id <= codeSearchBackfillPageSize+5; id++ {
		name := fmt.Sprintf("repo-%d", id)
		repos = append(repos, backfillRepo(id, name))
		if id <= codeSearchBackfillPageSize {
			failing[name] = true // a full page that stays unindexed
		}
	}
	q := newBackfillQueries(repos...)
	result, err := NewSearchIndexer(q, &backfillHost{failing: failing}).Backfill(context.Background())
	require.Error(t, err)
	require.Equal(t, SearchIndexBackfillResult{Indexed: 5, Failed: codeSearchBackfillPageSize}, result)
	require.Equal(t, []db.ListCodeSearchUnindexedRepositoriesParams{
		{AfterID: 0, RowLimit: codeSearchBackfillPageSize},
		{AfterID: codeSearchBackfillPageSize, RowLimit: codeSearchBackfillPageSize},
	}, q.listCalls)
}

func TestSearchIndexBackfill_ExactFullPageEndsOnEmptyPage(t *testing.T) {
	var repos []db.ListCodeSearchUnindexedRepositoriesRow
	for id := int64(1); id <= codeSearchBackfillPageSize; id++ {
		repos = append(repos, backfillRepo(id, fmt.Sprintf("repo-%d", id)))
	}
	q := newBackfillQueries(repos...)
	result, err := NewSearchIndexer(q, &backfillHost{}).Backfill(context.Background())
	require.NoError(t, err)
	require.Equal(t, codeSearchBackfillPageSize, result.Indexed)
	require.Len(t, q.listCalls, 2)
}

func TestSearchIndexBackfill_ListErrorAndMissingDependencies(t *testing.T) {
	q := newBackfillQueries(backfillRepo(1, "alpha"))
	q.listErr = errors.New("database unavailable")
	_, err := NewSearchIndexer(q, &backfillHost{}).Backfill(context.Background())
	require.ErrorContains(t, err, "list unindexed repositories: database unavailable")

	for name, indexer := range map[string]*SearchIndexer{
		"nil indexer":  nil,
		"no queries":   NewSearchIndexer(nil, &backfillHost{}),
		"no repo host": NewSearchIndexer(newBackfillQueries(), nil),
	} {
		_, err := indexer.Backfill(context.Background())
		require.ErrorContains(t, err, "not configured", name)
	}
}

func TestSearchIndexBackfill_CancellationStopsWithoutCountingFailures(t *testing.T) {
	q := newBackfillQueries(backfillRepo(1, "alpha"), backfillRepo(2, "beta"))
	host := &backfillHost{block: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	var result SearchIndexBackfillResult
	var err error
	go func() {
		defer close(done)
		result, err = NewSearchIndexer(q, host).Backfill(ctx)
	}()
	require.Eventually(t, func() bool { return len(host.visited()) == 1 }, time.Second, time.Millisecond)
	cancel()
	<-done
	require.ErrorIs(t, err, context.Canceled)
	require.Equal(t, SearchIndexBackfillResult{}, result)
	require.Equal(t, []string{"acme/alpha"}, host.visited())

	result, err = NewSearchIndexer(q, &backfillHost{}).Backfill(ctx)
	require.ErrorIs(t, err, context.Canceled, "a cancelled sweep indexes nothing")
	require.Equal(t, SearchIndexBackfillResult{}, result)
}

func TestRunCodeSearchBackfill_SweepsImmediatelyAndOnEachInterval(t *testing.T) {
	q := newBackfillQueries(backfillRepo(1, "alpha"))
	host := &backfillHost{failing: map[string]bool{"alpha": true}}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		RunCodeSearchBackfill(ctx, NewSearchIndexer(q, host), 5*time.Millisecond)
	}()
	// A failed sweep is retried on the next tick.
	require.Eventually(t, func() bool { return len(host.visited()) >= 2 }, time.Second, time.Millisecond)
	host.mu.Lock()
	host.failing = nil
	host.mu.Unlock()
	require.Eventually(t, func() bool { _, ok := q.watermark(1); return ok }, time.Second, time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("backfill worker did not return after cancellation")
	}
}

func TestRunCodeSearchBackfill_ReturnsWithoutDependencies(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for name, run := range map[string]func(){
		"nil indexer": func() { RunCodeSearchBackfill(context.Background(), nil, time.Second) },
		"no interval": func() {
			RunCodeSearchBackfill(context.Background(), NewSearchIndexer(newBackfillQueries(), &backfillHost{}), 0)
		},
		"cancelled context": func() { RunCodeSearchBackfill(ctx, NewSearchIndexer(newBackfillQueries(), &backfillHost{}), time.Hour) },
	} {
		done := make(chan struct{})
		go func() { defer close(done); run() }()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatalf("%s: backfill worker did not return", name)
		}
	}
}

func (h *backfillHost) GetBookmark(ctx context.Context, owner, repo, name string) (repohost.Bookmark, error) {
	items, _, err := h.ListBookmarks(ctx, owner, repo, "", 1)
	if err != nil {
		return repohost.Bookmark{}, err
	}
	for _, bookmark := range items {
		if bookmark.Name == name {
			return bookmark, nil
		}
	}
	return repohost.Bookmark{}, &repohost.StatusError{StatusCode: 404, Code: "bookmark_not_found"}
}

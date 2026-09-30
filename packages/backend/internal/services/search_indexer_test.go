package services

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type fakeSearchIndexQueries struct {
	mu            sync.Mutex
	repository    db.Repository
	hasDocs       bool
	indexedCommit string
	hasCalls      int
	upserts       []db.UpsertCodeSearchDocumentParams
	deletes       []db.DeleteCodeSearchDocumentByPathParams
}

func (f *fakeSearchIndexQueries) GetRepoByID(context.Context, int64) (db.Repository, error) {
	return f.repository, nil
}

func (f *fakeSearchIndexQueries) GetCodeSearchIndexedCommit(context.Context, int64) (string, error) {
	if f.indexedCommit != "" {
		return f.indexedCommit, nil
	}
	if f.hasDocs {
		return "previous-commit", nil
	}
	return "", nil
}
func (f *fakeSearchIndexQueries) SetCodeSearchIndexedCommit(_ context.Context, arg db.SetCodeSearchIndexedCommitParams) error {
	f.indexedCommit = arg.CommitID
	return nil
}
func (f *fakeSearchIndexQueries) DeleteCodeSearchDocumentsExceptPaths(context.Context, db.DeleteCodeSearchDocumentsExceptPathsParams) error {
	return nil
}

func (f *fakeSearchIndexQueries) ListCodeSearchUnindexedRepositories(context.Context, db.ListCodeSearchUnindexedRepositoriesParams) ([]db.ListCodeSearchUnindexedRepositoriesRow, error) {
	return nil, nil
}

func (f *fakeSearchIndexQueries) HasCodeSearchDocumentsForRepo(context.Context, int64) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.hasCalls++
	return f.hasDocs, nil
}

func (f *fakeSearchIndexQueries) UpsertCodeSearchDocument(_ context.Context, arg db.UpsertCodeSearchDocumentParams) (db.UpsertCodeSearchDocumentRow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.upserts = append(f.upserts, arg)
	return db.UpsertCodeSearchDocumentRow{
		RepositoryID: arg.RepositoryID,
		FilePath:     arg.FilePath,
		Content:      arg.Content,
	}, nil
}

func (f *fakeSearchIndexQueries) DeleteCodeSearchDocumentByPath(_ context.Context, arg db.DeleteCodeSearchDocumentByPathParams) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deletes = append(f.deletes, arg)
	return nil
}

func (f *fakeSearchIndexQueries) snapshot() ([]db.UpsertCodeSearchDocumentParams, []db.DeleteCodeSearchDocumentByPathParams) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]db.UpsertCodeSearchDocumentParams(nil), f.upserts...), append([]db.DeleteCodeSearchDocumentByPathParams(nil), f.deletes...)
}

type fakeSearchIndexRepoHost struct {
	mu           sync.Mutex
	diff         repohost.ChangeDiff
	tree         []repohost.ChangeFile
	contents     map[string]repohost.FileContent
	diffCalls    int
	diffFrom     string
	diffTo       string
	failPath     string
	diffErr      error
	treeCalls    int
	getFileCalls []string
}

func (f *fakeSearchIndexRepoHost) ListBookmarks(context.Context, string, string, string, int) ([]repohost.Bookmark, string, error) {
	return []repohost.Bookmark{{Name: "main", TargetCommitID: "abc123"}}, "", nil
}
func (f *fakeSearchIndexRepoHost) GetRevisionDiff(ctx context.Context, owner, repo, changeID, from, to, path string) (repohost.ChangeDiff, error) {
	f.mu.Lock()
	f.diffFrom, f.diffTo = from, to
	f.mu.Unlock()
	if f.diffErr != nil {
		return repohost.ChangeDiff{}, f.diffErr
	}
	return f.GetChangeDiff(ctx, owner, repo, changeID)
}

func (f *fakeSearchIndexRepoHost) GetChangeDiff(context.Context, string, string, string) (repohost.ChangeDiff, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.diffCalls++
	return f.diff, nil
}

func (f *fakeSearchIndexRepoHost) ListFilesAtChange(context.Context, string, string, string, string) ([]repohost.ChangeFile, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.treeCalls++
	return append([]repohost.ChangeFile(nil), f.tree...), nil
}

func (f *fakeSearchIndexRepoHost) GetFileAtChange(_ context.Context, _, _, _, path string) (repohost.FileContent, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.getFileCalls = append(f.getFileCalls, path)
	if path == f.failPath {
		return repohost.FileContent{}, errors.New("temporary storage failure")
	}
	if content, ok := f.contents[path]; ok {
		return content, nil
	}
	return repohost.FileContent{Path: path, Content: "content for " + path, Encoding: "utf8"}, nil
}

func defaultSearchIndexInput() SearchIndexPushInput {
	return SearchIndexPushInput{
		RepositoryID:   41,
		Owner:          "alice",
		RepositoryName: "demo",
		Ref:            "refs/heads/main",
		CommitSHA:      "abc123",
	}
}

func newFakeSearchIndexQueries(hasDocs bool) *fakeSearchIndexQueries {
	return &fakeSearchIndexQueries{
		repository: db.Repository{ID: 41, Name: "demo", DefaultBookmark: "main"},
		hasDocs:    hasDocs,
	}
}

func TestSearchIndexer_UpsertsAddedAndModifiedTextFiles(t *testing.T) {
	t.Parallel()

	queries := newFakeSearchIndexQueries(true)
	repoHost := &fakeSearchIndexRepoHost{
		diff: repohost.ChangeDiff{FileDiffs: []repohost.FileDiff{
			{Path: "src/added.go", ChangeType: "added"},
			{Path: "README.md", ChangeType: "modified"},
		}},
		contents: map[string]repohost.FileContent{
			"src/added.go": {Path: "src/added.go", Content: "package added\n", Encoding: "utf8"},
			"README.md":    {Path: "README.md", Content: "fresh canary term\n", Encoding: "utf8"},
		},
	}

	err := NewSearchIndexer(queries, repoHost).IndexPush(context.Background(), defaultSearchIndexInput())
	require.NoError(t, err)

	upserts, deletes := queries.snapshot()
	require.Len(t, upserts, 2)
	assert.Empty(t, deletes)
	indexed := make(map[string]string, len(upserts))
	for _, upsert := range upserts {
		assert.Equal(t, int64(41), upsert.RepositoryID)
		indexed[upsert.FilePath] = upsert.Content
	}
	assert.Equal(t, "package added\n", indexed["src/added.go"])
	assert.Equal(t, "fresh canary term\n", indexed["README.md"])
	assert.Equal(t, 1, repoHost.diffCalls)
	assert.Equal(t, 0, repoHost.treeCalls)
}

func TestSearchIndexer_EnforcesFileSizeCap(t *testing.T) {
	t.Parallel()

	queries := newFakeSearchIndexQueries(true)
	repoHost := &fakeSearchIndexRepoHost{
		diff: repohost.ChangeDiff{FileDiffs: []repohost.FileDiff{
			{Path: "at-limit.txt", ChangeType: "modified"},
			{Path: "over-limit.txt", ChangeType: "modified"},
		}},
		contents: map[string]repohost.FileContent{
			"at-limit.txt":   {Content: strings.Repeat("a", maxCodeSearchFileBytes), Encoding: "utf8"},
			"over-limit.txt": {Content: strings.Repeat("b", maxCodeSearchFileBytes+1), Encoding: "utf8"},
		},
	}

	err := NewSearchIndexer(queries, repoHost).IndexPush(context.Background(), defaultSearchIndexInput())
	require.NoError(t, err)

	upserts, deletes := queries.snapshot()
	require.Len(t, upserts, 1)
	assert.Equal(t, "at-limit.txt", upserts[0].FilePath)
	require.Len(t, deletes, 1)
	assert.Equal(t, "over-limit.txt", deletes[0].FilePath)
}

func TestSearchIndexer_SkipsBinaryFilesByNullByteSniff(t *testing.T) {
	t.Parallel()

	queries := newFakeSearchIndexQueries(true)
	repoHost := &fakeSearchIndexRepoHost{
		diff: repohost.ChangeDiff{FileDiffs: []repohost.FileDiff{
			{Path: "asset.bin", ChangeType: "modified"},
		}},
		contents: map[string]repohost.FileContent{
			"asset.bin": {Content: "prefix\x00suffix", Encoding: "utf8"},
		},
	}

	err := NewSearchIndexer(queries, repoHost).IndexPush(context.Background(), defaultSearchIndexInput())
	require.NoError(t, err)

	upserts, deletes := queries.snapshot()
	assert.Empty(t, upserts)
	require.Len(t, deletes, 1)
	assert.Equal(t, "asset.bin", deletes[0].FilePath)
}

func TestSearchIndexer_DeletesRemovedPaths(t *testing.T) {
	t.Parallel()

	queries := newFakeSearchIndexQueries(true)
	repoHost := &fakeSearchIndexRepoHost{
		diff: repohost.ChangeDiff{FileDiffs: []repohost.FileDiff{
			{Path: "src/removed.go", ChangeType: "deleted"},
		}},
	}

	err := NewSearchIndexer(queries, repoHost).IndexPush(context.Background(), defaultSearchIndexInput())
	require.NoError(t, err)

	upserts, deletes := queries.snapshot()
	assert.Empty(t, upserts)
	require.Len(t, deletes, 1)
	assert.Equal(t, int64(41), deletes[0].RepositoryID)
	assert.Equal(t, "src/removed.go", deletes[0].FilePath)
	assert.Empty(t, repoHost.getFileCalls, "deleted paths must not be fetched")
}

func TestSearchIndexer_FirstIndexIncludesFilesBeyondFormerCap(t *testing.T) {
	t.Parallel()

	queries := newFakeSearchIndexQueries(false)
	tree := make([]repohost.ChangeFile, 2001)
	for i := range tree {
		tree[i] = repohost.ChangeFile{Path: fmt.Sprintf("file-%04d.txt", i)}
	}
	repoHost := &fakeSearchIndexRepoHost{tree: tree}

	err := NewSearchIndexer(queries, repoHost).IndexPush(context.Background(), defaultSearchIndexInput())
	require.NoError(t, err)

	upserts, deletes := queries.snapshot()
	assert.Len(t, upserts, 2001)
	assert.Empty(t, deletes)
	assert.Equal(t, 1, repoHost.treeCalls)
	assert.Equal(t, 0, repoHost.diffCalls, "first indexing must use the full snapshot, not only the push diff")
	assert.Len(t, repoHost.getFileCalls, 2001)
	indexedPaths := make(map[string]struct{}, len(upserts))
	for _, upsert := range upserts {
		indexedPaths[upsert.FilePath] = struct{}{}
	}
	assert.Contains(t, indexedPaths, "file-1999.txt")
	assert.Contains(t, indexedPaths, "file-2000.txt")
}

func TestSearchIndexerDiffsWatermarkToCurrentHeadForStalePush(t *testing.T) {
	queries := newFakeSearchIndexQueries(true)
	queries.indexedCommit = "last-successful-snapshot"
	repoHost := &fakeSearchIndexRepoHost{diff: repohost.ChangeDiff{FileDiffs: []repohost.FileDiff{{Path: "earlier-commit.txt", ChangeType: "added"}}}}
	input := defaultSearchIndexInput()
	input.CommitSHA = "delayed-old-push"
	require.NoError(t, NewSearchIndexer(queries, repoHost).IndexPush(t.Context(), input))
	require.Equal(t, "last-successful-snapshot", repoHost.diffFrom)
	require.Equal(t, "abc123", repoHost.diffTo)
	require.Equal(t, "abc123", queries.indexedCommit)
	require.Equal(t, "earlier-commit.txt", queries.upserts[0].FilePath)
}

func TestSearchIndexerRollsBackDocumentsAndWatermarkOnReadFailure(t *testing.T) {
	pool := setupTestPool(t)
	_, repoID := setupTestUserAndRepo(t, pool)
	queries := db.New(pool)
	_, err := queries.UpsertCodeSearchDocument(t.Context(), db.UpsertCodeSearchDocumentParams{RepositoryID: repoID, FilePath: "old.txt", Content: "preserve this snapshot"})
	require.NoError(t, err)
	require.NoError(t, queries.SetCodeSearchIndexedCommit(t.Context(), db.SetCodeSearchIndexedCommitParams{RepositoryID: repoID, CommitID: "before"}))
	repoHost := &fakeSearchIndexRepoHost{failPath: "broken.txt", diff: repohost.ChangeDiff{FileDiffs: []repohost.FileDiff{{Path: "old.txt", ChangeType: "deleted"}, {Path: "new.txt", ChangeType: "added"}, {Path: "broken.txt", ChangeType: "added"}}}}
	input := defaultSearchIndexInput()
	input.RepositoryID = repoID
	err = NewSearchIndexer(queries, repoHost, pool).IndexPush(t.Context(), input)
	require.ErrorContains(t, err, "temporary storage failure")
	watermark, err := queries.GetCodeSearchIndexedCommit(t.Context(), repoID)
	require.NoError(t, err)
	require.Equal(t, "before", watermark)
	var paths []string
	require.NoError(t, pool.QueryRow(t.Context(), "SELECT array_agg(file_path ORDER BY file_path) FROM code_search_documents WHERE repository_id = $1", repoID).Scan(&paths))
	require.Equal(t, []string{"old.txt"}, paths)
}

func TestSearchIndexerRebuildsAfterWatermarkCommitIsPruned(t *testing.T) {
	queries := newFakeSearchIndexQueries(true)
	rh := &fakeSearchIndexRepoHost{diffErr: &repohost.StatusError{StatusCode: 404}, tree: []repohost.ChangeFile{{Path: "current.txt"}}}
	require.NoError(t, NewSearchIndexer(queries, rh).IndexPush(t.Context(), defaultSearchIndexInput()))
	require.Equal(t, 1, rh.treeCalls)
	require.Equal(t, "current.txt", queries.upserts[0].FilePath)
	require.Equal(t, "abc123", queries.indexedCommit)
}

type boundedSearchBookmarkHost struct {
	*fakeSearchIndexRepoHost
	items                  map[string]repohost.Bookmark
	lookupCalls, listCalls int
	listErr                error
	t                      *testing.T
}

func (h *boundedSearchBookmarkHost) GetBookmark(_ context.Context, _, _, name string) (repohost.Bookmark, error) {
	h.lookupCalls++
	if bookmark, ok := h.items[name]; ok {
		return bookmark, nil
	}
	return repohost.Bookmark{}, &repohost.StatusError{StatusCode: 404, Code: "bookmark_not_found"}
}
func (h *boundedSearchBookmarkHost) ListBookmarks(_ context.Context, _, _, cursor string, limit int) ([]repohost.Bookmark, string, error) {
	h.listCalls++
	require.Empty(h.t, cursor)
	require.Equal(h.t, 1, limit)
	if h.listErr != nil {
		return nil, "", h.listErr
	}
	for _, bookmark := range h.items {
		return []repohost.Bookmark{bookmark}, "more", nil
	}
	return nil, "", nil
}
func TestSearchIndexerNamedBookmarkOneLookupBeyond500(t *testing.T) {
	items := map[string]repohost.Bookmark{}
	for i := range 601 {
		name := fmt.Sprintf("branch-%d", i)
		items[name] = repohost.Bookmark{Name: name, TargetCommitID: name}
	}
	items["main"] = repohost.Bookmark{Name: "main", TargetCommitID: "wanted"}
	host := &boundedSearchBookmarkHost{fakeSearchIndexRepoHost: &fakeSearchIndexRepoHost{}, items: items, t: t}
	q := newFakeSearchIndexQueries(false)
	require.NoError(t, NewSearchIndexer(q, host).IndexPush(t.Context(), defaultSearchIndexInput()))
	require.Equal(t, "wanted", q.indexedCommit)
	require.Equal(t, 1, host.lookupCalls)
	require.Zero(t, host.listCalls)
}
func TestSearchIndexBackfillMissingDefaultUsesOneExistencePage(t *testing.T) {
	for _, tc := range []struct {
		name      string
		items     map[string]repohost.Bookmark
		listErr   error
		failed    bool
		listCalls int
	}{
		{name: "empty", listCalls: 1},
		{name: "other bookmarks", items: map[string]repohost.Bookmark{"release": {Name: "release", TargetCommitID: "release-head"}}, failed: true, listCalls: 1},
		{name: "storage failure", listErr: errors.New("unavailable"), failed: true, listCalls: 1},
		{name: "empty default target", items: map[string]repohost.Bookmark{"trunk": {Name: "trunk"}}, failed: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			q := newBackfillQueries(backfillRepo(1, "demo"))
			host := &boundedSearchBookmarkHost{fakeSearchIndexRepoHost: &fakeSearchIndexRepoHost{}, items: tc.items, listErr: tc.listErr, t: t}
			result, err := NewSearchIndexer(q, host).Backfill(t.Context())
			if tc.failed {
				require.Error(t, err)
				require.Equal(t, 1, result.Failed)
				_, ok := q.watermark(1)
				require.False(t, ok)
			} else {
				require.NoError(t, err)
				require.Equal(t, 1, result.Indexed)
				_, ok := q.watermark(1)
				require.True(t, ok)
			}
			require.Equal(t, 1, host.lookupCalls)
			require.Equal(t, tc.listCalls, host.listCalls)
		})
	}
}

func (h *fakeSearchIndexRepoHost) GetBookmark(ctx context.Context, owner, repo, name string) (repohost.Bookmark, error) {
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

type blankDefaultSearchQueries struct{ *backfillQueries }

func (q blankDefaultSearchQueries) GetRepoByID(_ context.Context, id int64) (db.Repository, error) {
	return db.Repository{ID: id, Name: "demo", DefaultBookmark: " "}, nil
}
func TestSearchIndexerBlankDefaultSkipsNamedLookup(t *testing.T) {
	t.Run("push clears old watermark", func(t *testing.T) {
		q := newFakeSearchIndexQueries(true)
		q.repository.DefaultBookmark = " "
		host := &boundedSearchBookmarkHost{fakeSearchIndexRepoHost: &fakeSearchIndexRepoHost{}, t: t}
		input := defaultSearchIndexInput()
		input.Ref = ""
		require.NoError(t, NewSearchIndexer(q, host).IndexPush(t.Context(), input))
		require.Empty(t, q.indexedCommit)
		require.Zero(t, host.lookupCalls)
		require.Zero(t, host.listCalls)
	})
	for _, hasBookmarks := range []bool{false, true} {
		t.Run(fmt.Sprintf("backfill bookmarks=%t", hasBookmarks), func(t *testing.T) {
			q := blankDefaultSearchQueries{newBackfillQueries(backfillRepo(1, "demo"))}
			host := &boundedSearchBookmarkHost{fakeSearchIndexRepoHost: &fakeSearchIndexRepoHost{}, t: t}
			if hasBookmarks {
				host.items = map[string]repohost.Bookmark{"main": {Name: "main", TargetCommitID: "head"}}
			}
			result, err := NewSearchIndexer(q, host).Backfill(t.Context())
			if hasBookmarks {
				require.ErrorContains(t, err, "default bookmark")
				require.Equal(t, 1, result.Failed)
			} else {
				require.NoError(t, err)
				require.Equal(t, 1, result.Indexed)
			}
			require.Zero(t, host.lookupCalls)
			require.Equal(t, 1, host.listCalls)
		})
	}
}

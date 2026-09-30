package services

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// RED PHASE — "Reused mirrors must refresh from GitHub".
//
// Today the REUSE path (finishReusedImport) deliberately skips cloneMirror +
// ImportRefs, so a reused mirror NEVER picks up new GitHub commits: every reopen
// serves the tree frozen at first-import time (the 2026-07-14 "the file system
// doesn't have the files I expect" complaint).
//
// These tests pin the intended behavior: on the reuse path the mirror is
// refreshed from GitHub with NON-DESTRUCTIVE semantics (fetch like
// cloneAndPushMirror, then push with non-pruning refspecs instead of --mirror,
// then ImportRefs) BEFORE the default-branch bookmark is resolved — while
// preserving #47 (no --mirror clobber) and degrading to the stale mirror on a
// refresh failure. They exercise the git seam via the white-box s.runGit /
// s.mkdirTemp fields so no real network or repo-host storage is touched.

// gitCallRecorder captures every git invocation the refresh performs so the
// reuse-path tests can assert on the recorded push refspecs (non-pruning, never
// --mirror) and can force a push failure to exercise graceful degradation.
type gitCallRecorder struct {
	calls   [][]string
	events  *[]string
	pushErr error
}

func (r *gitCallRecorder) run(_ context.Context, _ []string, args ...string) (string, error) {
	r.calls = append(r.calls, append([]string(nil), args...))
	verb := gitVerb(args)
	if r.events != nil {
		*r.events = append(*r.events, "git_"+verb)
	}
	if verb == "push" && r.pushErr != nil {
		return "remote rejected", r.pushErr
	}
	return "", nil
}

// gitVerb returns the first non-flag, non-"--git-dir"-value token — the git
// subcommand (clone / push / …).
func gitVerb(args []string) string {
	skipNext := false
	for _, a := range args {
		if skipNext {
			skipNext = false
			continue
		}
		if a == "--git-dir" {
			skipNext = true
			continue
		}
		if len(a) >= 2 && a[0:2] == "--" {
			continue
		}
		return a
	}
	return ""
}

func (r *gitCallRecorder) pushCall() []string {
	for _, c := range r.calls {
		if gitVerb(c) == "push" {
			return c
		}
	}
	return nil
}

func argsContain(args []string, want string) bool {
	for _, a := range args {
		if a == want {
			return true
		}
	}
	return false
}

// refreshSeamRepoHost records the order of ImportRefs vs bookmark listing so the
// reuse tests can assert the refresh (ImportRefs) runs BEFORE bookmark
// resolution (the first ListBookmarks).
type refreshSeamRepoHost struct {
	bookmarks         []repohost.Bookmark
	events            *[]string
	importRefsOwner   string
	createdBookmark   repohost.CreateBookmarkRequest
	createdBookmarkOK bool
}

func (t *refreshSeamRepoHost) InitRepo(context.Context, string, string, string, bool) error {
	return nil
}

func (t *refreshSeamRepoHost) DeleteRepo(context.Context, string, string) error {
	return nil
}

func (t *refreshSeamRepoHost) ImportRefs(_ context.Context, owner, _ string) error {
	t.importRefsOwner = owner
	if t.events != nil {
		*t.events = append(*t.events, "import_refs")
	}
	return nil
}

func (t *refreshSeamRepoHost) ListBookmarks(context.Context, string, string, string, int) ([]repohost.Bookmark, string, error) {
	if t.events != nil {
		*t.events = append(*t.events, "list_bookmarks")
	}
	return t.bookmarks, "", nil
}

func (t *refreshSeamRepoHost) CreateBookmark(_ context.Context, _ string, _ string, req repohost.CreateBookmarkRequest) (repohost.Bookmark, error) {
	t.createdBookmark = req
	t.createdBookmarkOK = true
	return repohost.Bookmark{Name: req.Name, TargetChangeID: req.TargetChangeID}, nil
}

func indexOf(events []string, want string) int {
	for i, e := range events {
		if e == want {
			return i
		}
	}
	return -1
}

func newRefreshImportAPI(t *testing.T) *httptest.Server {
	t.Helper()
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"private":        false,
			"default_branch": "main",
		})
	}))
	t.Cleanup(api.Close)
	t.Setenv(envGitHubAppAPIBaseURL, api.URL)
	return api
}

// TestGitHubImportService_ReuseRefreshesMirrorFromGitHub is the core RED test:
// re-importing an already-mirrored repo (provenance matches) must REFRESH the
// mirror from GitHub — fetch + a non-pruning push + ImportRefs — BEFORE
// resolving the default-branch bookmark, then reach ready. Fails on current
// code, which skips the refresh entirely (no git ops, ImportRefs never called).
func TestGitHubImportService_ReuseRefreshesMirrorFromGitHub(t *testing.T) {
	api := newRefreshImportAPI(t)

	events := &[]string{}
	existing := db.Repository{ID: 99, Name: "smithers", LowerName: "smithers", DefaultBookmark: "main"}
	repoHost := &refreshSeamRepoHost{
		bookmarks: []repohost.Bookmark{{Name: "main", TargetChangeID: "c-main"}},
		events:    events,
	}
	provisioner := &testGitHubImportWorkspaceProvisioner{
		resp: WorkspaceResponse{
			ID:             "11111111-1111-1111-1111-111111111111",
			RepositoryID:   99,
			UserID:         7,
			TargetBookmark: "main",
			Status:         "running",
		},
	}
	recorder := &gitCallRecorder{events: events}
	svc := NewGitHubImportService(
		&stageRecordingDB{},
		testGitHubImportRepoDB{existing: &existing},
		testGitHubImportTokenDB{},
		repoHost,
		testGitHubImportDecrypter{},
		"https://smithers.test",
		WithGitHubImportHTTPClient(api.Client()),
		WithGitHubImportWorkspaceProvisioner(provisioner),
		withGitHubImportProvenance(func(context.Context, int64, string, string, int64) (bool, error) {
			return true, nil
		}),
	)
	// White-box: fake the git seam + temp dir so the refresh runs no real git.
	svc.runGit = recorder.run
	svc.mkdirTemp = func(string, string) (string, error) { return t.TempDir(), nil }

	repository, workspace, err := svc.runImport(context.Background(), 7, "smithersai", "smithers", "importer", "main", "job-reuse-refresh")
	require.NoError(t, err, "reuse must refresh then reach ready")
	assert.Equal(t, int64(99), repository.ID, "reuse returns the existing repo row")
	assert.Equal(t, "11111111-1111-1111-1111-111111111111", workspace.ID)

	// The refresh must actually run against GitHub + storage on the reuse path.
	assert.NotEmpty(t, recorder.calls, "reuse must refresh the mirror via git (fetch + push), not skip it")
	require.NotNil(t, recorder.pushCall(), "reuse must push the refreshed refs into repo-host storage")
	assert.Equal(t, "importer", repoHost.importRefsOwner, "reuse must ImportRefs the refreshed git refs into jj")

	// Refresh must precede bookmark resolution (the first ListBookmarks).
	pushIdx := indexOf(*events, "git_push")
	importIdx := indexOf(*events, "import_refs")
	listIdx := indexOf(*events, "list_bookmarks")
	require.GreaterOrEqual(t, pushIdx, 0)
	require.GreaterOrEqual(t, importIdx, 0)
	require.GreaterOrEqual(t, listIdx, 0)
	assert.Less(t, pushIdx, importIdx, "the non-pruning push must precede ImportRefs")
	assert.Less(t, importIdx, listIdx, "the refresh (push+ImportRefs) must precede bookmark resolution")
}

// TestGitHubImportService_ReuseRefreshPushUsesNonPruningRefspecs pins the #47
// security property under the refresh: the push into existing storage must use
// non-pruning refspecs (refs/heads/*:refs/heads/*, refs/tags/*:refs/tags/*) so
// jjhub-created bookmarks/landing branches survive — it must NEVER be a
// --mirror push (which PRUNES refs absent from GitHub). Fails on current code:
// the reuse path performs no push at all.
func TestGitHubImportService_ReuseRefreshPushUsesNonPruningRefspecs(t *testing.T) {
	api := newRefreshImportAPI(t)

	existing := db.Repository{ID: 99, Name: "smithers", LowerName: "smithers", DefaultBookmark: "main"}
	repoHost := &refreshSeamRepoHost{bookmarks: []repohost.Bookmark{{Name: "main", TargetChangeID: "c-main"}}}
	provisioner := &testGitHubImportWorkspaceProvisioner{
		resp: WorkspaceResponse{ID: "11111111-1111-1111-1111-111111111111", RepositoryID: 99, UserID: 7, TargetBookmark: "main", Status: "running"},
	}
	recorder := &gitCallRecorder{}
	svc := NewGitHubImportService(
		&stageRecordingDB{},
		testGitHubImportRepoDB{existing: &existing},
		testGitHubImportTokenDB{},
		repoHost,
		testGitHubImportDecrypter{},
		"https://smithers.test",
		WithGitHubImportHTTPClient(api.Client()),
		WithGitHubImportWorkspaceProvisioner(provisioner),
		withGitHubImportProvenance(func(context.Context, int64, string, string, int64) (bool, error) { return true, nil }),
	)
	svc.runGit = recorder.run
	svc.mkdirTemp = func(string, string) (string, error) { return t.TempDir(), nil }

	_, _, err := svc.runImport(context.Background(), 7, "smithersai", "smithers", "importer", "main", "job-reuse-refspecs")
	require.NoError(t, err)

	push := recorder.pushCall()
	require.NotNil(t, push, "reuse must push the refreshed refs")
	assert.False(t, argsContain(push, "--mirror"), "the refresh push must NEVER use --mirror (it prunes jjhub-side refs, #47)")
	assert.True(t, argsContain(push, "refs/heads/*:refs/heads/*"), "the refresh push must use a non-pruning heads refspec")
	assert.True(t, argsContain(push, "refs/tags/*:refs/tags/*"), "the refresh push must use a non-pruning tags refspec")
}

// TestGitHubImportService_ReuseRefreshFailureDegradesToStaleMirror pins the
// graceful-degradation contract: when the refresh push FAILS (GitHub outage /
// expired token), the reopen must still reach ready serving the existing (stale)
// mirror — no error surfaced, the pre-existing repo NEVER deleted, and the
// failure logged (mirror.reuse.refresh_failed). Fails on current code because
// the refresh is never attempted at all (no push recorded, no log emitted).
func TestGitHubImportService_ReuseRefreshFailureDegradesToStaleMirror(t *testing.T) {
	api := newRefreshImportAPI(t)

	var logBuf bytes.Buffer
	prevLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logBuf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prevLogger) })

	deleted := &[]int64{}
	existing := db.Repository{ID: 99, Name: "smithers", LowerName: "smithers", DefaultBookmark: "main"}
	repoHost := &refreshSeamRepoHost{bookmarks: []repohost.Bookmark{{Name: "main", TargetChangeID: "c-main"}}}
	provisioner := &testGitHubImportWorkspaceProvisioner{
		resp: WorkspaceResponse{ID: "11111111-1111-1111-1111-111111111111", RepositoryID: 99, UserID: 7, TargetBookmark: "main", Status: "running"},
	}
	recorder := &gitCallRecorder{pushErr: errors.New("push mirrored refs: connection refused")}
	svc := NewGitHubImportService(
		&stageRecordingDB{},
		testGitHubImportRepoDB{existing: &existing, deleted: deleted},
		testGitHubImportTokenDB{},
		repoHost,
		testGitHubImportDecrypter{},
		"https://smithers.test",
		WithGitHubImportHTTPClient(api.Client()),
		WithGitHubImportWorkspaceProvisioner(provisioner),
		withGitHubImportProvenance(func(context.Context, int64, string, string, int64) (bool, error) { return true, nil }),
	)
	svc.runGit = recorder.run
	svc.mkdirTemp = func(string, string) (string, error) { return t.TempDir(), nil }

	repository, workspace, err := svc.runImport(context.Background(), 7, "smithersai", "smithers", "importer", "main", "job-reuse-refresh-fail")
	require.NoError(t, err, "a refresh failure must degrade to the stale mirror, not fail the reopen")
	assert.Equal(t, int64(99), repository.ID, "the stale mirror is still served")
	assert.Equal(t, "11111111-1111-1111-1111-111111111111", workspace.ID)

	// The refresh must have been ATTEMPTED (this is the RED signal today).
	require.NotNil(t, recorder.pushCall(), "reuse must attempt the refresh push even though it fails")
	// A failed refresh must never delete the pre-existing mirror (#47 boundary).
	assert.Empty(t, *deleted, "a refresh failure on the reuse path must NEVER delete the pre-existing repo")
	assert.Contains(t, logBuf.String(), "mirror.reuse.refresh_failed", "a degraded refresh must be logged")
}

// TestGitHubImportService_FreshImportStillClonesAndImportsRefs is a guard: the
// FRESH (non-reuse) path must keep its full cloneMirror + ImportRefs behavior.
// Passes on current code and must stay green after the reuse-refresh change.
func TestGitHubImportService_FreshImportStillClonesAndImportsRefs(t *testing.T) {
	api := newRefreshImportAPI(t)

	repoHost := &testGitHubImportRepoHost{bookmarks: []repohost.Bookmark{{Name: "main", TargetChangeID: "c-main"}}}
	provisioner := &testGitHubImportWorkspaceProvisioner{
		resp: WorkspaceResponse{ID: "33333333-3333-3333-3333-333333333333", RepositoryID: 42, UserID: 7, TargetBookmark: "main", Status: "running"},
	}
	cloneCalled := false
	svc := NewGitHubImportService(
		&stageRecordingDB{},
		testGitHubImportRepoDB{},
		testGitHubImportTokenDB{},
		repoHost,
		testGitHubImportDecrypter{},
		"https://smithers.test",
		WithGitHubImportHTTPClient(api.Client()),
		WithGitHubImportWorkspaceProvisioner(provisioner),
		withGitHubImportCloneMirror(func(context.Context, string, string, string, string, string, string) error {
			cloneCalled = true
			return nil
		}),
	)

	repository, _, err := svc.runImport(context.Background(), 7, "octo", "demo", "importer", "main", "job-fresh")
	require.NoError(t, err)
	assert.Equal(t, int64(42), repository.ID)
	assert.True(t, cloneCalled, "the fresh path must still cloneMirror")
	assert.Equal(t, "importer", repoHost.importRefsOwner, "the fresh path must still ImportRefs")
}

func (t *refreshSeamRepoHost) GetBookmark(ctx context.Context, owner, repo, name string) (repohost.Bookmark, error) {
	items, _, err := t.ListBookmarks(ctx, owner, repo, "", 100)
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

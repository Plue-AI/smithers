package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type testGitHubImportTokenDB struct {
	accounts []db.OauthAccount
}

func (t testGitHubImportTokenDB) CreateAccessToken(context.Context, db.CreateAccessTokenParams) (db.AccessToken, error) {
	return db.AccessToken{ID: 99}, nil
}

func (t testGitHubImportTokenDB) DeleteAccessToken(context.Context, db.DeleteAccessTokenParams) error {
	return nil
}

func (t testGitHubImportTokenDB) ListUserOAuthAccounts(context.Context, int64) ([]db.OauthAccount, error) {
	return t.accounts, nil
}

type testGitHubImportDecrypter struct {
	token string
}

func (t testGitHubImportDecrypter) DecryptOAuthAccessToken([]byte) (string, error) {
	return t.token, nil
}

type testGitHubImportRepoHost struct {
	bookmarks         []repohost.Bookmark
	createdBookmark   repohost.CreateBookmarkRequest
	createdBookmarkOK bool
	importRefsOwner   string
	importRefsRepo    string
	initRepoErr       error
	initRepoOwner     string
	initRepoName      string
	deletedRepos      []string
	deleteRepoErr     error
}

func (t *testGitHubImportRepoHost) InitRepo(_ context.Context, owner, repo, _ string, _ bool) error {
	t.initRepoOwner = owner
	t.initRepoName = repo
	return t.initRepoErr
}

func (t *testGitHubImportRepoHost) DeleteRepo(_ context.Context, owner, repo string) error {
	t.deletedRepos = append(t.deletedRepos, owner+"/"+repo)
	return t.deleteRepoErr
}

func (t *testGitHubImportRepoHost) ImportRefs(_ context.Context, owner, repo string) error {
	t.importRefsOwner = owner
	t.importRefsRepo = repo
	return nil
}

func (t *testGitHubImportRepoHost) ListBookmarks(context.Context, string, string, string, int) ([]repohost.Bookmark, string, error) {
	return t.bookmarks, "", nil
}

func (t *testGitHubImportRepoHost) CreateBookmark(_ context.Context, _ string, _ string, req repohost.CreateBookmarkRequest) (repohost.Bookmark, error) {
	t.createdBookmark = req
	t.createdBookmarkOK = true
	return repohost.Bookmark{Name: req.Name, TargetChangeID: req.TargetChangeID}, nil
}

type testGitHubImportWorkspaceProvisioner struct {
	input CreateWorkspaceInput
	resp  WorkspaceResponse
}

func (t *testGitHubImportWorkspaceProvisioner) CreateWorkspaceAsync(_ context.Context, input CreateWorkspaceInput) (WorkspaceResponse, error) {
	t.input = input
	return t.resp, nil
}

type testGitHubImportRepoDB struct {
	repo     db.Repository
	existing *db.Repository
	deleted  *[]int64
}

func (t testGitHubImportRepoDB) CreateRepo(_ context.Context, arg db.CreateRepoParams) (db.Repository, error) {
	repo := t.repo
	repo.ID = 42
	repo.Name = arg.Name
	repo.LowerName = arg.LowerName
	repo.DefaultBookmark = arg.DefaultBookmark
	return repo, nil
}

func (t testGitHubImportRepoDB) DeleteRepo(_ context.Context, id int64) error {
	if t.deleted != nil {
		*t.deleted = append(*t.deleted, id)
	}
	return nil
}

func (t testGitHubImportRepoDB) GetRepoByOwnerAndLowerName(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	if t.existing != nil {
		return *t.existing, nil
	}
	return db.Repository{}, pgx.ErrNoRows
}

func TestGitHubImportService_PublicRepoUsesAnonymousClone(t *testing.T) {
	var authHeader string
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader = r.Header.Get("Authorization")
		require.Equal(t, "/repos/octo/public-demo", r.URL.Path)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"private":        false,
			"default_branch": "trunk",
		})
	}))
	defer api.Close()
	t.Setenv(envGitHubAppAPIBaseURL, api.URL)

	svc := NewGitHubImportService(nil, nil, testGitHubImportTokenDB{}, &testGitHubImportRepoHost{}, testGitHubImportDecrypter{}, "https://smithers.test", WithGitHubImportHTTPClient(api.Client()))

	token, private, defaultBranch, err := svc.githubCloneInfoForRepo(context.Background(), 7, "octo", "public-demo")
	require.NoError(t, err)
	assert.False(t, private)
	assert.Empty(t, token)
	assert.Equal(t, "trunk", defaultBranch)
	assert.Empty(t, authHeader)
}

func TestGitHubImportService_NonInteractiveGitEnvDisablesCredentialPrompts(t *testing.T) {
	t.Parallel()

	env := nonInteractiveGitEnv()
	assert.Contains(t, env, "GIT_TERMINAL_PROMPT=0")
	for _, entry := range env {
		assert.False(t, strings.HasPrefix(entry, "GIT_CONFIG_VALUE_0=Authorization: Bearer "), "source token must only be added for authenticated GitHub clones")
	}
}

func TestGitHubImportService_PrivateRepoUsesStoredOAuthToken(t *testing.T) {
	var authHeader string
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader = r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"private":        true,
			"default_branch": "main",
		})
	}))
	defer api.Close()
	t.Setenv(envGitHubAppAPIBaseURL, api.URL)

	svc := NewGitHubImportService(
		nil,
		nil,
		testGitHubImportTokenDB{accounts: []db.OauthAccount{{Provider: "github", AccessTokenEncrypted: []byte("encrypted")}}},
		&testGitHubImportRepoHost{},
		testGitHubImportDecrypter{token: "gho_private_token"},
		"https://smithers.test",
		WithGitHubImportHTTPClient(api.Client()),
	)

	token, private, defaultBranch, err := svc.githubCloneInfoForRepo(context.Background(), 7, "octo", "private-demo")
	require.NoError(t, err)
	assert.True(t, private)
	assert.Equal(t, "gho_private_token", token)
	assert.Equal(t, "main", defaultBranch)
	assert.Equal(t, "Bearer gho_private_token", authHeader)
}

// TestGitHubImportService_RefreshesExpiredTokenOnce covers the import-path half
// of the bug fix: a rejected stored token is refreshed once and the repo probe
// retried with the rotated token, so private-repo imports survive the ~8h
// GitHub App access-token expiry.
func TestGitHubImportService_RefreshesExpiredTokenOnce(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Bearer gho_new" {
			_ = json.NewEncoder(w).Encode(map[string]any{"private": true, "default_branch": "main"})
			return
		}
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer api.Close()
	t.Setenv(envGitHubAppAPIBaseURL, api.URL)

	refresher := &fakeGitHubTokenRefresher{newToken: "gho_new"}
	svc := NewGitHubImportService(
		nil,
		nil,
		testGitHubImportTokenDB{accounts: []db.OauthAccount{{Provider: "github", AccessTokenEncrypted: []byte("encrypted")}}},
		&testGitHubImportRepoHost{},
		testGitHubImportDecrypter{token: "gho_old"},
		"https://smithers.test",
		WithGitHubImportHTTPClient(api.Client()),
		WithGitHubImportTokenRefresher(refresher),
	)

	token, private, defaultBranch, err := svc.githubCloneInfoForRepo(context.Background(), 7, "octo", "private-demo")
	require.NoError(t, err)
	assert.True(t, private)
	assert.Equal(t, "gho_new", token, "the clone uses the rotated token")
	assert.Equal(t, "main", defaultBranch)
	assert.Equal(t, 1, refresher.callCount(), "the expired token is refreshed exactly once")
	assert.Equal(t, "github", refresher.account().Provider, "the selected oauth account is handed to the refresher")
}

// TestGitHubImportService_RefreshFailureSurfacesCredentialGone verifies the
// import path keeps today's honest 401 when the refresh cannot succeed.
func TestGitHubImportService_RefreshFailureSurfacesCredentialGone(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer api.Close()
	t.Setenv(envGitHubAppAPIBaseURL, api.URL)

	refresher := &fakeGitHubTokenRefresher{err: fmt.Errorf("no refresh token stored")}
	svc := NewGitHubImportService(
		nil,
		nil,
		testGitHubImportTokenDB{accounts: []db.OauthAccount{{Provider: "github", AccessTokenEncrypted: []byte("encrypted")}}},
		&testGitHubImportRepoHost{},
		testGitHubImportDecrypter{token: "gho_old"},
		"https://smithers.test",
		WithGitHubImportHTTPClient(api.Client()),
		WithGitHubImportTokenRefresher(refresher),
	)

	_, _, _, err := svc.githubCloneInfoForRepo(context.Background(), 7, "octo", "private-demo")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "github oauth token was rejected")
	assert.Equal(t, 1, refresher.callCount(), "exactly one refresh is attempted before the 401 surfaces")
}

func TestGitHubImportService_ClassifiesForbiddenRateLimitsAsRetryable(t *testing.T) {
	tests := []struct {
		status         int
		name           string
		header         http.Header
		wantRateLimit  bool
		wantRetryAfter int
	}{
		{
			name:           "429 retry after",
			status:         http.StatusTooManyRequests,
			header:         http.Header{"Retry-After": []string{"3600"}},
			wantRateLimit:  true,
			wantRetryAfter: 3600,
		},
		{
			name:           "primary reset",
			header:         http.Header{"X-RateLimit-Remaining": []string{"0"}, "X-RateLimit-Reset": []string{strconv.FormatInt(time.Now().Add(time.Hour).Unix(), 10)}},
			wantRateLimit:  true,
			wantRetryAfter: 3590,
		},
		{
			name:           "retry after",
			header:         http.Header{"Retry-After": []string{"17"}},
			wantRateLimit:  true,
			wantRetryAfter: 17,
		},
		{
			name:          "primary limit exhausted",
			header:        http.Header{"X-RateLimit-Remaining": []string{"0"}},
			wantRateLimit: true,
		},
		{
			name:   "access denied",
			header: http.Header{"X-RateLimit-Remaining": []string{"42"}},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				for name, values := range tt.header {
					for _, value := range values {
						w.Header().Add(name, value)
					}
				}
				if tt.status != 0 {
					w.WriteHeader(tt.status)
				} else {
					w.WriteHeader(http.StatusForbidden)
				}
			}))
			defer api.Close()
			t.Setenv(envGitHubAppAPIBaseURL, api.URL)

			refresher := &fakeGitHubTokenRefresher{newToken: "must-not-be-used"}
			svc := NewGitHubImportService(
				nil,
				nil,
				testGitHubImportTokenDB{accounts: []db.OauthAccount{{Provider: "github", AccessTokenEncrypted: []byte("encrypted")}}},
				&testGitHubImportRepoHost{},
				testGitHubImportDecrypter{token: "gho_token"},
				"https://smithers.test",
				WithGitHubImportHTTPClient(api.Client()),
				WithGitHubImportTokenRefresher(refresher),
			)

			_, _, _, err := svc.githubCloneInfoForRepo(context.Background(), 7, "octo", "private-demo")
			require.Error(t, err)

			var apiErr *pkgerrors.APIError
			require.ErrorAs(t, err, &apiErr)
			assert.Equal(t, 0, refresher.callCount(), "403 responses must never rotate the GitHub token")
			if tt.wantRateLimit {
				assert.Equal(t, http.StatusTooManyRequests, apiErr.Status)
				assert.Equal(t, pkgerrors.CodeRateLimitExceeded, apiErr.Code)
				assert.GreaterOrEqual(t, apiErr.RetryAfter, tt.wantRetryAfter)
				assert.GreaterOrEqual(t, githubImportRetryDelaySeconds(err), int32(tt.wantRetryAfter))
				assert.False(t, isTerminalGitHubImportFailure(err))
				return
			}
			assert.Equal(t, http.StatusForbidden, apiErr.Status)
			// This refusal has no code of its own yet, so it carries the
			// generic one for its status rather than reaching a client with
			// no verdict at all.
			assert.Equal(t, pkgerrors.CodeForbidden, apiErr.Code)
			assert.True(t, isTerminalGitHubImportFailure(err))
		})
	}
}

func TestGitHubImportService_ImportedBookmarkTargetResolvesChangeID(t *testing.T) {
	svc := &GitHubImportService{repoHost: &testGitHubImportRepoHost{bookmarks: []repohost.Bookmark{
		{Name: "main", TargetChangeID: "zz-main"},
		{Name: "feature", TargetChangeID: "zz-feature"},
	}}}

	target, err := svc.importedBookmarkTarget(context.Background(), "octo", "demo", "main")
	require.NoError(t, err)
	assert.Equal(t, "zz-main", target)
}

// pagedGitHubImportRepoHost slices a flat bookmark list by the caller's offset
// cursor and limit, and synthesizes the next cursor as offset+limit exactly
// like the real repohost client does (the server never returns next_cursor).
// Recording cursors AND limits lets tests pin both halves of the contract: the
// service must echo server cursors verbatim, and must never ask for more than
// the production router's per_page cap of 100 (above that the server 400s).
type pagedGitHubImportRepoHost struct {
	testGitHubImportRepoHost
	items       []repohost.Bookmark
	seenCursors []string
	seenLimits  []int
}

func (t *pagedGitHubImportRepoHost) ListBookmarks(_ context.Context, _, _ string, cursor string, limit int) ([]repohost.Bookmark, string, error) {
	t.seenCursors = append(t.seenCursors, cursor)
	t.seenLimits = append(t.seenLimits, limit)
	offset := 0
	if cursor != "" {
		parsed, err := strconv.Atoi(cursor)
		if err != nil {
			return nil, "", err
		}
		offset = parsed
	}
	if offset >= len(t.items) || limit <= 0 {
		return nil, "", nil
	}
	end := min(offset+limit, len(t.items))
	next := ""
	if end < len(t.items) {
		next = strconv.Itoa(end)
	}
	return t.items[offset:end], next, nil
}

// mirroredBookmarkFixture reproduces the production shape that broke imports:
// 228 bookmarks with "main" at sorted index 190, behind pages of codex/*
// branches.
func mirroredBookmarkFixture() []repohost.Bookmark {
	items := make([]repohost.Bookmark, 0, 228)
	for i := range 190 {
		items = append(items, repohost.Bookmark{
			Name:           fmt.Sprintf("codex/branch-%03d", i),
			TargetChangeID: fmt.Sprintf("c-%03d", i),
		})
	}
	items = append(items, repohost.Bookmark{Name: "main", TargetChangeID: "c-main"})
	for i := range 37 {
		items = append(items, repohost.Bookmark{
			Name:           fmt.Sprintf("wip/branch-%03d", i),
			TargetChangeID: fmt.Sprintf("w-%03d", i),
		})
	}
	return items
}

func TestGitHubImportService_ImportedBookmarkTargetFollowsPagination(t *testing.T) {
	// Regression: a mirrored repo with >100 bookmarks put "main" past the
	// first page and the import failed with "imported bookmark not found".
	repoHost := &pagedGitHubImportRepoHost{items: mirroredBookmarkFixture()}
	svc := &GitHubImportService{repoHost: repoHost}

	target, err := svc.importedBookmarkTarget(context.Background(), "octo", "demo", "main")
	require.NoError(t, err)
	assert.Equal(t, "c-main", target)
	// The service must echo the server's offset cursors verbatim and stop on
	// the page that contains the bookmark (index 190 → second page of 100).
	assert.Equal(t, []string{"", "100"}, repoHost.seenCursors)
	for _, limit := range repoHost.seenLimits {
		assert.Equal(t, 100, limit, "limit must stay at the repo-host per_page cap; larger values 400 in production")
	}
}

func TestGitHubImportService_ImportedBookmarkTargetMissingAfterAllPages(t *testing.T) {
	items := mirroredBookmarkFixture()
	// Drop "main"; the walk must visit all three pages, then report not found.
	items = append(items[:190], items[191:]...)
	repoHost := &pagedGitHubImportRepoHost{items: items}
	svc := &GitHubImportService{repoHost: repoHost}

	_, err := svc.importedBookmarkTarget(context.Background(), "octo", "demo", "main")
	require.ErrorContains(t, err, "imported bookmark not found")
	assert.Equal(t, []string{"", "100", "200"}, repoHost.seenCursors)
}

// The regression crossed the service/client boundary: the service discarded
// the cursor AND only the client-side synthesized offset cursor (the server
// never returns next_cursor) makes page 2 reachable at all. Wire the REAL
// repohost client against a paging server to pin the whole path.
func TestGitHubImportService_ImportedBookmarkTargetWalksRealClientPagination(t *testing.T) {
	items := mirroredBookmarkFixture()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		perPage, _ := strconv.Atoi(r.URL.Query().Get("per_page"))
		// Mirror the production router: per_page above 100 is a 400.
		if page < 1 || perPage < 1 || perPage > 100 {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		start := min((page-1)*perPage, len(items))
		end := min(start+perPage, len(items))
		out := make([]map[string]any, 0, end-start)
		for _, b := range items[start:end] {
			out = append(out, map[string]any{"name": b.Name, "target_change_id": b.TargetChangeID})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"items": out, "total_count": int64(len(items))})
	}))
	t.Cleanup(server.Close)

	client := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: server.URL}, "test-token")
	svc := &GitHubImportService{repoHost: client}

	target, err := svc.importedBookmarkTarget(context.Background(), "octo", "demo", "main")
	require.NoError(t, err)
	assert.Equal(t, "c-main", target)
}

// stuckCursorGitHubImportRepoHost always returns the same non-empty cursor, as
// a misbehaving server might; the lookup must terminate rather than spin.
type stuckCursorGitHubImportRepoHost struct {
	testGitHubImportRepoHost
	calls int
}

func (t *stuckCursorGitHubImportRepoHost) ListBookmarks(context.Context, string, string, string, int) ([]repohost.Bookmark, string, error) {
	t.calls++
	return []repohost.Bookmark{{Name: "feat/a", TargetChangeID: "c-a"}}, "stuck", nil
}

func TestGitHubImportService_ImportedBookmarkTargetStuckCursorTerminates(t *testing.T) {
	repoHost := &stuckCursorGitHubImportRepoHost{}
	svc := &GitHubImportService{repoHost: repoHost}

	_, err := svc.importedBookmarkTarget(context.Background(), "octo", "demo", "main")
	require.ErrorContains(t, err, "imported bookmark not found")
	assert.Equal(t, 2, repoHost.calls)
}

func TestGitHubImportService_PublicRepoImportsAndBindingRoundTrips(t *testing.T) {
	var authHeader string
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader = r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"private":        false,
			"default_branch": "trunk",
		})
	}))
	defer api.Close()
	t.Setenv(envGitHubAppAPIBaseURL, api.URL)

	repoHost := &testGitHubImportRepoHost{bookmarks: []repohost.Bookmark{{Name: "trunk", TargetChangeID: "change-trunk"}}}
	provisioner := &testGitHubImportWorkspaceProvisioner{
		resp: WorkspaceResponse{
			ID:             "11111111-1111-1111-1111-111111111111",
			RepositoryID:   42,
			UserID:         7,
			TargetBookmark: "landing/public-demo",
			Status:         "running",
		},
	}
	var cloneSourceToken string
	svc := NewGitHubImportService(
		nil,
		testGitHubImportRepoDB{},
		testGitHubImportTokenDB{},
		repoHost,
		testGitHubImportDecrypter{},
		"https://smithers.test",
		WithGitHubImportHTTPClient(api.Client()),
		WithGitHubImportWorkspaceProvisioner(provisioner),
		withGitHubImportCloneMirror(func(_ context.Context, _, _, sourceToken, pushURL, pushToken, _ string) error {
			cloneSourceToken = sourceToken
			if pushURL == "" {
				return errors.New("missing push url")
			}
			// The push token must be delivered out-of-band, never embedded in
			// the push URL (which would leak it to /proc via git's argv).
			require.NotEmpty(t, pushToken, "push token must be delivered separately")
			assert.NotContains(t, pushURL, "@", "push URL must carry no userinfo credentials")
			assert.NotContains(t, pushURL, pushToken, "push URL must not embed the push token")
			return nil
		}),
	)

	// localOwner ("importer") is the importing user's jjhub namespace; the github
	// source owner ("octo") differs. The fix requires every repo-host op + the
	// workspace to key on localOwner so the storage-set resolver finds the repo
	// that was created under the user.
	repository, workspace, err := svc.runImport(context.Background(), 7, "octo", "public-demo", "importer", "landing/public-demo", "job-public")
	require.NoError(t, err)
	assert.Equal(t, int64(42), repository.ID)
	assert.Empty(t, authHeader)
	assert.Empty(t, cloneSourceToken, "public repos must clone anonymously")
	require.True(t, repoHost.createdBookmarkOK)
	assert.Equal(t, repohost.CreateBookmarkRequest{Name: "landing/public-demo", TargetChangeID: "change-trunk", IfAbsent: true}, repoHost.createdBookmark)
	assert.Equal(t, "landing/public-demo", provisioner.input.SourceBookmark)
	assert.Equal(t, "landing/public-demo", workspace.TargetBookmark)
	assert.Equal(t, "11111111-1111-1111-1111-111111111111", workspace.ID)
	// repo-host + workspace must use the local owner, never the github source.
	assert.Equal(t, "importer", repoHost.importRefsOwner, "ImportRefs must use the local owner, not the github source owner")
	assert.Equal(t, "importer", provisioner.input.RepoOwner, "workspace must bind under the local owner")
}

func TestGitHubImportService_RunImportConflictsBeforeMirrorPushWhenLocalRepoExists(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"private":        false,
			"default_branch": "main",
		})
	}))
	defer api.Close()
	t.Setenv(envGitHubAppAPIBaseURL, api.URL)

	existing := db.Repository{ID: 99, Name: "demo", LowerName: "demo", DefaultBookmark: "main"}
	cloneCalled := false
	svc := NewGitHubImportService(
		nil,
		testGitHubImportRepoDB{existing: &existing},
		testGitHubImportTokenDB{},
		&testGitHubImportRepoHost{},
		testGitHubImportDecrypter{},
		"https://smithers.test",
		WithGitHubImportHTTPClient(api.Client()),
		withGitHubImportCloneMirror(func(context.Context, string, string, string, string, string, string) error {
			cloneCalled = true
			return nil
		}),
	)

	_, _, err := svc.runImport(context.Background(), 7, "octo", "demo", "alice", "main", "job-conflict")
	require.ErrorContains(t, err, "repository 'demo' already exists")
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, http.StatusConflict, apiErr.Status)
	assert.False(t, cloneCalled, "existing local repositories must not be mirror-pushed over")
}

// TestGitHubImportService_RunImportReusesMirrorWhenProvenanceMatches pins the
// reopen flow behind the prod toast bug (2026-07-13): the multi client POSTs
// /api/github/import on every repo pick, so re-picking an already-imported repo
// must REUSE the existing mirror — proceed to ready WITHOUT cloning or
// re-importing refs over repo-host storage (the #47 security property), and
// WITHOUT re-creating a branch bookmark that already exists (repo-host
// CreateBookmark MOVES an existing bookmark, clobbering committed user work on
// reopen). Currently ensureLocalRepo returns an unconditional 409, so this fails.
func TestGitHubImportService_RunImportReusesMirrorWhenProvenanceMatches(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"private":        false,
			"default_branch": "main",
		})
	}))
	defer api.Close()
	t.Setenv(envGitHubAppAPIBaseURL, api.URL)

	existing := db.Repository{ID: 99, Name: "smithers", LowerName: "smithers", DefaultBookmark: "main"}
	// The requested branch bookmark ("main") already exists in the mirror, so
	// the reuse path must NOT re-create (move) it.
	repoHost := &testGitHubImportRepoHost{bookmarks: []repohost.Bookmark{{Name: "main", TargetChangeID: "c-main"}}}
	provisioner := &testGitHubImportWorkspaceProvisioner{
		resp: WorkspaceResponse{
			ID:             "11111111-1111-1111-1111-111111111111",
			RepositoryID:   99,
			UserID:         7,
			TargetBookmark: "main",
			Status:         "running",
		},
	}
	cloneCalled := false
	svc := NewGitHubImportService(
		&stageRecordingDB{},
		testGitHubImportRepoDB{existing: &existing},
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
		// Provenance proves the existing local repo IS the mirror of octo/smithers.
		withGitHubImportProvenance(func(_ context.Context, _ int64, _, _ string, repositoryID int64) (bool, error) {
			assert.Equal(t, int64(99), repositoryID, "provenance check must key on the existing repo's ID")
			return true, nil
		}),
	)
	// White-box the git seam so the reuse-path refresh runs no real git/network.
	svc.runGit = func(context.Context, []string, ...string) (string, error) { return "", nil }
	svc.mkdirTemp = func(string, string) (string, error) { return t.TempDir(), nil }

	repository, workspace, err := svc.runImport(context.Background(), 7, "smithersai", "smithers", "importer", "main", "job-reuse")
	require.NoError(t, err, "re-import with provenance must reuse the mirror, not 409")
	assert.Equal(t, int64(99), repository.ID, "reuse must return the existing repo row")
	assert.False(t, cloneCalled, "reuse must NOT use the fresh --mirror clone path over existing repo-host storage (#47)")
	assert.Equal(t, "importer", repoHost.importRefsOwner, "reuse now refreshes: ImportRefs re-imports the refreshed git refs into jj")
	assert.False(t, repoHost.createdBookmarkOK, "an already-present branch bookmark must not be re-created/moved")
	assert.Equal(t, "11111111-1111-1111-1111-111111111111", workspace.ID, "reuse still provisions the bound workspace")
}

// TestGitHubImportService_RunImportReuseCreatesMissingBranchBookmark covers the
// other half of the reuse guard: when the requested branch bookmark is NOT
// already present, the reuse path must create it (pointing at the default
// branch's resolved change) rather than skip it.
func TestGitHubImportService_RunImportReuseCreatesMissingBranchBookmark(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"private":        false,
			"default_branch": "main",
		})
	}))
	defer api.Close()
	t.Setenv(envGitHubAppAPIBaseURL, api.URL)

	existing := db.Repository{ID: 99, Name: "smithers", LowerName: "smithers", DefaultBookmark: "main"}
	// Only the default branch exists; the requested "feature-x" bookmark is absent.
	repoHost := &testGitHubImportRepoHost{bookmarks: []repohost.Bookmark{{Name: "main", TargetChangeID: "c-main"}}}
	provisioner := &testGitHubImportWorkspaceProvisioner{
		resp: WorkspaceResponse{
			ID:             "22222222-2222-2222-2222-222222222222",
			RepositoryID:   99,
			UserID:         7,
			TargetBookmark: "feature-x",
			Status:         "running",
		},
	}
	cloneCalled := false
	svc := NewGitHubImportService(
		&stageRecordingDB{},
		testGitHubImportRepoDB{existing: &existing},
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
		withGitHubImportProvenance(func(context.Context, int64, string, string, int64) (bool, error) {
			return true, nil
		}),
	)
	// White-box the git seam so the reuse-path refresh runs no real git/network.
	svc.runGit = func(context.Context, []string, ...string) (string, error) { return "", nil }
	svc.mkdirTemp = func(string, string) (string, error) { return t.TempDir(), nil }

	repository, _, err := svc.runImport(context.Background(), 7, "smithersai", "smithers", "importer", "feature-x", "job-reuse-new-branch")
	require.NoError(t, err, "re-import with provenance must reuse the mirror, not 409")
	assert.Equal(t, int64(99), repository.ID)
	assert.False(t, cloneCalled, "reuse must NOT use the fresh --mirror clone path over existing storage (#47)")
	assert.Equal(t, "importer", repoHost.importRefsOwner, "reuse now refreshes: ImportRefs re-imports the refreshed git refs")
	require.True(t, repoHost.createdBookmarkOK, "a missing requested branch bookmark must be created on reuse")
	assert.Equal(t, "feature-x", repoHost.createdBookmark.Name)
	assert.Equal(t, "c-main", repoHost.createdBookmark.TargetChangeID, "the new branch points at the resolved default-branch change")
}

// TestGitHubImportService_RunImportConflictsWhenProvenanceAbsent pins the
// #47 conflict path: an existing same-name repo WITHOUT provenance must still
// 409 rather than clone over it. (Passes today; a guard so the reuse fix does
// not weaken the security property.)
func TestGitHubImportService_RunImportConflictsWhenProvenanceAbsent(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"private":        false,
			"default_branch": "main",
		})
	}))
	defer api.Close()
	t.Setenv(envGitHubAppAPIBaseURL, api.URL)

	existing := db.Repository{ID: 99, Name: "smithers", LowerName: "smithers", DefaultBookmark: "main"}
	cloneCalled := false
	svc := NewGitHubImportService(
		&stageRecordingDB{},
		testGitHubImportRepoDB{existing: &existing},
		testGitHubImportTokenDB{},
		&testGitHubImportRepoHost{},
		testGitHubImportDecrypter{},
		"https://smithers.test",
		WithGitHubImportHTTPClient(api.Client()),
		withGitHubImportCloneMirror(func(context.Context, string, string, string, string, string, string) error {
			cloneCalled = true
			return nil
		}),
		withGitHubImportProvenance(func(context.Context, int64, string, string, int64) (bool, error) {
			return false, nil
		}),
	)

	_, _, err := svc.runImport(context.Background(), 7, "smithersai", "smithers", "importer", "main", "job-no-provenance")
	require.ErrorContains(t, err, "repository 'smithers' already exists")
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, http.StatusConflict, apiErr.Status)
	assert.False(t, cloneCalled, "an unprovenanced same-name repo must never be mirror-pushed over")
}

// TestGitHubImportService_RunImportConflictsWhenOnlyDescriptionMarkerMatches
// pins REQUIRED CHANGE A: the "Imported from github.com/<owner>/<repo>"
// Description marker must NOT be sufficient provenance on its own — it also
// matches a FRESH import that failed after ensureLocalRepo stamped it but
// before the import_jobs row ever went status='ready'. When the strong
// provenance seam returns FALSE (no ready import job), an existing same-name
// repo carrying only the marker must still 409 (#47), NOT take the reuse path.
// Fails on current code: mirrorProvenanceMatches accepts the marker fallback,
// so runImport reuses the (possibly-empty) mirror instead of conflicting.
func TestGitHubImportService_RunImportConflictsWhenOnlyDescriptionMarkerMatches(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"private":        false,
			"default_branch": "main",
		})
	}))
	defer api.Close()
	t.Setenv(envGitHubAppAPIBaseURL, api.URL)

	// The description marker is exactly what ensureLocalRepo stamps for a
	// github.com/octo/demo import, so the weak fallback matches it today.
	existing := db.Repository{ID: 99, Name: "demo", LowerName: "demo", DefaultBookmark: "main", Description: "Imported from github.com/octo/demo"}
	// Give the reuse path everything it would need to SUCCEED, so the failure is
	// crisp: on current code runImport returns nil (reused) instead of the 409.
	repoHost := &testGitHubImportRepoHost{bookmarks: []repohost.Bookmark{{Name: "main", TargetChangeID: "c-main"}}}
	provisioner := &testGitHubImportWorkspaceProvisioner{
		resp: WorkspaceResponse{
			ID:             "11111111-1111-1111-1111-111111111111",
			RepositoryID:   99,
			UserID:         7,
			TargetBookmark: "main",
			Status:         "running",
		},
	}
	cloneCalled := false
	svc := NewGitHubImportService(
		&stageRecordingDB{},
		testGitHubImportRepoDB{existing: &existing},
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
		// No status='ready' import job exists (the first import FAILED), so the
		// strong provenance signal is absent.
		withGitHubImportProvenance(func(context.Context, int64, string, string, int64) (bool, error) {
			return false, nil
		}),
	)

	_, _, err := svc.runImport(context.Background(), 7, "octo", "demo", "alice", "main", "job-marker-only")
	require.ErrorContains(t, err, "repository 'demo' already exists")
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, http.StatusConflict, apiErr.Status)
	assert.False(t, cloneCalled, "the description marker alone must not trigger the reuse path")
}

// TestGitHubImportService_RunImportCleansUpCreatedRepoWhenBookmarkResolveFails
// pins REQUIRED CHANGE B for the exact prod failure: a FRESH import of an empty
// GitHub repo creates the local repo row + storage, then fails at
// importedBookmarkTarget ("imported bookmark not found") because there is no
// default-branch bookmark. runImport must compensate by deleting the created
// repo (like the InitRepo-failure path) so the next retry starts clean.
// Regression guard: storage and the DB row must both be removed.
func TestGitHubImportService_RunImportCleansUpCreatedRepoWhenBookmarkResolveFails(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"private":        false,
			"default_branch": "main",
		})
	}))
	defer api.Close()
	t.Setenv(envGitHubAppAPIBaseURL, api.URL)

	deleted := &[]int64{}
	// Empty source → the mirror carries no "main" bookmark, so
	// importedBookmarkTarget fails after the fresh repo was created.
	repoHost := &testGitHubImportRepoHost{}
	svc := NewGitHubImportService(
		&stageRecordingDB{},
		testGitHubImportRepoDB{deleted: deleted},
		testGitHubImportTokenDB{},
		repoHost,
		testGitHubImportDecrypter{},
		"https://smithers.test",
		WithGitHubImportHTTPClient(api.Client()),
		withGitHubImportCloneMirror(func(context.Context, string, string, string, string, string, string) error {
			return nil
		}),
	)

	_, _, err := svc.runImport(context.Background(), 7, "octo", "demo", "importer", "main", "job-empty-source")
	require.ErrorContains(t, err, "imported bookmark not found")
	require.Contains(t, repoHost.deletedRepos, "importer/demo", "repo-host storage must be deleted before the DB row")
	require.Contains(t, *deleted, int64(42), "a fresh import that fails at bookmark resolution must delete the repo it created")
}

// TestGitHubImportService_RunImportCleansUpCreatedRepoWhenCloneFails pins the
// same REQUIRED CHANGE B cleanup for an earlier stage: a fresh import whose
// cloneMirror fails must also delete the repo row it created.
// Regression guard: clone failure must remove storage and the DB row.
func TestGitHubImportService_RunImportCleansUpCreatedRepoWhenCloneFails(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"private":        false,
			"default_branch": "main",
		})
	}))
	defer api.Close()
	t.Setenv(envGitHubAppAPIBaseURL, api.URL)

	deleted := &[]int64{}
	repoHost := &testGitHubImportRepoHost{}
	svc := NewGitHubImportService(
		&stageRecordingDB{},
		testGitHubImportRepoDB{deleted: deleted},
		testGitHubImportTokenDB{},
		repoHost,
		testGitHubImportDecrypter{},
		"https://smithers.test",
		WithGitHubImportHTTPClient(api.Client()),
		withGitHubImportCloneMirror(func(context.Context, string, string, string, string, string, string) error {
			return errors.New("clone github repo: boom")
		}),
	)

	_, _, err := svc.runImport(context.Background(), 7, "octo", "demo", "importer", "main", "job-clone-fail")
	require.Error(t, err)
	require.Contains(t, repoHost.deletedRepos, "importer/demo")
	require.Contains(t, *deleted, int64(42), "a fresh import that fails at clone must delete the repo it created")
}

func TestGitHubImportService_RollbackFreshImportPreservesRowWhenStorageCleanupFails(t *testing.T) {
	deleted := &[]int64{}
	repoHost := &testGitHubImportRepoHost{deleteRepoErr: errors.New("repo-host unavailable")}
	svc := NewGitHubImportService(
		nil,
		testGitHubImportRepoDB{deleted: deleted},
		testGitHubImportTokenDB{},
		repoHost,
		testGitHubImportDecrypter{},
		"https://smithers.test",
	)

	svc.rollbackFreshImportRepo(context.Background(), 42, "importer", "demo")

	require.Contains(t, repoHost.deletedRepos, "importer/demo", "storage cleanup must be attempted first")
	require.Empty(t, *deleted, "the DB row must remain while repo-host still needs it to resolve storage")
}

// TestGitHubImportService_RunImportReuseFailureDoesNotDeleteExistingRepo guards
// REQUIRED CHANGE B's boundary: on the REUSE path the repo predates this run, so
// a later failure (here bookmark resolution) must NEVER delete it. Passes on
// current code (nothing is ever deleted) and must stay green after the fix so
// cleanup is scoped strictly to repos this run created.
func TestGitHubImportService_RunImportReuseFailureDoesNotDeleteExistingRepo(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"private":        false,
			"default_branch": "main",
		})
	}))
	defer api.Close()
	t.Setenv(envGitHubAppAPIBaseURL, api.URL)

	deleted := &[]int64{}
	existing := db.Repository{ID: 99, Name: "smithers", LowerName: "smithers", DefaultBookmark: "main"}
	// No bookmarks → the reuse path fails at importedBookmarkTarget.
	repoHost := &testGitHubImportRepoHost{}
	svc := NewGitHubImportService(
		&stageRecordingDB{},
		testGitHubImportRepoDB{existing: &existing, deleted: deleted},
		testGitHubImportTokenDB{},
		repoHost,
		testGitHubImportDecrypter{},
		"https://smithers.test",
		WithGitHubImportHTTPClient(api.Client()),
		withGitHubImportCloneMirror(func(context.Context, string, string, string, string, string, string) error {
			return nil
		}),
		withGitHubImportProvenance(func(context.Context, int64, string, string, int64) (bool, error) {
			return true, nil
		}),
	)
	// White-box the git seam so the reuse-path refresh runs no real git/network.
	svc.runGit = func(context.Context, []string, ...string) (string, error) { return "", nil }
	svc.mkdirTemp = func(string, string) (string, error) { return t.TempDir(), nil }

	_, _, err := svc.runImport(context.Background(), 7, "smithersai", "smithers", "importer", "main", "job-reuse-fail")
	require.Error(t, err)
	assert.NotContains(t, *deleted, int64(99), "the reuse path must never delete a pre-existing mirror")
	assert.Empty(t, *deleted, "no repo may be deleted on the reuse path")
}

// stageRecordingDB answers only the setStage UPDATE, recording each stage in
// order; every other statement is unexpected in the direct-runImport tests.
type stageRecordingDB struct {
	stages []string
	// ledger records the mirror refresh ledger statements, each granted.
	ledger []string
}

type stageIDRow struct{ err error }

func (r stageIDRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	if len(dest) == 1 {
		if id, ok := dest[0].(*string); ok {
			*id = "job"
		}
	}
	return nil
}

func (d *stageRecordingDB) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	if sql == setImportJobStageSQL && len(args) == 2 {
		if stage, ok := args[1].(string); ok {
			d.stages = append(d.stages, stage)
			return stageIDRow{}
		}
	}
	switch sql {
	case claimGitHubMirrorRefreshSQL, completeGitHubMirrorRefreshSQL, releaseGitHubMirrorRefreshSQL, recordGitHubMirrorClonedSQL:
		d.ledger = append(d.ledger, sql)
		return stageIDRow{}
	}
	return stageIDRow{err: fmt.Errorf("unexpected statement: %s", sql)}
}

func TestGitHubImportService_RunImportRecordsProgressStages(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"private": false, "default_branch": "trunk"})
	}))
	defer api.Close()
	t.Setenv(envGitHubAppAPIBaseURL, api.URL)

	repoHost := &testGitHubImportRepoHost{bookmarks: []repohost.Bookmark{{Name: "trunk", TargetChangeID: "change-trunk"}}}
	provisioner := &testGitHubImportWorkspaceProvisioner{
		resp: WorkspaceResponse{
			ID:             "11111111-1111-1111-1111-111111111111",
			RepositoryID:   42,
			UserID:         7,
			TargetBookmark: "landing/demo",
			Status:         "running",
		},
	}
	recorder := &stageRecordingDB{}
	svc := NewGitHubImportService(
		recorder,
		testGitHubImportRepoDB{},
		testGitHubImportTokenDB{},
		repoHost,
		testGitHubImportDecrypter{},
		"https://smithers.test",
		WithGitHubImportHTTPClient(api.Client()),
		WithGitHubImportWorkspaceProvisioner(provisioner),
		withGitHubImportCloneMirror(func(context.Context, string, string, string, string, string, string) error { return nil }),
	)

	_, _, err := svc.runImport(context.Background(), 7, "octo", "demo", "importer", "landing/demo", "job-stages")
	require.NoError(t, err)
	// pushing_mirror is written inside the real cloneAndPushMirror (replaced
	// here), so the direct-runImport progression skips it.
	assert.Equal(t, []string{
		importStageResolving,
		importStageCreatingRepo,
		importStageCloningGitHub,
		importStageImportingRefs,
		importStageCreatingBookmark,
		importStageProvisioningWorkspace,
	}, recorder.stages)
}

func TestGitHubImportService_CreateBoundWorkspacePersistsTargetBookmark(t *testing.T) {
	provisioner := &testGitHubImportWorkspaceProvisioner{
		resp: WorkspaceResponse{
			ID:             "11111111-1111-1111-1111-111111111111",
			RepositoryID:   42,
			UserID:         7,
			TargetBookmark: "landing/demo-123",
			Status:         "running",
		},
	}
	svc := &GitHubImportService{workspaces: provisioner}

	workspace, err := svc.createBoundWorkspace(context.Background(), 7, db.Repository{ID: 42}, "octo", "demo", "landing/demo-123")
	require.NoError(t, err)
	assert.Equal(t, "landing/demo-123", workspace.TargetBookmark)
	assert.Equal(t, int64(42), provisioner.input.RepositoryID)
	assert.Equal(t, int64(7), provisioner.input.UserID)
	assert.Equal(t, "octo", provisioner.input.RepoOwner)
	assert.Equal(t, "demo", provisioner.input.RepoName)
	assert.Equal(t, "landing/demo-123", provisioner.input.Name)
	assert.Equal(t, "landing/demo-123", provisioner.input.SourceBookmark)
}

func TestWorkspaceResponseIncludesTargetBookmark(t *testing.T) {
	svc := NewWorkspaceService(nil)
	workspace := sampleDBWorkspace("ws-bound")
	workspace.TargetBookmark = "landing/demo-123"
	workspace.SuspendedAt = pgtype.Timestamptz{}

	resp := svc.toWorkspaceResponse(workspace)
	assert.Equal(t, "landing/demo-123", resp.TargetBookmark)
}

func TestGitBearerAuthEnv_KeepsTokenOffArgv(t *testing.T) {
	env := gitBearerAuthEnv("  gho_secret  ")
	assert.Equal(t, []string{
		"GIT_CONFIG_COUNT=1",
		"GIT_CONFIG_KEY_0=http.extraHeader",
		"GIT_CONFIG_VALUE_0=Authorization: Bearer gho_secret",
	}, env, "credential must be delivered via GIT_CONFIG_* env, trimmed")
}

func TestGitHubImportPlanLimitIsTerminal(t *testing.T) {
	limit := sandboxPlanLimitError(SandboxEntitlement{PlanKey: BillingPlanPro}, "concurrent_sandboxes", 3, BillingPlanMax, "sandbox limit")
	require.True(t, isTerminalGitHubImportFailure(fmt.Errorf("create bound workspace: %w", limit)))
	require.False(t, isTerminalGitHubImportFailure(pkgerrors.Internal("temporary upstream failure")))
}

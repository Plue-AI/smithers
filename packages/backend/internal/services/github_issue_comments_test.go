package services

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestGitHubIssueComments_LivePassthroughWhenNotEnrolled(t *testing.T) {
	var mu sync.Mutex
	var gotPath, gotQuery, gotAuth, gotAccept string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		gotPath, gotQuery, gotAuth, gotAccept = r.URL.Path, r.URL.RawQuery, r.Header.Get("Authorization"), r.Header.Get("Accept")
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"id":1,"body":"first"}]`))
	}))
	defer srv.Close()
	t.Setenv(envGitHubAppAPIBaseURL, srv.URL)

	service := NewGitHubUserReposService(newFakeGitHubUserReposDB(), fakeOAuthTokenDecrypter{token: "gho_user"})
	result, err := service.ListAuthenticatedUserGitHubIssueComments(
		context.Background(), 42, "octo", "widget", 7, mustParseQuery(t, "per_page=100"),
	)
	require.NoError(t, err)
	assert.JSONEq(t, `[{"id":1,"body":"first"}]`, string(result.Body))
	assert.Equal(t, GitHubRepoMetadataSourceLive, result.Source)

	mu.Lock()
	path, query, auth, accept := gotPath, gotQuery, gotAuth, gotAccept
	mu.Unlock()
	assert.Equal(t, "/repos/octo/widget/issues/7/comments", path)
	assert.Equal(t, "per_page=100", query)
	assert.Equal(t, "Bearer gho_user", auth)
	assert.Equal(t, "application/vnd.github+json", accept)
}

func TestGitHubIssueComments_ServesSyncedStoreWhenEnrolled(t *testing.T) {
	store := newFakeSyncedRepoStore()
	synced := NewGitHubSyncedRepoService(store)
	row, err := synced.EnrollGitHubRepo(context.Background(), EnrollGitHubRepoInput{
		Owner: "octo", Repo: "widget", EnrolledVia: GitHubSyncedRepoEnrolledViaImport,
	})
	require.NoError(t, err)
	require.NoError(t, store.MarkGitHubSyncedRepoSynced(context.Background(), row.ID))
	require.NoError(t, store.TouchGitHubSyncedRepoWebhook(context.Background(), row.ID))
	seedSyncedIssueComments(t, store, row.ID, 7, 1)
	require.NoError(t, store.UpsertGitHubSyncedIssueComment(context.Background(), db.UpsertGitHubSyncedIssueCommentParams{
		SyncedRepoID: row.ID,
		IssueNumber:  7,
		GithubID:     9001,
		Payload:      json.RawMessage(`{"id":9001,"body":"from the store"}`),
	}))

	// User 42's own credential read this repo live moments ago.
	require.NoError(t, synced.RecordReadGrant(context.Background(), 42, "octo", "widget"))

	// Any upstream hit is a test failure: the store must serve.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("store-servable comments read must not hit the live passthrough")
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	t.Setenv(envGitHubAppAPIBaseURL, srv.URL)

	service := NewGitHubUserReposService(
		newFakeGitHubUserReposDB(),
		fakeOAuthTokenDecrypter{token: "gho_user"},
		WithGitHubUserReposSyncedStore(synced),
	)
	result, err := service.ListAuthenticatedUserGitHubIssueComments(
		context.Background(), 42, "octo", "widget", 7, url.Values{},
	)
	require.NoError(t, err)
	assert.Equal(t, GitHubRepoMetadataSourceStore, result.Source)
	require.NotNil(t, result.SyncedAt)
	assert.JSONEq(t, `[{"id":9001,"body":"from the store"}]`, string(result.Body))
}

func TestGitHubIssueComments_SyncedPagination(t *testing.T) {
	store := newFakeSyncedRepoStore()
	synced := NewGitHubSyncedRepoService(store)
	row, err := synced.EnrollGitHubRepo(context.Background(), EnrollGitHubRepoInput{Owner: "octo", Repo: "widget"})
	require.NoError(t, err)
	require.NoError(t, store.MarkGitHubSyncedRepoSynced(context.Background(), row.ID))
	require.NoError(t, store.TouchGitHubSyncedRepoWebhook(context.Background(), row.ID))
	seedSyncedIssueComments(t, store, row.ID, 7, 3)
	for _, id := range []int64{1, 2, 3} {
		payload, err := json.Marshal(map[string]int64{"id": id})
		require.NoError(t, err)
		require.NoError(t, store.UpsertGitHubSyncedIssueComment(context.Background(), db.UpsertGitHubSyncedIssueCommentParams{
			SyncedRepoID: row.ID, IssueNumber: 7, GithubID: id, Payload: payload,
		}))
	}
	require.NoError(t, synced.RecordReadGrant(context.Background(), 42, "octo", "widget"))
	service := NewGitHubUserReposService(newFakeGitHubUserReposDB(), fakeOAuthTokenDecrypter{token: "gho_user"}, WithGitHubUserReposSyncedStore(synced))
	for _, tc := range []struct{ query, body, link string }{
		{"per_page=1", `[{"id":1}]`, `</api/user/github-repos/octo/widget/issues/7/comments?cursor=2&per_page=1>; rel="next"`},
		{"per_page=1&page=2", `[{"id":2}]`, `</api/user/github-repos/octo/widget/issues/7/comments?cursor=3&per_page=1>; rel="next"`},
		{"per_page=1&cursor=2", `[{"id":2}]`, `</api/user/github-repos/octo/widget/issues/7/comments?cursor=3&per_page=1>; rel="next"`},
		{"per_page=1&page=3", `[{"id":3}]`, ""},
		{"per_page=1&cursor=4", `[]`, ""},
	} {
		t.Run(tc.query, func(t *testing.T) {
			result, err := service.ListAuthenticatedUserGitHubIssueComments(context.Background(), 42, "octo", "widget", 7, mustParseQuery(t, tc.query))
			require.NoError(t, err)
			assert.Equal(t, GitHubRepoMetadataSourceStore, result.Source)
			assert.JSONEq(t, tc.body, string(result.Body))
			assert.Equal(t, tc.link, result.Link)
		})
	}
}

func TestGitHubIssueComments_NoWebhookHeartbeatGoesLive(t *testing.T) {
	// Enrolled and backfilled, but comments are webhook-populated only — a repo
	// with no webhook heartbeat yet cannot prove its comments store is complete.
	store := newFakeSyncedRepoStore()
	synced := NewGitHubSyncedRepoService(store)
	row, err := synced.EnrollGitHubRepo(context.Background(), EnrollGitHubRepoInput{
		Owner: "octo", Repo: "widget", EnrolledVia: GitHubSyncedRepoEnrolledViaLazy,
	})
	require.NoError(t, err)
	require.NoError(t, store.MarkGitHubSyncedRepoSynced(context.Background(), row.ID))

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"id":1,"body":"live"}]`))
	}))
	defer srv.Close()
	t.Setenv(envGitHubAppAPIBaseURL, srv.URL)

	service := NewGitHubUserReposService(
		newFakeGitHubUserReposDB(),
		fakeOAuthTokenDecrypter{token: "gho_user"},
		WithGitHubUserReposSyncedStore(synced),
	)
	result, err := service.ListAuthenticatedUserGitHubIssueComments(
		context.Background(), 42, "octo", "widget", 7, url.Values{},
	)
	require.NoError(t, err)
	assert.Equal(t, GitHubRepoMetadataSourceLive, result.Source)
	assert.JSONEq(t, `[{"id":1,"body":"live"}]`, string(result.Body))
}

func TestGitHubIssueComments_RejectsInvalidInput(t *testing.T) {
	service := NewGitHubUserReposService(newFakeGitHubUserReposDB(), fakeOAuthTokenDecrypter{token: "gho_user"})

	_, err := service.ListAuthenticatedUserGitHubIssueComments(context.Background(), 42, "octo", "widget", 0, url.Values{})
	require.Error(t, err)
	assert.Equal(t, http.StatusBadRequest, err.(*pkgerrors.APIError).Status)

	_, err = service.ListAuthenticatedUserGitHubIssueComments(
		context.Background(), 42, "octo", "widget", 7, mustParseQuery(t, "per_page=101"),
	)
	require.Error(t, err)
	assert.Equal(t, http.StatusBadRequest, err.(*pkgerrors.APIError).Status)

	_, err = service.ListAuthenticatedUserGitHubIssueComments(
		context.Background(), 42, "octo", "widget", 7, mustParseQuery(t, "labels=bug"),
	)
	require.Error(t, err)
	assert.Equal(t, http.StatusBadRequest, err.(*pkgerrors.APIError).Status)
}

func TestSyncedRepos_ServeCommentsRequiresWebhookHeartbeat(t *testing.T) {
	store := newFakeSyncedRepoStore()
	service := NewGitHubSyncedRepoService(store)

	_, served := service.ServeComments(context.Background(), testReadGrant("octo", "widget"), 7, nil, nil)
	assert.False(t, served, "an unenrolled repo must fall through to the live passthrough")

	row, err := service.EnrollGitHubRepo(context.Background(), EnrollGitHubRepoInput{Owner: "octo", Repo: "widget"})
	require.NoError(t, err)
	require.NoError(t, store.MarkGitHubSyncedRepoSynced(context.Background(), row.ID))

	_, served = service.ServeComments(context.Background(), testReadGrant("octo", "widget"), 7, nil, nil)
	assert.False(t, served, "no webhook heartbeat yet — the comments store may be incomplete")

	require.NoError(t, store.TouchGitHubSyncedRepoWebhook(context.Background(), row.ID))
	seedSyncedIssueComments(t, store, row.ID, 7, 1)
	require.NoError(t, store.UpsertGitHubSyncedIssueComment(context.Background(), db.UpsertGitHubSyncedIssueCommentParams{
		SyncedRepoID:    row.ID,
		IssueNumber:     7,
		GithubID:        9001,
		Payload:         json.RawMessage(`{"id":9001,"body":"hi"}`),
		GithubCreatedAt: pgtype.Timestamptz{Valid: false},
	}))

	page, served := service.ServeComments(context.Background(), testReadGrant("octo", "widget"), 7, nil, nil)
	require.True(t, served)
	assert.JSONEq(t, `[{"id":9001,"body":"hi"}]`, string(page.Body))

	// A heartbeat says nothing about an issue the store never loaded (#2405).
	_, served = service.ServeComments(context.Background(), testReadGrant("octo", "widget"), 99, nil, nil)
	assert.False(t, served, "an issue with no stored baseline must be read live")
}

// seedSyncedIssueComments stores issue number as advertising comments comments.
func seedSyncedIssueComments(t *testing.T, store GitHubSyncedRepoStore, repoID, number, comments int64) {
	t.Helper()
	payload, err := json.Marshal(map[string]any{"id": 1000 + number, "number": number, "state": "open", "comments": comments})
	require.NoError(t, err)
	require.NoError(t, store.UpsertGitHubSyncedIssue(context.Background(), db.UpsertGitHubSyncedIssueParams{
		SyncedRepoID: repoID, Resource: GitHubRepoMetadataIssues, Number: number, GithubID: 1000 + number,
		State: "open", Payload: payload,
	}))
}

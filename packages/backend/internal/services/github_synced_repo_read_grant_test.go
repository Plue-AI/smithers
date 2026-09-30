package services

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// privateRepoFixture is one private repo (acme/secret) that user A imported:
// enrolled, backfilled, webhook-fed, with an issue and a comment in the shared
// store. GitHub answers user A's token and refuses user B's with 404.
type privateRepoFixture struct {
	synced *GitHubSyncedRepoService
	mu     sync.Mutex
	auths  []string
}

func newPrivateRepoFixture(t *testing.T) *privateRepoFixture {
	t.Helper()
	ctx := context.Background()
	store := newFakeSyncedRepoStore()
	f := &privateRepoFixture{synced: NewGitHubSyncedRepoService(store)}
	row, err := f.synced.EnrollGitHubRepo(ctx, EnrollGitHubRepoInput{
		Owner: "acme", Repo: "secret", EnrolledVia: GitHubSyncedRepoEnrolledViaImport,
	})
	require.NoError(t, err)
	require.NoError(t, store.MarkGitHubSyncedRepoSynced(ctx, row.ID))
	require.NoError(t, store.TouchGitHubSyncedRepoWebhook(ctx, row.ID))
	seedSyncedIssue(t, store, row.ID, GitHubRepoMetadataIssues, 1, "open", time.Now())
	seedSyncedIssueComments(t, store, row.ID, 1, 1)
	require.NoError(t, store.UpsertGitHubSyncedIssueComment(ctx, db.UpsertGitHubSyncedIssueCommentParams{
		SyncedRepoID: row.ID,
		IssueNumber:  1,
		GithubID:     9001,
		Payload:      json.RawMessage(`{"id":9001,"body":"private from the store"}`),
	}))

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		f.mu.Lock()
		f.auths = append(f.auths, auth)
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if auth != "Bearer gho_a" {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"Not Found"}`))
			return
		}
		if r.URL.Path == "/repos/acme/secret" {
			_, _ = w.Write([]byte(`{"id":1,"full_name":"acme/secret","private":true}`))
			return
		}
		_, _ = w.Write([]byte(`[{"number":1,"body":"live"}]`))
	}))
	t.Cleanup(srv.Close)
	t.Setenv(envGitHubAppAPIBaseURL, srv.URL)
	return f
}

func (f *privateRepoFixture) contacted(auth string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, got := range f.auths {
		if got == auth {
			return true
		}
	}
	return false
}

func (f *privateRepoFixture) userService(token string, withAccount bool, opts ...GitHubUserReposOption) *GitHubUserReposService {
	users := newFakeGitHubUserReposDB()
	if !withAccount {
		users.accounts = nil
	}
	opts = append(opts, WithGitHubUserReposSyncedStore(f.synced))
	return NewGitHubUserReposService(users, fakeOAuthTokenDecrypter{token: token}, opts...)
}

func TestSyncedRepoReadGrant_MetadataStoreServesOnlyUsersGitHubAdmits(t *testing.T) {
	f := newPrivateRepoFixture(t)
	ctx := context.Background()
	const userA, userB = int64(1), int64(2)

	// User B has no GitHub credential: the store must not answer, and the
	// credential check refuses before GitHub is contacted.
	_, err := f.userService("", false).ListAuthenticatedUserGitHubRepoMetadata(
		ctx, userB, "acme", "secret", GitHubRepoMetadataIssues, url.Values{})
	requireAPIStatus(t, err, http.StatusUnauthorized)

	// User B's GitHub token cannot see the repo: GitHub is asked and says 404.
	result, err := f.userService("gho_b", true).ListAuthenticatedUserGitHubRepoMetadata(
		ctx, userB, "acme", "secret", GitHubRepoMetadataIssues, url.Values{})
	requireAPIStatus(t, err, http.StatusNotFound)
	assert.Nil(t, result.Body)
	assert.True(t, f.contacted("Bearer gho_b"), "user B's access must be decided by GitHub")

	// User A's first read goes live and stamps A's grant; the next is the store.
	enrolled := make(chan struct{}, 1)
	serviceA := f.userService("gho_a", true, WithGitHubUserReposEnrollNotify(func(string, string) { enrolled <- struct{}{} }))
	first, err := serviceA.ListAuthenticatedUserGitHubRepoMetadata(
		ctx, userA, "acme", "secret", GitHubRepoMetadataIssues, url.Values{})
	require.NoError(t, err)
	assert.Equal(t, GitHubRepoMetadataSourceLive, first.Source)
	select {
	case <-enrolled:
	case <-time.After(5 * time.Second):
		t.Fatal("live read never recorded access")
	}
	second, err := serviceA.ListAuthenticatedUserGitHubRepoMetadata(
		ctx, userA, "acme", "secret", GitHubRepoMetadataIssues, url.Values{})
	require.NoError(t, err)
	assert.Equal(t, GitHubRepoMetadataSourceStore, second.Source)

	// A's grant does not carry over to B.
	_, err = f.userService("gho_b", true).ListAuthenticatedUserGitHubRepoMetadata(
		ctx, userB, "acme", "secret", GitHubRepoMetadataIssues, url.Values{})
	requireAPIStatus(t, err, http.StatusNotFound)
}

func TestSyncedRepoReadGrant_CommentsStoreServesOnlyUsersGitHubAdmits(t *testing.T) {
	f := newPrivateRepoFixture(t)
	ctx := context.Background()
	const userA, userB = int64(1), int64(2)

	_, err := f.userService("", false).ListAuthenticatedUserGitHubIssueComments(
		ctx, userB, "acme", "secret", 1, url.Values{})
	requireAPIStatus(t, err, http.StatusUnauthorized)

	result, err := f.userService("gho_b", true).ListAuthenticatedUserGitHubIssueComments(
		ctx, userB, "acme", "secret", 1, url.Values{})
	requireAPIStatus(t, err, http.StatusNotFound)
	assert.NotContains(t, string(result.Body), "private from the store")
	assert.True(t, f.contacted("Bearer gho_b"), "user B's access must be decided by GitHub")

	enrolled := make(chan struct{}, 1)
	serviceA := f.userService("gho_a", true, WithGitHubUserReposEnrollNotify(func(string, string) { enrolled <- struct{}{} }))
	first, err := serviceA.ListAuthenticatedUserGitHubIssueComments(ctx, userA, "acme", "secret", 1, url.Values{})
	require.NoError(t, err)
	assert.Equal(t, GitHubRepoMetadataSourceLive, first.Source)
	select {
	case <-enrolled:
	case <-time.After(5 * time.Second):
		t.Fatal("live read never recorded access")
	}
	second, err := serviceA.ListAuthenticatedUserGitHubIssueComments(ctx, userA, "acme", "secret", 1, url.Values{})
	require.NoError(t, err)
	assert.Equal(t, GitHubRepoMetadataSourceStore, second.Source)
	assert.JSONEq(t, `[{"id":9001,"body":"private from the store"}]`, string(second.Body))
}

func TestSyncedRepoReadGrant_CredentialGoneRevokesGrants(t *testing.T) {
	f := newPrivateRepoFixture(t)
	ctx := context.Background()
	require.NoError(t, f.synced.RecordReadGrant(ctx, 1, "acme", "secret"))
	require.True(t, f.synced.ReadGrant(ctx, 1, "acme", "secret").ok)

	// GitHub answers 401 for the listing refresh: the credential is gone.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"message":"Bad credentials"}`))
	}))
	defer srv.Close()
	t.Setenv(envGitHubAppAPIBaseURL, srv.URL)

	service := f.userService("gho_a", true)
	require.Error(t, service.syncGitHubRepoListing(ctx, 1))
	assert.False(t, f.synced.ReadGrant(ctx, 1, "acme", "secret").ok, "a gone credential revokes the store grant")
}

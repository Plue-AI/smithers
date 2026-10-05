package services

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type mirrorCredentialStore struct {
	*fakeGitMirrorSyncStore
	destination string
	sources     []db.ListRepositoryGitHubSourcesRow
	created     []db.CreateAccessTokenParams
	deleted     []db.DeleteAccessTokenParams
}

func (s *mirrorCredentialStore) GetRepoByID(_ context.Context, id int64) (db.Repository, error) {
	return db.Repository{ID: id, MirrorDestination: s.destination}, nil
}
func (s *mirrorCredentialStore) ListRepositoryGitHubSources(_ context.Context, id int64) ([]db.ListRepositoryGitHubSourcesRow, error) {
	return s.sources, nil
}
func (s *mirrorCredentialStore) CreateAccessToken(_ context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
	s.created = append(s.created, arg)
	return db.AccessToken{ID: 81}, nil
}
func (s *mirrorCredentialStore) DeleteAccessToken(_ context.Context, arg db.DeleteAccessTokenParams) error {
	s.deleted = append(s.deleted, arg)
	return nil
}

type mirrorGitHubCredentialFunc func(context.Context, int64, string, string) (string, error)

func (f mirrorGitHubCredentialFunc) GitHubPushToken(ctx context.Context, userID int64, owner, repo string) (string, error) {
	return f(ctx, userID, owner, repo)
}
func mirrorCredentialFixture(t *testing.T) (*mirrorCredentialStore, *GitMirrorSyncService) {
	t.Helper()
	q := &mirrorCredentialStore{fakeGitMirrorSyncStore: newFakeGitMirrorSyncStore(), sources: []db.ListRepositoryGitHubSourcesRow{{GithubOwner: "upstream", GithubRepo: "renamed"}}}
	github := mirrorGitHubCredentialFunc(func(_ context.Context, userID int64, owner, repo string) (string, error) {
		require.Equal(t, int64(7), userID)
		require.Equal(t, "upstream", owner)
		require.Equal(t, "renamed", repo)
		return "caller-github-secret", nil
	})
	s := NewGitMirrorSyncService(q, WithGitMirrorCredentials(q, github, "https://forge.example"))
	s.launch = func(_ string, fn func()) { fn() }
	s.listRemoteRefs = func(context.Context, string) (map[string]string, error) { return map[string]string{}, nil }
	s.runGitSync = func(context.Context, string, string, []gitMirrorRefChange) error { return nil }
	return q, s
}
func TestGitMirrorCredentialsAreCallerScopedAndRevoked(t *testing.T) {
	setGitMirrorEnv(t) // The configured resolver must ignore these global credentials.
	q, s := mirrorCredentialFixture(t)
	s.listRemoteRefs = func(_ context.Context, remote string) (map[string]string, error) {
		return map[string]string{"refs/heads/main": remote}, nil
	}
	s.runGitSync = func(_ context.Context, sourceURL, targetURL string, _ []gitMirrorRefChange) error {
		require.Empty(t, q.deleted)
		source, err := url.Parse(sourceURL)
		require.NoError(t, err)
		target, err := url.Parse(targetURL)
		require.NoError(t, err)
		assert.Equal(t, "forge.example", source.Host)
		assert.Equal(t, "/native/copy.git", source.Path)
		password, _ := source.User.Password()
		assert.True(t, strings.HasPrefix(password, "smithers_"))
		assert.Equal(t, "github.com", target.Host)
		assert.Equal(t, "/upstream/renamed.git", target.Path)
		password, _ = target.User.Password()
		assert.Equal(t, "caller-github-secret", password)
		return nil
	}
	_, err := s.StartMirrorSync(context.Background(), 7, 19, "native", "copy")
	require.NoError(t, err)
	require.Len(t, q.created, 1)
	assert.Equal(t, int64(7), q.created[0].UserID)
	assert.Equal(t, "read:repository,repo:19", q.created[0].Scopes)
	assert.WithinDuration(t, time.Now().Add(15*time.Minute), q.created[0].ExpiresAt.Time, 5*time.Second)
	assert.Equal(t, []db.DeleteAccessTokenParams{{ID: 81, UserID: 7}}, q.deleted)
}
func TestGitMirrorCredentialsRevokeWhenRunCannotBeCreated(t *testing.T) {
	q, s := mirrorCredentialFixture(t)
	q.createErr = errors.New("store unavailable")
	_, err := s.StartMirrorSync(context.Background(), 7, 19, "native", "copy")
	require.Error(t, err)
	require.Len(t, q.deleted, 1)
}
func TestGitMirrorCredentialsRevokeAfterWorkerFailure(t *testing.T) {
	q, s := mirrorCredentialFixture(t)
	s.listRemoteRefs = func(context.Context, string) (map[string]string, error) { return nil, errors.New("read failed") }
	_, err := s.StartMirrorSync(context.Background(), 7, 19, "native", "copy")
	require.NoError(t, err)
	assert.Equal(t, "failed", q.run.State)
	require.Len(t, q.deleted, 1)
}
func TestGitMirrorCredentialsDenyBeforeMintingOrStarting(t *testing.T) {
	setGitMirrorEnv(t)
	q, s := mirrorCredentialFixture(t)
	WithGitMirrorCredentials(q, mirrorGitHubCredentialFunc(func(context.Context, int64, string, string) (string, error) {
		return "", pkgerrors.Forbidden("no push access")
	}), "https://forge.example")(s)
	_, err := s.StartMirrorSync(context.Background(), 7, 19, "native", "copy")
	require.Error(t, err)
	assert.Empty(t, q.created)
	assert.Zero(t, q.run.ID)
}
func TestGitMirrorCredentialsRequireUnambiguousDestination(t *testing.T) {
	for _, sources := range [][]db.ListRepositoryGitHubSourcesRow{nil, {{GithubOwner: "a", GithubRepo: "b"}, {GithubOwner: "c", GithubRepo: "d"}}} {
		q, s := mirrorCredentialFixture(t)
		q.sources = sources
		_, err := s.StartMirrorSync(context.Background(), 7, 19, "native", "copy")
		require.Error(t, err)
		assert.Empty(t, q.created)
		assert.Zero(t, q.run.ID)
	}
}
func TestGitMirrorCredentialsExplicitDestinationAndRetryCleanup(t *testing.T) {
	q, s := mirrorCredentialFixture(t)
	q.sources = nil
	q.destination = "https://github.com/upstream/renamed.git"
	q.refs["refs/heads/main"] = db.GithubMirrorSyncRefResult{Name: "refs/heads/main", Status: "failed"}
	s.runGitRefSync = func(context.Context, string, string, string, string, string) error { return nil }
	_, err := s.RetryMirrorRef(context.Background(), 7, 19, "native", "copy", "refs/heads/main")
	require.NoError(t, err)
	require.Len(t, q.created, 1)
	require.Len(t, q.deleted, 1)
}
func TestGitMirrorCredentialsRejectUnsafeDestination(t *testing.T) {
	for _, destination := range []string{"https://elsewhere.test/a/b", "https://secret@github.com/a/b", "https://github.com/a/b?token=x", "https://github.com/a/b#x", "https://github.com/a/b/c"} {
		q, s := mirrorCredentialFixture(t)
		q.destination = destination
		_, err := s.StartMirrorSync(context.Background(), 7, 19, "native", "copy")
		require.Error(t, err)
		assert.Empty(t, q.created)
	}
}
func TestMirrorCommandKeepsCredentialsOutOfArguments(t *testing.T) {
	cmd := mirrorCommand(context.Background(), "fetch", "https://x-access-token:source-secret@forge.example/a/b.git", "https://x-access-token:target-secret@github.com/c/d.git")
	assert.Equal(t, []string{"-c", "core.hooksPath=/dev/null", "fetch", "https://forge.example/a/b.git", "https://github.com/c/d.git"}, cmd.Args[1:])
	assert.True(t, slices.Contains(cmd.Env, "GIT_CONFIG_COUNT=6"))
	assert.True(t, slices.Contains(cmd.Env, "GIT_CONFIG_VALUE_4=Authorization: Basic "+base64.StdEncoding.EncodeToString([]byte("x-access-token:source-secret"))))
	assert.True(t, slices.Contains(cmd.Env, "GIT_CONFIG_VALUE_5=Authorization: Basic "+base64.StdEncoding.EncodeToString([]byte("x-access-token:target-secret"))))
	assert.True(t, slices.Contains(cmd.Env, "GIT_CONFIG_KEY_4=http.https://forge.example/a/b.git.extraHeader"))
	assert.True(t, slices.Contains(cmd.Env, "GIT_CONFIG_KEY_5=http.https://github.com/c/d.git.extraHeader"))
	assert.True(t, slices.Contains(cmd.Env, "GIT_TERMINAL_PROMPT=0"))
	assert.False(t, slices.Contains(cmd.Env, "GITSYNC_TARGET_INSECURE_SKIP_TLS_VERIFY=true"))
}

func TestMirrorCredentialErrorsRedactEncodedAndBareSecrets(t *testing.T) {
	remote := "https://x-access-token:caller-secret@github.com/a/b.git"
	basic := base64.StdEncoding.EncodeToString([]byte("x-access-token:caller-secret"))
	message := sanitizeMirrorError(errors.New(remote+" caller-secret "+basic), remote)
	assert.NotContains(t, message, "caller-secret")
	assert.NotContains(t, message, basic)
}

type mirrorConnectionChecker bool

func (c mirrorConnectionChecker) GetRepoConnectionStatus(context.Context, int64, string, string) (RepoConnectionStatus, error) {
	return RepoConnectionStatus{Connected: bool(c)}, nil
}
func TestGitMirrorCredentialsNativeTargetRequiresVerifiedConnection(t *testing.T) {
	for _, connected := range []bool{false, true} {
		q, s := mirrorCredentialFixture(t)
		q.sources = nil
		github := mirrorGitHubCredentialFunc(func(_ context.Context, userID int64, owner, repo string) (string, error) {
			require.True(t, connected)
			require.Equal(t, int64(7), userID)
			require.Equal(t, "native", owner)
			require.Equal(t, "copy", repo)
			return "user-token", nil
		})
		WithGitMirrorCredentials(q, github, "https://forge.example", mirrorConnectionChecker(connected))(s)
		_, err := s.StartMirrorSync(context.Background(), 7, 19, "native", "copy")
		if connected {
			require.NoError(t, err)
			require.Len(t, q.deleted, 1)
		} else {
			require.Error(t, err)
			require.Empty(t, q.created)
		}
	}
}

func TestMirrorCredentialUsesURLScopedHeader(t *testing.T) {
	headers := make(chan string, 4)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		headers <- r.Header.Get("Authorization")
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()
	remote, err := url.Parse(server.URL + "/a/b.git")
	require.NoError(t, err)
	remote.User = url.UserPassword("x-access-token", "transport-test-secret")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err = defaultListRemoteRefs(ctx, remote.String())
	require.Error(t, err) // The fixture deliberately refuses the Git protocol.
	select {
	case header := <-headers:
		assert.Equal(t, "Basic "+base64.StdEncoding.EncodeToString([]byte("x-access-token:transport-test-secret")), header)
	case <-ctx.Done():
		t.Fatal("git did not reach the HTTP fixture")
	}
	assert.NotContains(t, err.Error(), "transport-test-secret")
}

func TestGitMirrorInternalRefsDoNotFailAnOtherwiseSyncedRepository(t *testing.T) {
	q, s := mirrorCredentialFixture(t)
	reads := 0
	s.listRemoteRefs = func(context.Context, string) (map[string]string, error) {
		reads++
		if reads == 1 {
			return map[string]string{"refs/heads/main": "same", "refs/jj/keep/private": "unpublished", "refs/smithers/workspaces/owned/head": "private-head"}, nil
		}
		return map[string]string{"refs/heads/main": "same", "refs/pull/1/head": "github-owned", "refs/smithers/workspaces/target-only/head": "protected"}, nil
	}
	s.runGitSync = func(context.Context, string, string, []gitMirrorRefChange) error {
		t.Fatal("an in-sync repository needs no push")
		return nil
	}
	_, err := s.StartMirrorSync(context.Background(), 7, 19, "native", "copy")
	require.NoError(t, err)
	assert.Equal(t, "succeeded", q.run.State)
	assert.Empty(t, q.refs)
	for _, ref := range []string{"refs/jj/keep/private", "refs/pull/1/head", "refs/smithers/workspaces/owned/head"} {
		_, err := s.RetryMirrorRef(context.Background(), 7, 19, "native", "copy", ref)
		assert.Equal(t, 400, apiStatus(t, err))
	}
}

func TestGitMirrorPreservesNotesAndCustomRefScope(t *testing.T) {
	changes := mirrorRefChanges(
		map[string]string{"refs/heads/main": "new", "refs/notes/review": "note", "refs/jj/keep/private": "private"},
		map[string]string{"refs/heads/main": "old", "refs/custom/obsolete": "old", "refs/pull/1/head": "github-owned"},
	)
	assert.Equal(t, []gitMirrorRefChange{
		{name: "refs/heads/main", from: "old", to: "new"},
		{name: "refs/notes/review", from: "", to: "note"},
	}, changes)
}

package services

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/stretchr/testify/require"
)

// policyHTTPFixture exposes a large bookmark inventory and records actual HTTP
// requests. The targeted endpoint must resolve main without visiting that list.
type policyHTTPFixture struct {
	client                *repohost.Client
	lookups, lists, reads atomic.Int32
	commit                atomic.Value
}

func newPolicyHTTPFixture(t *testing.T) *policyHTTPFixture {
	t.Helper()
	f := &policyHTTPFixture{}
	f.commit.Store("commit-one")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/bookmarks/main"):
			f.lookups.Add(1)
			_ = json.NewEncoder(w).Encode(repohost.Bookmark{Name: "main", TargetCommitID: f.commit.Load().(string)})
		case strings.HasSuffix(r.URL.Path, "/bookmarks"):
			f.lists.Add(1)
			entries := make([]repohost.Bookmark, 601)
			for i := range entries {
				entries[i] = repohost.Bookmark{Name: fmt.Sprintf("feature-%03d", i), TargetCommitID: "other"}
			}
			entries[600] = repohost.Bookmark{Name: "main", TargetCommitID: f.commit.Load().(string)}
			_ = json.NewEncoder(w).Encode(entries)
		case strings.Contains(r.URL.Path, "/file/"):
			f.reads.Add(1)
			maintainer := "alice"
			if strings.Contains(r.URL.Path, "commit-two") {
				maintainer = "bob"
			}
			_ = json.NewEncoder(w).Encode(repohost.FileContent{Content: fmt.Sprintf(`{"github":{"maintainers":[%q]}}`, maintainer)})
		default:
			http.Error(w, "unexpected request "+r.URL.Path, 500)
		}
	}))
	t.Cleanup(server.Close)
	f.client = repohost.NewClient(&repohost.StaticStorageSetResolver{URL: server.URL}, "test-token")
	return f
}

func TestRepositoryPolicyConcurrentHTTPReadsFollowImmutableCommit(t *testing.T) {
	f := newPolicyHTTPFixture(t)
	errs := make(chan error, 50)
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			p, e := readRepositoryPolicy(context.Background(), f.client, "owner", "repo", "main")
			if e == nil && !p.maintains("alice") {
				e = fmt.Errorf("wrong policy")
			}
			errs <- e
		}()
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		require.NoError(t, e)
	}
	require.EqualValues(t, 50, f.lookups.Load())
	require.Zero(t, f.lists.Load())
	require.EqualValues(t, 1, f.reads.Load())
	f.commit.Store("commit-two")
	for i := 0; i < 2; i++ {
		p, e := readRepositoryPolicy(context.Background(), f.client, "owner", "repo", "main")
		require.NoError(t, e)
		require.True(t, p.maintains("bob"))
		require.False(t, p.maintains("alice"))
	}
	require.EqualValues(t, 52, f.lookups.Load())
	require.EqualValues(t, 2, f.reads.Load())
}

func TestObserveGitHubEventConcurrentPolicyReads(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	var user, repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES ('policy-owner','policy-owner') RETURNING id`).Scan(&user))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name,default_bookmark,mirror_destination) VALUES ($1,'repo','repo','main','https://github.com/source/repo') RETURNING id`, user).Scan(&repo))
	_, e := pool.Exec(ctx, `INSERT INTO mythical_stacks(repository_id,actor_user_id) VALUES ($1,$2)`, repo, user)
	require.NoError(t, e)
	f := newPolicyHTTPFixture(t)
	s := NewMythicalService(pool, nil)
	s.SetPolicyReader(f.client)
	deliver := func(number int) error {
		payload, e := json.Marshal(map[string]any{"action": "opened", "repository": map[string]any{"name": "repo", "owner": map[string]string{"login": "source"}}, "issue": map[string]any{"number": number, "title": "policy regression", "state": "open", "user": map[string]string{"login": "outsider"}, "created_at": "2026-01-01T00:00:00Z"}})
		if e != nil {
			return e
		}
		return s.ObserveGitHubEvent(ctx, "issues", payload)
	}
	errs := make(chan error, 50)
	var wg sync.WaitGroup
	for i := 1; i <= 50; i++ {
		wg.Add(1)
		go func(n int) { defer wg.Done(); errs <- deliver(n) }(i)
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		require.NoError(t, e)
	}
	require.EqualValues(t, 50, f.lookups.Load())
	require.Zero(t, f.lists.Load())
	require.EqualValues(t, 1, f.reads.Load())
	f.commit.Store("commit-two")
	require.NoError(t, deliver(51))
	require.NoError(t, deliver(52))
	require.EqualValues(t, 52, f.lookups.Load())
	require.EqualValues(t, 2, f.reads.Load())
	var persisted int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE repository_id=$1`, repo).Scan(&persisted))
	require.Equal(t, 52, persisted)
}

func TestRepositoryPolicyGeneric404FailsClosedThenCachesTypedAbsence(t *testing.T) {
	var reads atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/bookmarks/main") {
			_ = json.NewEncoder(w).Encode(repohost.Bookmark{Name: "main", TargetCommitID: "same-commit"})
			return
		}
		if reads.Add(1) <= 2 {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]string{"code": "file_not_found", "message": "file missing"})
	}))
	defer server.Close()
	client := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: server.URL}, "test-token")
	for i := 0; i < 2; i++ {
		_, e := readRepositoryPolicy(context.Background(), client, "o", "r", "main")
		require.Error(t, e, "an unknown 404 must not authorize an empty policy")
	}
	for i := 0; i < 2; i++ {
		p, e := readRepositoryPolicy(context.Background(), client, "o", "r", "main")
		require.NoError(t, e)
		require.False(t, p.namesMaintainers())
	}
	require.EqualValues(t, 3, reads.Load(), "only a typed missing-file result may be retained")
}

func TestRepositoryPolicyReturnedSlicesDoNotMutateCachedPolicy(t *testing.T) {
	var reads atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/bookmarks/main") {
			_ = json.NewEncoder(w).Encode(repohost.Bookmark{Name: "main", TargetCommitID: "same-commit"})
			return
		}
		reads.Add(1)
		_ = json.NewEncoder(w).Encode(repohost.FileContent{Content: `{"github":{"maintainers":["alice"],"reviewerAgents":["review-bot"],"protectedPaths":["AGENTS.md"],"agentIssueSources":["run"]}}`})
	}))
	defer server.Close()
	client := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: server.URL}, "test-token")
	p, e := readRepositoryPolicy(context.Background(), client, "o", "r", "main")
	require.NoError(t, e)
	p.Maintainers[0] = "mallory"
	p.ReviewerAgents[0] = "other"
	p.ProtectedPaths[0] = "other"
	p.AgentIssueSources[0] = "trial"
	next, e := readRepositoryPolicy(context.Background(), client, "o", "r", "main")
	require.NoError(t, e)
	require.Equal(t, []string{"alice"}, next.Maintainers)
	require.Equal(t, []string{"review-bot"}, next.ReviewerAgents)
	require.Equal(t, []string{"AGENTS.md"}, next.ProtectedPaths)
	require.Equal(t, []string{"run"}, next.AgentIssueSources)
	require.EqualValues(t, 1, reads.Load())
}

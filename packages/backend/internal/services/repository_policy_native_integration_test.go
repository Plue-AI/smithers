package services

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
	"github.com/stretchr/testify/require"
)

// Counters observe the actual native boundary; every operation delegates to the
// loaded Rust FFI instead of substituting bookmark or file contents.
type policyNativeCounter struct {
	repohostserver.FFIClient
	lookups, lists, reads atomic.Int32
}

func (f *policyNativeCounter) GetBookmark(path, name string) (*repohost.Bookmark, error) {
	f.lookups.Add(1)
	return f.FFIClient.GetBookmark(path, name)
}

func (f *policyNativeCounter) ListBookmarks(path string, page, limit uint32) (repohostffi.Paginated[repohost.Bookmark], error) {
	f.lists.Add(1)
	return f.FFIClient.ListBookmarks(path, page, limit)
}

func (f *policyNativeCounter) GetFileContent(path, revision, file string) (repohost.FileContent, error) {
	f.reads.Add(1)
	return f.FFIClient.GetFileContent(path, revision, file)
}

func TestRepositoryPolicyNativeLookupAndConcurrentIssueEvents(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	native := newNativeRepoHost(t, "policy-owner", "repo")
	firstPolicy := `{"github":{"maintainers":["alice"]}}`
	first := native.commit("repo", "refs/heads/main", "", map[string]string{factoryProjectionPath: firstPolicy})
	var refs strings.Builder
	for i := 0; i < 601; i++ {
		fmt.Fprintf(&refs, "update refs/heads/feature-%04d %s\n", i, first)
	}
	populate := exec.CommandContext(ctx, "git", "--git-dir", native.cfg.GitBackendPath(native.owner, "repo"), "update-ref", "--stdin")
	populate.Stdin = strings.NewReader(refs.String())
	output, err := populate.CombinedOutput()
	require.NoError(t, err, "%s", output)
	require.NoError(t, native.ffi.ImportGitRefs(native.cfg.RepoPath(native.owner, "repo")))
	inventory, err := native.ffi.ListBookmarks(native.cfg.RepoPath(native.owner, "repo"), 1, 100)
	require.NoError(t, err)
	require.Greater(t, inventory.TotalCount, 500, "the real jj view contains more than five pages of bookmarks")

	ffi := &policyNativeCounter{FFIClient: native.ffi}
	backend, err := repohostserver.NewWithFFI(native.cfg, ffi)
	require.NoError(t, err)
	var lookups, lists, reads atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/bookmarks/"):
			lookups.Add(1)
		case strings.HasSuffix(r.URL.Path, "/bookmarks"):
			lists.Add(1)
		case strings.Contains(r.URL.Path, "/file/"):
			reads.Add(1)
		}
		backend.Handler().ServeHTTP(w, r)
	}))
	t.Cleanup(server.Close)
	client := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: server.URL}, native.cfg.AuthToken)
	bookmark, err := client.GetBookmark(ctx, native.owner, "repo", "feature-0600")
	require.NoError(t, err)
	require.Equal(t, "feature-0600", bookmark.Name)
	require.Equal(t, first, bookmark.TargetCommitID)
	require.EqualValues(t, 1, lookups.Load())
	require.EqualValues(t, 1, ffi.lookups.Load())
	require.Zero(t, lists.Load())
	require.Zero(t, ffi.lists.Load())

	pool := newProductTestPool(t)
	var ownerID, repositoryID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES ($1,$1) RETURNING id`, native.owner).Scan(&ownerID))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name,default_bookmark,mirror_destination) VALUES ($1,'repo','repo','main','https://github.com/source/repo') RETURNING id`, ownerID).Scan(&repositoryID))
	_, err = pool.Exec(ctx, `INSERT INTO mythical_stacks(repository_id,actor_user_id) VALUES ($1,$2)`, repositoryID, ownerID)
	require.NoError(t, err)
	mythical := NewMythicalService(pool, nil)
	mythical.SetPolicyReader(client)
	deliver := func(number int) error {
		payload, err := json.Marshal(map[string]any{
			"action": "opened", "repository": map[string]any{"name": "repo", "owner": map[string]string{"login": "source"}},
			"issue": map[string]any{"number": number, "title": "native policy regression", "state": "open", "user": map[string]string{"login": "outsider"}, "created_at": "2026-01-01T00:00:00Z"},
		})
		if err != nil {
			return err
		}
		_ = payload
		_, err = mythical.stackPolicy(ctx, repositoryID)
		return err
	}
	errs := make(chan error, 50)
	var wg sync.WaitGroup
	for i := 1; i <= 50; i++ {
		wg.Add(1)
		go func(number int) { defer wg.Done(); errs <- deliver(number) }(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		require.NoError(t, err)
	}
	require.EqualValues(t, 51, lookups.Load(), "one host lookup per issue event, plus the direct resolution")
	require.EqualValues(t, 51, ffi.lookups.Load(), "one actual FFI lookup per host resolution")
	require.Zero(t, lists.Load())
	require.Zero(t, ffi.lists.Load())
	require.EqualValues(t, 1, reads.Load(), "all concurrent events share one immutable policy read")
	require.EqualValues(t, 1, ffi.reads.Load())

	secondPolicy := `{"github":{"maintainers":["bob"]}}`
	second := native.commit("repo", "refs/heads/main", first, map[string]string{factoryProjectionPath: secondPolicy})
	require.NotEqual(t, first, second)
	require.NoError(t, deliver(51))
	require.NoError(t, deliver(52))
	require.EqualValues(t, 53, lookups.Load())
	require.EqualValues(t, 53, ffi.lookups.Load())
	require.EqualValues(t, 2, reads.Load(), "a new commit has one distinct policy read")
	require.EqualValues(t, 2, ffi.reads.Load())
	retained, err := client.GetFileAtCommit(ctx, native.owner, "repo", first, factoryProjectionPath)
	require.NoError(t, err)
	require.JSONEq(t, firstPolicy, retained.Content, "moving main cannot rewrite the cached older policy")
	current, err := client.GetFileAtCommit(ctx, native.owner, "repo", second, factoryProjectionPath)
	require.NoError(t, err)
	require.JSONEq(t, secondPolicy, current.Content)
	require.EqualValues(t, 2, reads.Load())
	require.EqualValues(t, 2, ffi.reads.Load())
	var persisted int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE repository_id=$1`, repositoryID).Scan(&persisted))
	require.Zero(t, persisted, "policy reads never admit issues")
}

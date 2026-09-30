package services

import (
	"context"
	"errors"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
)

// nativeChangesetRepos is a real repo-host (jj + git stores behind the HTTP
// API) holding one organization's member repositories and superproject.
type nativeChangesetRepos struct {
	t      *testing.T
	owner  string
	cfg    repohostserver.Config
	ffi    *repohostffi.Client
	client *repohost.Client
}

func newNativeChangesetRepos(t *testing.T, repos ...string) *nativeChangesetRepos {
	t.Helper()
	return newNativeRepoHost(t, "acme", repos...)
}

// newNativeRepoHost is a real repo-host holding owner's repositories.
func newNativeRepoHost(t *testing.T, owner string, repos ...string) *nativeChangesetRepos {
	t.Helper()
	library := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	if library == "" {
		t.Skip("set SMITHERS_FFI_LIBRARY_PATH to the built smithers-ffi library")
	}
	n := &nativeChangesetRepos{t: t, owner: owner, cfg: repohostserver.Config{StoragePath: t.TempDir(), AuthToken: "changeset-native", FFILibraryPath: library}}
	n.ffi = repohostffi.New(library)
	require.NoError(t, n.ffi.Load())
	for _, repo := range repos {
		_, err := n.ffi.InitRepo(n.cfg.RepoPath(n.owner, repo))
		require.NoError(t, err)
		n.git(repo, "symbolic-ref", "HEAD", "refs/heads/main")
	}
	backend, err := repohostserver.NewWithFFI(n.cfg, n.ffi)
	require.NoError(t, err)
	server := httptest.NewServer(backend.Handler())
	t.Cleanup(server.Close)
	n.client = repohost.NewClient(&repohost.StaticStorageSetResolver{URL: server.URL}, n.cfg.AuthToken)
	return n
}

func (n *nativeChangesetRepos) git(repo string, args ...string) string {
	n.t.Helper()
	return n.gitEnv(repo, nil, args...)
}

func (n *nativeChangesetRepos) gitEnv(repo string, env []string, args ...string) string {
	n.t.Helper()
	cmd := exec.Command("git", append([]string{"--git-dir", n.cfg.GitBackendPath(n.owner, repo)}, args...)...)
	cmd.Env = append(append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.invalid", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.invalid"), env...)
	out, err := cmd.CombinedOutput()
	require.NoError(n.t, err, "git %v: %s", args, out)
	return strings.TrimSpace(string(out))
}

// commit writes files on top of parent ("" for a root commit), points ref at
// the result behind repo-host's back, and imports it into jj like a push.
func (n *nativeChangesetRepos) commit(repo, ref, parent string, files map[string]string) string {
	n.t.Helper()
	index := []string{"GIT_INDEX_FILE=" + filepath.Join(n.t.TempDir(), "index")}
	if parent != "" {
		n.gitEnv(repo, index, "read-tree", parent)
	}
	for path, body := range files {
		blob := n.gitHashObject(repo, body)
		n.gitEnv(repo, index, "update-index", "--add", "--cacheinfo", "100644,"+blob+","+path)
	}
	tree := n.gitEnv(repo, index, "write-tree")
	args := []string{"commit-tree", tree, "-m", ref + " " + strings.Join(sortedKeys(files), ",")}
	if parent != "" {
		args = append(args, "-p", parent)
	}
	commit := n.git(repo, args...)
	n.git(repo, "update-ref", ref, commit)
	require.NoError(n.t, n.ffi.ImportGitRefs(n.cfg.RepoPath(n.owner, repo)))
	return commit
}

func (n *nativeChangesetRepos) gitHashObject(repo, body string) string {
	n.t.Helper()
	cmd := exec.Command("git", "--git-dir", n.cfg.GitBackendPath(n.owner, repo), "hash-object", "-w", "--stdin")
	cmd.Stdin = strings.NewReader(body)
	out, err := cmd.CombinedOutput()
	require.NoError(n.t, err, string(out))
	return strings.TrimSpace(string(out))
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func (n *nativeChangesetRepos) head(repo string) string {
	n.t.Helper()
	require.NoError(n.t, n.ffi.ExportGitRefs(n.cfg.RepoPath(n.owner, repo)))
	return n.git(repo, "rev-parse", "refs/heads/main")
}

func (n *nativeChangesetRepos) file(repo, path string) string {
	n.t.Helper()
	cmd := exec.Command("git", "--git-dir", n.cfg.GitBackendPath(n.owner, repo), "show", n.head(repo)+":"+path)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "<absent>"
	}
	return string(out)
}

func (n *nativeChangesetRepos) isAncestor(repo, ancestor, descendant string) bool {
	return exec.Command("git", "--git-dir", n.cfg.GitBackendPath(n.owner, repo), "merge-base", "--is-ancestor", ancestor, descendant).Run() == nil
}

func (n *nativeChangesetRepos) changeID(repo, commit string) string {
	n.t.Helper()
	change, err := n.client.GetChange(context.Background(), n.owner, repo, commit)
	require.NoError(n.t, err)
	return change.ChangeID
}

// webMainMovesOnce advances web's main (and, as another writer, api's main)
// between the plan and web's landing, so web's landing is refused (409) after
// api has already landed.
type webMainMovesOnce struct {
	*repohost.Client
	n     *nativeChangesetRepos
	moved bool
	api   string
}

func (h *webMainMovesOnce) LandChanges(ctx context.Context, owner, repo string, req repohost.LandRequest) (repohost.LandResult, error) {
	if repo == "web" && !req.LookupOnly && !h.moved {
		h.moved = true
		h.api = h.n.commit("api", "refs/heads/main", h.n.head("api"), map[string]string{"other.txt": "another writer\n"})
		h.n.commit("web", "refs/heads/main", h.n.head("web"), map[string]string{"web-other.txt": "moved\n"})
	}
	return h.Client.LandChanges(ctx, owner, repo, req)
}

// #2236: main is append-only, so a partially landed changeset is compensated
// by landing a revert on top of it, and a retry reapplies the member.
func TestChangesetNativeRollbackAppendsRevertAndRetryReapplies(t *testing.T) {
	n := newNativeChangesetRepos(t, "api", "web", OrgSuperprojectRepoName)
	apiBase := n.commit("api", "refs/heads/main", "", map[string]string{"api.txt": "base\n"})
	// api's member is a two-change stack whose first change is not in main,
	// and main has moved since, so its landing is a merge of both changes.
	apiFirst := n.commit("api", "refs/heads/feature", apiBase, map[string]string{"api.txt": "feature\n"})
	apiFeature := n.commit("api", "refs/heads/feature", apiFirst, map[string]string{"api2.txt": "second\n"})
	n.commit("api", "refs/heads/main", apiBase, map[string]string{"main.txt": "main\n"})
	webBase := n.commit("web", "refs/heads/main", "", map[string]string{"web.txt": "base\n"})
	webFeature := n.commit("web", "refs/heads/feature", webBase, map[string]string{"web.txt": "feature\n"})

	q := newFakeChangesetQueries()
	host := &webMainMovesOnce{Client: n.client, n: n}
	svc := NewChangesetService(q, host, nil, nil)
	actor := &db.User{ID: 1, Username: "alice"}
	created, err := svc.CreateChangeset(t.Context(), actor, "acme", CreateChangesetInput{Members: []ChangesetMemberInput{
		{Repo: "api", ChangeID: n.changeID("api", apiFeature)},
		{Repo: "web", ChangeID: n.changeID("web", webFeature)},
	}})
	require.NoError(t, err)

	_, err = svc.LandChangeset(t.Context(), actor, "acme", created.ID)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	require.Equal(t, 409, apiErr.Status, err.Error())
	require.NotContains(t, err.Error(), "rollback incomplete")

	// api's main was never rewound: it still holds the landed member and the
	// other writer's commit, and a revert on top restores the content.
	apiHead := n.head("api")
	require.True(t, n.isAncestor("api", apiFeature, apiHead), "main was rewound past the landed member")
	require.True(t, n.isAncestor("api", host.api, apiHead), "another writer's commit was dropped")
	require.Equal(t, "base\n", n.file("api", "api.txt"))
	require.Equal(t, "<absent>", n.file("api", "api2.txt"))
	require.Equal(t, "main\n", n.file("api", "main.txt"))
	require.Equal(t, "another writer\n", n.file("api", "other.txt"))
	require.Equal(t, "failed", q.changesets[created.ID].State)
	for _, member := range q.csMembers[created.ID] {
		require.Empty(t, member.LandedCommitID)
	}

	// The retry lands onto main that already holds the member and its
	// revert: the member's content is applied again, not silently skipped.
	landed, err := svc.LandChangeset(t.Context(), actor, "acme", created.ID)
	require.NoError(t, err)
	require.Equal(t, "landed", landed.State)
	require.True(t, n.isAncestor("api", apiHead, n.head("api")))
	require.Equal(t, "feature\n", n.file("api", "api.txt"))
	require.Equal(t, "second\n", n.file("api", "api2.txt"))
	require.Equal(t, "main\n", n.file("api", "main.txt"))
	require.Equal(t, "another writer\n", n.file("api", "other.txt"))
	require.Equal(t, "feature\n", n.file("web", "web.txt"))
	require.Equal(t, "moved\n", n.file("web", "web-other.txt"))
	for _, member := range landed.Members {
		require.Equal(t, n.head(member.Path), member.LandedCommitID)
	}
}

// lostNativeRevertResponse loses the HTTP result after real storage commits
// the revert. A second request must return that receipt without landing again.
type lostNativeRevertResponse struct {
	*webMainMovesOnce
	revertTargets []string
	backouts      int
}

func (h *lostNativeRevertResponse) BackoutChange(ctx context.Context, owner, repo, changeID string, req repohost.BackoutChangeRequest) (repohost.Change, error) {
	h.backouts++
	return h.Client.BackoutChange(ctx, owner, repo, changeID, req)
}

func (h *lostNativeRevertResponse) LandChanges(ctx context.Context, owner, repo string, req repohost.LandRequest) (repohost.LandResult, error) {
	result, err := h.webMainMovesOnce.LandChanges(ctx, owner, repo, req)
	if err == nil && !req.LookupOnly && strings.Contains(req.OperationKey, "/revert/") {
		h.revertTargets = append(h.revertTargets, result.TargetCommitID)
		if len(h.revertTargets) == 1 {
			return repohost.LandResult{}, errors.New("connection lost after revert storage commit")
		}
	}
	return result, err
}

func TestChangesetNativeRollbackRecoversLostRevertResponse(t *testing.T) {
	n := newNativeChangesetRepos(t, "api", "web", OrgSuperprojectRepoName)
	apiBase := n.commit("api", "refs/heads/main", "", map[string]string{"api.txt": "base\n"})
	apiFeature := n.commit("api", "refs/heads/feature", apiBase, map[string]string{"api.txt": "feature\n"})
	webBase := n.commit("web", "refs/heads/main", "", map[string]string{"web.txt": "base\n"})
	webFeature := n.commit("web", "refs/heads/feature", webBase, map[string]string{"web.txt": "feature\n"})
	q := newFakeChangesetQueries()
	host := &lostNativeRevertResponse{webMainMovesOnce: &webMainMovesOnce{Client: n.client, n: n}}
	svc := NewChangesetService(q, host, nil, nil)
	actor := &db.User{ID: 1, Username: "alice"}
	created, err := svc.CreateChangeset(t.Context(), actor, "acme", CreateChangesetInput{Members: []ChangesetMemberInput{
		{Repo: "api", ChangeID: n.changeID("api", apiFeature)},
		{Repo: "web", ChangeID: n.changeID("web", webFeature)},
	}})
	require.NoError(t, err)

	_, err = svc.LandChangeset(t.Context(), actor, "acme", created.ID)
	require.ErrorContains(t, err, "rollback incomplete")
	require.Len(t, host.revertTargets, 1)
	revertHead := n.head("api")
	require.Equal(t, host.revertTargets[0], revertHead)
	require.Equal(t, "base\n", n.file("api", "api.txt"))
	require.Equal(t, "another writer\n", n.file("api", "other.txt"))
	require.True(t, n.isAncestor("api", apiFeature, revertHead))

	// Recover from persisted database/storage state with a fresh service.
	svc = NewChangesetService(q, host, nil, nil)
	landed, err := svc.LandChangeset(t.Context(), actor, "acme", created.ID)
	require.NoError(t, err)
	require.Equal(t, "landed", landed.State)
	require.Equal(t, []string{revertHead, revertHead}, host.revertTargets, "recovery must reuse the storage receipt")
	require.Equal(t, 2, host.backouts, "one revert and one reapply; recovery creates no extra revert")
	require.True(t, n.isAncestor("api", revertHead, n.head("api")))
	require.Equal(t, "feature\n", n.file("api", "api.txt"))
	require.Equal(t, "another writer\n", n.file("api", "other.txt"))
	require.Equal(t, "feature\n", n.file("web", "web.txt"))
	for _, member := range landed.Members {
		require.Equal(t, n.head(member.Path), member.LandedCommitID)
	}
}

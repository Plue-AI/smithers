package services

import (
	"context"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	processruntime "github.com/smithersai/smithers/packages/backend/process"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// gitUserRefHost is repo-host's retain contract over a real bare repository:
// the ref resolves only in the caller's namespace and its commit is pinned
// under the workspace's source ref.
type gitUserRefHost struct {
	t        *testing.T
	bare     string
	retained []repohost.RetainUserRefRequest
}

func (h *gitUserRefHost) ListUserRefs(context.Context, string, string, int64) (repohost.UserRefList, error) {
	return repohost.UserRefList{}, nil
}

func (h *gitUserRefHost) RenewUserRef(context.Context, string, string, int64, string) (repohost.UserRefInfo, error) {
	return repohost.UserRefInfo{}, nil
}

func (h *gitUserRefHost) RetainUserRef(_ context.Context, _, _ string, userID int64, req repohost.RetainUserRefRequest) (repohost.RetainedUserRef, error) {
	h.retained = append(h.retained, req)
	ref := repohost.UserRef(userID, req.Name)
	output, err := exec.Command("git", "--git-dir="+h.bare, "rev-parse", "--verify", "--quiet", ref+"^{commit}").Output()
	if err != nil {
		return repohost.RetainedUserRef{}, &repohost.StatusError{StatusCode: http.StatusNotFound, Code: "user_ref_missing", Message: ref + " does not exist or expired"}
	}
	commit := strings.TrimSpace(string(output))
	source := repohost.WorkspaceSourceRef(req.WorkspaceID, commit)
	runGitFixture(h.t, h.bare, nil, "update-ref", source, commit)
	return repohost.RetainedUserRef{UserRefInfo: repohost.UserRefInfo{Name: req.Name, Ref: ref, CommitID: commit}, SourceRef: source}, nil
}

// A workspace created from the caller's pushed ref checks out that commit
// without a run, on the migrated product schema, a real Git host and a real
// process runtime (#1968).
func TestCreateWorkspaceFromPushedRef(t *testing.T) {
	requireExecutable(t, "git")
	requireExecutable(t, "jj")
	pool := newProductTestPool(t)
	ctx := context.Background()
	aliceID, repositoryID := setupTestUserAndRepo(t, pool)
	bobID, _ := setupTestUserAndRepo(t, pool)
	slug, err := db.New(pool).GetRepoOwnerSlugAndNameByID(ctx, repositoryID)
	require.NoError(t, err)

	gitRoot := t.TempDir()
	bare := filepath.Join(gitRoot, "api", slug.OwnerSlug, slug.RepoName+".git")
	seedBareRepository(t, bare, "main")
	main := strings.TrimSpace(runGitFixture(t, bare, nil, "rev-parse", "refs/heads/main"))
	blob := strings.TrimSpace(runGitFixture(t, bare, strings.NewReader("pushed work\n"), "hash-object", "-w", "--stdin"))
	tree := strings.TrimSpace(runGitFixture(t, bare, strings.NewReader("100644 blob "+blob+"\tREADME.md\n"), "mktree"))
	pushed := strings.TrimSpace(runGitFixture(t, bare, strings.NewReader("pushed\n"), "commit-tree", tree, "-p", main))
	runGitFixture(t, bare, nil, "update-ref", repohost.UserRef(aliceID, "spike"), pushed)
	gitExecutable, err := exec.LookPath("git")
	require.NoError(t, err)
	backend := &cgi.Handler{Path: gitExecutable, Args: []string{"http-backend"}, Dir: gitRoot,
		Env: []string{"GIT_PROJECT_ROOT=" + gitRoot, "GIT_HTTP_EXPORT_ALL=1"}}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if !strings.HasPrefix(request.Header.Get("Authorization"), "Bearer ") {
			http.Error(response, "missing repository bearer", http.StatusUnauthorized)
			return
		}
		backend.ServeHTTP(response, request)
	}))
	t.Cleanup(server.Close)

	runtime, err := processruntime.New(processruntime.Config{Root: t.TempDir(), MaxConcurrent: 2, OutputLimit: 1 << 20})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	host := &gitUserRefHost{t: t, bare: bare}
	service := NewWorkspaceService(db.New(pool), WithWorkspaceRuntime(runtime), WithWorkspaceTransactions(pool),
		WithWorkspaceGitBaseURL(server.URL+"/api"), WithWorkspaceUserRefs(host))
	input := CreateWorkspaceInput{RepositoryID: repositoryID, UserID: aliceID, RepoOwner: slug.OwnerSlug, RepoName: slug.RepoName,
		Name: "spike", SourceRef: "spike"}

	created, err := service.CreateWorkspace(ctx, input)
	require.NoError(t, err)
	require.Equal(t, "running", created.Status)
	require.Equal(t, pushed, created.SourceCommit)
	require.Equal(t, "main", created.TargetBookmark)
	require.Equal(t, []repohost.RetainUserRefRequest{{Name: "spike", WorkspaceID: created.ID}}, host.retained)
	jjParent := func(workspaceID string) string {
		result, err := runtime.ExecuteCommand(ctx, workspaceID, workspaceapi.Command{
			Args: []string{"jj", "log", "--no-graph", "-r", "@-", "-T", "commit_id"}})
		require.NoError(t, err)
		require.Zero(t, result.ExitCode, result.Stderr)
		return strings.TrimSpace(result.Stdout)
	}
	require.Equal(t, pushed, jjParent(created.ID))
	readme, err := runtime.ReadFile(ctx, created.ID, "README.md")
	require.NoError(t, err)
	require.Equal(t, "pushed work\n", string(readme))
	var stored string
	require.NoError(t, pool.QueryRow(ctx, `SELECT source_commit FROM workspaces WHERE id = $1`, created.ID).Scan(&stored))
	require.Equal(t, pushed, stored)

	// A restart trusts the receipt, which records the pinned commit.
	row, err := db.New(pool).GetWorkspace(ctx, created.ID)
	require.NoError(t, err)
	require.NoError(t, service.ensureRuntimeWorkspaceRepository(ctx, row, aliceID))
	require.Equal(t, pushed, jjParent(created.ID))

	// Like a fork, a pushed-ref workspace reserves no named identity: the
	// same request creates another workspace, and a bookmark workspace of
	// the same name still gets its own.
	again, err := service.CreateWorkspace(ctx, input)
	require.NoError(t, err)
	require.NotEqual(t, created.ID, again.ID)
	require.Equal(t, pushed, again.SourceCommit)
	plain, err := service.CreateWorkspace(ctx, CreateWorkspaceInput{RepositoryID: repositoryID, UserID: aliceID,
		RepoOwner: slug.OwnerSlug, RepoName: slug.RepoName, Name: "spike"})
	require.NoError(t, err)
	require.Empty(t, plain.SourceCommit)
	require.Equal(t, main, jjParent(plain.ID))

	countWorkspaces := func() int {
		var count int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE repository_id = $1`, repositoryID).Scan(&count))
		return count
	}
	before, retains := countWorkspaces(), len(host.retained)

	// Bob's request resolves only in his own namespace: Alice's ref is missing.
	_, err = service.CreateWorkspace(ctx, CreateWorkspaceInput{RepositoryID: repositoryID, UserID: bobID,
		RepoOwner: slug.OwnerSlug, RepoName: slug.RepoName, SourceRef: "spike"})
	requireAPICode(t, err, pkgerrors.CodeUserRefMissing)
	// A malformed name or a snapshot restore is refused before the host.
	_, err = service.CreateWorkspace(ctx, CreateWorkspaceInput{RepositoryID: repositoryID, UserID: aliceID,
		RepoOwner: slug.OwnerSlug, RepoName: slug.RepoName, SourceRef: "../spike"})
	requireAPICode(t, err, pkgerrors.CodeBadRequest)
	_, err = service.CreateWorkspace(ctx, CreateWorkspaceInput{RepositoryID: repositoryID, UserID: aliceID,
		RepoOwner: slug.OwnerSlug, RepoName: slug.RepoName, SourceRef: "spike", SnapshotID: created.ID})
	requireAPICode(t, err, pkgerrors.CodeBadRequest)
	require.Len(t, host.retained, retains+1)

	// A repository that lands through its mythical stack refuses a named ref.
	_, err = pool.Exec(ctx, `INSERT INTO mythical_stacks(repository_id, actor_user_id) VALUES ($1, $2)`, repositoryID, aliceID)
	require.NoError(t, err)
	_, err = service.CreateWorkspaceAsync(ctx, input)
	requireAPICode(t, err, pkgerrors.CodeUserRefStack)
	require.Len(t, host.retained, retains+1)
	require.Equal(t, before, countWorkspaces())
}

// A pushed-ref VM clone fetches the pinned source ref and starts the working
// copy at its commit, as shallow as the clone.
func TestWorkspaceCloneCommandChecksOutPinnedSource(t *testing.T) {
	commit := strings.Repeat("a", 40)
	row := db.Workspace{ID: "11111111-2222-3333-4444-555555555555", SourceCommit: commit}
	source := workspaceCloneSourceOf(row)
	require.Equal(t, workspaceCloneSource{Ref: repohost.WorkspaceSourceRef(row.ID, commit), Commit: commit}, source)
	command := buildWorkspaceCloneCommand("https://git.test/o/r.git", "tok", "main", 0, source)
	require.Contains(t, command, "fetch --depth=")
	require.Contains(t, command, " origin "+shellQuote(source.Ref))
	require.Contains(t, command, "checkout --detach "+shellQuote(commit))
	require.Less(t, strings.Index(command, "checkout --detach"), strings.Index(command, "jj git init"))
	require.True(t, strings.HasSuffix(command, " new "+shellQuote(commit)), command)
	require.NotContains(t, command, " new 'main'")
	full := buildWorkspaceCloneCommand("https://git.test/o/r.git", "tok", "main", -1, source)
	require.Contains(t, full, "fetch origin "+shellQuote(source.Ref))

	plain := buildWorkspaceCloneCommand("https://git.test/o/r.git", "tok", "main", 0, workspaceCloneSourceOf(db.Workspace{ID: row.ID}))
	require.NotContains(t, plain, "/sources/")
	require.True(t, strings.HasSuffix(plain, " new 'main'"), plain)
}

// A pushed-ref workspace never adopts a receipt for a different start.
func TestWorkspaceRepositoryReceiptBindsPushedRefCommit(t *testing.T) {
	commit := strings.Repeat("b", 40)
	row := db.Workspace{ID: "w", RepositoryID: 7, SourceCommit: commit}
	receipt := workspaceRepositoryReceipt{Version: workspaceRepositoryReceiptVersion, WorkspaceID: "w", RepositoryID: 7,
		CloneURL: "https://git.test/o/r.git", SourceBookmark: "main", SourceRevision: strings.Repeat("c", 40),
		SourceCommit: commit, InitializedAt: time.Now()}
	require.NoError(t, validateWorkspaceRepositoryReceiptSource(receipt, row, receipt.CloneURL, "main"))
	receipt.SourceCommit = ""
	requireAPICode(t, validateWorkspaceRepositoryReceiptSource(receipt, row, receipt.CloneURL, "main"), pkgerrors.CodeConflict)
	receipt.SourceCommit = strings.Repeat("d", 40)
	requireAPICode(t, validateWorkspaceRepositoryReceiptSource(receipt, row, receipt.CloneURL, "main"), pkgerrors.CodeConflict)
	// A bookmark workspace (or a fork of a pushed-ref one) keeps its receipt.
	row.SourceCommit = ""
	require.NoError(t, validateWorkspaceRepositoryReceiptSource(receipt, row, receipt.CloneURL, "main"))
}

package services

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	processruntime "github.com/smithersai/smithers/packages/backend/process"
)

type runtimeRepositoryQuerier struct {
	*mockWorkspaceQuerier
	owner                string
	repo                 string
	linkAgentWorkspaceFn func(context.Context, db.SetAgentSessionWorkspaceParams) error
}

func (q *runtimeRepositoryQuerier) GetRepoOwnerSlugAndNameByID(context.Context, int64) (db.GetRepoOwnerSlugAndNameByIDRow, error) {
	return db.GetRepoOwnerSlugAndNameByIDRow{OwnerSlug: q.owner, RepoName: q.repo}, nil
}

func (q *runtimeRepositoryQuerier) SetAgentSessionWorkspace(ctx context.Context, input db.SetAgentSessionWorkspaceParams) error {
	return q.linkAgentWorkspaceFn(ctx, input)
}

func (q *runtimeRepositoryQuerier) ListRunningWorkspacesForUserRepoBookmark(context.Context, db.ListRunningWorkspacesForUserRepoBookmarkParams) ([]db.Workspace, error) {
	return nil, nil
}

func TestRuntimeWorkspaceInitializesRepositoryBeforeRunningAndReusesReceipt(t *testing.T) {
	requireExecutable(t, "git")
	requireExecutable(t, "jj")

	const owner, repo = "alice", "fixture"
	gitRoot := t.TempDir()
	seedBareRepository(t, filepath.Join(gitRoot, "api", owner, repo+".git"), "main")

	var authMu sync.Mutex
	authenticatedRequests := 0
	gitExecutable, err := exec.LookPath("git")
	require.NoError(t, err)
	backend := &cgi.Handler{
		Path: gitExecutable, Args: []string{"http-backend"}, Dir: gitRoot,
		Env: []string{"GIT_PROJECT_ROOT=" + gitRoot, "GIT_HTTP_EXPORT_ALL=1"},
	}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		authorization := request.Header.Get("Authorization")
		if !strings.HasPrefix(authorization, "Bearer ") || strings.TrimSpace(strings.TrimPrefix(authorization, "Bearer ")) == "" {
			http.Error(response, "missing repository bearer", http.StatusUnauthorized)
			return
		}
		authMu.Lock()
		authenticatedRequests++
		authMu.Unlock()
		backend.ServeHTTP(response, request)
	}))
	t.Cleanup(server.Close)

	row := sampleDBWorkspace("runtime-repository")
	row.Status = "starting"
	row.VmID = ""
	current := row
	issued, revoked := 0, 0
	mock := &mockWorkspaceQuerier{}
	mock.getWorkspaceFn = func(context.Context, string) (db.Workspace, error) { return current, nil }
	mock.updateWorkspaceStatusFn = func(_ context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
		current.Status = arg.Status
		return current, nil
	}
	mock.createAccessTokenFn = func(context.Context, db.CreateAccessTokenParams) (db.AccessToken, error) {
		issued++
		return db.AccessToken{ID: int64(issued)}, nil
	}
	mock.deleteAccessTokenFn = func(context.Context, db.DeleteAccessTokenParams) error {
		revoked++
		return nil
	}
	queries := &runtimeRepositoryQuerier{mockWorkspaceQuerier: mock, owner: owner, repo: repo}
	runtime, err := processruntime.New(processruntime.Config{Root: t.TempDir(), MaxConcurrent: 2})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	service := newWorkspaceServiceForTests(queries, WithWorkspaceRuntime(runtime), WithWorkspaceGitBaseURL(server.URL+"/api"))

	initialized, err := service.ensureRuntimeWorkspaceRunningLocked(context.Background(), row, row.UserID)
	require.NoError(t, err)
	require.Equal(t, "running", initialized.Status)
	require.Equal(t, 1, issued)
	require.Equal(t, 1, revoked)
	authMu.Lock()
	require.Positive(t, authenticatedRequests)
	authMu.Unlock()

	readme, err := runtime.ReadFile(context.Background(), row.ID, "README.md")
	require.NoError(t, err)
	require.Equal(t, "runtime repository fixture\n", string(readme))
	receiptContents, err := runtime.ReadFile(context.Background(), row.ID, workspaceRepositoryReceiptPath)
	require.NoError(t, err)
	var receipt workspaceRepositoryReceipt
	require.NoError(t, json.Unmarshal(receiptContents, &receipt))
	require.Equal(t, row.ID, receipt.WorkspaceID)
	require.Equal(t, row.RepositoryID, receipt.RepositoryID)
	require.Equal(t, "main", receipt.SourceBookmark)
	require.True(t, isLowerHexRevision(receipt.SourceRevision))
	revision, err := runtime.ResolveWorkspaceSourceRevision(context.Background(), row.ID)
	require.NoError(t, err)
	require.True(t, isLowerHexRevision(revision))

	// A later resume trusts the matching durable receipt and verifies the
	// origin. It neither obtains another credential nor resets user files.
	require.NoError(t, runtime.WriteFile(context.Background(), row.ID, "user-work.txt", []byte("keep me\n"), 0o600))
	resumed, err := service.ensureRuntimeWorkspaceRunningLocked(context.Background(), initialized, row.UserID)
	require.NoError(t, err)
	require.Equal(t, "running", resumed.Status)
	require.Equal(t, 1, issued)
	preserved, err := runtime.ReadFile(context.Background(), row.ID, "user-work.txt")
	require.NoError(t, err)
	require.Equal(t, "keep me\n", string(preserved))

	// Repository initialization alone cannot authorize a TODO machine. The
	// composed install supplies its canonical branch providers; this isolated
	// legacy fixture must refuse before creating or linking another machine.
	mock.createWorkspaceFn = func(context.Context, db.CreateWorkspaceParams) (db.Workspace, error) {
		t.Fatal("missing branch authority must refuse before workspace creation")
		return db.Workspace{}, nil
	}
	queries.linkAgentWorkspaceFn = func(context.Context, db.SetAgentSessionWorkspaceParams) error {
		t.Fatal("missing branch authority must not attach a run")
		return nil
	}
	_, err = service.CreateAgentWorkspace(context.Background(), CreateAgentWorkspaceInput{
		RepositoryID: row.RepositoryID, UserID: row.UserID,
		SessionID: "12345678-1234-1234-1234-123456789abc",
		RepoOwner: owner, RepoName: repo, SourceBookmark: "main",
	})
	requireAPICode(t, err, pkgerrors.CodeServiceUnavailable)
	require.Equal(t, 1, issued)
	require.Equal(t, 1, revoked)
}

func requireExecutable(t *testing.T, name string) {
	t.Helper()
	if _, err := exec.LookPath(name); err != nil {
		t.Skipf("%s is required: %v", name, err)
	}
}

func seedBareRepository(t *testing.T, directory, bookmark string) {
	t.Helper()
	require.NoError(t, os.MkdirAll(filepath.Dir(directory), 0o700))
	runGitFixture(t, "", nil, "init", "--bare", "--initial-branch="+bookmark, directory)
	blob := strings.TrimSpace(runGitFixture(t, directory, strings.NewReader("runtime repository fixture\n"), "hash-object", "-w", "--stdin"))
	tree := strings.TrimSpace(runGitFixture(t, directory, strings.NewReader("100644 blob "+blob+"\tREADME.md\n"), "mktree"))
	commit := strings.TrimSpace(runGitFixture(t, directory, strings.NewReader("fixture\n"), "commit-tree", tree))
	runGitFixture(t, directory, nil, "update-ref", "refs/heads/"+bookmark, commit)
	runGitFixture(t, directory, nil, "symbolic-ref", "HEAD", "refs/heads/"+bookmark)
}

func runGitFixture(t *testing.T, gitDirectory string, stdin io.Reader, args ...string) string {
	t.Helper()
	if gitDirectory != "" {
		args = append([]string{"--git-dir=" + gitDirectory}, args...)
	}
	command := exec.Command("git", args...)
	command.Stdin = stdin
	command.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=Smithers Test", "GIT_AUTHOR_EMAIL=test@smithers.invalid", "GIT_AUTHOR_DATE=2020-01-01T00:00:00Z",
		"GIT_COMMITTER_NAME=Smithers Test", "GIT_COMMITTER_EMAIL=test@smithers.invalid", "GIT_COMMITTER_DATE=2020-01-01T00:00:00Z",
	)
	output, err := command.CombinedOutput()
	require.NoError(t, err, "%s", output)
	return string(output)
}

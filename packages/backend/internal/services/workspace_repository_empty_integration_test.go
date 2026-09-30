package services

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	processruntime "github.com/smithersai/smithers/packages/backend/process"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// Inject only a lost initialization-receipt write; every filesystem and
// execution operation otherwise uses the real process provider. This isolates
// the crash boundary without killing the test worker or corrupting shared disk.
type failFirstRepositoryReceiptRuntime struct {
	workspaceapi.WorkspaceRuntime
	failed atomic.Bool
}

func (r *failFirstRepositoryReceiptRuntime) WriteFile(ctx context.Context, id, path string, contents []byte, mode fs.FileMode) error {
	if path == workspaceRepositoryReceiptPath && !r.failed.Swap(true) {
		return errors.New("injected receipt write failure")
	}
	return r.WorkspaceRuntime.WriteFile(ctx, id, path, contents, mode)
}

// Inject bridge loss only after a real Git clone has completed with a failure.
// The continuation must retain its infrastructure classification, so the
// command worker retries without crossing the external-start fence.
type lostRepositoryContinuationRuntime struct {
	workspaceapi.WorkspaceRuntime
	cloneFailed bool
}

func (r *lostRepositoryContinuationRuntime) ExecuteCommand(ctx context.Context, id string, command workspaceapi.Command) (workspaceapi.CommandResult, error) {
	if len(command.Args) > 1 && command.Args[0] == "git" && command.Args[1] == "clone" {
		command.Args = append([]string(nil), command.Args...)
		for i := range command.Args {
			if command.Args[i] == "--branch" {
				command.Args[i+1] = "absent-continuation-test"
			}
		}
		result, err := r.WorkspaceRuntime.ExecuteCommand(ctx, id, command)
		r.cloneFailed = err == nil && result.ExitCode != 0
		return result, err
	}
	if r.cloneFailed && len(command.Args) > 3 && command.Args[0] == "git" && command.Args[1] == "remote" && command.Args[2] == "get-url" {
		return workspaceapi.CommandResult{}, lostWorkerRuntimeCause()
	}
	return r.WorkspaceRuntime.ExecuteCommand(ctx, id, command)
}

// PostgreSQL, authenticated smart HTTP, Git, Jujutsu and the process provider
// are real. The HTTP refusal and concurrent push are controlled fault inputs.
// A push that lands between the advertisement and the clone makes an ordinary
// checkout; unreceipted local history is refused, never adopted.
func TestWorkspaceEmptyRepositorySafety(t *testing.T) {
	requireExecutable(t, "git")
	requireExecutable(t, "jj")
	pool := newProductTestPool(t)
	ctx := context.Background()
	for _, scenario := range []string{"authentication-failure", "remote-gains-refs", "existing-history", "receipt-write-retry", "lost-clone-continuation"} {
		t.Run(scenario, func(t *testing.T) {
			userID, repositoryID := setupTestUserAndRepo(t, pool)
			q := db.New(pool)
			slug, err := q.GetRepoOwnerSlugAndNameByID(ctx, repositoryID)
			require.NoError(t, err)
			gitRoot := t.TempDir()
			bare := filepath.Join(gitRoot, "api", slug.OwnerSlug, slug.RepoName+".git")
			require.NoError(t, os.MkdirAll(filepath.Dir(bare), 0o700))
			runGitFixture(t, "", nil, "init", "--bare", "--initial-branch=main", bare)
			if scenario == "lost-clone-continuation" {
				seedBareRepository(t, bare, "main")
			}
			gitExecutable, err := exec.LookPath("git")
			require.NoError(t, err)
			backend := &cgi.Handler{Path: gitExecutable, Args: []string{"http-backend"}, Dir: gitRoot,
				Env: []string{"GIT_PROJECT_ROOT=" + gitRoot, "GIT_HTTP_EXPORT_ALL=1"}}
			var advertisements atomic.Int32
			var authenticated atomic.Bool
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
					authenticated.Store(true)
				} else {
					http.Error(w, "missing bearer", http.StatusUnauthorized)
					return
				}
				if scenario == "authentication-failure" {
					http.Error(w, "expired bearer", http.StatusUnauthorized)
					return
				}
				if strings.HasSuffix(r.URL.Path, "/info/refs") && advertisements.Add(1) == 2 && scenario == "remote-gains-refs" {
					seedBareRepository(t, bare, "main")
				}
				backend.ServeHTTP(w, r)
			}))
			t.Cleanup(server.Close)
			id := uuid.NewString()
			_, err = pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,name,kind,status,target_bookmark) VALUES($1,$2,$3,$4,'container','running','main')`, id, repositoryID, userID, id)
			require.NoError(t, err)
			row, err := q.GetWorkspace(ctx, id)
			require.NoError(t, err)
			runtime, err := processruntime.New(processruntime.Config{Root: t.TempDir()})
			require.NoError(t, err)
			t.Cleanup(func() { require.NoError(t, runtime.Close()) })
			_, err = runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: id})
			require.NoError(t, err)
			_, err = runtime.StartWorkspace(ctx, id)
			require.NoError(t, err)
			run := func(args ...string) string {
				t.Helper()
				result, err := runtime.ExecuteCommand(ctx, id, workspaceapi.Command{Args: args})
				require.NoError(t, err)
				require.Equal(t, 0, result.ExitCode, result.Stderr)
				return result.Stdout
			}
			origin := server.URL + "/api/" + slug.OwnerSlug + "/" + slug.RepoName + ".git"
			var head, jjOperation string
			if scenario == "existing-history" {
				run("git", "init", "--initial-branch=user-work", ".")
				run("git", "remote", "add", "origin", origin)
				require.NoError(t, runtime.WriteFile(ctx, id, "user-work.txt", []byte("preserve local history\n"), 0o644))
				run("git", "add", "user-work.txt")
				run("git", "-c", "user.name=User", "-c", "user.email=user@example.test", "commit", "-m", "User history")
				run("jj", "git", "init", "--colocate", ".")
				head = run("git", "rev-parse", "HEAD")
				jjOperation = run("jj", "op", "log", "--ignore-working-copy", "--no-graph", "-n", "1", "-T", "id")
			}
			var serviceRuntime workspaceapi.WorkspaceRuntime = runtime
			if scenario == "receipt-write-retry" {
				serviceRuntime = &failFirstRepositoryReceiptRuntime{WorkspaceRuntime: runtime}
			}
			if scenario == "lost-clone-continuation" {
				serviceRuntime = &lostRepositoryContinuationRuntime{WorkspaceRuntime: runtime}
			}
			service := NewWorkspaceService(q, WithWorkspaceRuntime(serviceRuntime), WithWorkspaceGitBaseURL(server.URL+"/api"))
			err = service.ensureRuntimeWorkspaceRepository(ctx, row, userID)
			if scenario == "remote-gains-refs" {
				require.NoError(t, err)
				require.GreaterOrEqual(t, advertisements.Load(), int32(2))
				seeded := strings.TrimSpace(runGitFixture(t, bare, nil, "rev-parse", "refs/heads/main"))
				contents, err := runtime.ReadFile(ctx, id, workspaceRepositoryReceiptPath)
				require.NoError(t, err)
				var receipt workspaceRepositoryReceipt
				require.NoError(t, json.Unmarshal(contents, &receipt))
				require.Equal(t, seeded, receipt.SourceRevision)
				return
			}
			require.Error(t, err, "unsafe fallback must not issue a usable workspace receipt")
			require.True(t, authenticated.Load())
			if scenario == "lost-clone-continuation" {
				requireLostWorkerRuntimeFailure(t, err)
				require.False(t, errors.Is(err, errWorkspaceRepositoryPreparationRefused))
				return
			}
			if scenario == "receipt-write-retry" {
				before := run("jj", "op", "log", "--ignore-working-copy", "--no-graph", "-n", "1", "-T", "id")
				// Make the internal keep-ref case explicit across JJ versions.
				working := strings.TrimSpace(run("jj", "log", "--ignore-working-copy", "--no-graph", "-r", "@", "-T", "commit_id"))
				run("git", "update-ref", "refs/jj/keep/"+working, working)
				require.NoError(t, runtime.WriteFile(ctx, id, "user-work.txt", []byte("preserve retry work\n"), 0o644))
				require.NoError(t, service.ensureRuntimeWorkspaceRepository(ctx, row, userID))
				require.Equal(t, before, run("jj", "op", "log", "--ignore-working-copy", "--no-graph", "-n", "1", "-T", "id"))
				contents, err := runtime.ReadFile(ctx, id, "user-work.txt")
				require.NoError(t, err)
				require.Equal(t, "preserve retry work\n", string(contents))
				contents, err = runtime.ReadFile(ctx, id, workspaceRepositoryReceiptPath)
				require.NoError(t, err)
				var receipt workspaceRepositoryReceipt
				require.NoError(t, json.Unmarshal(contents, &receipt))
				require.Equal(t, emptyWorkspaceSourceRevision, receipt.SourceRevision)
				return
			}
			entries, err := runtime.ListFiles(ctx, id, "")
			require.NoError(t, err)
			if scenario == "authentication-failure" {
				require.Empty(t, entries, "failed advertisement must not initialize a checkout")
			} else {
				_, err := runtime.ReadFile(ctx, id, workspaceRepositoryReceiptPath)
				require.Error(t, err, "no source receipt may misrepresent the remote as empty")
			}
			if scenario == "existing-history" {
				require.Equal(t, head, run("git", "rev-parse", "HEAD"))
				require.Equal(t, jjOperation, run("jj", "op", "log", "--ignore-working-copy", "--no-graph", "-n", "1", "-T", "id"))
				contents, err := runtime.ReadFile(ctx, id, "user-work.txt")
				require.NoError(t, err)
				require.Equal(t, "preserve local history\n", string(contents))
			}
		})
	}
}

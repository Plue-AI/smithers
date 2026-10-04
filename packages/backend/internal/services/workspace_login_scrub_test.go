package services

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// Synthetic vendor logins a person makes inside their own workspace (#2805).
var syntheticWorkspaceLogins = map[string]string{
	".claude/.credentials.json": `{"claudeAiOauth":{"refreshToken":"rt-owner"}}`,
	".claude.json":              `{"oauthAccount":{"emailAddress":"owner@example.com"}}`,
	".codex/auth.json":          `{"tokens":{"refresh_token":"rt-owner"}}`,
	".config/anthropic/key":     "sk-owner",
}

// Workspace state a sign-out must keep.
const keptWorkspaceSetting = ".claude/settings.json"

func writeSyntheticLogins(t *testing.T, home string) {
	t.Helper()
	for rel, content := range syntheticWorkspaceLogins {
		path := filepath.Join(home, rel)
		require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o700))
		require.NoError(t, os.WriteFile(path, []byte(content), 0o600))
	}
	require.NoError(t, os.WriteFile(filepath.Join(home, keptWorkspaceSetting), []byte(`{"theme":"dark"}`), 0o600))
}

func requireSignedIn(t *testing.T, home string) {
	t.Helper()
	for rel, content := range syntheticWorkspaceLogins {
		got, err := os.ReadFile(filepath.Join(home, rel))
		require.NoError(t, err, rel)
		require.Equal(t, content, string(got), rel)
	}
}

func requireSignedOut(t *testing.T, home string) {
	t.Helper()
	for rel := range syntheticWorkspaceLogins {
		_, err := os.Lstat(filepath.Join(home, rel))
		require.ErrorIs(t, err, os.ErrNotExist, "%s must not survive into a derived workspace", rel)
	}
	for _, rel := range workspaceVendorLoginPaths {
		_, err := os.Lstat(filepath.Join(home, rel))
		require.ErrorIs(t, err, os.ErrNotExist, rel)
	}
	_, err := os.Stat(filepath.Join(home, keptWorkspaceSetting))
	require.NoError(t, err, "a sign-out keeps workspace settings")
}

func runLoginScrubScript(t *testing.T, env []string, args ...string) (string, error) {
	t.Helper()
	cmd := exec.Command("/bin/sh", append([]string{"-c", workspaceLoginScrubScript(), "scrub"}, args...)...)
	cmd.Env = append([]string{"PATH=/usr/bin:/bin"}, env...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func TestWorkspaceLoginScrubScriptRemovesEveryVendorLogin(t *testing.T) {
	first, second := t.TempDir(), t.TempDir()
	writeSyntheticLogins(t, first)
	writeSyntheticLogins(t, second)
	// A symlinked login is removed as a link, not followed into its target.
	target := filepath.Join(t.TempDir(), "elsewhere.json")
	require.NoError(t, os.WriteFile(target, []byte("{}"), 0o600))
	require.NoError(t, os.Symlink(target, filepath.Join(first, ".claude.json.backup")))

	out, err := runLoginScrubScript(t, nil, first, filepath.Join(t.TempDir(), "missing"), second)
	require.NoError(t, err, out)
	requireSignedOut(t, first)
	requireSignedOut(t, second)
	_, err = os.Stat(target)
	require.NoError(t, err)

	// Idempotent: signing out a signed-out home succeeds.
	out, err = runLoginScrubScript(t, nil, first)
	require.NoError(t, err, out)
}

func TestWorkspaceLoginScrubScriptDefaultsToHome(t *testing.T) {
	home := t.TempDir()
	writeSyntheticLogins(t, home)
	out, err := runLoginScrubScript(t, []string{"HOME=" + home})
	require.NoError(t, err, out)
	requireSignedOut(t, home)
}

func TestWorkspaceLoginScrubScriptFailsWhenALoginRemains(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores the directory permission this case relies on")
	}
	home := t.TempDir()
	writeSyntheticLogins(t, home)
	codex := filepath.Join(home, ".codex")
	require.NoError(t, os.Chmod(codex, 0o500))
	t.Cleanup(func() { _ = os.Chmod(codex, 0o700) })
	out, err := runLoginScrubScript(t, nil, home)
	require.Error(t, err)
	require.Contains(t, out, "vendor login remains: "+home+"/.codex/auth.json")
}

func TestWorkspaceSandboxLoginScrubCommandNamesBothHomes(t *testing.T) {
	command := workspaceSandboxLoginScrubCommand()
	require.True(t, strings.HasPrefix(command, "/bin/sh -c "))
	require.True(t, strings.HasSuffix(command, " '/home/developer' '/root'"), command)
}

// Record every exec, including artifact commands the shared mock handles itself.
type loginRecordingSandboxClient struct {
	*mockWorkspaceSandboxVMClient
	record func(string, string)
}

func (c *loginRecordingSandboxClient) Execute(ctx context.Context, id string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
	c.record(id, req.Command)
	return c.mockWorkspaceSandboxVMClient.Execute(ctx, id, req)
}

// A Microsandbox fork runs the sign-out on the child guest before any setup,
// and a child that cannot be signed out is discarded for a fresh guest.
func TestSandboxForkSignsOutChildBeforeUse(t *testing.T) {
	for _, tc := range []struct {
		name      string
		scrubFail bool
	}{{name: "signed out"}, {name: "sign-out fails", scrubFail: true}} {
		t.Run(tc.name, func(t *testing.T) {
			source := sampleDBWorkspace("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
			source.VmID = "vm-source"
			source.Kind = "container"
			created := sampleDBWorkspace("11111111-2222-3333-4444-555555555555")
			created.Status = "starting"
			created.VmID = ""
			created.Kind = "container"
			var mu sync.Mutex
			var execs []string
			var deleted []string
			var cold int
			client := &mockWorkspaceSandboxVMClient{
				forkVMFn: func(context.Context, string, sandbox.ForkRequest) (sandbox.CreateResult, error) {
					return sandbox.CreateResult{ID: "vm-child"}, nil
				},
				createVMFn: func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
					mu.Lock()
					cold++
					mu.Unlock()
					return sandbox.CreateResult{ID: "vm-fresh"}, nil
				},
				execAwaitFn: func(_ context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
					status := int32(0)
					if tc.scrubFail && req.Command == workspaceSandboxLoginScrubCommand() {
						status = 1
					}
					return sandbox.ExecResult{StatusCode: &status, Stderr: "vendor login remains"}, nil
				},
				deleteVMFn: func(_ context.Context, vmID string) error {
					mu.Lock()
					deleted = append(deleted, vmID)
					mu.Unlock()
					return nil
				},
			}
			q := &mockWorkspaceQuerier{
				getWorkspaceFn: func(_ context.Context, id string) (db.Workspace, error) {
					if id == source.ID {
						return source, nil
					}
					return created, nil
				},
				getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) { return source, nil },
				createWorkspaceFn:    func(context.Context, db.CreateWorkspaceParams) (db.Workspace, error) { return created, nil },
			}
			service := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&loginRecordingSandboxClient{
				mockWorkspaceSandboxVMClient: client,
				record: func(id, command string) {
					mu.Lock()
					defer mu.Unlock()
					execs = append(execs, id+" "+command)
				},
			}))
			_, err := service.ForkWorkspace(context.Background(), ForkWorkspaceInput{RepositoryID: 101, UserID: 1, WorkspaceID: source.ID, Name: "branch"})
			require.NoError(t, err)
			require.NotEmpty(t, execs)
			require.Equal(t, "vm-child "+workspaceSandboxLoginScrubCommand(), execs[0], "sign-out is the first command on the child")
			if tc.scrubFail {
				for _, command := range execs[1:] {
					require.NotContains(t, command, "vm-child ", "a signed-in child never runs bootstrap")
				}
				require.Contains(t, deleted, "vm-child", "a child that stays signed in is discarded")
				require.Equal(t, 1, cold, "the fork falls back to a fresh guest")
			} else {
				require.NotContains(t, deleted, "vm-child")
				require.Zero(t, cold)
			}
		})
	}
}

// A Microsandbox snapshot restore signs the restored guest out; one that
// cannot be signed out is discarded and the restore fails.
func TestSandboxSnapshotRestoreSignsOut(t *testing.T) {
	for _, scrubFail := range []bool{false, true} {
		row := sampleDBWorkspace("ws-restore")
		row.Status = "starting"
		row.VmID = ""
		snapshot := sampleDBWorkspaceSnapshot("cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa", "ws-source", "checkpoint", "provider-snap")
		var execs, deleted []string
		client := &mockWorkspaceSandboxVMClient{
			createVMFn: func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
				return sandbox.CreateResult{ID: "vm-restored"}, nil
			},
			execAwaitFn: func(_ context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
				status := int32(0)
				if scrubFail {
					status = 1
				}
				return sandbox.ExecResult{StatusCode: &status}, nil
			},
			deleteVMFn: func(_ context.Context, vmID string) error { deleted = append(deleted, vmID); return nil },
		}
		service := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(&loginRecordingSandboxClient{
			mockWorkspaceSandboxVMClient: client,
			record:                       func(id, command string) { execs = append(execs, id+" "+command) },
		}))
		_, err := service.createWorkspaceVMFromSnapshot(context.Background(), row, snapshot)
		require.NotEmpty(t, execs)
		require.Equal(t, []string{"vm-restored " + workspaceSandboxLoginScrubCommand()}, execs[:1])
		if scrubFail {
			require.Len(t, execs, 1, "a restored guest that stays signed in never runs bootstrap")
			require.Error(t, err)
			require.Equal(t, []string{"vm-restored"}, deleted)
		} else {
			require.NoError(t, err)
			require.Empty(t, deleted)
		}
	}
}

// loginRuntime is a workspace runtime whose workspaces are real directories:
// each has a home the scrub runs in with /bin/sh, and a cold snapshot or fork
// copies the whole directory like a disk image. Repository metadata is
// synthetic; only the files a person signs in with are real.
type loginRuntime struct {
	workspaceapi.WorkspaceRuntime
	root         string
	repositoryID int64
	cloneURL     string

	mu    sync.Mutex
	state map[string]workspaceapi.WorkspaceState
}

func newLoginRuntime(t *testing.T, repositoryID int64, cloneURL string) *loginRuntime {
	return &loginRuntime{root: t.TempDir(), repositoryID: repositoryID, cloneURL: cloneURL, state: map[string]workspaceapi.WorkspaceState{}}
}

func (r *loginRuntime) workspaceDir(id string) string { return filepath.Join(r.root, "workspaces", id) }
func (r *loginRuntime) home(id string) string         { return filepath.Join(r.workspaceDir(id), "home") }
func (r *loginRuntime) snapshotDir(id string) string  { return filepath.Join(r.root, "snapshots", id) }

func (r *loginRuntime) set(id string, state workspaceapi.WorkspaceState) workspaceapi.Workspace {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.state[id] = state
	return workspaceapi.Workspace{ID: id, Home: r.home(id), State: state}
}

func (*loginRuntime) Isolation() workspaceapi.IsolationLevel { return workspaceapi.IsolationSandboxed }

func (*loginRuntime) Capabilities() workspaceapi.WorkspaceCapabilities {
	return workspaceapi.WorkspaceCapabilities{PersistentFiles: true, Execution: true, FileOperations: true, ColdSnapshots: true}
}

func (r *loginRuntime) CreateWorkspace(_ context.Context, spec workspaceapi.WorkspaceSpec) (workspaceapi.Workspace, error) {
	if err := os.MkdirAll(r.home(spec.ID), 0o700); err != nil {
		return workspaceapi.Workspace{}, err
	}
	return r.set(spec.ID, workspaceapi.WorkspaceRunning), nil
}

func (r *loginRuntime) InspectWorkspace(_ context.Context, id string) (workspaceapi.Workspace, error) {
	r.mu.Lock()
	state, ok := r.state[id]
	r.mu.Unlock()
	if !ok {
		return workspaceapi.Workspace{}, workspaceapi.ErrWorkspaceNotFound
	}
	return workspaceapi.Workspace{ID: id, Home: r.home(id), State: state}, nil
}

func (r *loginRuntime) StartWorkspace(_ context.Context, id string) (workspaceapi.Workspace, error) {
	return r.set(id, workspaceapi.WorkspaceRunning), nil
}

func (r *loginRuntime) StopWorkspace(_ context.Context, id string) error {
	r.set(id, workspaceapi.WorkspaceStopped)
	return nil
}

func (r *loginRuntime) DeleteWorkspace(_ context.Context, id string) error {
	r.mu.Lock()
	delete(r.state, id)
	r.mu.Unlock()
	return os.RemoveAll(r.workspaceDir(id))
}

func (r *loginRuntime) CreateColdSnapshot(_ context.Context, source string, spec workspaceapi.ColdSnapshotSpec) (workspaceapi.ColdSnapshot, error) {
	if err := os.CopyFS(r.snapshotDir(spec.ID), os.DirFS(r.workspaceDir(source))); err != nil {
		return workspaceapi.ColdSnapshot{}, err
	}
	return workspaceapi.ColdSnapshot{ID: spec.ID, SourceWorkspaceID: source}, nil
}

func (r *loginRuntime) ForkColdSnapshot(_ context.Context, snapshotID string, spec workspaceapi.WorkspaceSpec) (workspaceapi.Workspace, error) {
	if err := os.CopyFS(r.workspaceDir(spec.ID), os.DirFS(r.snapshotDir(snapshotID))); err != nil {
		return workspaceapi.Workspace{}, err
	}
	return r.set(spec.ID, workspaceapi.WorkspaceStopped), nil
}

func (r *loginRuntime) DeleteColdSnapshot(_ context.Context, snapshotID string) error {
	return os.RemoveAll(r.snapshotDir(snapshotID))
}

func (*loginRuntime) ListFiles(_ context.Context, _, path string) ([]workspaceapi.FileEntry, error) {
	if path == ".git" {
		return []workspaceapi.FileEntry{{Name: "smithers-workspace-initialization.json"}}, nil
	}
	return []workspaceapi.FileEntry{{Name: ".git", IsDir: true}, {Name: ".jj", IsDir: true}}, nil
}

func (r *loginRuntime) ReadFile(_ context.Context, workspaceID, _ string) ([]byte, error) {
	return json.Marshal(workspaceRepositoryReceipt{Version: workspaceRepositoryReceiptVersion, WorkspaceID: workspaceID,
		RepositoryID: r.repositoryID, CloneURL: r.cloneURL, SourceBookmark: "main",
		SourceRevision: strings.Repeat("a", 40), InitializedAt: time.Now().UTC()})
}

func (*loginRuntime) WriteFile(context.Context, string, string, []byte, os.FileMode) error {
	return nil
}

func (r *loginRuntime) ExecuteCommand(ctx context.Context, workspaceID string, command workspaceapi.Command) (workspaceapi.CommandResult, error) {
	switch {
	case len(command.Args) >= 2 && command.Args[0] == "git" && command.Args[1] == "remote":
		return workspaceapi.CommandResult{Stdout: r.cloneURL + "\n"}, nil
	case len(command.Args) > 0 && command.Args[0] == "/bin/sh":
		cmd := exec.CommandContext(ctx, "/bin/sh", command.Args[1:]...)
		cmd.Dir = r.workspaceDir(workspaceID)
		cmd.Env = []string{"PATH=/usr/bin:/bin", "HOME=" + r.home(workspaceID)}
		var stderr strings.Builder
		cmd.Stderr = &stderr
		err := cmd.Run()
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return workspaceapi.CommandResult{ExitCode: exitErr.ExitCode(), Stderr: stderr.String()}, nil
		}
		return workspaceapi.CommandResult{Stderr: stderr.String()}, err
	}
	return workspaceapi.CommandResult{}, nil
}

// A runtime fork refuses without touching the owner's logins. Snapshot
// restores, including a write-share user's restore, start signed out. Real
// PostgreSQL holds identity, shares and snapshots.
func TestDerivedWorkspacesStartSignedOut(t *testing.T) {
	pool := newProductTestPool(t)
	owner, repo := setupTestUserAndRepo(t, pool)
	grantee, _ := setupTestUserAndRepo(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	queries := db.New(pool)
	slug, err := queries.GetRepoOwnerSlugAndNameByID(ctx, repo)
	require.NoError(t, err)
	runtime := newLoginRuntime(t, repo, testWorkspaceGitBaseURL+"/"+slug.OwnerSlug+"/"+slug.RepoName+".git")
	svc := NewWorkspaceService(queries, WithWorkspaceGitBaseURL(testWorkspaceGitBaseURL), WithWorkspaceRuntime(runtime))

	parent, err := svc.CreateWorkspace(ctx, CreateWorkspaceInput{RepositoryID: repo, UserID: owner, RepoOwner: slug.OwnerSlug, RepoName: slug.RepoName, Name: "main"})
	require.NoError(t, err)
	require.Equal(t, "running", parent.Status)
	writeSyntheticLogins(t, runtime.home(parent.ID))

	_, err = svc.ForkWorkspace(ctx, ForkWorkspaceInput{RepositoryID: repo, UserID: owner, WorkspaceID: parent.ID, Name: "child"})
	require.ErrorContains(t, err, "revision-based fork unavailable")
	requireSignedIn(t, runtime.home(parent.ID))

	snapshot, err := svc.CreateWorkspaceSnapshot(ctx, CreateWorkspaceSnapshotInput{RepositoryID: repo, UserID: owner, WorkspaceID: parent.ID, Name: "checkpoint"})
	require.NoError(t, err)
	requireSignedIn(t, runtime.home(parent.ID))
	requireSignedIn(t, filepath.Join(runtime.snapshotDir(snapshot.SnapshotID), "home"))

	restored, err := svc.CreateWorkspace(ctx, CreateWorkspaceInput{RepositoryID: repo, UserID: owner, RepoOwner: slug.OwnerSlug, RepoName: slug.RepoName, Name: "restored", SnapshotID: snapshot.ID})
	require.NoError(t, err)
	requireSignedOut(t, runtime.home(restored.ID))

	// A write-share user may restore the owner's snapshot; the owner's
	// logins never reach them.
	_, err = queries.UpsertWorkspaceShare(ctx, db.UpsertWorkspaceShareParams{WorkspaceID: parent.ID, OwnerUserID: owner, GranteeUserID: grantee, Level: string(WorkspaceAccessWrite)})
	require.NoError(t, err)
	shared, err := svc.CreateWorkspace(ctx, CreateWorkspaceInput{RepositoryID: repo, UserID: grantee, RepoOwner: slug.OwnerSlug, RepoName: slug.RepoName, Name: "shared", SnapshotID: snapshot.ID})
	require.NoError(t, err)
	require.Equal(t, "running", shared.Status)
	requireSignedOut(t, runtime.home(shared.ID))
	requireSignedIn(t, runtime.home(parent.ID))
}

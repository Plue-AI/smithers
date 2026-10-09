package services

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/process"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// mainMachineRuntime is a real process workspace running real git and jj. It
// adds only the sandboxed runtime's admission, guest identity and protected
// host seams, which this test does not qualify.
type mainMachineRuntime struct{ *process.Runtime }

func (mainMachineRuntime) Isolation() workspaceapi.IsolationLevel {
	return workspaceapi.IsolationSandboxed
}
func (mainMachineRuntime) FreeDisk(context.Context) (int64, error) { return 1 << 40, nil }
func (mainMachineRuntime) CancelFailedAdmission(string, string)    {}
func (mainMachineRuntime) WaitAdmission(ctx context.Context, _ microsandbox.AdmissionProviders, _, _, _, _ string) (context.Context, error) {
	return ctx, nil
}
func (mainMachineRuntime) WorkspaceMachineIdentity(_ context.Context, id string) (string, error) {
	return id, nil
}
func (mainMachineRuntime) GuestIdentity() (string, int)                            { return "agent", 19999 }
func (mainMachineRuntime) ProtectedManagedHostReady(context.Context, string) error { return nil }

// The manual main machine sets itself up in PrepareMainMachine, so it ends
// with the receipt a Flow host start waits for, as branch setup does. The bare
// repository plays the install's git endpoint, the only test port.
func TestPrepareMainMachineWritesInitializationReceipt(t *testing.T) {
	if _, err := exec.LookPath("jj"); err != nil {
		t.Skip("jj is required for the machine's working copy")
	}
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	ctx := t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "main-machine-owner", LowerUsername: "main-machine-owner", DisplayName: "Owner"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)

	endpoint, work := t.TempDir(), t.TempDir()
	bare := filepath.Join(endpoint, "main-machine-owner", "app.git")
	require.NoError(t, os.MkdirAll(bare, 0o700))
	reviewGit(t, bare, "init", "--quiet", "--bare")
	reviewGit(t, work, "init", "--quiet", "-b", "main")
	require.NoError(t, os.WriteFile(filepath.Join(work, "deploy.ts"), []byte("export const target = 'production'\n"), 0o600))
	reviewGit(t, work, "add", ".")
	reviewGit(t, work, "commit", "--quiet", "-m", "Deploy")
	reviewGit(t, work, "push", "--quiet", bare, "HEAD:refs/heads/main")
	revision := reviewGit(t, work, "rev-parse", "HEAD")
	gitConfig := filepath.Join(t.TempDir(), "gitconfig")
	require.NoError(t, os.WriteFile(gitConfig, []byte("[url \"file://"+endpoint+"/\"]\n\tinsteadOf = http://git.test/\n"), 0o600))

	root, err := filepath.EvalSymlinks(t.TempDir())
	require.NoError(t, err)
	runtime, err := process.New(process.Config{Root: root, Environment: map[string]string{"PATH": os.Getenv("PATH"), "GIT_CONFIG_GLOBAL": gitConfig}})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	service := NewWorkspaceService(q, WithWorkspaceRuntime(mainMachineRuntime{runtime}), WithWorkspaceGitBaseURL("http://git.test"))
	workspaceID := uuid.NewString()
	_, err = pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,name,status,kind) VALUES($1,$2,$3,'manual-main','starting','vm')`, workspaceID, repo.ID, owner.ID)
	require.NoError(t, err)
	authority := flowhost.Authority{RepositoryID: repo.ID, UserID: owner.ID, WorkspaceID: workspaceID, SourceRevision: revision}
	gate := func() error { return service.FlowHostWorkspaceInitialized(ctx, authority) }

	require.NoError(t, service.PrepareMainMachine(ctx, workspaceID, repo.ID, owner.ID, revision))
	head, err := workspaceapi.ResolveSourceRevision(ctx, runtime, workspaceID)
	require.NoError(t, err)
	require.Equal(t, revision, head)
	receipt, err := runtime.ReadFile(ctx, workspaceID, workspaceRepositoryReceiptPath)
	require.NoError(t, err, "a main machine that never writes its receipt is refused workspace_initializing forever")
	require.True(t, completedWorkspaceReceipt(receipt, workspaceID, repo.ID), string(receipt))
	require.Contains(t, string(receipt), `"source_revision":"`+revision+`"`)
	require.NoError(t, gate(), "the Flow host gate accepts what PrepareMainMachine wrote")

	// A machine already at the revision skips the fetch; it still ends with
	// the receipt, so a machine prepared before this receipt existed recovers.
	require.NoError(t, runtime.RemoveFile(ctx, workspaceID, workspaceRepositoryReceiptPath))
	require.Error(t, gate())
	require.NoError(t, service.PrepareMainMachine(ctx, workspaceID, repo.ID, owner.ID, revision))
	require.NoError(t, gate())
}

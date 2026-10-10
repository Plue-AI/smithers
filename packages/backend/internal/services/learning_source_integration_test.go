package services

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/process"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// The bare repository plays the install's git endpoint, the only test port.
// The machine is a real process workspace running real git and jj, and the
// read token is a real row. It does not qualify the microVM's unprivileged user.
func TestLearningSourceRestoresPinnedMerge(t *testing.T) {
	if _, err := exec.LookPath("jj"); err != nil {
		t.Skip("jj is required for the machine's working copy")
	}
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	ctx := t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "learning-source-owner", LowerUsername: "learning-source-owner", DisplayName: "Owner"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)

	work, bare := t.TempDir(), t.TempDir()
	reviewGit(t, bare, "init", "--quiet", "--bare")
	reviewGit(t, work, "init", "--quiet", "-b", "main")
	require.NoError(t, os.WriteFile(filepath.Join(work, "retry.ts"), []byte("export const retry = 'fixed'\n"), 0o600))
	reviewGit(t, work, "add", ".")
	reviewGit(t, work, "commit", "--quiet", "-m", "Base")
	reviewGit(t, work, "push", "--quiet", bare, "HEAD:refs/heads/main")
	require.NoError(t, os.WriteFile(filepath.Join(work, "retry.ts"), []byte("export const retry = 'exponential'\n"), 0o600))
	reviewGit(t, work, "commit", "--quiet", "-am", "Retry webhook deliveries (#7)")
	merge := reviewGit(t, work, "rev-parse", "HEAD")
	pin := flowruntime.Pin{Flow: "learning", SourceCommit: merge, ExecutionDigest: strings.Repeat("c", 64)}

	root, err := filepath.EvalSymlinks(t.TempDir())
	require.NoError(t, err)
	machine, err := process.New(process.Config{Root: root, Environment: map[string]string{"PATH": os.Getenv("PATH")}})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, machine.Close()) })
	runtime := &exporterMachine{Runtime: machine}
	var cloned []string
	source := &LearningSource{q: q, runtime: runtime, clone: func(owner, repository string) (string, error) {
		cloned = append(cloned, owner+"/"+repository)
		return bare, nil
	}}

	t.Run("refuses before allocation", func(t *testing.T) {
		for name, tc := range map[string]struct {
			source *LearningSource
			pin    flowruntime.Pin
			code   string
		}{
			"no runtime":   {&LearningSource{q: q, clone: source.clone}, pin, "learning_source_unavailable"},
			"no endpoint":  {&LearningSource{q: q, runtime: runtime}, pin, "learning_source_unavailable"},
			"no exporter":  {&LearningSource{q: q, runtime: machine, clone: source.clone}, pin, "learning_source_unavailable"},
			"review pin":   {source, flowruntime.Pin{Flow: "review", SourceCommit: merge, ExecutionDigest: pin.ExecutionDigest}, "learning_binding_unavailable"},
			"invalid pin":  {source, flowruntime.Pin{Flow: "learning", SourceCommit: "main", ExecutionDigest: pin.ExecutionDigest}, "learning_binding_unavailable"},
			"absent pin":   {source, flowruntime.Pin{}, "learning_binding_unavailable"},
			"nil boundary": {nil, pin, "learning_source_unavailable"},
		} {
			t.Run(name, func(t *testing.T) {
				requireTodoControl(t, tc.source.Prepare(ctx, repo.ID, tc.pin), 503, tc.code)
			})
		}
		require.Empty(t, cloned)
	})

	workspaceID := "0b6f9f0e-3c1d-5e8a-9f42-6d1c7a2e4b10"
	_, err = runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: workspaceID})
	require.NoError(t, err)
	_, err = runtime.StartWorkspace(ctx, workspaceID)
	require.NoError(t, err)
	var tokens int
	countTokens := func() int {
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM access_tokens WHERE user_id=$1`, owner.ID).Scan(&tokens))
		return tokens
	}

	// GitHub merged, but the install's main has not followed yet.
	requireTodoControl(t, source.Restore(ctx, workspaceID, repo.ID, owner.ID, pin), 503, "learning_source_unavailable")
	require.Zero(t, countTokens(), "a refused restore revokes its read token")
	_, err = workspaceapi.ResolveSourceRevision(ctx, runtime, workspaceID)
	require.Error(t, err, "nothing is checked out before the merge is on main")
	_, err = runtime.ReadFile(ctx, workspaceID, workspaceRepositoryReceiptPath)
	require.Error(t, err, "a refused restore leaves the machine initializing")

	reviewGit(t, work, "push", "--quiet", bare, "HEAD:refs/heads/main")
	require.NoError(t, source.Restore(ctx, workspaceID, repo.ID, owner.ID, pin))
	// Restore is the learning machine's whole setup, so it ends with the
	// receipt a Flow host start waits for; without it run 12's learning
	// machine was refused workspace_initializing until its slot was taken.
	receipt, err := runtime.ReadFile(ctx, workspaceID, workspaceRepositoryReceiptPath)
	require.NoError(t, err)
	require.True(t, completedWorkspaceReceipt(receipt, workspaceID, repo.ID), string(receipt))
	require.Contains(t, string(receipt), `"source_revision":"`+merge+`"`)
	require.False(t, completedWorkspaceReceipt(receipt, workspaceID, repo.ID+1), "the receipt names its own repository")
	require.Equal(t, []string{"learning-source-owner/app", "learning-source-owner/app"}, cloned)
	// The coding host exports the pinned merge with the exporter, so Restore
	// plants it before the receipt; a refused restore plants nothing (#3783).
	require.Equal(t, []string{workspaceID}, runtime.planted)
	require.Equal(t, []bool{false}, runtime.receiptFirst, "the exporter is planted before the receipt")
	revision, err := workspaceapi.ResolveSourceRevision(ctx, runtime, workspaceID)
	require.NoError(t, err)
	require.Equal(t, merge, revision, "the machine's recorded revision is the pinned merge")
	data, err := runtime.ReadFile(ctx, workspaceID, "retry.ts")
	require.NoError(t, err)
	require.Equal(t, "export const retry = 'exponential'\n", string(data))
	remotes, err := runtime.ExecuteCommand(ctx, workspaceID, workspaceapi.Command{Args: []string{"git", "remote"}})
	require.NoError(t, err)
	require.Empty(t, strings.TrimSpace(remotes.Stdout), "no remote names a push destination")
	require.Zero(t, countTokens(), "the read token is revoked when restore returns")

	// A replay after a lost reply reuses the fetched merge: the endpoint is
	// not read again.
	source.clone = func(string, string) (string, error) { return "", errors.New("endpoint must not be read") }
	require.NoError(t, runtime.RemoveFile(ctx, workspaceID, workspaceRepositoryReceiptPath))
	require.NoError(t, source.Restore(context.WithoutCancel(ctx), workspaceID, repo.ID, owner.ID, pin))
	revision, err = workspaceapi.ResolveSourceRevision(ctx, runtime, workspaceID)
	require.NoError(t, err)
	require.Equal(t, merge, revision)
	receipt, err = runtime.ReadFile(ctx, workspaceID, workspaceRepositoryReceiptPath)
	require.NoError(t, err)
	require.True(t, completedWorkspaceReceipt(receipt, workspaceID, repo.ID), "a replay writes the receipt again")
}

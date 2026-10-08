package services

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

// The subprocess runs the production scheduler and transactional service. Only
// capture/inventory are the policy-suite runtime fake; SIGKILL, PostgreSQL and
// disk removal are real. The reference-host microVM suite remains separate.
type crashCleanupRuntime struct {
	*cleanupDiskFixture
	ready string
}

func (r *crashCleanupRuntime) ReclaimWorkspaceDisk(ctx context.Context, id string) error {
	if r.ready != "" {
		// Called only after the archive decision commits, before touching the disk.
		if err := os.WriteFile(r.ready, []byte(id), 0600); err != nil {
			return err
		}
		<-ctx.Done()
		return ctx.Err()
	}
	if err := r.cleanupDiskFixture.ReclaimWorkspaceDisk(ctx, id); err != nil {
		return err
	}
	if r.removals > 0 {
		return os.WriteFile(r.disk+".removed", []byte(id), 0600)
	}
	return nil
}

func TestWorkspaceCleanerHostKillRestart(t *testing.T) {
	if database := os.Getenv("MCH09_CHILD_DATABASE"); database != "" {
		pool, err := pgxpool.New(t.Context(), database)
		require.NoError(t, err)
		defer pool.Close()
		q := db.New(pool)
		id := os.Getenv("MCH09_CHILD_ID")
		runtime := &crashCleanupRuntime{cleanupDiskFixture: &cleanupDiskFixture{
			cleanupPolicyRuntime: &cleanupPolicyRuntime{capture: WorkspaceDiskReclaimCapture{CandidateHead: "head", RetainedHead: "head", CaptureID: "capture", Settled: true, Quiet: true, BindingVerified: true, CaptureComplete: true, InventoryCurrent: true}},
			disk:                 os.Getenv("MCH09_CHILD_DISK"),
		}, ready: os.Getenv("MCH09_CHILD_READY")}
		svc := NewWorkspaceService(q, WithWorkspaceRuntime(runtime), WithWorkspaceTransactions(pool), WithTransactionalWorkspaceCleanup(func() time.Time { return time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC) }))
		svc.diskReclaimAuthority = singleCleanupCandidate{svc.diskReclaimAuthority, id}
		cleanupPolicyTick(t, svc)
		return
	}
	pool := newProductTestPool(t)
	_, repo := setupTestUserAndRepo(t, pool)
	q := db.New(pool)
	owner, err := q.GetBranchMachineOwner(t.Context())
	require.NoError(t, err)
	create := func(branch string) string {
		row, err := q.CreateWorkspace(t.Context(), db.CreateWorkspaceParams{RepositoryID: repo, UserID: owner, TargetBookmark: branch, Kind: "container", Status: "suspended"})
		require.NoError(t, err)
		_, err = pool.Exec(t.Context(), `UPDATE workspaces SET vm_id='original',head_commit_id='head',branch_archived_at=$2 WHERE id=$1`, row.ID, time.Date(2026, 10, 7, 11, 59, 0, 0, time.UTC))
		require.NoError(t, err)
		return row.ID
	}
	id := create("scratch/member/crash")
	other := create("scratch/member/untouched")
	disk := filepath.Join(t.TempDir(), "disk")
	require.NoError(t, os.Mkdir(disk, 0700))
	require.NoError(t, os.WriteFile(filepath.Join(disk, "untracked.bin"), []byte{0, 255, 1}, 0600))
	ready := disk + ".ready"
	start := func(pause bool) *exec.Cmd {
		cmd := exec.Command(os.Args[0], "-test.run=^TestWorkspaceCleanerHostKillRestart$", "-test.count=1")
		cmd.Env = append(os.Environ(), "MCH09_CHILD_DATABASE="+pool.Config().ConnString(), "MCH09_CHILD_ID="+id, "MCH09_CHILD_DISK="+disk, "MCH09_CHILD_READY=")
		if pause {
			cmd.Env[len(cmd.Env)-1] = "MCH09_CHILD_READY=" + ready
		}
		require.NoError(t, cmd.Start())
		return cmd
	}
	child := start(true)
	waited := false
	defer func() {
		if !waited {
			_ = child.Process.Kill()
			_ = child.Wait()
		}
	}()
	require.Eventually(t, func() bool { _, err := os.Stat(ready); return err == nil }, 10*time.Second, 10*time.Millisecond)
	pending, err := q.GetWorkspace(t.Context(), id)
	require.NoError(t, err)
	require.True(t, pending.BranchArchivedAt.Valid)
	require.Equal(t, "head", pending.CleanupPendingHead)
	require.Equal(t, "capture", pending.CleanupPendingCaptureID)
	require.False(t, pending.DiskReclaimedAt.Valid)
	require.FileExists(t, filepath.Join(disk, "untracked.bin"))
	require.NoError(t, child.Process.Kill())
	require.Error(t, child.Wait(), "host must die, not return normally")
	waited = true
	restarted := start(false)
	require.NoError(t, restarted.Wait())
	require.NoDirExists(t, disk)
	require.FileExists(t, disk+".removed")
	done, err := q.GetWorkspace(t.Context(), id)
	require.NoError(t, err)
	require.True(t, done.DiskReclaimedAt.Valid)
	require.Empty(t, done.CleanupPendingHead)
	receipt, err := os.Stat(disk + ".removed")
	require.NoError(t, err)
	restarted = start(false)
	require.NoError(t, restarted.Wait())
	after, err := os.Stat(disk + ".removed")
	require.NoError(t, err)
	require.Equal(t, receipt.ModTime(), after.ModTime(), "completed removal must not repeat")
	untouched, err := q.GetWorkspace(t.Context(), other)
	require.NoError(t, err)
	require.False(t, untouched.DiskReclaimedAt.Valid)
	require.Empty(t, untouched.CleanupPendingHead, fmt.Sprint(untouched))
}

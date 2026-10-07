package services

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

type cleanupDiskFixture struct {
	*cleanupPolicyRuntime
	disk     string
	removals int
}

func (r *cleanupDiskFixture) ReclaimWorkspaceDisk(_ context.Context, id string) error {
	r.calls = append(r.calls, id)
	if _, err := os.Stat(r.disk); os.IsNotExist(err) {
		return nil
	}
	if err := os.RemoveAll(r.disk); err != nil {
		return err
	}
	r.removals++
	return nil
}

// Runtime removal is a fixture; PostgreSQL, host Git objects and the cleaner
// are real. This does not qualify microVM reconstruction or the root broker.
func TestWorkspaceCleanerRetainsCapturedObjectsAfterDiskRemoval(t *testing.T) {
	pool := newProductTestPool(t)
	_, repo := setupTestUserAndRepo(t, pool)
	ctx := t.Context()
	q := db.New(pool)
	owner, err := q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	row, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: owner, Kind: "container", Status: "suspended", TargetBookmark: "smithers/retained-objects"})
	require.NoError(t, err)
	root := t.TempDir()
	disk := filepath.Join(root, "disk")
	host := filepath.Join(root, "host.git")
	git := func(args ...string) string {
		cmd := exec.CommandContext(ctx, "/usr/bin/git", args...)
		cmd.Env = []string{"PATH=/usr/bin:/bin", "HOME=" + root, "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_COUNT=1", "GIT_CONFIG_KEY_0=core.hooksPath", "GIT_CONFIG_VALUE_0=/dev/null"}
		output, err := cmd.CombinedOutput()
		require.NoError(t, err, string(output))
		return strings.TrimSpace(string(output))
	}
	git("init", disk)
	git("init", "--bare", host)
	bytes := map[string][]byte{"tracked.txt": []byte("tracked capture\n"), "untracked.txt": []byte("new file in final capture\n"), "binary.bin": {0, 0xff, 0x80, 1}}
	for path, data := range bytes {
		require.NoError(t, os.WriteFile(filepath.Join(disk, path), data, 0600))
	}
	git("-C", disk, "add", ".")
	git("-C", disk, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "complete capture")
	head := git("-C", disk, "rev-parse", "HEAD")
	tree := git("-C", disk, "rev-parse", "HEAD^{tree}")
	ref := "refs/smithers/branches/" + row.ID + "/head"
	git("-C", disk, "push", host, "HEAD:"+ref)
	var blobs []string
	for path := range bytes {
		blobs = append(blobs, git("--git-dir", host, "rev-parse", head+":"+path))
	}
	_, err = pool.Exec(ctx, `UPDATE workspaces SET vm_id='disk-fixture',head_commit_id=$2 WHERE id=$1`, row.ID, head)
	require.NoError(t, err)
	now := time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)
	item, _, err := q.InsertMythicalChatItem(ctx, db.MythicalItem{RepositoryID: repo, IssueTitle: "Retain evidence", WorkspaceID: row.ID})
	require.NoError(t, err)
	item = mythicalLanded(item, "merge", now.Add(-24*time.Hour-time.Minute))
	checks := mythicalChecksOf(item)
	checks.Attempts = []todoAttemptEvidence{{RunID: "retained-run", Attempt: 1, Revision: head, Outcome: "merged", Items: []map[string]any{{"check": "capture", "status": "passed"}}}}
	item.Checks = checks.encode()
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	event, err := jobs.RecordFactInTx(ctx, tx, jobs.Scope{TenantID: fmt.Sprint(repo), PrincipalID: "branch:" + row.ID}, row.ID, "branch.captured", "completed", json.RawMessage(`{"activity":"captured"}`))
	require.NoError(t, err)
	require.NoError(t, tx.Commit(ctx))
	// Durable attempt and evidence bytes are retained verbatim, irrespective of
	// the cleanup selector's own projection of these checks.
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET state=$2,checks=$3,learning_receipt=$4 WHERE id=$1`, item.ID, item.State, item.Checks, []byte(`{"note":"retained-evidence"}`))
	require.NoError(t, err)
	_, _, err = q.BindMythicalLane(ctx, db.MythicalLane{WorkspaceID: row.ID, RepositoryID: repo, ItemID: item.ID, Name: "retained-objects"})
	require.NoError(t, err)
	runtime := &cleanupDiskFixture{cleanupPolicyRuntime: &cleanupPolicyRuntime{capture: WorkspaceDiskReclaimCapture{CandidateHead: head, RetainedHead: head, CaptureID: "complete capture", Settled: true, Quiet: true, BindingVerified: true, CaptureComplete: true, InventoryCurrent: true}}, disk: disk}
	svc := NewWorkspaceService(q, WithWorkspaceRuntime(runtime), WithWorkspaceTransactions(pool), WithTransactionalWorkspaceCleanup(func() time.Time { return now }))
	cleanupPolicyTick(t, svc)
	_, err = os.Stat(disk)
	require.True(t, os.IsNotExist(err), "original disk actually removed")
	require.Equal(t, 1, runtime.removals)
	stored, err := q.GetWorkspace(ctx, row.ID)
	require.NoError(t, err)
	require.True(t, stored.DiskReclaimedAt.Valid)
	require.False(t, stored.DeletedAt.Valid)
	retained, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	require.JSONEq(t, string(item.Checks), string(retained.Checks))
	var retainedActivity []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT data FROM product_job_events WHERE event_id=$1`, event.EventID).Scan(&retainedActivity))
	require.JSONEq(t, `{"activity":"captured"}`, string(retainedActivity))
	var retainedEvidence []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT learning_receipt FROM mythical_items WHERE id=$1`, item.ID).Scan(&retainedEvidence))
	require.JSONEq(t, `{"note":"retained-evidence"}`, string(retainedEvidence))
	require.Equal(t, head, git("--git-dir", host, "rev-parse", ref))
	for _, object := range append([]string{head, tree}, blobs...) {
		git("--git-dir", host, "cat-file", "-e", object)
	}
	for path, data := range bytes {
		cmd := exec.CommandContext(ctx, "/usr/bin/git", "--git-dir", host, "show", head+":"+path)
		raw, err := cmd.Output()
		require.NoError(t, err)
		require.Equal(t, data, raw)
	}
	restarted := NewWorkspaceService(q, WithWorkspaceRuntime(runtime), WithWorkspaceTransactions(pool), WithTransactionalWorkspaceCleanup(func() time.Time { return now }))
	cleanupPolicyTick(t, restarted)
	require.Equal(t, 1, runtime.removals)
	require.Len(t, runtime.calls, 1)
}

package compose

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/process"
	"github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// The real installed cleaner, PostgreSQL projection, retained object verifier
// and trusted-process disk remover run together; HTTP reads the resulting card.
// Native capture and real-guest recovery still require the reference mini.
func cleanupInstallProof(t *testing.T, pool *pgxpool.Pool, runtime *process.Runtime, id string, item db.MythicalItem, head, base, hostGit string, read func(string, int) []byte, capture *sleepCaptureFunc, serviceFinalWrites bool, sleep func()) {
	t.Helper()
	ctx := t.Context()
	observed, err := runtime.InspectWorkspace(ctx, id)
	require.NoError(t, err)
	settled := time.Now().Add(-25 * time.Hour).UTC().Format(time.RFC3339Nano)
	checks := fmt.Sprintf(`{"completion":{"commit":%q,"since":%q,"outcome":"closed"}}`, head, settled)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='landed',checks=$2 WHERE id=$1`, item.ID, []byte(checks))
	require.NoError(t, err)
	assertRetained := func() {
		var reclaimed bool
		require.NoError(t, pool.QueryRow(ctx, `SELECT disk_reclaimed_at IS NOT NULL FROM workspaces WHERE id=$1`, id).Scan(&reclaimed))
		require.False(t, reclaimed)
		require.FileExists(t, observed.Root+"/retained.txt")
	}
	// Settlement without an authenticated capture receipt never removes files.
	time.Sleep(120 * time.Millisecond)
	assertRetained()
	// Capture through the authenticated install sleep door. The native guest
	// is simulated here; runtime admission, state, receipts and storage are real.
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='proposed',checks='{}' WHERE id=$1`, item.ID)
	require.NoError(t, err)
	require.Eventually(t, func() bool { _, err = runtime.StartWorkspace(ctx, id); return err == nil }, 5*time.Second, 10*time.Millisecond)
	require.NoError(t, runtime.WriteFile(ctx, id, "binary.bin", []byte{0, 255, 1}, 0600))
	_, err = pool.Exec(ctx, `UPDATE workspaces SET status='running' WHERE id=$1`, id)
	require.NoError(t, err)
	entered, finish := make(chan struct{}), make(chan struct{})
	receipt := uuid.NewString()
	if serviceFinalWrites {
		_, err := runtime.StartService(ctx, id, workspace.ServiceSpec{Name: "dev", Command: workspace.Command{Args: []string{"/bin/sh", "-c", "trap 'printf \"final\\n\" > service-final.txt; exit' TERM; printf ready > service-ready; while :; do sleep 1; done"}}})
		require.NoError(t, err)
		require.Eventually(t, func() bool { _, err := runtime.ReadFile(ctx, id, "service-ready"); return err == nil }, 3*time.Second, 10*time.Millisecond)
	}

	*capture = func(captureCtx context.Context, branch string) (machined.CaptureResult, error) {
		if serviceFinalWrites {
			final, err := runtime.ReadFile(captureCtx, id, "service-final.txt")
			require.NoError(t, err)
			require.Equal(t, "final\n", string(final))
		}
		close(entered)
		<-finish
		git := func(args ...string) string {
			out, err := exec.Command("/usr/bin/git", args...).CombinedOutput()
			require.NoError(t, err, string(out))
			return string(bytes.TrimSpace(out))
		}
		git("init", observed.Root)
		git("-C", observed.Root, "add", ".")
		git("-C", observed.Root, "-c", "user.name=Capture", "-c", "user.email=capture@example.test", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Complete native capture fixture")
		head = git("-C", observed.Root, "rev-parse", "HEAD")
		tree := git("-C", observed.Root, "rev-parse", "HEAD^{tree}")
		git("-C", observed.Root, "push", hostGit, "+HEAD:refs/smithers/branches/"+id+"/head")
		decode := func(s string) []byte { b, err := hex.DecodeString(s); require.NoError(t, err); return b }
		payload := wire.Union(2, wire.Field(1, decode(head)), wire.Field(2, decode(tree)), wire.Field(3, decode(base)))
		digest := sha256.Sum256(payload)
		_, err := pool.Exec(captureCtx, `INSERT INTO machine_event_receipts(workspace_id,event_id,outcome,payload_digest,capture_payload) VALUES($1,$2,'applied',$3,$4)`, id, receipt, digest[:], payload)
		require.NoError(t, err)
		pending := fmt.Sprintf(`{"head":%q,"tree":%q,"base":%q,"onto":%q,"stale":false}`, head, tree, base, head)
		_, err = pool.Exec(captureCtx, `UPDATE workspaces SET head_commit_id=$2,capture_pending=$3 WHERE id=$1`, id, head, []byte(pending))
		require.NoError(t, err)
		return machined.CaptureResult{Head: head, Tree: tree}, nil
	}
	if serviceFinalWrites {
		_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='landed',checks=$2 WHERE id=$1`, item.ID, []byte(checks))
		require.NoError(t, err)
	} else {
		sleep()
	}
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("install capture did not start")
	}
	require.ErrorIs(t, runtime.WriteFile(ctx, id, "retained.txt", []byte("lost"), 0600), workspace.ErrCleanupBusy)
	_, err = runtime.StartWorkspace(ctx, id)
	require.ErrorIs(t, err, workspace.ErrCleanupBusy)
	var releasing struct{ State string }
	require.NoError(t, json.Unmarshal(read("/api/branches/"+id, 200), &releasing))
	require.Equal(t, "releasing", releasing.State)
	close(finish)
	if !serviceFinalWrites {
		require.Eventually(t, func() bool {
			var status string
			err := pool.QueryRow(ctx, `SELECT status FROM workspaces WHERE id=$1`, id).Scan(&status)
			return err == nil && status == "suspended"
		}, 5*time.Second, 20*time.Millisecond)
		checks = fmt.Sprintf(`{"completion":{"commit":%q,"since":%q,"outcome":"closed"}}`, head, time.Now().Add(-24*time.Hour+time.Minute).UTC().Format(time.RFC3339Nano))
		_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='landed',checks=$2 WHERE id=$1`, item.ID, []byte(checks))
		require.NoError(t, err)
		time.Sleep(120 * time.Millisecond)
		assertRetained()
		// A mismatched ref remains ineligible even with a valid retained receipt.
		out, err := exec.Command("/usr/bin/git", "--git-dir", hostGit, "update-ref", "refs/smithers/branches/"+id+"/head", base).CombinedOutput()
		require.NoError(t, err, string(out))
		checks = fmt.Sprintf(`{"completion":{"commit":%q,"since":%q,"outcome":"closed"}}`, head, settled)
		_, err = pool.Exec(ctx, `UPDATE mythical_items SET checks=$2 WHERE id=$1`, item.ID, []byte(checks))
		require.NoError(t, err)
		time.Sleep(120 * time.Millisecond)
		assertRetained()
		out, err = exec.Command("/usr/bin/git", "--git-dir", hostGit, "update-ref", "refs/smithers/branches/"+id+"/head", head).CombinedOutput()
		require.NoError(t, err, string(out))
	}
	require.Eventually(t, func() bool {
		var done bool
		err := pool.QueryRow(ctx, `SELECT disk_reclaimed_at IS NOT NULL FROM workspaces WHERE id=$1`, id).Scan(&done)
		return err == nil && done
	}, 5*time.Second, 20*time.Millisecond)
	_, err = os.Stat(observed.Root)
	require.True(t, os.IsNotExist(err), "original mutable disk must be absent")
	var row workspace.Workspace
	row, err = runtime.InspectWorkspace(ctx, id)
	require.NoError(t, err)
	require.Equal(t, workspace.WorkspaceStopped, row.State)
	var projection struct {
		State string
		Head  string
	}
	require.NoError(t, json.Unmarshal(read("/api/branches/"+id, 200), &projection))
	require.Equal(t, "closed", projection.State)
	require.Equal(t, head, projection.Head)
	for path, expected := range map[string][]byte{"retained.txt": []byte("final bytes\n"), "binary.bin": {0, 255, 1}} {
		contents, err := exec.Command("/usr/bin/git", "--git-dir", hostGit, "show", head+":"+path).Output()
		require.NoError(t, err)
		require.Equal(t, expected, contents)
	}
	if serviceFinalWrites {
		contents, err := exec.Command("/usr/bin/git", "--git-dir", hostGit, "show", head+":service-final.txt").Output()
		require.NoError(t, err)
		require.Equal(t, "final\n", string(contents))
	}
	var kept int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE id=$1`, item.ID).Scan(&kept))
	require.Equal(t, 1, kept)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM machine_event_receipts WHERE workspace_id=$1 AND event_id=$2`, id, receipt).Scan(&kept))
	require.Equal(t, 1, kept)
	out, err := exec.Command("/usr/bin/git", "--git-dir", hostGit, "cat-file", "-e", head).CombinedOutput()
	require.NoError(t, err, string(out))
	out, err = exec.Command("/usr/bin/git", "--git-dir", hostGit, "rev-parse", "refs/smithers/branches/"+id+"/head").Output()
	require.NoError(t, err)
	require.Equal(t, head, string(bytes.TrimSpace(out)))
}

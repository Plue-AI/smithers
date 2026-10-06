package compose

import (
	"encoding/json"
	"net/http/cookiejar"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// Uses the production install composer, native mirror and real PostgreSQL.
// No workspace is provisioned: setup stops after Source ready.
func TestBranchFilesBeforeMachineReady(t *testing.T) {
	r := newRehearsal(t, "SMITHERS_BRANCH_FILES_INTEGRATION", "C-J1-03", "branch-files-")
	seed := filepath.Join(r.gitRoot, "seed")
	require.NoError(t, os.MkdirAll(filepath.Join(seed, ".smithers"), 0700))
	const machine = "{\"v\":1,\"image\":\"file-card-canary\"}\n"
	require.NoError(t, os.WriteFile(filepath.Join(seed, ".smithers/machine.json"), []byte(machine), 0600))
	for _, argv := range [][]string{
		{"-C", seed, "add", ".smithers/machine.json"},
		{"-C", seed, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "File card fixture"},
		{"-C", seed, "push", filepath.Join(r.gitRoot, "rehearsal-owner/app.git"), "main"},
	} {
		out, err := exec.Command("/usr/bin/git", argv...).CombinedOutput()
		require.NoError(t, err, string(out))
	}
	head, err := exec.Command("/usr/bin/git", "-C", seed, "rev-parse", "HEAD").Output()
	require.NoError(t, err)
	r.mainCommit = strings.TrimSpace(string(head))
	if !r.setupSource() {
		return
	}
	creates, live := len(r.compute.Creates()), len(r.compute.Live())
	var before, queuedBefore int
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM workspaces`).Scan(&before))
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_requests`).Scan(&queuedBefore))
	for _, item := range []struct{ path, text string }{
		{"JOURNEY.md", "Add a greeting to JOURNEY.md\n"},
		{".smithers/machine.json", machine},
	} {
		body, err := r.expect("GET", "/api/branches/main/files/"+item.path, "", 200)
		require.NoError(t, err)
		var file struct {
			Path, Branch, Mode string
			Content            struct{ Kind, Text string }
		}
		require.NoError(t, json.Unmarshal(body, &file))
		require.Equal(t, item.path, file.Path)
		require.Equal(t, "main", file.Branch)
		require.Equal(t, "read_only", file.Mode)
		require.Equal(t, "text", file.Content.Kind)
		require.Equal(t, item.text, file.Content.Text)
	}
	_, err = r.expect("GET", "/api/branches/main/files/absent.ts", "", 404)
	require.NoError(t, err)
	_, err = r.expect("GET", "/api/branches/main/files/%2e%2e/etc/passwd", "", 400)
	require.NoError(t, err)
	empty, err := cookiejar.New(nil)
	require.NoError(t, err)
	_, err = r.expectAs(empty, "GET", "/api/branches/main/files/JOURNEY.md", "", 401)
	require.NoError(t, err)
	// With source authority removed, a previously readable path gives no bytes.
	_, err = r.pool.Exec(r.ctx, `DELETE FROM install_settings WHERE key = 'setup.source.repository'`)
	require.NoError(t, err)
	body, err := r.expect("GET", "/api/branches/main/files/JOURNEY.md", "", 503)
	require.NoError(t, err)
	require.NotContains(t, string(body), "Add a greeting")
	var after, queuedAfter int
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM workspaces`).Scan(&after))
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_requests`).Scan(&queuedAfter))
	require.Equal(t, queuedBefore, queuedAfter)
	require.Equal(t, before, after)
	require.Equal(t, creates, len(r.compute.Creates()))
	require.Equal(t, live, len(r.compute.Live()))
}

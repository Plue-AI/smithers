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
// The external image builder is held after Source ready; reads must provision
// no workspace while the owner's admitted build remains running.
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
	_, err = r.expect("POST", "/api/install/setup/machine", `{}`, 202)
	require.NoError(t, err)
	building, err := r.expect("GET", "/api/install", "", 200)
	require.NoError(t, err)
	require.Contains(t, string(building), `"id":"machine","state":"running"`)
	// An authenticated install member still needs repository read authority.
	ben, err := r.member("ben", 8, "write")
	require.NoError(t, err)
	_, err = r.expectAs(ben, "GET", "/api/branches/main/files/JOURNEY.md", "", 200)
	require.NoError(t, err)
	_, err = r.expect("DELETE", "/api/members/ben", "", 204)
	require.NoError(t, err)
	denied, err := r.expectAs(ben, "GET", "/api/branches/main/files/JOURNEY.md", "", 401)
	require.NoError(t, err)
	require.NotContains(t, string(denied), "Add a greeting")
	creates, live := len(r.compute.Creates()), len(r.compute.Live())
	var before, queuedBefore int
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM workspaces`).Scan(&before))
	// Completed receipts and host-only conversation summaries are not machine
	// demand. A question legitimately schedules its summary without admitting
	// a machine; every other outstanding operation stays in this assertion.
	const queuedJobs = `SELECT count(*) FROM product_job_requests WHERE operation <> 'conversation.summary' AND state IN ('accepted','dispatching','running','waiting','uncertain')`
	require.NoError(t, r.pool.QueryRow(r.ctx, queuedJobs).Scan(&queuedBefore))
	// The app-agent door must produce the same mirrored File card while no
	// machine exists, not merely expose bytes at an otherwise unused route.
	answer, frames, terminal, err := r.ask("", "What is in JOURNEY.md? Show the file.")
	require.NoError(t, err)
	require.True(t, terminal)
	require.Contains(t, answer, "Add a greeting to JOURNEY.md")
	fileCard := false
	for _, frame := range frames {
		if frame.Type == "card" && frame.Card.Kind == "file" && frame.Card.Payload.Path == "JOURNEY.md" {
			require.Equal(t, "Add a greeting to JOURNEY.md\n", frame.Card.Payload.Content)
			require.Equal(t, r.mainCommit, frame.Card.Payload.ReadAt.CommitID)
			fileCard = true
		}
	}
	// Shared conversation frames deliberately omit internal command receipts.
	// Verify dispatch in the durable audit, independently of the served card.
	var fileReads int
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM chat_turn_batches b, jsonb_array_elements(b.frames) f WHERE f->>'type'='call.settled' AND f->>'name'='file' AND f->>'verdict'='run'`).Scan(&fileReads))
	require.Equal(t, 1, fileReads, "the registered /file command must settle once")
	require.True(t, fileCard, "the answer must include a mirrored File card")
	var afterQuestion int
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM workspaces`).Scan(&afterQuestion))
	require.Equal(t, before, afterQuestion, "the question must not create a workspace")
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
	// main has no live digest provider. Selectors must not silently fall back
	// to readable mirror bytes. The composed version reader rejects malformed
	// versions before trying to resolve a branch or read a snapshot.
	for _, selector := range []string{"digest=sha256:abc", "digest=", "at=" + r.mainCommit + "&digest=sha256:abc"} {
		body, err := r.expect("GET", "/api/branches/main/files/JOURNEY.md?"+selector, "", 503)
		require.NoError(t, err)
		require.Contains(t, string(body), `"code":"service_unavailable"`)
		require.NotContains(t, string(body), "Add a greeting")
	}
	for _, selector := range []string{"compare=burst-before", "compare="} {
		body, err := r.expect("GET", "/api/branches/main/files/JOURNEY.md?"+selector, "", 400)
		require.NoError(t, err)
		require.Contains(t, string(body), `"message":"invalid file version"`)
		require.NotContains(t, string(body), "Add a greeting")
	}
	// Captured immutable reads keep their existing route and never wake.
	body, err := r.expect("GET", "/api/branches/main/files/JOURNEY.md?at="+r.mainCommit, "", 200)
	require.NoError(t, err)
	require.Contains(t, string(body), "Add a greeting")
	_, err = r.expect("GET", "/api/branches/main/files/absent.ts", "", 404)
	require.NoError(t, err)
	_, err = r.expect("GET", "/api/branches/main/files/%2e%2e/etc/passwd", "", 400)
	require.NoError(t, err)
	empty, err := cookiejar.New(nil)
	require.NoError(t, err)
	_, err = r.expectAs(empty, "GET", "/api/branches/main/files/JOURNEY.md", "", 401)
	require.NoError(t, err)
	// Retained mirror bytes alone are insufficient when Source ready is lost.
	var sourceStep []byte
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT value FROM install_settings WHERE key = 'setup.step.source'`).Scan(&sourceStep))
	_, err = r.pool.Exec(r.ctx, `DELETE FROM install_settings WHERE key = 'setup.step.source'`)
	require.NoError(t, err)
	body, err = r.expect("GET", "/api/branches/main/files/JOURNEY.md", "", 503)
	require.NoError(t, err)
	require.NotContains(t, string(body), "Add a greeting")
	_, err = r.pool.Exec(r.ctx, `INSERT INTO install_settings (key, value) VALUES ('setup.step.source', $1)`, sourceStep)
	require.NoError(t, err)
	// With source authority removed, a previously readable path gives no bytes.
	_, err = r.pool.Exec(r.ctx, `DELETE FROM install_settings WHERE key = 'setup.source.repository'`)
	require.NoError(t, err)
	body, err = r.expect("GET", "/api/branches/main/files/JOURNEY.md", "", 503)
	require.NoError(t, err)
	require.NotContains(t, string(body), "Add a greeting")
	var after, queuedAfter int
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM workspaces`).Scan(&after))
	require.NoError(t, r.pool.QueryRow(r.ctx, queuedJobs).Scan(&queuedAfter))
	var jobStates []byte
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT jsonb_agg(jsonb_build_object('operation',operation,'state',state)) FROM product_job_requests`).Scan(&jobStates))
	require.Equal(t, queuedBefore, queuedAfter, string(jobStates))
	require.Equal(t, before, after)
	require.Equal(t, creates, len(r.compute.Creates()))
	require.Equal(t, live, len(r.compute.Live()))
}

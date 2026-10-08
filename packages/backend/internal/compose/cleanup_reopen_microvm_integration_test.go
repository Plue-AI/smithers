package compose

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// C-MCH-05's native recovery qualification uses the approved installed
// composition, real guest capture and normal GitHub ingress. No capture
// receipt, host object or replacement working copy is seeded by this test.
func TestCleanupReopenInstalledMicroVM(t *testing.T) {
	testCleanupReopenInstalledMicroVM(t)
}

// The named security qualification must cover capture, production cleanup and
// normal PR-reopen together, rather than only adapter stop/remove calls.
func TestCleanupRepositoryExecutionBoundary(t *testing.T) {
	testCleanupReopenInstalledMicroVM(t)
}

func testCleanupReopenInstalledMicroVM(t *testing.T) {
	t.Helper()
	h, _, bundle, _, _ := startInstalledTerminalHarness(t, nil)
	t.Logf("native cleanup provenance: bundle_revision=%s manifest_sha256=%s msb=%s", bundle.Revision(), bundle.ManifestSHA256(), os.Getenv("SMITHERS_MICROSANDBOX_BIN"))
	state, message := h.runMachine(t, "cleanup-reopen")
	require.Equal(t, "done", state, message)
	h.expect("POST", "/api/todos", `{"title":"Cleanup recovery","prompt":"Add a greeting to JOURNEY.md","place":{"mode":"append"}}`, 202)
	exerciseCleanupReopenInstalledMicroVM(t, h)
}

func exerciseCleanupReopenInstalledMicroVM(t *testing.T, h *rootLayerHarness) {
	ctx := t.Context()
	require.NotZero(t, os.Geteuid(), "cleanup must run as the install service user")
	var number, pull int64
	var branch string
	require.Eventually(t, func() bool {
		return h.pool.QueryRow(ctx, `SELECT number,pr_number,workspace_id FROM mythical_items WHERE state='proposed' AND workspace_id IS NOT NULL AND pr_number>0 ORDER BY number DESC LIMIT 1`).Scan(&number, &pull, &branch) == nil
	}, 10*time.Minute, 250*time.Millisecond, "native TODO must reach In review: %s", h.logs.String())
	url := "/api/repos/rehearsal-owner/app/workspaces/" + branch
	h.expect("POST", url+"/resume", "", 200)
	files := map[string][]byte{"JOURNEY.md": []byte("tracked cleanup bytes\n"), "cleanup-untracked.txt": []byte("untracked cleanup bytes\n"), "cleanup-binary.bin": {0, 255, 128, 1}, ".gitattributes": []byte("*.txt filter=hostile\n"), "cleanup-probe.sh": []byte("#!/bin/sh\nset -eu\nid -u\nprintf old-disk > /tmp/cleanup-original-disk\n")}
	for path, data := range files {
		require.NoError(t, writeGuestFixture(h.runtime, ctx, branch, path, data, 0600))
	}
	// An uncaptured file outside /workspace distinguishes a fresh guest from
	// an accidentally reused disk without changing the captured branch tree.
	marker, err := h.runtime.ExecuteCommand(ctx, branch, workspace.Command{Args: []string{"/bin/sh", "/workspace/cleanup-probe.sh"}})
	require.NoError(t, err)
	require.Zero(t, marker.ExitCode, marker.Stderr)
	require.Equal(t, "19999\n", marker.Stdout)
	machine, err := h.runtime.WorkspaceMachineIdentity(ctx, branch)
	require.NoError(t, err)
	inventory := func() []struct {
		Name string `json:"name"`
	} {
		cmd := exec.CommandContext(ctx, os.Getenv("SMITHERS_MICROSANDBOX_BIN"), "list", "--format", "json")
		account, err := user.LookupId(strconv.Itoa(os.Getuid()))
		require.NoError(t, err)
		cmd.Env = []string{"HOME=" + account.HomeDir, "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "MSB_BACKEND=local", "NO_COLOR=1"}
		out, err := cmd.Output()
		require.NoError(t, err)
		var rows []struct {
			Name string `json:"name"`
		}
		require.NoError(t, json.Unmarshal(out, &rows))
		return rows
	}
	present := func() bool {
		for _, row := range inventory() {
			if row.Name == machine {
				return true
			}
		}
		return false
	}
	require.True(t, present(), "original native machine must exist")
	account, err := user.LookupId(strconv.Itoa(os.Getuid()))
	require.NoError(t, err)
	originalDisk := filepath.Join(account.HomeDir, ".microsandbox", "sandboxes", machine)
	require.DirExists(t, originalDisk, "record the actual msb disk directory before removal")
	hostGit := filepath.Join(h.storage.StoragePath, "rehearsal-owner", "app", ".jj/repo/store/git")
	canary := filepath.Join(t.TempDir(), "host-execution")
	// Prove the host canary is writable before interpreting its absence.
	require.NoError(t, os.WriteFile(canary, []byte("positive host control"), 0600))
	require.NoError(t, os.Remove(canary))
	hooks := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(hooks, "post-checkout"), []byte("#!/bin/sh\nprintf hostile > "+canary+"\n"), 0755))
	git := func(args ...string) string {
		output, err := exec.CommandContext(ctx, "/usr/bin/git", append([]string{"--git-dir", hostGit}, args...)...).CombinedOutput()
		require.NoError(t, err, string(output))
		return strings.TrimSpace(string(output))
	}
	git("config", "core.hooksPath", hooks)
	for _, filter := range []string{"clean", "smudge"} {
		git("config", "filter.hostile."+filter, "/bin/sh -c 'printf hostile > "+canary+"'")
	}
	// Positive guest execution is already proved by id -u above. Host hooks and
	// attribute-selected filters must remain inert through capture and reopen.
	h.expect("POST", url+"/suspend", "", 200)
	var head string
	require.NoError(t, h.pool.QueryRow(ctx, `SELECT head_commit_id FROM workspaces WHERE id=$1`, branch).Scan(&head))
	require.NotEmpty(t, head, "production sleep must acknowledge guest capture")
	assertObjects := func() {
		require.NoFileExists(t, canary)
		require.Equal(t, head, git("rev-parse", "refs/smithers/branches/"+branch+"/head"))
		git("cat-file", "-e", head+"^{tree}")
		for path, want := range files {
			f, err := h.repoClient.GetFileAtCommit(ctx, "rehearsal-owner", "app", head, path)
			require.NoError(t, err)
			got := []byte(f.Content)
			if f.Encoding == "base64" {
				got, err = base64.StdEncoding.DecodeString(f.Content)
				require.NoError(t, err)
			}
			require.Equal(t, want, got, path)
			require.Equal(t, sha256.Sum256(want), sha256.Sum256(got), path)
		}
	}
	assertObjects()
	retained := cleanupRetainedEvidence(t, h.pool, branch)
	h.expect("POST", fmt.Sprintf("/api/todos/%d", number), `{"op":"drop"}`, 202)
	require.Eventually(t, func() bool {
		var done bool
		return h.pool.QueryRow(ctx, `SELECT state='dropped' AND pending_op IS NULL FROM mythical_items WHERE number=$1`, number).Scan(&done) == nil && done
	}, time.Minute, 100*time.Millisecond)
	var retainedAttempts []byte
	require.NoError(t, h.pool.QueryRow(ctx, `SELECT COALESCE(checks->'attempts','[]'::jsonb) FROM mythical_items WHERE number=$1`, number).Scan(&retainedAttempts))
	h.options.CleanupInterval = 100 * time.Millisecond
	h.options.CleanupClock = func() time.Time { return time.Now().Add(24*time.Hour + time.Minute) }
	h.recompose()
	require.Eventually(t, func() bool {
		var done bool
		return h.pool.QueryRow(ctx, `SELECT disk_reclaimed_at IS NOT NULL FROM workspaces WHERE id=$1`, branch).Scan(&done) == nil && done
	}, 2*time.Minute, 100*time.Millisecond, "production cleaner must remove the native disk: %s", h.logs.String())
	require.False(t, present(), "msb must confirm original machine removal")
	require.NoDirExists(t, originalDisk, "cleanup must remove the original backing disk directory")
	retained()
	assertObjects()
	var archivedAttempts []byte
	require.NoError(t, h.pool.QueryRow(ctx, `SELECT COALESCE(checks->'attempts','[]'::jsonb) FROM mythical_items WHERE number=$1`, number).Scan(&archivedAttempts))
	require.JSONEq(t, string(retainedAttempts), string(archivedAttempts), "cleanup must preserve attempts and their evidence")
	h.expect("GET", fmt.Sprintf("/api/todos/%d", number), "", 200)
	// Age the retained close projection to the ticket's 7 days minus 1 hour.
	// Only time is injected; reopening is consumed through the normal webhook.
	_, err = h.pool.Exec(ctx, `UPDATE mythical_items SET checks=jsonb_set(checks,'{githubClosedAt}',to_jsonb(clock_timestamp()-interval '167 hours')) WHERE number=$1`, number)
	require.NoError(t, err)
	h.github.UpdatePull("rehearsal-owner/app", pull, func(p *githubfake.Pull) { p.State = "open"; p.ClosedAt = nil })
	var prBranch, prHead string
	require.NoError(t, h.pool.QueryRow(ctx, `SELECT w.target_bookmark,i.pr_head FROM mythical_items i JOIN workspaces w ON w.id=i.workspace_id WHERE i.number=$1`, number).Scan(&prBranch, &prHead))
	payload := []byte(fmt.Sprintf(`{"action":"reopened","number":%d,"installation":{"id":%d},"repository":{"id":100,"name":"app","full_name":"rehearsal-owner/app","owner":{"login":"rehearsal-owner"}},"pull_request":{"number":%d,"head":{"ref":%q,"sha":%q}}}`, pull, rootLayerInstallationID(t, h), pull, prBranch, prHead))
	mac := hmac.New(sha256.New, []byte("webhook"))
	_, err = mac.Write(payload)
	require.NoError(t, err)
	request, err := http.NewRequestWithContext(ctx, "POST", h.origin+"/webhooks/github", bytes.NewReader(payload))
	require.NoError(t, err)
	request.Header.Set("X-GitHub-Event", "pull_request")
	request.Header.Set("X-GitHub-Delivery", uuid.NewString())
	request.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	response, err := h.client.Do(request)
	require.NoError(t, err)
	require.Less(t, response.StatusCode, 300)
	require.NoError(t, response.Body.Close())
	require.Eventually(t, func() bool {
		var ready bool
		return h.pool.QueryRow(ctx, `SELECT state='proposed' AND pending_op IS NULL FROM mythical_items WHERE number=$1`, number).Scan(&ready) == nil && ready
	}, time.Minute, 100*time.Millisecond)
	// Stop advancing cleanup's clock before new admission.
	h.options.CleanupClock = time.Now
	h.recompose()
	h.expect("POST", url+"/resume", "", 200)
	require.True(t, present(), "reopen must admit a fresh native machine")
	for path, want := range files {
		got, err := h.runtime.ReadFile(ctx, branch, path)
		require.NoError(t, err)
		require.Equal(t, want, got, path)
	}
	fresh, err := h.runtime.ExecuteCommand(ctx, branch, workspace.Command{Args: []string{"/bin/sh", "-c", "test ! -e /tmp/cleanup-original-disk && id -u"}})
	require.NoError(t, err)
	require.Zero(t, fresh.ExitCode, fresh.Stderr)
	require.Equal(t, "19999\n", fresh.Stdout)
	assertObjects()
	retained()

	t.Logf("C-MCH-05 native cleanup/reopen branch=%s head=%s host_euid=%d guest_euid=19999 paths=5 original_removed=true", branch, head, os.Geteuid())
}

func rootLayerInstallationID(t *testing.T, h *rootLayerHarness) int64 {
	t.Helper()
	var id int64
	require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT installation_id FROM github_synced_repos WHERE owner_login='rehearsal-owner' AND repo_name='app'`).Scan(&id))
	return id
}

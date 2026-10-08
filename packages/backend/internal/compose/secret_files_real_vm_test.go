package compose

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/installbundle"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"testing"
	"time"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

const installedSecretsURL = "/api/repos/rehearsal-owner/app/secrets"

func seedInstalledSecretFiles(t *testing.T, h *rootLayerHarness) {
	t.Helper()
	for _, path := range []string{"/workspace/key", "~/../x", "/etc/x", "~/.cargo/credentials"} {
		code, body := h.request("POST", installedSecretsURL, fmt.Sprintf(`{"name":"REFUSED_PATH","value":"fixture","path":%q}`, path), "")
		require.Equal(t, 400, code, string(body))
		require.Contains(t, string(body), `"class":"user"`)
	}
	body := h.expect("POST", installedSecretsURL, `{"name":"ANTHROPIC_API_KEY","value":"mch-provider-real-fixture-0123456789abcdef","path":"~/.config/anthropic/key","hosts":["api.anthropic.com"],"match_headers":["x-api-key"]}`, 201)
	require.NotContains(t, string(body), "mch-provider-real-fixture-0123456789abcdef")
	h.expect("POST", installedSecretsURL, `{"name":"MCH_FILE","value":"mch-file-v1","path":"~/.config/mch/key"}`, 201)
	h.expect("POST", installedSecretsURL, `{"name":"MCH_ABSOLUTE_FILE","value":"mch-absolute-v1","path":"/run/smithers/files/mch/key"}`, 201)
}

func testInstalledSecretFiles(t *testing.T, h *rootLayerHarness, branch string, term *rehearsalTerminal, browsers ...http.CookieJar) {
	t.Helper()
	// Observe each private home through its own authenticated member session.
	// Agent commands use the existing production runtime's non-root identity.
	terminals := []*rehearsalTerminal{term}
	for _, browser := range browsers {
		member := installedMemberTerminal(t, h, branch, browser)
		defer member.close()
		terminals = append(terminals, member)
	}
	initial := `test "$(stat -c '%u:%g:%a' "$HOME/.config/anthropic/key")" = "$(id -u):$(id -g):600" && test "$(cat "$HOME/.config/anthropic/key")" = ANTHROPIC_API_KEY && test "$ANTHROPIC_API_KEY" = ANTHROPIC_API_KEY && test "$(cat "$HOME/.config/mch/key")" = mch-file-v1`
	// Send only a digest into the guest: embedding the real fixture in a
	// grep command would itself plant that key in shell history.
	digest := sha256.Sum256([]byte("mch-provider-real-fixture-0123456789abcdef"))
	initial += fmt.Sprintf(` && python3 -c 'import hashlib,os; n=%d; expected="%x"; assert all(hashlib.sha256(value.encode()[i:i+n]).hexdigest()!=expected for value in os.environ.values() for i in range(max(0,len(value.encode())-n+1)))'`, len("mch-provider-real-fixture-0123456789abcdef"), digest)
	for _, member := range terminals {
		installedShell(t, member, initial)
	}
	installedAgentSecretCheck(t, h, branch, time.Now().Add(30*time.Second), initial)
	// One wall-clock deadline covers mutation and observation in ALL homes.
	deadline := time.Now().Add(5 * time.Second)
	h.expect("POST", installedSecretsURL, `{"name":"MCH_FILE","value":"mch-file-v2","path":"~/.config/mch/key"}`, 201)
	updated := `for i in $(seq 1 50); do test "$(cat "$HOME/.config/mch/key")" = mch-file-v2 && break; sleep .1; done; test "$(cat "$HOME/.config/mch/key")" = mch-file-v2 && test "$(stat -c '%u:%g:%a' "$HOME/.config/mch/key")" = "$(id -u):$(id -g):600"`
	for _, member := range terminals {
		installedSecretDeadline(t, member, deadline, updated)
	}
	installedAgentSecretCheck(t, h, branch, deadline, updated)
	deadline = time.Now().Add(5 * time.Second)
	h.expect("DELETE", installedSecretsURL+"/MCH_FILE", "", 204)
	deleted := `for i in $(seq 1 50); do test ! -e "$HOME/.config/mch/key" && break; sleep .1; done; test ! -e "$HOME/.config/mch/key"`
	for _, member := range terminals {
		installedSecretDeadline(t, member, deadline, deleted)
	}
	installedAgentSecretCheck(t, h, branch, deadline, deleted)
	// Absolute files are shared with team, but remain root-owned. Observe the
	// fresh-boot fixture and its lifecycle through the same person sessions.
	absoluteInitial := `test "$(stat -c '%u:%g:%a' /run/smithers/files/mch/key)" = 0:20000:640 && test "$(cat /run/smithers/files/mch/key)" = mch-absolute-v1 && test ! -w /run/smithers/files/mch/key`
	for _, member := range terminals {
		installedShell(t, member, absoluteInitial)
	}
	installedAgentSecretCheck(t, h, branch, time.Now().Add(30*time.Second), absoluteInitial)
	deadline = time.Now().Add(5 * time.Second)
	h.expect("POST", installedSecretsURL, `{"name":"MCH_ABSOLUTE_FILE","value":"mch-absolute-v2"}`, 201)
	absoluteUpdated := `for i in $(seq 1 50); do test "$(cat /run/smithers/files/mch/key)" = mch-absolute-v2 && break; sleep .1; done; test "$(cat /run/smithers/files/mch/key)" = mch-absolute-v2 && test "$(stat -c '%u:%g:%a' /run/smithers/files/mch/key)" = 0:20000:640 && test ! -w /run/smithers/files/mch/key`
	for _, member := range terminals {
		installedSecretDeadline(t, member, deadline, absoluteUpdated)
	}
	installedAgentSecretCheck(t, h, branch, deadline, absoluteUpdated)
	deadline = time.Now().Add(5 * time.Second)
	h.expect("DELETE", installedSecretsURL+"/MCH_ABSOLUTE_FILE", "", 204)
	absoluteDeleted := `for i in $(seq 1 50); do test ! -e /run/smithers/files/mch/key && break; sleep .1; done; test ! -e /run/smithers/files/mch/key`
	for _, member := range terminals {
		installedSecretDeadline(t, member, deadline, absoluteDeleted)
	}
	installedAgentSecretCheck(t, h, branch, deadline, absoluteDeleted)
	// Plant the link AFTER a valid declaration, exercising the writer's race
	// defense without treating declaration-time acceptance of a link as valid.
	deadline = time.Now().Add(5 * time.Second)
	h.expect("POST", installedSecretsURL, `{"name":"SYMLINK_FILE","value":"before-link","path":"~/.mch-symlink"}`, 201)
	installedSecretDeadline(t, term, deadline, `for i in $(seq 1 50); do test -f "$HOME/.mch-symlink" && break; sleep .1; done; test "$(cat "$HOME/.mch-symlink")" = before-link`)
	installedShell(t, term, `printf 'outside-unchanged\n' > "$HOME/.mch-outside" && rm "$HOME/.mch-symlink" && ln -s "$HOME/.mch-outside" "$HOME/.mch-symlink"`)
	code, body := h.request("POST", installedSecretsURL, `{"name":"SYMLINK_FILE","value":"must-not-write","path":"~/.mch-symlink"}`, "")
	// Member-created links can appear after declaration. The broker must
	// refuse the write without following the link even in that race.
	require.Equal(t, 201, code, string(body))
	time.Sleep(5 * time.Second)
	installedShell(t, term, `test -L "$HOME/.mch-symlink" && test "$(cat "$HOME/.mch-outside")" = outside-unchanged`)
}

// Include the HTTP mutation in the five-second budget. A five-second guest
// polling loop started after the response would silently allow late delivery.
func installedSecretDeadline(t *testing.T, term *rehearsalTerminal, deadline time.Time, script string) {
	t.Helper()
	remaining := time.Until(deadline)
	require.Positive(t, remaining, "secret mutation exhausted the five-second budget")
	marker := fmt.Sprintf("MCHSECRET%d", time.Now().UnixNano())
	_, err := term.run("( "+script+" ) && printf '"+marker[:3]+"''"+marker[3:]+"\\n'", regexp.MustCompile(marker), remaining)
	require.NoError(t, err)
	require.True(t, time.Now().Before(deadline), "secret file settled after five seconds")
}

// Never substitute a host process for the native coding-agent session.
func installedAgentSecretCheck(t *testing.T, h *rootLayerHarness, branch string, deadline time.Time, script string) {
	t.Helper()
	require.Positive(t, time.Until(deadline))
	ctx, cancel := context.WithDeadline(t.Context(), deadline)
	defer cancel()
	result, err := h.runtime.ExecuteCommand(ctx, branch, workspaceapi.Command{Args: []string{"/bin/sh", "-c", `test "$(id -u)" = 19999 && ( ` + script + ` )`}})
	require.NoError(t, err)
	require.Zero(t, result.ExitCode, result.Stdout+result.Stderr)
	require.True(t, time.Now().Before(deadline), "agent secret observation exceeded deadline")
}

// Reuse the bundle's reviewed no-follow diagnostic; never install test code
// as root or pass the key in a terminal command/history entry.
func testInstalledBoundKeyDiskScan(t *testing.T, h *rootLayerHarness, branch string, bundle *installbundle.Bundle) {
	t.Helper()
	sum := sha256.Sum256([]byte(branch))
	body, err := os.ReadFile(filepath.Join(h.runtimeState, "workspaces", fmt.Sprintf("%x", sum), "metadata.json"))
	require.NoError(t, err)
	var stored struct {
		ID      string `json:"id"`
		Machine string `json:"machine"`
	}
	require.NoError(t, json.Unmarshal(body, &stored))
	require.Equal(t, branch, stored.ID)
	require.NotEmpty(t, stored.Machine)
	scan, err := microsandbox.ScanInstalledMachine(t.Context(), microsandbox.Config{Bundle: bundle}, stored.Machine, map[string]string{
		"PROVIDER": "mch-provider-real-fixture-0123456789abcdef",
		"RELAY":    "mch-relay-real-fixture-0123456789abcdef",
	})
	require.NoError(t, err, "whole-disk/environment scan must be complete")
	require.Empty(t, scan.Failures)
	require.Positive(t, scan.Files)
	require.Empty(t, scan.Hits, "host-bound key entered guest disk or process environment")
	t.Logf("C-MCH-12 installed scan: files=%d bytes=%d hits=%d failures=%d", scan.Files, scan.Bytes, len(scan.Hits), len(scan.Failures))
}

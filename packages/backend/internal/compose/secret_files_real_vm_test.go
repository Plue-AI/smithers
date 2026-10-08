package compose

import (
	"bytes"
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
	var sealed []byte
	require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT value_encrypted FROM repository_secrets WHERE name='SYMLINK_FILE'`).Scan(&sealed))
	code, body := h.request("POST", installedSecretsURL, `{"name":"SYMLINK_FILE","value":"must-not-write","path":"~/.mch-symlink"}`, "")
	// Replacement revalidates member-created links before persisting.
	require.Equal(t, 400, code, string(body))
	require.Contains(t, string(body), `"class":"user"`)
	var unchanged []byte
	require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT value_encrypted FROM repository_secrets WHERE name='SYMLINK_FILE'`).Scan(&unchanged))
	require.Equal(t, sealed, unchanged, "refused replacement cannot persist a new value")
	// An arbitrary linked parent in any member home also refuses a new
	// declaration. Nothing is written to another home or the outside target.
	for _, member := range terminals {
		installedShell(t, member, `mkdir -p "$HOME/.mch-parent-outside" && ln -s "$HOME/.mch-parent-outside" "$HOME/.mch-parent-link"`)
	}
	code, body = h.request("POST", installedSecretsURL, `{"name":"REFUSED_MEMBER_LINK","value":"must-not-write","path":"~/.mch-parent-link/key"}`, "")
	require.Equal(t, 400, code, string(body))
	require.Contains(t, string(body), `"class":"user"`)
	var count int
	require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT count(*) FROM repository_secrets WHERE name='REFUSED_MEMBER_LINK'`).Scan(&count))
	require.Zero(t, count)
	for _, member := range terminals {
		installedShell(t, member, `test ! -e "$HOME/.mch-parent-outside/key"`)
	}
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

// M-42 falsifier: the actual installed coding CLI, in the fresh TODO branch's
// agent home, consumes the declared placeholder file and implements a TODO.
// The provider is local and deterministic; the CLI, broker and relay are real.
// No sign-in, package install, host coding process or subscription token exists.
func testInstalledCodingToolSecret(t *testing.T, h *rootLayerHarness, branch, provider string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Minute)
	defer cancel()
	script := fmt.Sprintf(`test "$(id -u)" = 19999 && command -v claude && test ! -e "$HOME/.claude/.credentials.json" && test ! -e /workspace/MCH42.md && ANTHROPIC_API_KEY="$(cat "$HOME/.config/mch/relay")" ANTHROPIC_BASE_URL=%q HTTP_PROXY="$http_proxy" HTTPS_PROXY="$http_proxy" claude -p 'Implement this TODO: write MCH42.md containing M42 coding tool proof. Use the Write tool.' --tools Write --allowedTools Write --permission-mode acceptEdits --max-turns 3 --output-format json && test "$(cat /workspace/MCH42.md)" = 'M42 coding tool proof' && test ! -e "$HOME/.claude/.credentials.json"`, provider)
	result, err := h.runtime.ExecuteCommand(ctx, branch, workspaceapi.Command{Args: []string{"/bin/sh", "-c", script}})
	require.NoError(t, err)
	require.Zero(t, result.ExitCode, result.Stdout+result.Stderr)
	t.Log("C-MCH-12 M-42: installed Claude Code implemented a TODO using a declared placeholder file without sign-in")
}

// Anthropic's production streaming wire protocol, consumed by the installed
// CLI, rather than a replacement coding tool. The real key arrives only here.
func serveInstalledCodingProvider(t *testing.T, w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("x-api-key") != "mch-relay-real-fixture-0123456789abcdef" {
		t.Error("coding provider did not receive the relay-substituted key")
		http.Error(w, "invalid fixture credential", http.StatusUnauthorized)
		return
	}
	var body struct {
		Messages []struct {
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		t.Error(err)
		http.Error(w, "invalid request", 400)
		return
	}
	finished := false
	for _, message := range body.Messages {
		if bytes.Contains(message.Content, []byte(`"tool_result"`)) {
			finished = true
		}
	}
	w.Header().Set("Content-Type", "text/event-stream")
	emit := func(event string, value any) {
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Error(err)
			return
		}
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, encoded)
	}
	emit("message_start", map[string]any{"type": "message_start", "message": map[string]any{"id": "msg_mch42", "type": "message", "role": "assistant", "model": "claude-sonnet-4-5", "content": []any{}, "stop_reason": nil, "stop_sequence": nil, "usage": map[string]int{"input_tokens": 1, "output_tokens": 0}}})
	stop := "end_turn"
	if !finished {
		stop = "tool_use"
		emit("content_block_start", map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "tool_use", "id": "toolu_mch42", "name": "Write", "input": map[string]any{}}})
		emit("content_block_delta", map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "input_json_delta", "partial_json": `{"file_path":"/workspace/MCH42.md","content":"M42 coding tool proof\n"}`}})
	} else {
		emit("content_block_start", map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text", "text": ""}})
		emit("content_block_delta", map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": "TODO implemented."}})
	}
	emit("content_block_stop", map[string]any{"type": "content_block_stop", "index": 0})
	emit("message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": stop, "stop_sequence": nil}, "usage": map[string]int{"output_tokens": 1}})
	emit("message_stop", map[string]any{"type": "message_stop"})
}

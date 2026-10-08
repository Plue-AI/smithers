package compose

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net/http"
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
	body := h.expect("POST", installedSecretsURL, `{"name":"ANTHROPIC_API_KEY","value":"mch-provider-real-fixture","path":"~/.config/anthropic/key","hosts":["api.anthropic.com"],"match_headers":["x-api-key"]}`, 201)
	require.NotContains(t, string(body), "mch-provider-real-fixture")
	h.expect("POST", installedSecretsURL, `{"name":"MCH_FILE","value":"mch-file-v1","path":"~/.config/mch/key"}`, 201)
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
	digest := sha256.Sum256([]byte("mch-provider-real-fixture"))
	initial += fmt.Sprintf(` && python3 -c 'import hashlib,os; n=25; expected="%x"; assert all(hashlib.sha256(value.encode()[i:i+n]).hexdigest()!=expected for value in os.environ.values() for i in range(max(0,len(value.encode())-n+1)))'`, digest)
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

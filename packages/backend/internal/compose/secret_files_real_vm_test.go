package compose

import (
	"fmt"
	"regexp"
	"testing"
	"time"

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

func testInstalledSecretFiles(t *testing.T, h *rootLayerHarness, branch string, term *rehearsalTerminal) {
	t.Helper()
	installedShell(t, term, `test "$(stat -c '%u:%a' "$HOME/.config/anthropic/key")" = "$(id -u):600" && test "$(cat "$HOME/.config/anthropic/key")" = ANTHROPIC_API_KEY && test "$ANTHROPIC_API_KEY" = ANTHROPIC_API_KEY && ! env | grep -F mch-provider-real-fixture && test "$(cat "$HOME/.config/mch/key")" = mch-file-v1`)
	// Updates and deletes must settle in the already-running machine in five
	// seconds, rather than requiring a new machine or a terminal relaunch.
	deadline := time.Now().Add(5 * time.Second)
	h.expect("POST", installedSecretsURL, `{"name":"MCH_FILE","value":"mch-file-v2","path":"~/.config/mch/key"}`, 201)
	installedSecretDeadline(t, term, deadline, `for i in $(seq 1 50); do test "$(cat "$HOME/.config/mch/key")" = mch-file-v2 && break; sleep .1; done; test "$(cat "$HOME/.config/mch/key")" = mch-file-v2 && test "$(stat -c '%u:%a' "$HOME/.config/mch/key")" = "$(id -u):600"`)
	deadline = time.Now().Add(5 * time.Second)
	h.expect("DELETE", installedSecretsURL+"/MCH_FILE", "", 204)
	installedSecretDeadline(t, term, deadline, `for i in $(seq 1 50); do test ! -e "$HOME/.config/mch/key" && break; sleep .1; done; test ! -e "$HOME/.config/mch/key"`)
	installedShell(t, term, `printf 'outside-unchanged\n' > "$HOME/.mch-outside" && ln -s "$HOME/.mch-outside" "$HOME/.mch-symlink"`)
	code, body := h.request("POST", installedSecretsURL, `{"name":"SYMLINK_FILE","value":"must-not-write","path":"~/.mch-symlink"}`, "")
	// Member-created links can appear after declaration. The broker must
	// refuse the write without following the link even in that race.
	require.Equal(t, 201, code, string(body))
	time.Sleep(5 * time.Second)
	installedShell(t, term, `test "$(cat "$HOME/.mch-outside")" = outside-unchanged`)
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

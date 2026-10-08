package compose

import (
	"fmt"
	"net/http"
	"regexp"
	"testing"
	"time"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// These checks deliberately share the installed terminal chain: every member
// command crosses the authenticated HTTP launch and terminal WebSocket and the
// real broker. They must never use a process-runtime substitute.
func installedShell(t *testing.T, term *rehearsalTerminal, script string) {
	t.Helper()
	marker := fmt.Sprintf("MCH%d", time.Now().UnixNano())
	_, err := term.run("( "+script+" ) && printf '"+marker[:3]+"''"+marker[3:]+"\\n'", regexp.MustCompile(marker), 30*time.Second)
	require.NoError(t, err)
}

// A missing fixture is not evidence of isolation. Observe the kernel's
// EACCES for both directory enumeration and every credential-file open.
const installedBenHomeDenied = `python3 - <<'MCHDENIED'
import errno, os
for path in ("/home/ben", "/home/ben/.claude/.credentials.json", "/home/ben/.codex/auth.json", "/home/ben/.config/gh/hosts.yml"):
    try:
        if path == "/home/ben":
            os.listdir(path)
        else:
            with open(path, "rb") as f:
                f.read()
    except OSError as error:
        assert error.errno == errno.EACCES, (path, error.errno)
    else:
        raise AssertionError("private home readable: " + path)
MCHDENIED
`

func testInstalledUsers(t *testing.T, h *rootLayerHarness, branch string, term *rehearsalTerminal, benBrowser, aliceBrowser http.CookieJar) {
	t.Helper()
	installedShell(t, term, `test "$(stat -c '%u:%g:%a' "$HOME")" = "$(id -u):$(id -u):700" && test "$(stat -c '%u:%g' /workspace)" = 0:20000 && test "$(stat -c %a /workspace)" = 2775 && ! command -v sudo && ! command -v su && test -z "$(find / -xdev -type f -perm /6000 2>/dev/null)" && test -z "$(getcap -r / 2>/dev/null)" && ! mount | grep -E ' on /home(/| )'`)
	installedShell(t, term, `printf 'private-home-fixture\n' > "$HOME/.mch-private" && printf 'member\n' > /workspace/mch-team.txt && test "$(stat -c '%g:%a' /workspace/mch-team.txt)" = 20000:664 && for i in $(seq 1 10); do jj st && git status || exit 1; done`)
	result, err := h.runtime.ExecuteCommand(t.Context(), branch, workspaceapi.Command{Args: []string{"/bin/sh", "-c", `test "$(id -u)" = 19999 && test "$(id -g)" = 19999 && test "$(id -G)" = '19999 20000' && printf 'agent\n' >> /workspace/mch-team.txt && for i in $(seq 1 10); do jj st && git status || exit 1; done; for home in /home/*; do test "$home" = /home/agent && continue; test ! -r "$home/.mch-private" || exit 1; done`}})
	require.NoError(t, err)
	require.Zero(t, result.ExitCode, result.Stdout+result.Stderr)
	installedShell(t, term, `test "$(cat /workspace/mch-team.txt)" = "$(printf 'member\nagent')" && test "$(stat -c '%g:%a' /workspace/mch-team.txt)" = 20000:664`)
	ben := installedMemberTerminal(t, h, branch, benBrowser)
	alice := installedMemberTerminal(t, h, branch, aliceBrowser)
	defer ben.close()
	defer alice.close()
	installedShell(t, ben, `test "$(id -u)" = 20001 && test "$(id -g)" = 20001 && test "$(id -G)" = '20001 20000' && test "$HOME" = /home/ben && test "$(stat -c '%u:%g:%a' /home/ben)" = 20001:20001:700 && mkdir -p "$HOME/.config/gh" && printf 'ben-private-fixture\n' > "$HOME/.config/gh/hosts.yml" && printf 'ben\n' > /workspace/mch-members.txt`)
	installedShell(t, alice, `test "$(id -u)" = 20002 && test "$(id -g)" = 20002 && test "$(id -G)" = '20002 20000' && test "$HOME" = /home/alice && test "$(stat -c '%u:%g:%a' /home/alice)" = 20002:20002:700 && ! cat /home/ben/.config/gh/hosts.yml && printf 'alice\n' >> /workspace/mch-members.txt && for i in $(seq 1 10); do jj st && git status || exit 1; done`)
	result, err = h.runtime.ExecuteCommand(t.Context(), branch, workspaceapi.Command{Args: []string{"/bin/sh", "-c", `! cat /home/ben/.config/gh/hosts.yml && printf 'agent\n' >> /workspace/mch-members.txt`}})
	require.NoError(t, err)
	require.Zero(t, result.ExitCode, result.Stdout+result.Stderr)
	installedShell(t, ben, `test "$(cat /workspace/mch-members.txt)" = "$(printf 'ben\nalice\nagent')" && test "$(stat -c '%g:%a' /workspace/mch-members.txt)" = 20000:664 && for i in $(seq 1 10); do jj st && git status || exit 1; done`)
	// Carol joins after boot; her first admitted session creates a private home
	// without replacing the running machine or either existing member's home.
	memberFixture := &rehearsal{ctx: t.Context(), origin: h.origin, jar: h.jar, client: h.client, fake: h.github}
	carolBrowser, err := memberFixture.member("carol", 10, "write")
	require.NoError(t, err)
	carol := installedMemberTerminal(t, h, branch, carolBrowser)
	defer carol.close()
	installedShell(t, carol, `test "$(id -u)" = 20003 && test "$HOME" = /home/carol && test "$(stat -c '%u:%g:%a' /home/carol)" = 20003:20003:700`)
	code, body := h.request("GET", "/api/repos/rehearsal-owner/app/workspaces/"+branch+"/ssh?user=root", "", "")
	require.Equal(t, 400, code, string(body))
	require.Contains(t, string(body), "workspace_ssh_user_invalid")
}

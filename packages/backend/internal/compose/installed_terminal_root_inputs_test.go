package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// Executed by a login rc file, before the interactive prompt, and again as a
// branch executable. Observations are written before assertions so a failed
// privilege drop leaves evidence. No bearer contents are recorded.
const installedTerminalStartupCanary = `import json, os, pathlib, sys
home = pathlib.Path(os.environ["HOME"])
fds = {}
for name in os.listdir("/proc/self/fd"):
    try:
        fds[name] = os.readlink("/proc/self/fd/" + name)
    except FileNotFoundError:
        pass
row = {"uid": os.getuid(), "euid": os.geteuid(), "gid": os.getgid(), "groups": os.getgroups(), "fds": fds, "phase": sys.argv[1]}
with open(home / ".trm-startup.jsonl", "a") as out:
    out.write(json.dumps(row) + "\n")
assert row["uid"] == row["euid"] == row["gid"] == 20001, row
assert row["groups"] == [20000], row
assert str(home) == "/home/ben"
assert os.getcwd() == "/workspace"
mask = os.umask(0o002)
assert mask == 0o002
assert "SMITHERS_TOKEN" not in os.environ
assert not any(key in os.environ for key in ("LD_PRELOAD", "LD_LIBRARY_PATH", "BASH_ENV", "ENV"))
assert all(int(fd) <= 2 for fd in fds), fds
p = pathlib.Path(os.environ["SMITHERS_TOKEN_FILE"])
assert str(p).startswith("/run/smithers/20001/token/sessions/")
assert p.name == "token" and p.stat().st_uid == 20001
assert p.stat().st_mode & 0o777 == 0o600
`

// A surviving session swaps only its sibling's token leaf while the owner
// closes that sibling through the real socket. The foreign-session file must
// remain byte-identical. Hashes and token bytes never leave the guest.
const installedTerminalCredentialRace = `import hashlib, os, pathlib, time
home = pathlib.Path(os.environ["HOME"])
a = pathlib.Path((home / ".trm-a-path").read_text().strip())
b = pathlib.Path(os.environ["SMITHERS_TOKEN_FILE"])
assert a != b and a.parent.parent == b.parent.parent
original = hashlib.sha256(b.read_bytes()).digest()
saved = a.with_name("saved-token")
a.rename(saved)
count = 0
while not (home / ".trm-race-stop").exists():
    try:
        a.unlink()
    except FileNotFoundError:
        pass
    a.symlink_to(b)
    count += 1
    if count >= 1000:
        (home / ".trm-race-ready").write_text(str(count))
    assert hashlib.sha256(b.read_bytes()).digest() == original
    try:
        a.unlink()
    except FileNotFoundError:
        pass
    time.sleep(.001)
assert hashlib.sha256(b.read_bytes()).digest() == original
assert count >= 1000
for p in (a, saved):
    try:
        p.unlink()
    except FileNotFoundError:
        pass
(home / ".trm-race-done").write_text(str(count))
`

func testInstalledTerminalRootInputs(t *testing.T, h *rootLayerHarness, branch string, ben http.CookieJar) {
	t.Helper()
	a := installedMemberTerminal(t, h, branch, ben)
	installedShell(t, a, `test "$(id -u)" = 20001 && test ! -e "$HOME/.trm-profile-saved" && if test -e "$HOME/.bash_profile"; then mv "$HOME/.bash_profile" "$HOME/.trm-profile-saved"; fi`)
	// The canary and rc are member-written inputs. They never become a packaged
	// helper or a root recipe; only a broker-dropped member shell loads them.
	installedShell(t, a, "cat > /workspace/trm-startup.py <<'TRMCANARY'\n"+installedTerminalStartupCanary+"\nTRMCANARY\n"+`printf 'python3 /workspace/trm-startup.py rc || exit 91\n' > "$HOME/.bash_profile" && printf 'retained-home\n' > "$HOME/.trm-retained" && printf '%s\n' "$SMITHERS_TOKEN_FILE" > "$HOME/.trm-a-path"`)
	b := installedMemberTerminal(t, h, branch, ben)
	// The rc must have run before commands can reach the new prompt.
	installedShell(t, b, `test "$(wc -l < "$HOME/.trm-startup.jsonl")" = 1 && python3 /workspace/trm-startup.py executable`)
	installedShell(t, b, "cat > /workspace/trm-race.py <<'TRMRACE'\n"+installedTerminalCredentialRace+"\nTRMRACE\n"+`python3 /workspace/trm-race.py > "$HOME/.trm-race-output" 2>&1 &`)
	installedShell(t, b, `for i in $(seq 1 100); do test -s "$HOME/.trm-race-ready" && break; sleep .05; done; test -s "$HOME/.trm-race-ready"`)
	closeCtx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	require.NoError(t, a.conn.Write(closeCtx, websocket.MessageText, []byte(`{"type":"close"}`)))
	select {
	case <-a.closed:
	case <-closeCtx.Done():
		t.Fatal("owner close failed during token-leaf swaps")
	}
	installedShell(t, b, `touch "$HOME/.trm-race-stop"; for i in $(seq 1 100); do test -s "$HOME/.trm-race-done" && break; sleep .05; done; test -s "$HOME/.trm-race-done" && test ! -s "$HOME/.trm-race-output" && python3 /workspace/trm-startup.py survivor && printf '%s\n' "$SMITHERS_TOKEN_FILE" > "$HOME/.trm-b-path"`)
	code, body := h.request("POST", "/api/branches/"+branch, `{"op":"sleep"}`, uuid.NewString())
	require.Equal(t, 202, code, string(body))
	require.Eventually(t, func() bool {
		machine, err := h.runtime.InspectWorkspace(t.Context(), branch)
		return err == nil && machine.State == workspaceapi.WorkspaceStopped
	}, 2*time.Minute, 100*time.Millisecond)
	select {
	case <-b.closed:
	case <-time.After(5 * time.Second):
		t.Fatal("sleep retained the old terminal socket")
	}
	retained := installedMemberTerminal(t, h, branch, ben)
	installedShell(t, retained, `test "$(cat "$HOME/.trm-retained")" = retained-home && test "$(wc -l < "$HOME/.trm-startup.jsonl")" = 4 && test "$SMITHERS_TOKEN_FILE" != "$(cat "$HOME/.trm-b-path")" && test ! -e "$(cat "$HOME/.trm-b-path")" && python3 /workspace/trm-startup.py retained && rm "$HOME/.bash_profile" && if test -e "$HOME/.trm-profile-saved"; then mv "$HOME/.trm-profile-saved" "$HOME/.bash_profile"; fi`)
	// Restart the composed install with a live terminal, rather than closing
	// its socket first and hiding a missing shutdown/revocation hook.
	installedShell(t, retained, `printf '%s\n' "$SMITHERS_TOKEN_FILE" > "$HOME/.trm-c-path"`)
	h.recompose()
	select {
	case <-retained.closed:
	case <-time.After(5 * time.Second):
		t.Fatal("install recomposition retained the old terminal socket")
	}
	restarted := installedMemberTerminal(t, h, branch, ben)
	installedShell(t, restarted, `test "$(id -u)" = 20001 && test "$(cat "$HOME/.trm-retained")" = retained-home && test "$SMITHERS_TOKEN_FILE" != "$(cat "$HOME/.trm-c-path")" && test ! -e "$(cat "$HOME/.trm-c-path")" && test -r "$SMITHERS_TOKEN_FILE"`)
}

// Linux validates the exact guest workloads and the canary's failure receipt.
// This is deliberately separate from native execution evidence.
func TestInstalledTerminalStartupWorkload(t *testing.T) {
	python, err := exec.LookPath("python3")
	require.NoError(t, err)
	for i, script := range []string{installedTerminalStartupCanary, installedTerminalCredentialRace} {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			out, err := exec.CommandContext(t.Context(), python, "-c", "import sys; compile(sys.argv[1], '<terminal-acceptance>', 'exec')", script).CombinedOutput()
			require.NoError(t, err, string(out))
		})
	}
	home := t.TempDir()
	cmd := exec.CommandContext(t.Context(), python, "-c", installedTerminalStartupCanary, "rc")
	cmd.Env = []string{"HOME=" + home}
	out, err := cmd.CombinedOutput()
	require.Error(t, err)
	require.Contains(t, string(out), "AssertionError")
	data, err := os.ReadFile(home + "/.trm-startup.jsonl")
	require.NoError(t, err)
	var observed struct {
		UID int `json:"uid"`
	}
	require.NoError(t, json.Unmarshal(data, &observed))
	require.Equal(t, os.Getuid(), observed.UID)
	require.NotEqual(t, 20001, observed.UID)
}

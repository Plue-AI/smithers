package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
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
row = {"uid": os.getuid(), "euid": os.geteuid(), "gid": os.getgid(), "resuid": list(os.getresuid()), "resgid": list(os.getresgid()), "groups": os.getgroups(), "fds": fds, "phase": sys.argv[1]}
with open(home / ".trm-startup.jsonl", "a") as out:
    out.write(json.dumps(row) + "\n")
assert row["uid"] == row["euid"] == row["gid"] == 20001, row
assert row["resuid"] == [20001, 20001, 20001], row
assert row["resgid"] == [20001, 20001, 20001], row
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
	// Repeat the HTTP root-input matrix with every real provider composed.
	// Record the token high-water mark so concurrent cleanup cannot disguise
	// a newly minted credential behind a decreased total row count.
	var highWater int64
	require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT coalesce(max(id),0) FROM access_tokens`).Scan(&highWater))
	requests := &rehearsal{ctx: t.Context(), origin: h.origin, jar: ben, client: h.client}
	for _, field := range []string{
		`"uid":0`, `"uid":19999`, `"owner":0`, `"member":0`,
		`"login":"root"`, `"login":"../ben"`, `"login":"alice"`,
		`"session":"../foreign"`, `"run":"foreign-run"`,
		`"argv":["/workspace/trm-startup.py"]`, `"shell":"/workspace/trm-startup.py"`,
		`"environment":{"LD_PRELOAD":"/workspace/trm-startup.so","BASH_ENV":"/workspace/trm-startup.py"}`,
		`"cwd":"/root"`, `"token_file":"/run/smithers/20002/token/sessions/foreign/token"`,
		`"cols":0`, `"rows":65536`,
	} {
		t.Run("native HTTP refuses "+field, func(t *testing.T) {
			code, body, err := requests.keyedAs(ben, "POST", "/api/terminals", fmt.Sprintf(`{"branch":%q,%s}`, branch, field), uuid.NewString())
			require.NoError(t, err)
			require.Equal(t, 400, code, string(body))
		})
	}
	var minted int
	require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT count(*) FROM access_tokens WHERE id>$1 AND name LIKE 'terminal-session-%'`, highWater).Scan(&minted))
	require.Zero(t, minted, "invalid native HTTP requests minted terminal credentials")
	a := installedMemberTerminal(t, h, branch, ben)
	testInstalledTerminalAdmissionInputs(t, h, branch, a, "fresh")
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
	installedShell(t, retained, `test "$(cat "$HOME/.trm-retained")" = retained-home && test "$(wc -l < "$HOME/.trm-startup.jsonl")" = 4 && test "$SMITHERS_TOKEN_FILE" != "$(cat "$HOME/.trm-b-path")" && test ! -e "$(cat "$HOME/.trm-b-path")" && python3 /workspace/trm-startup.py retained`)
	testInstalledTerminalAdmissionInputs(t, h, branch, retained, "retained")
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
	installedShell(t, restarted, `test "$(id -u)" = 20001 && test "$(cat "$HOME/.trm-retained")" = retained-home && test "$SMITHERS_TOKEN_FILE" != "$(cat "$HOME/.trm-c-path")" && test ! -e "$(cat "$HOME/.trm-c-path")" && test -r "$SMITHERS_TOKEN_FILE" && test "$(wc -l < "$HOME/.trm-startup.jsonl")" = 6 && python3 /workspace/trm-startup.py restarted && rm "$HOME/.bash_profile" && if test -e "$HOME/.trm-profile-saved"; then mv "$HOME/.trm-profile-saved" "$HOME/.bash_profile"; fi`)
	testInstalledTerminalAdmissionInputs(t, h, branch, restarted, "restarted")
}

// Exercise the installed member admission and real broker launcher, bypassing
// HTTP's unknown-field rejection. Every invalid case carries an executable
// side-effect canary; a surviving HTTP/WebSocket terminal checks it never ran.
// Repeat on retained disks and after host recomposition, with no test transport.
func testInstalledTerminalAdmissionInputs(t *testing.T, h *rootLayerHarness, branch string, observer *rehearsalTerminal, phase string) {
	t.Helper()
	writer, err := h.runtime.SessionCredentialsForMember(t.Context(), branch, microsandbox.MemberIdentity{Login: "ben", UID: 20001, Active: true})
	require.NoError(t, err)
	testInstalledTerminalAdmissionControl(t, writer, branch)
	cases := []struct{ name, key, value string }{
		{"empty name", "", "x"},
		{"numeric name", "1BAD", "x"},
		{"non ASCII name", "BÉN", "x"},
		{"newline name", "BAD\nKEY", "x"},
		{"equals in name", "BAD=KEY", "x"},
		{"nul in name", "BAD\x00KEY", "x"},
		{"oversized name", strings.Repeat("K", 257), "x"},
		{"nul in value", "SAFE", "x\x00y"},
		{"oversized URL", "SMITHERS_URL", strings.Repeat("x", 4097)},
		{"empty URL", "SMITHERS_URL", ""},
		{"NUL URL", "SMITHERS_URL", "http://localhost/\x00"},
		{"NUL token path", "SMITHERS_TOKEN_FILE", "/run/smithers/20001/token/\x00"},
		{"foreign uid path", "SMITHERS_TOKEN_FILE", "/run/smithers/20002/token/sessions/foreign/token"},
		{"path traversal", "SMITHERS_TOKEN_FILE", "/run/smithers/20001/token/sessions/../foreign/token"},
		{"oversized envelope", "SAFE", strings.Repeat("x", 256*1024)},
		{"too many entries", "SAFE", "x"},
		{"foreign working directory", "SAFE", "x"},
		{"traversing working directory", "SAFE", "x"},
		{"NUL executable", "SAFE", "x"},
		{"oversized executable", "SAFE", "x"},
		{"invalid UTF8 executable", "SAFE", "x"},
	}
	for _, cell := range cases {
		t.Run(phase+"/"+cell.name, func(t *testing.T) {
			session := uuid.NewString()
			token := []byte("smithers_acceptance_literal")
			digest := workspaceapi.SessionCredentialIdentity(token)
			tokenPath, err := writer.PutSessionToken(t.Context(), branch, session, token, "")
			require.NoError(t, err)
			defer func() { require.NoError(t, writer.DeleteSessionToken(t.Context(), branch, session, digest)) }()
			environment := map[string]string{"SMITHERS_TOKEN_FILE": tokenPath, "SMITHERS_URL": "http://127.0.0.1:4000"}
			environment[cell.key] = cell.value
			if cell.name == "too many entries" {
				for i := 0; i < 1001; i++ {
					environment[fmt.Sprintf("ENTRY_%d", i)] = "x"
				}
			}
			marker := "/workspace/trm-invalid-" + session
			installedTerminalInventory(t, observer, marker, "save")
			defer installedShell(t, observer, fmt.Sprintf("rm -f %q", marker+".inventory"))
			command := workspaceapi.Command{Args: []string{"/bin/sh", "-c", "touch " + marker + "; printf INVALID_ADMISSION_EXECUTED"}, Environment: environment}
			switch cell.name {
			case "foreign working directory":
				command.Directory = "/root"
			case "traversing working directory":
				command.Directory = "/workspace/../root"
			case "NUL executable":
				command.Args[0] = "/bin/sh\x00"
			case "oversized executable":
				command.Args[0] = strings.Repeat("x", 4097)
			case "invalid UTF8 executable":
				command.Args[0] = "\xff"
			}
			terminal, openErr := writer.OpenTerminal(t.Context(), branch, session, digest, command)
			// The broker can refuse synchronously, or its dropped-uid launcher can
			// reject the sealed binding and exit before evaluating the executable.
			if openErr == nil {
				require.NotNil(t, terminal)
				defer terminal.Close()
				done := make(chan struct{})
				var output []byte
				var readErr error
				go func() { output, readErr = io.ReadAll(terminal); close(done) }()
				select {
				case <-done:
					require.Error(t, readErr, "invalid binding must produce an unsuccessful launcher exit")
					require.NotContains(t, string(output), "INVALID_ADMISSION_EXECUTED")
				case <-time.After(10 * time.Second):
					require.NoError(t, terminal.Close())
					<-done
					t.Fatal("invalid admission left a live broker session")
				}
			} else {
				require.Nil(t, terminal)
			}
			installedShell(t, observer, fmt.Sprintf("test ! -e %q && test \"$(id -u)\" = 20001", marker))
			installedTerminalInventory(t, observer, marker, "0")
		})
	}
	testInstalledTerminalAdmissionControl(t, writer, branch)
	testInstalledTerminalEnvironmentBoundaries(t, writer, branch, observer, phase)
	testInstalledTerminalOpeningReplacement(t, writer, branch, observer, phase)
	testInstalledTerminalTokenPaths(t, writer, branch, observer, phase)
	testInstalledTerminalForeignTokenMutation(t, writer, branch, observer, phase)
}

// A valid binding must execute on both sides of the refusal matrix; an
// unavailable admission provider must never make every negative cell pass.
func testInstalledTerminalAdmissionControl(t *testing.T, writer microsandbox.MemberSessionCredentials, branch string) {
	t.Helper()
	session := uuid.NewString()
	token := []byte("smithers_acceptance_control")
	digest := workspaceapi.SessionCredentialIdentity(token)
	tokenPath, err := writer.PutSessionToken(t.Context(), branch, session, token, "")
	require.NoError(t, err)
	defer func() { require.NoError(t, writer.DeleteSessionToken(t.Context(), branch, session, digest)) }()
	terminal, err := writer.OpenTerminal(t.Context(), branch, session, digest, workspaceapi.Command{
		Args:        []string{"/bin/sh", "-c", "test \"$(id -u)\" = 20001 && printf ADMISSION_CONTROL_OK"},
		Environment: map[string]string{"SMITHERS_TOKEN_FILE": tokenPath, "SMITHERS_URL": "http://127.0.0.1:4000"},
	})
	require.NoError(t, err)
	defer terminal.Close()
	done := make(chan struct{})
	var output []byte
	var readErr error
	go func() { output, readErr = io.ReadAll(terminal); close(done) }()
	select {
	case <-done:
		require.NoError(t, readErr)
		require.Equal(t, "ADMISSION_CONTROL_OK", string(output))
	case <-time.After(10 * time.Second):
		require.NoError(t, terminal.Close())
		<-done
		t.Fatal("valid admission control did not exit")
	}
}

const installedTerminalEnvironmentCanary = `import os, sys
assert os.getresuid() == (20001, 20001, 20001)
assert os.getresgid() == (20001, 20001, 20001)
assert os.getgroups() == [20000]
assert os.environ["SAFE"] == sys.argv[1]
assert os.environ["K"*256] == "boundary-name"
assert len(os.environ["SMITHERS_URL"]) == 4096
assert all(os.environ["ENTRY_"+str(i)] == "boundary-entry" for i in range(995))
assert not os.path.exists(sys.argv[2])
print("ENVIRONMENT_BOUNDARY_OK", end="")`

// Positive controls exercise the literal limits through the real broker. Shell
// syntax in environment values is data; it must not run while constructing the
// session, and valid boundary values must survive the dropped-uid launcher.
func testInstalledTerminalEnvironmentBoundaries(t *testing.T, writer microsandbox.MemberSessionCredentials, branch string, observer *rehearsalTerminal, phase string) {
	t.Helper()
	t.Run(phase+"/environment literal boundary values", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
		defer cancel()
		session := uuid.NewString()
		token := []byte("smithers_environment_boundary")
		digest := workspaceapi.SessionCredentialIdentity(token)
		path, err := writer.PutSessionToken(ctx, branch, session, token, "")
		require.NoError(t, err)
		defer func() {
			cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
			defer stop()
			require.NoError(t, writer.DeleteSessionToken(cleanup, branch, session, digest))
		}()
		marker := "/workspace/trm-env-" + session
		installedTerminalInventory(t, observer, marker, "save")
		defer installedShell(t, observer, fmt.Sprintf("rm -f %q", marker+".inventory"))
		literal := "$(touch " + marker + "); `touch " + marker + "`\n'\"; café"
		environment := map[string]string{
			"SMITHERS_TOKEN_FILE":    path,
			"SMITHERS_URL":           "http://localhost/" + strings.Repeat("x", 4079),
			"SAFE":                   literal,
			strings.Repeat("K", 256): "boundary-name",
		}
		// Four entries above plus 995 plus the runtime's TERM = 1,000.
		for i := 0; i < 995; i++ {
			environment[fmt.Sprintf("ENTRY_%d", i)] = "boundary-entry"
		}
		command := workspaceapi.Command{
			Args:        []string{"/bin/sh", "-c", `exec python3 -c "$1" "$2" "$3"`, "trm-env", installedTerminalEnvironmentCanary, literal, marker},
			Environment: environment,
		}
		terminal, err := writer.OpenTerminal(ctx, branch, session, digest, command)
		require.NoError(t, err)
		defer terminal.Close()
		done := make(chan struct{})
		var output []byte
		var readErr error
		go func() { output, readErr = io.ReadAll(terminal); close(done) }()
		select {
		case <-done:
			require.NoError(t, readErr)
			require.Equal(t, "ENVIRONMENT_BOUNDARY_OK", string(output))
		case <-ctx.Done():
			_ = terminal.Close()
			<-done
			t.Fatal("valid environment boundaries did not complete")
		}
		installedShell(t, observer, fmt.Sprintf("test ! -e %q", marker))
		installedTerminalInventory(t, observer, marker, "0")
	})
}

// Linux validates the exact guest workloads and the canary's failure receipt.
// This is deliberately separate from native execution evidence.
func TestInstalledTerminalStartupWorkload(t *testing.T) {
	python, err := exec.LookPath("python3")
	require.NoError(t, err)
	for i, script := range []string{installedTerminalStartupCanary, installedTerminalCredentialRace, installedTerminalSessionInventory, installedTerminalEnvironmentCanary} {
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

package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// This targets the running installed service, not rootLayerHarness.recompose.
// Opt-in authorizes disruption of a disposable reference install only.
func TestInstalledPhysicalHomeRestart(t *testing.T) {
	if os.Getenv("SMITHERS_PHYSICAL_HOME_RESTART") != "1" {
		t.Skip("disposable reference Mac install required")
	}
	require.Equal(t, "darwin", runtime.GOOS)
	origin := os.Getenv("SMITHERS_RESTART_ORIGIN")
	parsed, err := url.Parse(origin)
	require.NoError(t, err)
	require.Contains(t, []string{"http", "https"}, parsed.Scheme)
	require.NotEmpty(t, parsed.Host)
	jar, err := cookiejar.New(nil)
	require.NoError(t, err)
	session := os.Getenv("SMITHERS_RESTART_BEN_SESSION")
	require.NotEmpty(t, session)
	jar.SetCookies(parsed, []*http.Cookie{{Name: "smithers_session", Value: session, Path: "/"}, {Name: "__csrf", Value: uuid.NewString(), Path: "/"}})
	r := &rehearsal{ctx: t.Context(), origin: strings.TrimRight(origin, "/"), jar: jar, client: &http.Client{Jar: jar, Timeout: 30 * time.Second}}
	branches := []string{os.Getenv("SMITHERS_RESTART_BRANCH_A"), os.Getenv("SMITHERS_RESTART_BRANCH_B")}
	require.NotEmpty(t, branches[0])
	require.NotEmpty(t, branches[1])
	require.NotEqual(t, branches[0], branches[1])
	open := func(branch string) *rehearsalTerminal {
		key := uuid.NewString()
		var current services.WorkspaceSessionResponse
		require.Eventually(t, func() bool {
			code, body, err := r.keyedAs(jar, "POST", "/api/terminals", fmt.Sprintf(`{"branch":%q}`, branch), key)
			if err != nil || code != 202 || json.Unmarshal(body, &current) != nil {
				return false
			}
			return current.Status == "running" && current.ID != ""
		}, 15*time.Minute, 250*time.Millisecond)
		term, err := r.openTerminal(current.ID)
		require.NoError(t, err)
		t.Cleanup(term.close)
		return term
	}
	// A real service PID, not a marker, binds evidence to the restart.
	pid := func() string {
		out, err := exec.CommandContext(t.Context(), "/bin/launchctl", "print", fmt.Sprintf("gui/%d/sh.smithers.host", os.Getuid())).CombinedOutput()
		require.NoError(t, err)
		match := regexp.MustCompile(`\bpid = (\d+)`).FindStringSubmatch(string(out))
		require.Len(t, match, 2)
		return match[1]
	}
	terms := []*rehearsalTerminal{open(branches[0]), open(branches[1])}
	for i, term := range terms {
		tag := []string{"A", "B"}[i]
		installedShell(t, term, fmt.Sprintf(`test "$(id -u)" = 20001 && test "$(stat -c '%%u:%%g:%%a' "$HOME")" = 20001:20001:700 && test ! -e "$HOME/.marker" && test ! -e "$HOME/.claude/.credentials.json" && test ! -e "$HOME/.codex/auth.json" && test ! -e "$HOME/.config/gh/hosts.yml" && mkdir -p "$HOME/.claude" "$HOME/.codex" "$HOME/.config/gh" && printf 'mch-claude-%s-fixture\n' > "$HOME/.claude/.credentials.json" && printf 'mch-codex-%s-fixture\n' > "$HOME/.codex/auth.json" && printf 'mch-gh-%s-fixture\n' > "$HOME/.config/gh/hosts.yml" && printf 'mch-marker-%s-fixture\n' > "$HOME/.marker" && test "$(stat -c %%a "$HOME/.marker")" = 664`, tag, tag, tag, tag))
	}
	testInstalledHomeWorkload(t, terms[0], terms[1])
	digest := func(term *rehearsalTerminal) string {
		marker := uuid.NewString()
		script := "python3 - <<'MCHDIGEST'\n" + fmt.Sprintf(installedRestartDigest, marker) + "\nMCHDIGEST"
		matches, err := term.run(script, regexp.MustCompile("MCHDIGEST"+regexp.QuoteMeta(marker)+`=([a-f0-9]{64})`), time.Minute)
		require.NoError(t, err)
		return matches[1]
	}
	before := []string{digest(terms[0]), digest(terms[1])}
	require.NotEqual(t, before[0], before[1])
	oldPID := pid()
	for _, term := range terms {
		term.close()
	}
	cli, err := exec.LookPath("smthrs")
	require.NoError(t, err)
	run := func(action string) {
		ctx, cancel := context.WithTimeout(t.Context(), 2*time.Minute)
		defer cancel()
		output, err := exec.CommandContext(ctx, cli, "host", action).CombinedOutput()
		require.NoError(t, err, string(output))
	}
	// Restore service even when the stop assertion fails.
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		_ = exec.CommandContext(ctx, cli, "host", "start").Run()
	})
	run("stop")
	_, err = exec.CommandContext(t.Context(), "/bin/launchctl", "print", fmt.Sprintf("gui/%d/sh.smithers.host", os.Getuid())).CombinedOutput()
	require.Error(t, err, "host stop must unload the physical service")
	run("start")
	require.Eventually(t, func() bool {
		response, err := r.client.Get(r.origin + "/readyz")
		if err != nil {
			return false
		}
		defer response.Body.Close()
		return response.StatusCode == 200
	}, 2*time.Minute, 250*time.Millisecond)
	newPID := pid()
	require.NotEqual(t, oldPID, newPID)
	for i, branch := range branches {
		term := open(branch)
		require.Equal(t, before[i], digest(term), "machine home changed across physical restart")
		installedShell(t, term, `test "$(stat -c '%u:%g:%a' "$HOME")" = 20001:20001:700 && test "$(stat -c '%u:%a' "$HOME/.marker")" = 20001:664 && ! mount | grep -E ' on /home(/| )'`)
	}
	t.Logf("physical launchd restart %s -> %s; A digest=%s B digest=%s", oldPID, newPID, before[0], before[1])
}

// Scope the receipt to personal logins, marker and the verified spike workload.
// Emit only a digest, never credentials or home contents.
const installedRestartDigest = `import hashlib, os, pathlib, stat
home = pathlib.Path(os.environ["HOME"])
h = hashlib.sha256()
for name in (".marker", ".claude/.credentials.json", ".codex/auth.json", ".config/gh/hosts.yml", ".claude/mch-load", ".config/gh/mch-load", ".npm/_cacache/mch-load"):
    root = home / name
    assert root.exists(), name
    for path in sorted([root] + (list(root.rglob("*")) if root.is_dir() else [])):
        info = path.lstat()
        assert not stat.S_ISLNK(info.st_mode)
        h.update(str(path.relative_to(home)).encode())
        h.update(str((info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode))).encode())
        if path.is_file():
            h.update(path.read_bytes())
print("MCH" + "DIGEST%s=" + h.hexdigest())`

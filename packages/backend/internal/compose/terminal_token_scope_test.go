package compose

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// C-SEC-05 CI coverage: the authenticated terminal WebSocket mints the
// credential, and the compiled guest CLI crosses the real install HTTP/auth/catalog
// boundary. Only the PTY and guest token file are doubles: CI has no microVM.
// Physical Linux-arm64 guest isolation still requires the native check.
func TestTerminalTokenScopeComposedInstall(t *testing.T) {
	terminalReplacementInstall(t, false, true)
}

// Simultaneous sessions use the same member and branch. Both credentials come
// from authenticated terminal lifecycle routes; no direct token mint is used.
func TestTerminalIndependentSessionsComposedInstall(t *testing.T) {
	terminalReplacementInstall(t, false, true, true)
}

func exerciseTerminalCatalogScope(t *testing.T, ctx context.Context, origin, token string, closed bool) {
	t.Helper()
	cli := newPackagedTerminalCLI(t, ctx, origin, token)
	invoke := cli.invoke
	skill, err := os.ReadFile("../../../smithers/skills/smithers/SKILL.md")
	require.NoError(t, err)
	for _, command := range []string{"smthrs todo new", "smthrs todo drop", "smthrs merge", "smthrs wiki show", "smthrs wiki page"} {
		require.Contains(t, string(skill), "`"+command+"`", "the packaged skill must advertise the exercised production command")
	}

	if !closed {
		code, identity := invoke("auth", "status")
		require.Zero(t, code)
		require.Equal(t, "ben", identity["username"])
		require.Equal(t, "delegated", identity["credential_kind"])
		require.Equal(t, "terminal", identity["via"])
		require.NotContains(t, identity, "token")
		code, index := invoke("wiki", "show", "--owner", "ben", "--repo", "demo")
		require.Zero(t, code, index)
		pages, ok := index["items"].([]any)
		require.True(t, ok, index)
		require.Len(t, pages, 1)
		require.Equal(t, "terminal-scope", pages[0].(map[string]any)["slug"])
		code, page := invoke("wiki", "page", "terminal-scope", "--owner", "ben", "--repo", "demo")
		require.Zero(t, code, page)
		require.Equal(t, "Terminal scope", page["title"])
		require.Equal(t, "Read through the packaged skill", page["body"])
		exercisePackagedTerminalFileRefusals(t, cli, origin, token)
	}
	if closed {
		for _, argv := range [][]string{{"wiki", "show", "--owner", "ben", "--repo", "demo"}, {"wiki", "page", "terminal-scope", "--owner", "ben", "--repo", "demo"}} {
			code, receipt := invoke(argv...)
			require.Equal(t, 1, code)
			require.Equal(t, "permission", receipt["class"])
			require.Equal(t, "unauthenticated", receipt["code"])
		}
	}
	for _, fixture := range []struct {
		argv []string
		code string
	}{
		{[]string{"todo", "new", "--text", "A guest cannot append without confirmation", "--idempotencyKey", "terminal-scope-new"}, "confirm_in_app"},
		{[]string{"todo", "new", "--text", "A guest cannot insert", "--before", "T2", "--idempotencyKey", "terminal-scope-before"}, "permission"},
		{[]string{"todo", "drop", "T2"}, "permission"},
		{[]string{"stack", "move", "T2", "up"}, "permission"},
		{[]string{"todo", "amend", "T2", "A guest cannot change the prompt"}, "permission"},
		{[]string{"todo", "stop", "T2"}, "permission"},
		{[]string{"todo", "resume", "T2"}, "permission"},
		{[]string{"todo", "retry", "T2"}, "permission"},
		{[]string{"merge", "T2", "--reviewed_head_sha", strings.Repeat("a", 40)}, "permission"},
	} {
		code, receipt := invoke(fixture.argv...)
		require.Equal(t, 1, code, fixture.argv)
		expected := fixture.code
		if closed {
			expected = "unauthenticated"
		}
		require.Equal(t, "permission", receipt["class"], fixture.argv)
		require.Equal(t, expected, receipt["code"], fixture.argv)
		require.NotContains(t, receipt, "confirmation")
		require.NotContains(t, receipt, "state")
	}
	// Forged attribution and profile hints cannot widen the persisted terminal
	// authority. Check these at HTTP as well as through the installed CLI parser.
	for _, fixture := range []struct{ method, path, body string }{
		{"GET", "/api/install", ""},
		{"GET", "/api/members", ""},
		{"GET", "/api/secrets", ""},
		{"POST", "/api/todos", `{"title":"After","prompt":"Forbidden placement","place":{"mode":"after","n":2}}`},
	} {
		path := fixture.path
		req, err := http.NewRequestWithContext(ctx, fixture.method, origin+path, strings.NewReader(fixture.body))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", "terminal-scope-after")
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Smithers-Via", "cli")
		req.Header.Set("Smithers-Actor-Kind", "person")
		req.Header.Set("Smithers-Profile", "full")
		res, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		var receipt map[string]any
		err = json.NewDecoder(res.Body).Decode(&receipt)
		_ = res.Body.Close()
		require.NoError(t, err)
		status, expected := http.StatusForbidden, "permission"
		if closed {
			status, expected = http.StatusUnauthorized, "unauthenticated"
		}
		require.Equal(t, status, res.StatusCode, path)
		require.Equal(t, "permission", receipt["class"], path)
		require.Equal(t, expected, receipt["code"], path)
	}
}

// Compile the production guest entry for this CI host; native acceptance uses
// the same entry cross-compiled to Linux arm64 in the install manifest.
func packagedTerminalCLIInvoker(t *testing.T, ctx context.Context, origin, token string) func(...string) (int, map[string]any) {
	return newPackagedTerminalCLI(t, ctx, origin, token).invoke
}

type packagedTerminalCLI struct {
	tokenFile string
	home      string
	invoke    func(...string) (int, map[string]any)
}

func newPackagedTerminalCLI(t *testing.T, ctx context.Context, origin, token string) *packagedTerminalCLI {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "smthrs")
	entry, err := filepath.Abs("../../../smithers/src/guest-bin.ts")
	require.NoError(t, err)
	build := exec.CommandContext(ctx, "bun", "build", "--compile", entry, "--outfile", binary)
	output, err := build.CombinedOutput()
	require.NoError(t, err, string(output))
	home := t.TempDir()
	session := "packaged-terminal"
	tokenFile := filepath.Join(home, "sessions", session, "token")
	require.NoError(t, os.MkdirAll(filepath.Dir(tokenFile), 0o700))
	require.NoError(t, os.WriteFile(tokenFile, []byte(token), 0o600))
	cli := &packagedTerminalCLI{tokenFile: tokenFile, home: home}
	cli.invoke = func(argv ...string) (int, map[string]any) {
		t.Helper()
		command := exec.CommandContext(ctx, binary, append(argv, "--json")...)
		command.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + home, "XDG_CONFIG_HOME=" + home, "XDG_DATA_HOME=" + home, "SMITHERS_DISABLE_SYSTEM_KEYRING=1", "SMITHERS_URL=" + origin, "SMITHERS_TOKEN_FILE=" + tokenFile, "CODEX_TEST=1"}
		output, err := command.CombinedOutput()
		code := 0
		if err != nil {
			var exit *exec.ExitError
			require.ErrorAs(t, err, &exit, string(output))
			code = exit.ExitCode()
		}
		var decoded any
		require.NoError(t, json.Unmarshal(output, &decoded), string(output))
		if items, ok := decoded.([]any); ok {
			return code, map[string]any{"items": items}
		}
		result, ok := decoded.(map[string]any)
		require.True(t, ok, string(output))
		return code, result
	}
	return cli
}

// These execute the compiled production reader and command mount, with a
// lifecycle-issued credential and a valid saved login on the composed router.
// Invalid session files must never fall back to that otherwise usable login.
func exercisePackagedTerminalFileRefusals(t *testing.T, cli *packagedTerminalCLI, origin, token string) {
	t.Helper()
	auth := filepath.Join(cli.home, ".config", "smithers", "auth.json")
	require.NoError(t, os.MkdirAll(filepath.Dir(auth), 0o700))
	record, err := json.Marshal(map[string]string{"api_url": origin, "token": token})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(auth, record, 0o600))
	for _, fixture := range []string{"empty", "malformed", "oversized", "unreadable", "symlink", "directory", "missing"} {
		t.Run("packaged file refuses "+fixture, func(t *testing.T) {
			require.NoError(t, os.Remove(cli.tokenFile))
			switch fixture {
			case "empty", "malformed", "oversized", "unreadable":
				contents := map[string]string{"empty": "", "malformed": "bad token", "oversized": strings.Repeat("a", 16385), "unreadable": token}[fixture]
				require.NoError(t, os.WriteFile(cli.tokenFile, []byte(contents), 0o600))
				if fixture == "unreadable" {
					require.NoError(t, os.Chmod(cli.tokenFile, 0))
				}
			case "symlink":
				foreign := filepath.Join(cli.home, "foreign-token")
				require.NoError(t, os.WriteFile(foreign, []byte(token), 0o600))
				require.NoError(t, os.Symlink(foreign, cli.tokenFile))
			case "directory":
				require.NoError(t, os.Mkdir(cli.tokenFile, 0o700))
			}
			code, result := cli.invoke("todo", "new", "--text", "Invalid session files cannot append", "--idempotencyKey", "invalid-file-"+fixture)
			require.Equal(t, 1, code)
			require.Equal(t, "token_file_unavailable", result["code"])
			require.NotContains(t, result, "confirmation")
			if fixture != "missing" {
				require.NoError(t, os.Remove(cli.tokenFile))
			}
			require.NoError(t, os.WriteFile(cli.tokenFile, []byte(token), 0o600))
		})
	}
	code, identity := cli.invoke("auth", "status")
	require.Zero(t, code)
	require.Equal(t, "ben", identity["username"], "restoring this session file restores its own identity")
}

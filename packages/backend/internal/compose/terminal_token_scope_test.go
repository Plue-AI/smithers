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
	invoke := packagedTerminalCLIInvoker(t, ctx, origin, token)
	skill, err := os.ReadFile("../../../smithers/skills/smithers/SKILL.md")
	require.NoError(t, err)
	for _, command := range []string{"smthrs todo new", "smthrs todo drop", "smthrs merge"} {
		require.Contains(t, string(skill), "`"+command+"`", "the packaged skill must advertise the exercised production command")
	}

	if !closed {
		code, identity := invoke("auth", "status")
		require.Zero(t, code)
		require.Equal(t, "ben", identity["username"])
		require.Equal(t, "delegated", identity["credential_kind"])
		require.Equal(t, "terminal", identity["via"])
		require.NotContains(t, identity, "token")
	}
	for _, fixture := range []struct {
		argv []string
		code string
	}{
		{[]string{"todo", "new", "--text", "A guest cannot append without confirmation", "--idempotencyKey", "terminal-scope-new"}, "confirm_in_app"},
		{[]string{"todo", "new", "--text", "A guest cannot insert", "--before", "T2", "--idempotencyKey", "terminal-scope-before"}, "permission"},
		{[]string{"todo", "drop", "T2"}, "permission"},
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
	for _, path := range []string{"/api/install", "/api/members", "/api/secrets"} {
		req, err := http.NewRequestWithContext(ctx, "GET", origin+path, nil)
		require.NoError(t, err)
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
	return func(argv ...string) (int, map[string]any) {
		t.Helper()
		command := exec.CommandContext(ctx, binary, append(argv, "--json")...)
		command.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + home, "XDG_CONFIG_HOME=" + home, "XDG_DATA_HOME=" + home, "SMITHERS_URL=" + origin, "SMITHERS_TOKEN_FILE=" + tokenFile, "CODEX_TEST=1"}
		output, err := command.CombinedOutput()
		code := 0
		if err != nil {
			var exit *exec.ExitError
			require.ErrorAs(t, err, &exit, string(output))
			code = exit.ExitCode()
		}
		var result map[string]any
		require.NoError(t, json.Unmarshal(output, &result), string(output))
		return code, result
	}
}

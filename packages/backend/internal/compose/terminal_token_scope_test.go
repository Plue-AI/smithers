package compose

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// C-SEC-05 CI coverage: the authenticated terminal WebSocket mints the
// credential, and the source CLI crosses the real install HTTP/auth/catalog
// boundary. Only the PTY and guest token file are doubles: CI has no microVM.
// Packaged CLI/skill and physical guest isolation still require the native check.
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
	invoke := catalogCLIInvoker(t, ctx, origin, token)
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

package compose

import (
	"encoding/json"
	"fmt"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// Personal-subscription fixtures are inert sentinel bytes, never live logins.
// API-key tools are separately covered by the M-42 secret-file check.
func testInstalledCredentials(t *testing.T, h *rootLayerHarness, branch string, term *rehearsalTerminal, browser http.CookieJar) {
	t.Helper()
	installedShell(t, term, `mkdir -p "$HOME/.claude" "$HOME/.codex" "$HOME/.config/gh" && printf 'mch-claude-A-fixture\n' > "$HOME/.claude/.credentials.json" && printf 'mch-codex-A-fixture\n' > "$HOME/.codex/auth.json" && printf 'mch-gh-A-fixture\n' > "$HOME/.config/gh/hosts.yml" && printf 'mch-marker-A-fixture\n' > "$HOME/.marker" && test "$(stat -c %a "$HOME/.marker")" = 664`)
	var todo struct {
		N int64 `json:"n"`
	}
	code, body := h.request("POST", "/api/todos", `{"title":"Credential isolation","prompt":"Add a greeting to JOURNEY.md","place":{"mode":"append"}}`, uuid.NewString())
	require.Equal(t, 202, code, string(body))
	require.NoError(t, json.Unmarshal(body, &todo))
	var secondBranch string
	require.Eventually(t, func() bool {
		return h.pool.QueryRow(t.Context(), `SELECT workspace_id FROM mythical_items WHERE number=$1`, todo.N).Scan(&secondBranch) == nil && secondBranch != "" && secondBranch != branch
	}, 15*time.Minute, 250*time.Millisecond)
	second := installedMemberTerminal(t, h, secondBranch, browser)
	installedShell(t, second, `test ! -e "$HOME/.marker" && test ! -e "$HOME/.claude/.credentials.json" && test ! -e "$HOME/.codex/auth.json" && test ! -e "$HOME/.config/gh/hosts.yml" && mkdir -p "$HOME/.claude" "$HOME/.codex" "$HOME/.config/gh" && printf 'mch-claude-B-fixture\n' > "$HOME/.claude/.credentials.json" && printf 'mch-codex-B-fixture\n' > "$HOME/.codex/auth.json" && printf 'mch-gh-B-fixture\n' > "$HOME/.config/gh/hosts.yml"`)
	for _, entry := range []struct {
		id, tag string
		term    *rehearsalTerminal
	}{{branch, "A", term}, {secondBranch, "B", second}} {
		entry.term.close()
		code, body := h.request("POST", "/api/branches/"+entry.id, `{"op":"sleep"}`, uuid.NewString())
		require.Equal(t, 202, code, string(body))
		require.Eventually(t, func() bool {
			machine, err := h.runtime.InspectWorkspace(t.Context(), entry.id)
			return err == nil && machine.State == workspaceapi.WorkspaceStopped
		}, 2*time.Minute, 100*time.Millisecond)
		awake := installedMemberTerminal(t, h, entry.id, browser)
		installedShell(t, awake, fmt.Sprintf(`test "$(stat -c '%%u:%%a' "$HOME")" = "$(id -u):700" && test "$(cat "$HOME/.claude/.credentials.json")" = mch-claude-%s-fixture && test "$(cat "$HOME/.codex/auth.json")" = mch-codex-%s-fixture && test "$(cat "$HOME/.config/gh/hosts.yml")" = mch-gh-%s-fixture`, entry.tag, entry.tag, entry.tag))
		if entry.tag == "A" {
			installedShell(t, awake, `test "$(cat "$HOME/.marker")" = mch-marker-A-fixture && test "$(stat -c '%u:%a' "$HOME/.marker")" = "$(id -u):664"`)
			installedShell(t, awake, `printf 'mch-claude-A-refreshed\n' > "$HOME/.claude/.credentials.json"`)
			installedShell(t, second, `test "$(cat "$HOME/.claude/.credentials.json")" = mch-claude-B-fixture`)
			installedShell(t, awake, `rm "$HOME/.claude/.credentials.json" "$HOME/.codex/auth.json" "$HOME/.config/gh/hosts.yml"`)
			installedShell(t, second, `test "$(cat "$HOME/.claude/.credentials.json")" = mch-claude-B-fixture && test "$(cat "$HOME/.codex/auth.json")" = mch-codex-B-fixture && test "$(cat "$HOME/.config/gh/hosts.yml")" = mch-gh-B-fixture`)
		}
	}
	// Scan every persisted product table, rather than just audit metadata.
	// Table names come from PostgreSQL and are quoted as identifiers; sentinel
	// values remain bound parameters and are never printed in evidence.
	tables, err := h.pool.Query(t.Context(), `SELECT tablename FROM pg_tables WHERE schemaname='public'`)
	require.NoError(t, err)
	var names []string
	for tables.Next() {
		var name string
		require.NoError(t, tables.Scan(&name))
		names = append(names, name)
	}
	require.NoError(t, tables.Err())
	tables.Close()
	require.NotEmpty(t, names)
	for _, name := range names {
		for _, sentinel := range []string{"mch-claude-A-fixture", "mch-codex-A-fixture", "mch-gh-A-fixture", "mch-claude-B-fixture", "mch-codex-B-fixture", "mch-gh-B-fixture"} {
			var copies int
			require.NoError(t, h.pool.QueryRow(t.Context(), "SELECT count(*) FROM "+pgx.Identifier{"public", name}.Sanitize()+" t WHERE strpos(row_to_json(t)::text,$1)>0", sentinel).Scan(&copies))
			require.Zero(t, copies, "tool login appeared in table %s", name)
			require.NotContains(t, h.logs.String(), sentinel)
			require.NotContains(t, string(h.expect("GET", "/api/todos", "", 200)), sentinel)
		}
	}
}

func installedMemberTerminal(t *testing.T, h *rootLayerHarness, branch string, browsers ...http.CookieJar) *rehearsalTerminal {
	t.Helper()
	key := uuid.NewString()
	var receipt services.WorkspaceSessionResponse
	jar := http.CookieJar(h.jar)
	if len(browsers) > 0 {
		jar = browsers[0]
	}
	r := &rehearsal{ctx: t.Context(), origin: h.origin, jar: jar, client: h.client}
	call := func() (int, []byte) {
		code, body, err := r.keyedAs(jar, "POST", "/api/terminals", `{"branch":"`+branch+`"}`, key)
		require.NoError(t, err)
		return code, body
	}
	code, body := call()
	require.Equal(t, 202, code, string(body))
	require.NoError(t, json.Unmarshal(body, &receipt))
	require.Eventually(t, func() bool {
		code, body := call()
		var current services.WorkspaceSessionResponse
		return code == 202 && json.Unmarshal(body, &current) == nil && current.ID == receipt.ID && current.Status == "running"
	}, 2*time.Minute, 100*time.Millisecond)
	term, err := r.openTerminal(receipt.ID)
	require.NoError(t, err)
	t.Cleanup(term.close)
	return term
}

package compose

import (
	"encoding/json"
	"fmt"
	"regexp"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// C-J6-01 guest bundle slice: invoked by the approved installed terminal/SSH
// chain through a real authenticated browser terminal, never a process double.
func testInstalledTerminalCLIAndSkill(t *testing.T, term *rehearsalTerminal, username string) {
	t.Helper()
	for _, command := range []string{
		`test "$(command -v smthrs)" = /opt/smithers/bundle/bin/linux-arm64/smthrs`,
		`test "$(readlink "$HOME/.claude/skills/smithers")" = /opt/smithers/bundle/share/skills/smithers`,
		`test "$(readlink "$HOME/.agents/skills/smithers")" = /opt/smithers/bundle/share/skills/smithers`,
		`test "$(stat -c %a /opt/smithers/bundle/share/skills/smithers/SKILL.md)" = 644`,
		`grep -q 'smthrs todo new' "$HOME/.agents/skills/smithers/SKILL.md"`,
		`smthrs wiki show --owner rehearsal-owner --repo app --json | /usr/bin/python3 -c 'import json,sys; r=json.load(sys.stdin); assert any(p["slug"] == "terminal-scope" for p in r)'`,
		`smthrs wiki page terminal-scope --owner rehearsal-owner --repo app --json | /usr/bin/python3 -c 'import json,sys; r=json.load(sys.stdin); assert r["title"] == "Terminal scope" and r["body"] == "Read through the packaged skill"'`,
		fmt.Sprintf(`smthrs auth status --json | /usr/bin/python3 -c 'import json,sys; r=json.load(sys.stdin); assert r["logged_in"] is True and r["username"] == sys.argv[1] and r["credential_kind"] == "delegated" and r["via"] == "terminal"' %q`, username),
	} {
		_, err := term.run(fmt.Sprintf(`%s && printf 'J6''BUNDLE=approved\n'`, command), regexp.MustCompile(`J6BUNDLE=approved`), 30*time.Second)
		require.NoError(t, err)
	}
	// S2 uses ordinary catalog policy; person-only SSH remains a typed scope
	// refusal. The independent S1 CLI matrix is retained in C-SEC-05.
	_, err := term.run(`smthrs ssh terminal --json | /usr/bin/python3 -c 'import json,sys; r=json.load(sys.stdin); assert r["class"] == "permission" and r["code"] == "permission"' && printf 'J6''PERSON=refused\n'`, regexp.MustCompile(`J6PERSON=refused`), 30*time.Second)
	require.NoError(t, err)
}

// Requests cross the packaged guest CLI and installed router. Approval is an
// authenticated person-app HTTP call; a delegated request never creates a TODO.
func testInstalledTerminalCatalogActions(t *testing.T, h *rootLayerHarness, term *rehearsalTerminal) {
	t.Helper()
	// The machine setup leaves one literal TODO fixture. Create T2 through
	// the person route so before-T2 has a real, independently known subject.
	var fixtureCount int
	require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT count(*) FROM mythical_items`).Scan(&fixtureCount))
	require.Equal(t, 1, fixtureCount)
	fixture := h.expect("POST", "/api/todos", `{"title":"Second terminal placement","prompt":"Keep the later placement fixture","place":{"mode":"append"}}`, 202)
	var second struct {
		N int64 `json:"n"`
	}
	require.NoError(t, json.Unmarshal(fixture, &second))
	require.Equal(t, int64(2), second.N)
	var before int
	require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT count(*) FROM mythical_items`).Scan(&before))
	result, err := term.run(`smthrs todo new --title 'S2 terminal placement' --text 'Request placement before T2' --before T2 --json | /usr/bin/python3 -c 'import json,sys; r=json.load(sys.stdin); assert r["state"] == "requested"; print("J6"+"CONFIRM="+r["confirmation"])'`, regexp.MustCompile(`J6CONFIRM=([a-f0-9-]+)`), 30*time.Second)
	require.NoError(t, err)
	id := result[1]
	var after int
	require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT count(*) FROM mythical_items`).Scan(&after))
	require.Equal(t, before, after)
	// Holding the guest bearer cannot press the person's confirmation.
	script := fmt.Sprintf(`import json,os,urllib.request,urllib.error
request=urllib.request.Request(os.environ['SMITHERS_URL'].rstrip('/')+'/api/confirmations/%s/approve',data=b'{}',method='POST',headers={'Authorization':'Bearer '+open(os.environ['SMITHERS_TOKEN_FILE']).read().strip(),'Content-Type':'application/json','Idempotency-Key':'native-agent-approve'})
try: response=urllib.request.urlopen(request)
except urllib.error.HTTPError as error: response=error
body=json.load(response)
assert response.status==403 and body['class']=='permission' and body['code']=='permission'
`, id)
	installedShell(t, term, "/usr/bin/python3 - <<'J6APPROVE'\n"+script+"\nJ6APPROVE")
	h.expect("POST", "/api/confirmations/"+id+"/approve", `{}`, 200)
	require.NoError(t, h.pool.QueryRow(t.Context(), `SELECT count(*) FROM mythical_items`).Scan(&after))
	require.Equal(t, before+1, after)
	var order []int64
	rows, err := h.pool.Query(t.Context(), `SELECT number FROM mythical_items ORDER BY stack_position`)
	require.NoError(t, err)
	defer rows.Close()
	for rows.Next() {
		var n int64
		require.NoError(t, rows.Scan(&n))
		order = append(order, n)
	}
	require.NoError(t, rows.Err())
	require.Equal(t, []int64{1, 3, 2}, order)
}

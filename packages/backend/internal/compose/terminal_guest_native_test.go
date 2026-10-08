package compose

import (
	"fmt"
	"regexp"
	"strings"
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
	// Literal commands exercise the shipped parser and production authorizer.
	// None may reach a mutation or open a confirmation even for the owner.
	for _, command := range []string{
		"smthrs todo drop T2",
		"smthrs stack move T2 up",
		"smthrs todo amend T2 'A guest cannot change the prompt'",
		"smthrs todo stop T2",
		"smthrs todo resume T2",
		"smthrs todo retry T2",
		"smthrs merge T2 --reviewed_head_sha " + strings.Repeat("a", 40),
	} {
		_, err := term.run(fmt.Sprintf(`%s --json | /usr/bin/python3 -c 'import json,sys; r=json.load(sys.stdin); assert r["class"] == "permission" and r["code"] == "permission" and "confirmation" not in r' && printf 'J6''SCOPE=refused\n'`, command), regexp.MustCompile(`J6SCOPE=refused`), 30*time.Second)
		require.NoError(t, err)
	}
}

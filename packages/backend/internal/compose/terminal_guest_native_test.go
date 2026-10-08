package compose

import (
	"fmt"
	"regexp"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// C-J6-01 guest bundle slice: invoked by the approved installed terminal/SSH
// chain through a real authenticated browser terminal, never a process double.
func testInstalledTerminalCLIAndSkill(t *testing.T, term *rehearsalTerminal) {
	t.Helper()
	for _, command := range []string{
		`test "$(command -v smthrs)" = /opt/smithers/bundle/bin/linux-arm64/smthrs`,
		`test "$(readlink "$HOME/.claude/skills/smithers")" = /opt/smithers/bundle/share/skills/smithers`,
		`test "$(readlink "$HOME/.agents/skills/smithers")" = /opt/smithers/bundle/share/skills/smithers`,
		`test "$(stat -c %a /opt/smithers/bundle/share/skills/smithers/SKILL.md)" = 644`,
		`grep -q 'smthrs todo new' "$HOME/.agents/skills/smithers/SKILL.md"`,
		`smthrs auth status --json | /usr/bin/python3 -c 'import json,sys; r=json.load(sys.stdin); assert r["logged_in"] is True and r["username"] == sys.argv[1] and r["credential_kind"] == "delegated" and r["via"] == "terminal"' "$(id -un)"`,
		`smthrs todo drop T2 --json | /usr/bin/python3 -c 'import json,sys; r=json.load(sys.stdin); assert r["class"] == "permission" and r["code"] == "permission"'`,
	} {
		_, err := term.run(fmt.Sprintf(`%s && printf 'J6''BUNDLE=approved\n'`, command), regexp.MustCompile(`J6BUNDLE=approved`), 30*time.Second)
		require.NoError(t, err)
	}
}

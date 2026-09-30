package services

import (
	"strings"
	"testing"
)

// The exec environment of an agent guest carries XDG_CONFIG_HOME under
// /workspace; jj prefers it over $HOME/.config, and the developer user cannot
// access it, so jj's secure-config check failed the clone with "Permission
// denied" (workspace 3f58c633, 2026-09-03). Every developer-user command must
// pin HOME and XDG_CONFIG_HOME and drop any inherited JJ_CONFIG, with the env
// options before the assignments (env parses -u only before the first NAME=).
func TestDeveloperCommandsPinJJConfigDirectory(t *testing.T) {
	want := "runuser -u 'developer' -- env -u JJ_CONFIG HOME='/home/developer' XDG_CONFIG_HOME='/home/developer/.config' USER='developer' LOGNAME='developer' "
	for name, script := range map[string]string{
		"clone":       buildWorkspaceCloneCommand("https://api.example/o/r.git", "tok", "main", 0, workspaceCloneSource{}),
		"fork-switch": buildForkBookmarkSwitchCommand("tok", "main"),
	} {
		if !strings.Contains(script, want+"jj ") {
			t.Fatalf("%s: jj commands must run with the pinned config directory; script:\n%s", name, script)
		}
		if strings.Contains(script, "HOME='/home/developer' -u JJ_CONFIG") {
			t.Fatalf("%s: env -u must precede the assignments", name)
		}
	}
}

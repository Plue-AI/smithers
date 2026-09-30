package services

import "strings"

// The provider's boot signal only promises exec/SSH. Its bootstrap service is
// still installing the coding runtime; never initialize a JJ repo with the
// base image's incompatible version or publish a workspace before staging ends.
func workspaceRuntimeReadyCommand() string {
	return strings.Join([]string{
		"smithers_runtime_ready() {",
		"  jj --version 2>/dev/null | grep -Eq '^jj 0\\.39\\.0([-+].*)?$' || return 1",
		"  if [ -s " + shellQuote(workspaceCodingHostB64Path+".part00000000") + " ]; then",
		"    test -x " + shellQuote(workspaceCodingHostPath) + " || return 1",
		"    case $(" + shellQuote(workspaceCodingHostPath) + " --version 2>/dev/null) in 1.*|smithers\\ 1.*) ;; *) return 1;; esac",
		"  fi",
		"  if [ -s " + shellQuote(workspaceJJExportB64Path+".part00000000") + " ]; then " + shellQuote(workspaceJJExportPath) + " --version >/dev/null 2>&1 || return 1; fi",
		"}",
		"for smithers_runtime_attempt in $(seq 1 120); do",
		"  if smithers_runtime_ready; then break; fi",
		"  sleep 1",
		"done",
		"if ! smithers_runtime_ready; then echo 'workspace coding runtime bootstrap did not become ready' >&2; exit 1; fi",
	}, "\n")
}

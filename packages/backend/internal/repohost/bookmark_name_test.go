package repohost

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestValidateBookmarkNameAcceptsExportableNames(t *testing.T) {
	// These are suffixes of refs/heads, not arguments to `git branch`. A leading
	// hyphen is valid in the full refname even though the branch CLI rejects it.
	for _, name := range []string{
		"main", "feature/login", "release/v1.2", "under_score", "Head",
		"-release", "équipe/demo", "a.locked", "a@b", "a+b",
	} {
		t.Run(name, func(t *testing.T) {
			require.NoError(t, ValidateBookmarkName(name))
		})
	}
}

func TestValidateBookmarkNameRejectsUnexportableAndReservedNames(t *testing.T) {
	for _, tc := range []struct{ name, want string }{
		{"", "bookmark name is required"},
		{"@", `bookmark name "@" is reserved by git`},
		{"HEAD", `bookmark name "HEAD" is reserved by git`},
		{"/main", "bookmark name must not start or end with '/'"},
		{"main/", "bookmark name must not start or end with '/'"},
		{"main.", "bookmark name must not end with '.'"},
		{"release..candidate", "bookmark name must not contain '..'"},
		{"release@{1}", "bookmark name must not contain '@{'"},
		{"feature//login", "bookmark name must not contain consecutive '/'"},
		{".hidden", "bookmark name components must not start with '.'"},
		{"feature/.hidden", "bookmark name components must not start with '.'"},
		{"main.lock", "bookmark name components must not end with '.lock'"},
		{"feature/main.lock", "bookmark name components must not end with '.lock'"},
		{"main\x00", "bookmark name must not contain control characters"},
		{"main\x1f", "bookmark name must not contain control characters"},
		{"main\x7f", "bookmark name must not contain control characters"},
		{"main name", `bookmark name must not contain ' '`},
		{"main~1", `bookmark name must not contain '~'`},
		{"main^1", `bookmark name must not contain '^'`},
		{"main:one", `bookmark name must not contain ':'`},
		{"main?", `bookmark name must not contain '?'`},
		{"main*", `bookmark name must not contain '*'`},
		{"main[one", `bookmark name must not contain '['`},
		{"main\\one", `bookmark name must not contain '\\'`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			require.EqualError(t, ValidateBookmarkName(tc.name), tc.want)
		})
	}
}

// ValidateRefName admits a receive command's ref: fully qualified under
// refs/ and within git-check-ref-format, the rule bookmark names share.
func TestValidateRefName(t *testing.T) {
	for _, tc := range []struct{ name, want string }{
		{"HEAD", `ref "HEAD" is not a fully qualified name under refs/`},
		{"FETCH_HEAD", `ref "FETCH_HEAD" is not a fully qualified name under refs/`},
		{"heads/main", `ref "heads/main" is not a fully qualified name under refs/`},
		{"refs/", `ref "refs/" must not start or end with '/'`},
		{"refs/heads/a..b", `ref "refs/heads/a..b" must not contain '..'`},
		{"refs/heads/x.lock", `ref "refs/heads/x.lock" components must not end with '.lock'`},
		{"refs/heads/a b", `ref "refs/heads/a b" must not contain ' '`},
	} {
		require.EqualError(t, ValidateRefName(tc.name), tc.want, tc.name)
	}
	for _, name := range []string{"refs/heads/main", "refs/tags/v1", "refs/heads/@"} {
		require.NoError(t, ValidateRefName(name), name)
	}
}

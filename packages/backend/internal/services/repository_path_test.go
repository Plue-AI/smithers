package services

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestContentPathTextIsBoundedValidText(t *testing.T) {
	t.Parallel()
	for _, accepted := range []string{"", "dir/file.txt", "docs/", "/README.md", "../x", strings.Repeat("p", MaxRepositoryPathBytes)} {
		require.Nil(t, ValidateContentPathText(accepted), "path %q", accepted)
	}
	for value, message := range map[string]string{
		strings.Repeat("p", MaxRepositoryPathBytes+1): "path is too long",
		"dir/\x00file":   "path contains invalid characters",
		"dir\rfile":      "path contains invalid characters",
		"dir/\x7ffile":   "path contains invalid characters",
		"\xffREADME.md":  "path contains invalid characters",
		"dir/\u0085file": "",
	} {
		got := ValidateContentPathText(value)
		if message == "" {
			require.Nil(t, got, "path %q", value)
			continue
		}
		require.NotNil(t, got, "path %q", value)
		require.Equal(t, message, got.Message, "path %q", value)
		require.Equal(t, 400, got.Status, "path %q", value)
	}
}

func TestRepositoryPathNamesOneEntryInsideTheTree(t *testing.T) {
	t.Parallel()
	// Names keep their bytes: spaces, a backslash, a percent escape and a
	// revision-like suffix are names, not separators or selectors.
	for _, accepted := range []string{
		"JOURNEY.md", "docs/guide.md", "  spaced name ", `docs\guide.md`, "docs%2Fguide.md",
		"JOURNEY.md?ref=x", "JOURNEY.md@{1}", "...", "a/.b/c", strings.Repeat("a/", 2047) + "b",
	} {
		require.Nil(t, ValidateRepositoryPath(accepted), "path %q", accepted)
	}
	for value, message := range map[string]string{
		"":                               "path is required",
		"/JOURNEY.md":                    "path must name an entry inside the repository",
		"/etc/passwd":                    "path must name an entry inside the repository",
		"../JOURNEY.md":                  "path must name an entry inside the repository",
		"docs/../JOURNEY.md":             "path must name an entry inside the repository",
		"./JOURNEY.md":                   "path must name an entry inside the repository",
		"docs/./guide.md":                "path must name an entry inside the repository",
		"docs//guide.md":                 "path must name an entry inside the repository",
		"docs/":                          "path must name an entry inside the repository",
		"..":                             "path must name an entry inside the repository",
		".":                              "path must name an entry inside the repository",
		"JOURNEY.md\x00":                 "path contains invalid characters",
		"\xffJOURNEY.md":                 "path contains invalid characters",
		strings.Repeat("a/", 2048) + "b": "path is too long",
	} {
		got := ValidateRepositoryPath(value)
		require.NotNil(t, got, "path %q", value)
		require.Equal(t, message, got.Message, "path %q", value)
		require.Equal(t, 400, got.Status, "path %q", value)
	}
}

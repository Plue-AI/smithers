package repohostserver

import (
	"fmt"
	"net/url"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestValidatePathComponent_ASCIIClassification(t *testing.T) {
	t.Parallel()

	caseCount := 0
	for ch := 0; ch < 128; ch++ {
		ch := ch
		t.Run(fmt.Sprintf("char_0x%02x", ch), func(t *testing.T) {
			caseCount++
			input := string(rune(ch))
			want := (ch >= 'a' && ch <= 'z') ||
				(ch >= 'A' && ch <= 'Z') ||
				(ch >= '0' && ch <= '9') ||
				ch == '-' || ch == '_'
			assert.Equal(t, want, validatePathComponent(input), "input=%q", input)
		})
	}

	assert.Equal(t, 128, caseCount)
}

func TestValidatePathComponent_CompositeCases(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		input string
		want  bool
	}{
		{name: "empty", input: "", want: false},
		{name: "dot", input: ".", want: false},
		{name: "double_dot", input: "..", want: false},
		{name: "simple", input: "repo", want: true},
		{name: "dashed", input: "repo-name", want: true},
		{name: "underscored", input: "repo_name", want: true},
		{name: "dotted", input: "repo.name", want: true},
		{name: "double_dot_inside", input: "repo..name", want: true},
		{name: "contains_space", input: "repo name", want: false},
		{name: "contains_slash", input: "repo/name", want: false},
		{name: "contains_backslash", input: "repo\\name", want: false},
		{name: "contains_colon", input: "repo:name", want: false},
		{name: "contains_at", input: "repo@name", want: false},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, validatePathComponent(tc.input))
		})
	}
}

func TestValidateOwnerRepo_Matrix(t *testing.T) {
	t.Parallel()

	validValues := []struct {
		owner string
		repo  string
	}{
		{owner: "alice", repo: "demo"},
		{owner: "team-1", repo: "demo_repo"},
		{owner: "alice.dev", repo: "demo.v2"},
	}

	for _, tc := range validValues {
		tc := tc
		t.Run("valid_"+tc.owner+"_"+tc.repo, func(t *testing.T) {
			assert.NoError(t, validateOwnerRepo(tc.owner, tc.repo))
		})
	}

	invalidParts := []string{
		"",
		".",
		"..",
		"bad/name",
		"bad\\name",
		"bad name",
		"bad:name",
		"bad@name",
	}

	for idx, part := range invalidParts {
		part := part
		t.Run(fmt.Sprintf("invalid_owner_%02d", idx), func(t *testing.T) {
			err := validateOwnerRepo(part, "demo")
			require.Error(t, err)
			assert.Contains(t, err.Error(), "invalid owner name")
		})
		t.Run(fmt.Sprintf("invalid_repo_%02d", idx), func(t *testing.T) {
			err := validateOwnerRepo("alice", part)
			require.Error(t, err)
			assert.Contains(t, err.Error(), "invalid repo name")
		})
	}

	// A repo whose name ends in a reserved store suffix (.wiki/.docs) would
	// collide on disk with another repo's derived wiki/docs store, so it must
	// be rejected regardless of case (case-insensitive filesystems).
	reservedRepos := []string{"demo.wiki", "demo.docs", "demo.WIKI", "Demo.Docs"}
	for idx, repo := range reservedRepos {
		repo := repo
		t.Run(fmt.Sprintf("reserved_repo_suffix_%02d", idx), func(t *testing.T) {
			err := validateOwnerRepo("alice", repo)
			require.Error(t, err)
			assert.Contains(t, err.Error(), "invalid repo name")
		})
	}

	// Names that merely contain (but do not end in) the reserved suffix, or
	// that use it as a non-suffix substring, remain valid.
	for idx, repo := range []string{"wiki-tools", "docs-site", "my.wiki.repo", "demo.v2"} {
		repo := repo
		t.Run(fmt.Sprintf("allowed_repo_%02d", idx), func(t *testing.T) {
			assert.NoError(t, validateOwnerRepo("alice", repo))
		})
	}
}

func TestParseRepoID_Matrix(t *testing.T) {
	t.Parallel()

	owners := []string{"alice", "team-1", "alice.dev", "USER_1", "repoowner"}
	repos := []string{"demo", "repo-1", "repo_name", "repo.v2", "sample"}
	caseCount := 0

	for _, owner := range owners {
		owner := owner
		for _, repo := range repos {
			repo := repo
			for _, encode := range []bool{false, true} {
				encode := encode
				t.Run(fmt.Sprintf("valid_%s_%s_encode_%t", owner, repo, encode), func(t *testing.T) {
					caseCount++
					raw := owner + ":" + repo
					if encode {
						raw = url.PathEscape(raw)
					}
					gotOwner, gotRepo, err := parseRepoID(raw)
					require.NoError(t, err)
					assert.Equal(t, owner, gotOwner)
					assert.Equal(t, repo, gotRepo)
				})
			}
		}
	}

	invalidCases := []struct {
		name  string
		input string
	}{
		{name: "empty", input: ""},
		{name: "whitespace", input: "   "},
		{name: "missing_colon", input: "alice"},
		{name: "too_many_colons", input: "alice:demo:extra"},
		{name: "invalid_escape", input: "alice%ZZdemo"},
		{name: "invalid_owner", input: "bad/name:demo"},
		{name: "invalid_repo", input: "alice:bad/name"},
		{name: "owner_dot", input: ".:demo"},
		{name: "repo_dotdot", input: "alice:.."},
		{name: "encoded_invalid_owner", input: url.PathEscape("bad name:demo")},
		{name: "encoded_invalid_repo", input: url.PathEscape("alice:bad name")},
	}

	for _, tc := range invalidCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			owner, repo, err := parseRepoID(tc.input)
			require.Error(t, err)
			assert.Empty(t, owner)
			assert.Empty(t, repo)
		})
	}

	assert.Equal(t, 50, caseCount)
}

func TestValidateFileSubpath_Matrix(t *testing.T) {
	t.Parallel()

	validPaths := []string{
		"README.md",
		"docs/index.md",
		"src/main.go",
		"nested/path/file.txt",
		"/leading/slash/is/trimmed.txt",
		" ",
		"   /OWNERS",
		" dir / report ",
	}

	for _, path := range validPaths {
		path := path
		t.Run("valid_"+path, func(t *testing.T) {
			assert.NoError(t, validateFileSubpath(path))
		})
	}

	invalidPaths := []string{
		"",
		"/",
		".",
		"..",
		"./file",
		"../file",
		"dir//file",
		"dir/./file",
		"dir/../file",
		"dir/",
		"/dir/../file",
	}

	for idx, path := range invalidPaths {
		path := path
		t.Run(fmt.Sprintf("invalid_%02d", idx), func(t *testing.T) {
			err := validateFileSubpath(path)
			require.Error(t, err)
			assert.Contains(t, err.Error(), "path")
		})
	}
}

func TestEnvOrDefault_TrimBehavior(t *testing.T) {
	tests := []struct {
		name     string
		envValue string
		fallback string
		want     string
	}{
		{name: "uses_trimmed_env", envValue: "  configured  ", fallback: "fallback", want: "configured"},
		{name: "falls_back_on_empty", envValue: "", fallback: "fallback", want: "fallback"},
		{name: "falls_back_on_whitespace", envValue: "   ", fallback: "fallback", want: "fallback"},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("REPOHOST_TEST_ENV", tc.envValue)
			assert.Equal(t, tc.want, envOrDefault("REPOHOST_TEST_ENV", tc.fallback))
		})
	}
}

func TestConfigPathHelpers(t *testing.T) {
	t.Parallel()

	cfg := Config{StoragePath: filepath.Join("tmp", "repos")}
	assert.Equal(t, filepath.Join("tmp", "repos", "alice", "demo"), cfg.RepoPath("alice", "demo"))
	assert.Equal(t, filepath.Join("tmp", "repos", "alice", "demo.wiki"), cfg.WikiRepoPath("alice", "demo"))
	assert.Equal(t, filepath.Join("tmp", "repos", "alice", "demo.docs"), cfg.DocsRepoPath("alice", "demo"))
	assert.Equal(t, filepath.Join("tmp", "repos", "alice", "demo", ".jj", "repo", "store", "git"), cfg.GitBackendPath("alice", "demo"))
}

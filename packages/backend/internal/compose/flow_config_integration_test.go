package compose

import (
	"encoding/json"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// Setup's actual HTTP admission and background worker must persist defaults
// before the person sees Source ready. This is process component evidence,
// not a real-microVM C-J1-06 receipt.
func TestInstallStoredConfigSourceReadyThroughRouter(t *testing.T) {
	for _, fixture := range []struct {
		name        string
		argv        [][]string
		checks      []string
		pages       []string
		directories []string
	}{
		{"node", [][]string{{"pnpm", "test"}, {"pnpm", "lint"}}, []string{"test", "lint"}, []string{"overview", "architecture"}, []string{".", "."}},
		{"node-packages", [][]string{{"pnpm", "test"}, {"pnpm", "lint"}}, []string{"test", "lint"}, []string{"overview", "architecture", "package-pkg00", "package-pkg01", "package-pkg02", "package-pkg03", "package-pkg04", "package-pkg05", "package-pkg06", "package-pkg07"}, []string{".", ".", "pkg00", "pkg01", "pkg02", "pkg03", "pkg04", "pkg05", "pkg06", "pkg07"}},
		{"go", [][]string{{"go", "test", "./..."}}, []string{"test"}, []string{"overview", "architecture"}, []string{".", "."}},
		{"node-all", [][]string{{"pnpm", "test"}, {"pnpm", "lint"}, {"pnpm", "typecheck"}, {"pnpm", "build"}}, []string{"test", "lint", "typecheck", "build"}, []string{"overview", "architecture"}, []string{".", "."}},
		{"rust", [][]string{{"cargo", "test"}}, []string{"test"}, []string{"overview", "architecture"}, []string{".", "."}},
		{"python", [][]string{{"pytest"}}, []string{"test"}, []string{"overview", "architecture"}, []string{".", "."}},
		{"no-checks", [][]string{{}}, []string{"build-only"}, []string{"overview", "architecture"}, []string{".", "."}},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			t.Setenv("REHEARSAL_CONFIG_FIXTURE", fixture.name)
			r := newRehearsal(t, "SMITHERS_FLW02_REHEARSAL", "C-J1-06", "flw02-")
			require.True(t, r.setupSource())
			var raw []byte
			require.NoError(t, r.pool.QueryRow(t.Context(), `SELECT value FROM install_settings WHERE key=$1`, services.InstallCodingProjectKey).Scan(&raw))
			var project struct {
				WikiOutput       string            `json:"wikiOutput"`
				Reviewer         string            `json:"reviewer"`
				ConflictAttempts int               `json:"conflictAttempts"`
				Wiki             bool              `json:"wiki"`
				WikiCitations    bool              `json:"wikiCitations"`
				Seats            map[string]string `json:"seats"`
				Checks           []struct {
					ID       string `json:"id"`
					Flow     string `json:"flow"`
					Required bool   `json:"required"`
				} `json:"checks"`
				Detected []struct {
					Argv      []string `json:"argv"`
					Flow      string   `json:"flow"`
					TimeoutMs int      `json:"timeoutMs"`
				} `json:"detected"`
				Pages []struct {
					ID              string `json:"id"`
					SourceDirectory string `json:"sourceDirectory"`
				} `json:"pages"`
			}
			require.NoError(t, json.Unmarshal(raw, &project))
			require.True(t, project.WikiCitations)
			argv := [][]string{}
			checkIDs := []string{}
			for _, check := range project.Checks {
				checkIDs = append(checkIDs, check.ID)
				require.Equal(t, "checks/"+check.ID, check.Flow)
				require.True(t, check.Required)
			}
			require.Equal(t, fixture.checks, checkIDs)
			require.Len(t, project.Detected, len(fixture.checks))
			for i, check := range project.Detected {
				argv = append(argv, check.Argv)
				require.Equal(t, "checks/"+fixture.checks[i], check.Flow)
				require.Equal(t, 1800000, check.TimeoutMs)
			}
			require.Equal(t, fixture.argv, argv)
			require.Equal(t, map[string]string{"coding/implement": "auto", "coding/plan": "auto", "coding/poc": "auto", "coding/review": "auto", "wiki/reviewer": "auto", "coding/dispatch": "auto", "repository/research": "auto", "repository/evaluator": "auto", "repository/author": "auto", "flow/author": "auto"}, project.Seats)
			require.True(t, project.Wiki)
			ids := []string{}
			directories := []string{}
			for _, page := range project.Pages {
				ids = append(ids, page.ID)
				directories = append(directories, page.SourceDirectory)
			}
			require.Equal(t, fixture.pages, ids)
			require.Equal(t, fixture.directories, directories)
			require.Equal(t, "/var/tmp/smithers/wiki", project.WikiOutput)
			require.Equal(t, "product-engineering-v1", project.Reviewer)
			require.Equal(t, 1, project.ConflictAttempts)
			// Setup reads pinned main as data; generated defaults stay in the
			// install, without a new commit or a repository declaration.
			source := filepath.Join(r.gitRoot, "rehearsal-owner/app.git")
			head, err := exec.Command("/usr/bin/git", "--git-dir", source, "rev-parse", "main").Output()
			require.NoError(t, err)
			require.Equal(t, r.mainCommit, strings.TrimSpace(string(head)))
			files, err := exec.Command("/usr/bin/git", "--git-dir", source, "ls-tree", "-r", "--name-only", "main").Output()
			require.NoError(t, err)
			for _, name := range strings.Fields(string(files)) {
				require.False(t, strings.HasPrefix(name, ".smithers/") || strings.HasPrefix(name, "flows/"), name)
			}
		})
	}
}

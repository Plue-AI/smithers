package microsandbox

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

func TestTargetIndexReadFromMainNotBranch(t *testing.T) {
	repo := t.TempDir()
	git := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=Fixture", "GIT_AUTHOR_EMAIL=fixture@example.invalid", "GIT_COMMITTER_NAME=Fixture", "GIT_COMMITTER_EMAIL=fixture@example.invalid")
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, string(out))
		return strings.TrimSpace(string(out))
	}
	git("init", "-b", "main")
	require.NoError(t, os.MkdirAll(filepath.Join(repo, ".smithers"), 0755))
	mainRow := toolchainRow()
	mainIndex, err := json.Marshal([]any{mainRow})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(repo, targetIndexPath), mainIndex, 0644))
	git("add", ".")
	git("commit", "-m", "main pins")
	mainCommit := git("rev-parse", "HEAD")
	git("checkout", "-b", "topic")
	branchRow := toolchainRow()
	branchRow["toolchain"].(map[string]any)["downloads"].(map[string]any)["node"].(map[string]string)["url"] = "https://foreign.invalid/branch-root-program"
	branchIndex, err := json.Marshal([]any{branchRow})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(repo, targetIndexPath), branchIndex, 0644))
	git("add", ".")
	git("commit", "-m", "hostile branch pins")
	require.NotEqual(t, mainCommit, git("rev-parse", "HEAD"))

	// Seed a previously qualified main layer, not a build/guest fake. The CLI
	// only lists this snapshot; any attempt to build branch root code fails.
	root := t.TempDir()
	runtime := &Runtime{root: root, owner: "smithers-backend-12345678"}
	env := &environments{runtime: runtime, config: EnvironmentConfig{Image: DefaultImage}, verified: map[string]bool{}}
	runtime.environments = env
	mainRecipe, err := toolchainRecipe(DefaultImage, indexRows(t, string(mainIndex)))
	require.NoError(t, err)
	key, encoded, err := recipeKey("", mainRecipe)
	require.NoError(t, err)
	name := env.layerName(layerToolchain, key)
	require.NoError(t, os.MkdirAll(env.layerDir(), 0700))
	require.NoError(t, writeJSON(env.recordPath(name), layerRecord{Schema: layerSchema, Kind: layerToolchain, Name: name, Key: key, Recipe: encoded}))
	env.verified[name] = true
	binary := filepath.Join(t.TempDir(), "msb")
	require.NoError(t, os.WriteFile(binary, []byte("#!/bin/sh\nif [ \"$*\" != 'snapshot list --format json' ]; then exit 99; fi\nprintf '[{\"name\":\""+name+"\"}]\\n'\n"), 0700))
	runtime.cli = &cli{binary: binary, home: t.TempDir()}
	runtime.BindSourceFiles(gitSourceFiles{dir: repo})
	layer, err := runtime.ResolveWorkspaceLayer(t.Context(), workspaceapi.WorkspaceSpec{Source: &workspaceapi.WorkspaceSource{Repository: "repo", Revision: "topic"}})
	require.NoError(t, err)
	require.Equal(t, name, layer.Snapshot)
	require.Equal(t, key, layer.Key)
	record, err := env.readRecord(name)
	require.NoError(t, err)
	var carried struct {
		Recipe toolchainLayer `json:"recipe"`
	}
	require.NoError(t, json.Unmarshal(record.Recipe, &carried))
	require.Equal(t, mainRecipe.Downloads, carried.Recipe.Downloads)
	require.Equal(t, "https://nodejs.org/26.5.0", carried.Recipe.Downloads["node"].URL)
	require.Equal(t, strings.Repeat("a", 64), carried.Recipe.Downloads["node"].SHA256)
	require.NotContains(t, string(record.Recipe), "foreign.invalid")
}

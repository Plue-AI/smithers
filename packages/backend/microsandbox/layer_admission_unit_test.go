package microsandbox

import (
	"context"
	"encoding/json"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// Explicit repository-reader unit fake: this never executes repository code,
// invokes msb, or substitutes SQL. Failures are legal SourceFiles outcomes.
type microsandboxUnitSources struct {
	commit              string
	resolveErr, readErr error
	resolves, reads     int
	seen                workspaceapi.WorkspaceSource
}

func (s *microsandboxUnitSources) ResolveSourceRevision(context.Context, string, string) (string, error) {
	s.resolves++
	return s.commit, s.resolveErr
}
func (s *microsandboxUnitSources) ReadSourceFile(_ context.Context, source workspaceapi.WorkspaceSource, _ string) ([]byte, error) {
	s.reads++
	s.seen = source
	return nil, s.readErr
}

func TestMicrosandboxUnitLayerAdmissionNeedsBoundReaderAndSourceIdentity(t *testing.T) {
	runtime := &Runtime{}
	spec := workspaceapi.WorkspaceSpec{Source: &workspaceapi.WorkspaceSource{Repository: "repo", Revision: "main"}}
	layer, err := runtime.ResolveWorkspaceLayer(t.Context(), spec)
	require.NoError(t, err)
	require.Equal(t, Layer{}, layer, "layer support is optional")
	runtime.environments = &environments{runtime: runtime}
	layer, err = runtime.ResolveWorkspaceLayer(t.Context(), workspaceapi.WorkspaceSpec{})
	require.NoError(t, err)
	require.Equal(t, Layer{}, layer, "a source-free workspace uses the base image")
	layer, err = runtime.ResolveWorkspaceLayer(t.Context(), spec)
	require.EqualError(t, err, "the repository reader for environment layers is not bound")
	require.Equal(t, Layer{}, layer)
	reader := &microsandboxUnitSources{}
	runtime.BindSourceFiles(reader)
	for _, source := range []workspaceapi.WorkspaceSource{{Repository: " ", Revision: "main"}, {Repository: "repo", Revision: "\t"}} {
		layer, err = runtime.ResolveWorkspaceLayer(t.Context(), workspaceapi.WorkspaceSpec{Source: &source})
		require.EqualError(t, err, "workspace source needs a repository and a revision")
		require.Equal(t, Layer{}, layer)
	}
	require.Zero(t, reader.resolves)
	require.Zero(t, reader.reads)
}

func TestMicrosandboxUnitLayerAdmissionPinsResolvedCommitAndPreservesReaderErrors(t *testing.T) {
	failure := &fs.PathError{Op: "read", Path: ".smithers/target-index.json", Err: fs.ErrPermission}
	for _, row := range []struct {
		name, commit        string
		resolveErr, readErr error
		reads               int
	}{
		{"resolver failure", "", failure, nil, 0},
		{"short commit", strings.Repeat("a", 39), nil, nil, 0},
		{"uppercase commit", strings.Repeat("A", 40), nil, nil, 0},
		{"nonhex commit", strings.Repeat("z", 40), nil, nil, 0},
		{"reader failure after resolution", strings.Repeat("a", 40), nil, failure, 1},
	} {
		t.Run(row.name, func(t *testing.T) {
			reader := &microsandboxUnitSources{commit: row.commit, resolveErr: row.resolveErr, readErr: row.readErr}
			runtime := &Runtime{}
			runtime.environments = &environments{runtime: runtime}
			runtime.BindSourceFiles(reader)
			layer, err := runtime.ResolveWorkspaceLayer(t.Context(), workspaceapi.WorkspaceSpec{Source: &workspaceapi.WorkspaceSource{Repository: "repo", Revision: "main"}})
			require.Error(t, err)
			require.Equal(t, Layer{}, layer)
			if row.reads == 0 {
				require.Equal(t, 1, reader.resolves)
			} else {
				require.Equal(t, 2, reader.resolves)
			} // branch and immutable main resolve separately (dispatch source rule).
			require.Equal(t, row.reads, reader.reads)
			if row.resolveErr != nil || row.readErr != nil {
				require.ErrorIs(t, err, failure)
			} else {
				require.EqualError(t, err, `repository reader resolved "`+row.commit+`", not a commit id`)
			}
			if row.reads != 0 {
				require.Equal(t, workspaceapi.WorkspaceSource{Repository: "repo", Revision: strings.Repeat("a", 40)}, reader.seen)
				require.Contains(t, err.Error(), "read .smithers/target-index.json at aaaaaaaaaaaa:")
			}
		})
	}
}

func TestMicrosandboxUnitDependencyInputsRefuseEscapeAndReaderFailure(t *testing.T) {
	for _, path := range []string{"/etc/passwd", "../outside", "sub/../../outside"} {
		targets := encodeRows(t, map[string]any{"label": "//:install", "rule": "Install", "destinations": []string{"registry.npmjs.org"}, "inputs": []any{map[string]string{"kind": "file", "path": path}}})
		reads := []string{}
		_, inputs, err := dependencyRecipe("toolchain", targets, func(path string) ([]byte, bool, error) {
			reads = append(reads, path)
			return nil, false, nil
		})
		require.ErrorContains(t, err, "declares an invalid input")
		require.Nil(t, inputs)
		require.Empty(t, reads, "escaped input must not reach the repository reader")
	}
	failure := &fs.PathError{Op: "read", Path: "go.sum", Err: fs.ErrPermission}
	targets := indexRows(t, `[{"label":"//:go","rule":"Go.ModDownload","destinations":["proxy.golang.org"],"inputs":[{"kind":"file","path":"go.sum"}]}]`)
	_, inputs, err := dependencyRecipe("toolchain", targets, func(string) ([]byte, bool, error) { return nil, false, failure })
	require.ErrorIs(t, err, failure)
	require.Nil(t, inputs)
	// An explicitly empty graph is authoritative; its presence must not cause
	// undeclared installs merely because common manifests exist in the checkout.
	layer, inputs, err := dependencies(t, map[string]string{
		targetIndexPath: "[]", "go.mod": "module sample\n", "pnpm-lock.yaml": "lockfileVersion: 9.0\n", "Cargo.toml": "[package]\n",
	})
	require.NoError(t, err)
	require.Empty(t, layer.Nodes)
	require.Empty(t, inputs)
	require.Nil(t, layer.link())
}

func TestMicrosandboxUnitDependencyKeyFollowsInputPresence(t *testing.T) {
	// Record absent inputs, then recover when they appear. Both transitions and
	// changed contents must invalidate the environment key; unrelated files do not.
	files := map[string]string{targetIndexPath: `[{"label":"//:go","rule":"Go.ModDownload","destinations":["proxy.golang.org"],"inputs":[{"kind":"file","path":"//go.sum"}]}]`}
	targets := indexRows(t, files[targetIndexPath])
	read := fakeRepository(files)
	absent, inputs, err := dependencyRecipe("parent", targets, read)
	require.NoError(t, err)
	require.Equal(t, []dependencyNode{{Label: "//:go", Rule: "Go.ModDownload", Files: map[string]string{"go.sum": "absent"}, Destinations: []string{"proxy.golang.org"}}}, absent.Nodes)
	require.Empty(t, inputs)
	require.Nil(t, absent.link())
	absentKey, _, err := recipeKey("parent", absent)
	require.NoError(t, err)
	files["go.sum"] = "first"
	present, inputs, err := dependencyRecipe("parent", targets, read)
	require.NoError(t, err)
	require.Equal(t, map[string][]byte{"go.sum": []byte("first")}, inputs)
	require.NotEqual(t, "absent", present.Nodes[0].Files["go.sum"])
	presentKey, _, err := recipeKey("parent", present)
	require.NoError(t, err)
	require.NotEqual(t, absentKey, presentKey)
	files["unrelated.txt"] = "unrelated"
	unchanged, _, err := dependencyRecipe("parent", targets, read)
	require.NoError(t, err)
	unchangedKey, _, err := recipeKey("parent", unchanged)
	require.NoError(t, err)
	require.Equal(t, presentKey, unchangedKey)
	files["go.sum"] = "second"
	changed, _, err := dependencyRecipe("parent", targets, read)
	require.NoError(t, err)
	changedKey, _, err := recipeKey("parent", changed)
	require.NoError(t, err)
	require.NotEqual(t, presentKey, changedKey)
	delete(files, "go.sum")
	recoveredAbsent, _, err := dependencyRecipe("parent", targets, read)
	require.NoError(t, err)
	recoveredKey, _, err := recipeKey("parent", recoveredAbsent)
	require.NoError(t, err)
	require.Equal(t, absentKey, recoveredKey)
}

func TestMicrosandboxUnitToolNodesRequireLockfileAndPackageLocalEntry(t *testing.T) {
	for _, row := range []struct {
		name, entry, packageDir string
		lockfile, admitted      bool
	}{
		{"mjs", "app/tool.mjs", "app", true, true},
		{"cjs", "app/tool.cjs", "app", true, true},
		{"js", "app/tool.js", "app", true, true},
		{"unlocked", "app/tool.mjs", "app", false, false},
		{"outside package", "other/tool.mjs", "app", true, false},
		{"prefix collision", "app-other/tool.mjs", "app", true, false},
		{"missing package", "app/tool.mjs", "", true, false},
		{"unsupported entry", "app/tool.txt", "app", true, false},
	} {
		t.Run(row.name, func(t *testing.T) {
			inputs := []map[string]string{{"kind": "file", "path": row.entry}}
			if row.lockfile {
				inputs = append(inputs, map[string]string{"kind": "file", "path": "pnpm-lock.yaml"})
			}
			index, err := json.Marshal([]any{map[string]any{"label": "//app:tool", "rule": "NodeBinary", "package": row.packageDir, "destinations": []string{"tools.example.com"}, "inputs": inputs}})
			require.NoError(t, err)
			layer, _, err := dependencies(t, map[string]string{
				targetIndexPath: string(index), row.entry: "entry bytes", "pnpm-lock.yaml": "lock bytes",
			})
			require.NoError(t, err)
			if row.admitted {
				require.Equal(t, []toolNode{{Label: "//app:tool", Package: "app", Entry: strings.TrimPrefix(row.entry, "app/")}}, layer.Tools)
				require.Len(t, layer.Nodes, 1)
				require.Equal(t, []string{"tools.example.com"}, layer.allowlist())
			} else {
				require.Empty(t, layer.Tools)
				require.Empty(t, layer.Nodes)
				require.Empty(t, layer.allowlist())
			}
			require.Nil(t, layer.link(), "a tool node alone does not invent a workspace install")
		})
	}
	index := `[{"label":"//app:format","rule":"Dprint","package":"app","inputs":[{"kind":"file","path":"a/dprint.json"},{"kind":"file","path":"b/dprint.json"},{"kind":"file","path":"broken/dprint.json"}]}]`
	layer, _, err := dependencies(t, map[string]string{
		targetIndexPath:      index,
		"a/dprint.json":      `{"plugins":["https://plugins.dprint.dev/json.wasm","http://insecure.invalid/plugin.wasm","file:///local/plugin.wasm"]}`,
		"b/dprint.json":      `{"plugins":["https://plugins.dprint.dev/json.wasm@reviewed-hash","https://plugins.dprint.dev/markdown.wasm"]}`,
		"broken/dprint.json": `{`,
	})
	require.NoError(t, err)
	require.Equal(t, "app", layer.Dprint)
	require.Equal(t, []string{"https://plugins.dprint.dev/json.wasm@reviewed-hash", "https://plugins.dprint.dev/markdown.wasm"}, layer.DprintPlugins)
	require.Contains(t, layer.allowlist(), "plugins.dprint.dev")
	require.NotContains(t, layer.allowlist(), "insecure.invalid")
	require.Equal(t, []string{"plugins.dprint.dev"}, layer.allowlist())
}

func TestMicrosandboxUnitLayerInputsPreserveDeterministicRegularFiles(t *testing.T) {
	files := map[string][]byte{"z/binary": {0, 255, 1}, "a.txt": []byte("héllo\n"), "empty": {}, "large": []byte(strings.Repeat("lockfile\n", 200000))}
	script, err := dependencyInputScript(files)
	require.NoError(t, err)
	again, err := dependencyInputScript(map[string][]byte{"empty": {}, "a.txt": []byte("héllo\n"), "z/binary": {0, 255, 1}, "large": []byte(strings.Repeat("lockfile\n", 200000))})
	require.NoError(t, err)
	require.Equal(t, script, again, "map insertion order cannot invalidate identical inputs")
	root := t.TempDir()
	command := exec.Command("/bin/bash")
	command.Stdin = strings.NewReader(strings.ReplaceAll(script, cacheRoot, root))
	output, err := command.CombinedOutput()
	require.NoError(t, err, string(output))
	for name, content := range files {
		destination := filepath.Join(root, "prepare/src", name)
		body, err := os.ReadFile(destination)
		require.NoError(t, err)
		require.Equal(t, content, body)
		info, err := os.Lstat(destination)
		require.NoError(t, err)
		require.True(t, info.Mode().IsRegular())
	}
	for _, name := range []string{"../escape", "/escape", "a/../b", ".", "a\\b"} {
		_, err := dependencyInputScript(map[string][]byte{name: {}})
		require.Error(t, err)
	}
	require.Equal(t, map[string]string{"node": "26.5.0", "rustc": "1.89.0 (build details)"},
		parseInventory("noise\n inventory node 26.5.0 \ninventory rustc 1.89.0 (build details)\ninventory missing\n"))
}

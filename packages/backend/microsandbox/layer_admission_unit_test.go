package microsandbox

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"io/fs"
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
	failure := &fs.PathError{Op: "read", Path: ".node-version", Err: fs.ErrPermission}
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
			require.Equal(t, 1, reader.resolves)
			require.Equal(t, row.reads, reader.reads)
			if row.resolveErr != nil || row.readErr != nil {
				require.ErrorIs(t, err, failure)
			} else {
				require.EqualError(t, err, `repository reader resolved "`+row.commit+`", not a commit id`)
			}
			if row.reads != 0 {
				require.Equal(t, workspaceapi.WorkspaceSource{Repository: "repo", Revision: strings.Repeat("a", 40)}, reader.seen)
				require.Contains(t, err.Error(), "read .node-version at aaaaaaaaaaaa:")
			}
		})
	}
}

func TestMicrosandboxUnitToolchainReadsFailClosedAndRejectUnreviewedPins(t *testing.T) {
	for _, filename := range []string{".node-version", "package.json", "go.mod", ".smithers/WORKSPACE.ts", "rust-toolchain.toml"} {
		failure := &fs.PathError{Op: "read", Path: filename, Err: fs.ErrPermission}
		layer, err := toolchainRecipe("image", func(path string) ([]byte, bool, error) {
			if path == filename {
				return nil, false, failure
			}
			return nil, false, nil
		})
		require.ErrorIs(t, err, failure)
		require.Equal(t, toolchainLayer{}, layer)
	}
	for _, pin := range []string{"26", "26.5", "latest", "26.5.0-rc.1"} {
		layer, err := toolchainRecipe("image", fakeRepository(map[string]string{".node-version": pin}))
		require.EqualError(t, err, ".node-version does not name an exact release")
		require.Equal(t, toolchainLayer{}, layer)
	}
	for _, row := range []struct{ path, contents, diagnostic string }{
		{"package.json", `{"packageManager":"pnpm@99.0.0"}`, "pnpm 99.0.0 has no reviewed linux/arm64 checksum"},
		{"go.mod", "module x\ngo 9.0.0\n", "go 9.0.0 has no reviewed linux/arm64 checksum"},
		{".smithers/WORKSPACE.ts", `export const bunVersion = "9.0.0"`, "bun 9.0.0 has no reviewed linux/arm64 checksum"},
	} {
		layer, err := toolchainRecipe("image", fakeRepository(map[string]string{row.path: row.contents}))
		require.ErrorContains(t, err, row.diagnostic)
		require.Equal(t, toolchainLayer{}, layer)
	}
	layer, err := toolchainRecipe("declared-image", fakeRepository(map[string]string{".node-version": " v26.5.0\n"}))
	require.NoError(t, err)
	require.Equal(t, "26.5.0", layer.Versions["node"])
	require.Equal(t, "declared-image", layer.Image)
}

func TestMicrosandboxUnitDependencyInputsRefuseEscapeAndReaderFailure(t *testing.T) {
	for _, path := range []string{"/etc/passwd", "../outside", "sub/../../outside"} {
		index, err := json.Marshal([]any{map[string]any{"label": "//:install", "rule": "Install", "inputs": []any{map[string]string{"kind": "file", "path": path}}}})
		require.NoError(t, err)
		reads := []string{}
		_, inputs, err := dependencyRecipe("toolchain", func(path string) ([]byte, bool, error) {
			reads = append(reads, path)
			return index, true, nil
		})
		require.ErrorContains(t, err, "declares an invalid input")
		require.Nil(t, inputs)
		require.Equal(t, []string{".smithers/target-index.json"}, reads, "escaped input must not reach the repository reader")
	}
	failure := &fs.PathError{Op: "read", Path: "go.sum", Err: fs.ErrPermission}
	_, inputs, err := dependencyRecipe("toolchain", func(path string) ([]byte, bool, error) {
		if path == ".smithers/target-index.json" {
			return []byte(`[{"label":"//:go","rule":"Go.ModDownload","inputs":[{"kind":"file","path":"go.sum"}]}]`), true, nil
		}
		return nil, false, failure
	})
	require.ErrorIs(t, err, failure)
	require.Nil(t, inputs)
	for _, raw := range []string{"{", `true`, `{"label":"object instead of list"}`} {
		_, inputs, err := dependencyRecipe("toolchain", fakeRepository(map[string]string{".smithers/target-index.json": raw}))
		require.ErrorContains(t, err, "decode .smithers/target-index.json:")
		require.Nil(t, inputs)
	}
	// An explicitly empty graph is authoritative; its presence must not cause
	// undeclared installs merely because common manifests exist in the checkout.
	layer, inputs, err := dependencyRecipe("toolchain", fakeRepository(map[string]string{
		".smithers/target-index.json": "[]", "go.mod": "module sample\n", "pnpm-lock.yaml": "lockfileVersion: 9.0\n",
	}))
	require.NoError(t, err)
	require.False(t, layer.Derived)
	require.Empty(t, layer.Nodes)
	require.Empty(t, inputs)
	require.Nil(t, layer.link())
}

func TestMicrosandboxUnitDependencyFallbackAndOfflineLinkFollowDeclaredInputs(t *testing.T) {
	for _, row := range []struct {
		name, manifest, label, rule string
		link                        []string
	}{
		{"pnpm", "pnpm-lock.yaml", "derived:pnpm", "Install", []string{"pnpm", "install", "--offline", "--frozen-lockfile"}},
		{"go", "go.mod", "derived:go", "Go.ModDownload", nil},
		{"cargo", "Cargo.toml", "derived:cargo", "Cargo.Fetch", nil},
	} {
		t.Run(row.name, func(t *testing.T) {
			layer, inputs, err := dependencyRecipe("parent-toolchain", fakeRepository(map[string]string{row.manifest: "fixture bytes"}))
			require.NoError(t, err)
			require.True(t, layer.Derived)
			require.Equal(t, "parent-toolchain", layer.Toolchain)
			require.Len(t, layer.Nodes, 1)
			require.Equal(t, row.label, layer.Nodes[0].Label)
			require.Equal(t, row.rule, layer.Nodes[0].Rule)
			require.Equal(t, map[string][]byte{row.manifest: []byte("fixture bytes")}, inputs)
			require.Equal(t, row.link, layer.link())
		})
	}
	// Record absent inputs, then recover when they appear. Both transitions and
	// changed contents must invalidate the environment key; unrelated files do not.
	files := map[string]string{".smithers/target-index.json": `[{"label":"//:go","rule":"Go.ModDownload","inputs":[{"kind":"file","path":"//go.sum"}]}]`}
	read := fakeRepository(files)
	absent, inputs, err := dependencyRecipe("parent", read)
	require.NoError(t, err)
	require.Equal(t, []dependencyNode{{Label: "//:go", Rule: "Go.ModDownload", Files: map[string]string{"go.sum": "absent"}}}, absent.Nodes)
	require.Empty(t, inputs)
	absentKey, _, err := recipeKey("parent", absent)
	require.NoError(t, err)
	files["go.sum"] = "first"
	present, inputs, err := dependencyRecipe("parent", read)
	require.NoError(t, err)
	require.Equal(t, map[string][]byte{"go.sum": []byte("first")}, inputs)
	require.NotEqual(t, "absent", present.Nodes[0].Files["go.sum"])
	presentKey, _, err := recipeKey("parent", present)
	require.NoError(t, err)
	require.NotEqual(t, absentKey, presentKey)
	files["unrelated.txt"] = "unrelated"
	unchanged, _, err := dependencyRecipe("parent", read)
	require.NoError(t, err)
	unchangedKey, _, err := recipeKey("parent", unchanged)
	require.NoError(t, err)
	require.Equal(t, presentKey, unchangedKey)
	files["go.sum"] = "second"
	changed, _, err := dependencyRecipe("parent", read)
	require.NoError(t, err)
	changedKey, _, err := recipeKey("parent", changed)
	require.NoError(t, err)
	require.NotEqual(t, presentKey, changedKey)
	delete(files, "go.sum")
	recoveredAbsent, _, err := dependencyRecipe("parent", read)
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
			index, err := json.Marshal([]any{map[string]any{"label": "//app:tool", "rule": "NodeBinary", "package": row.packageDir, "inputs": inputs}})
			require.NoError(t, err)
			layer, _, err := dependencyRecipe("toolchain", fakeRepository(map[string]string{
				".smithers/target-index.json": string(index), row.entry: "entry bytes", "pnpm-lock.yaml": "lock bytes",
			}))
			require.NoError(t, err)
			if row.admitted {
				require.Equal(t, []toolNode{{Label: "//app:tool", Package: "app", Entry: strings.TrimPrefix(row.entry, "app/")}}, layer.Tools)
				require.Len(t, layer.Nodes, 1)
			} else {
				require.Empty(t, layer.Tools)
				require.Empty(t, layer.Nodes)
			}
			require.Nil(t, layer.link(), "a tool node alone does not invent a workspace install")
		})
	}
	index := `[{"label":"//app:format","rule":"Dprint","package":"app","inputs":[{"kind":"file","path":"a/dprint.json"},{"kind":"file","path":"b/dprint.json"},{"kind":"file","path":"broken/dprint.json"}]}]`
	layer, _, err := dependencyRecipe("toolchain", fakeRepository(map[string]string{
		".smithers/target-index.json": index,
		"a/dprint.json":               `{"plugins":["https://plugins.dprint.dev/json.wasm","http://insecure.invalid/plugin.wasm","file:///local/plugin.wasm"]}`,
		"b/dprint.json":               `{"plugins":["https://plugins.dprint.dev/json.wasm@reviewed-hash","https://plugins.dprint.dev/markdown.wasm"]}`,
		"broken/dprint.json":          `{`,
	}))
	require.NoError(t, err)
	require.Equal(t, "app", layer.Dprint)
	require.Equal(t, []string{"https://plugins.dprint.dev/json.wasm@reviewed-hash", "https://plugins.dprint.dev/markdown.wasm"}, layer.DprintPlugins)
	require.Contains(t, layer.allowlist(), "plugins.dprint.dev")
	require.NotContains(t, layer.allowlist(), "insecure.invalid")
	for _, row := range []struct {
		rule    string
		domains []string
	}{
		{"Install", []string{"registry.npmjs.org"}},
		{"Go.ModDownload", []string{"registry.npmjs.org", "proxy.golang.org", "sum.golang.org", "storage.googleapis.com"}},
		{"Cargo.Fetch", []string{"registry.npmjs.org", "index.crates.io", "fastly-index.crates.io", "static.crates.io", "fastly-static.crates.io", "dualstack.k.sni.global.fastly.net", "crates.io", "github.com", "codeload.github.com"}},
	} {
		require.Equal(t, row.domains, (dependencyLayer{Nodes: []dependencyNode{{Rule: row.rule}}}).allowlist(), row.rule)
	}
}

func TestMicrosandboxUnitLayerArchivePreservesDeterministicFilesAndModes(t *testing.T) {
	files := map[string][]byte{"z/binary": {0, 255, 1}, "a.txt": []byte("héllo\n"), "empty": {}}
	archive, err := tarFiles(files)
	require.NoError(t, err)
	again, err := tarFiles(map[string][]byte{"empty": {}, "a.txt": []byte("héllo\n"), "z/binary": {0, 255, 1}})
	require.NoError(t, err)
	require.Equal(t, archive, again, "map insertion order cannot invalidate an identical layer archive")
	reader := tar.NewReader(bytes.NewReader(archive))
	for _, name := range []string{"a.txt", "empty", "z/binary"} {
		header, err := reader.Next()
		require.NoError(t, err)
		require.Equal(t, name, header.Name)
		require.Equal(t, int64(0o644), header.Mode)
		require.Equal(t, byte(tar.TypeReg), header.Typeflag)
		contents, err := io.ReadAll(reader)
		require.NoError(t, err)
		require.Equal(t, files[name], contents)
	}
	_, err = reader.Next()
	require.ErrorIs(t, err, io.EOF)
	require.Equal(t, map[string]string{"node": "26.5.0", "rustc": "1.89.0 (build details)"},
		parseInventory("noise\n inventory node 26.5.0 \ninventory rustc 1.89.0 (build details)\ninventory missing\n"))
}

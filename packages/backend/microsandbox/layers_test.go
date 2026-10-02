package microsandbox

import (
	"encoding/json"
	"io/fs"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func fakeRepository(files map[string]string) func(string) ([]byte, bool, error) {
	return func(path string) ([]byte, bool, error) {
		contents, ok := files[path]
		if !ok {
			return nil, false, nil
		}
		return []byte(contents), true, nil
	}
}

// indexRows decodes a target index the way resolve does.
func indexRows(t *testing.T, index string) []indexTarget {
	t.Helper()
	targets, err := readTargetIndex(fakeRepository(map[string]string{targetIndexPath: index}))
	require.NoError(t, err)
	return targets
}

// dependencies runs dependencyRecipe over the index file in files.
func dependencies(t *testing.T, files map[string]string) (dependencyLayer, map[string][]byte, error) {
	t.Helper()
	return dependencyRecipe("toolchain", indexRows(t, files[targetIndexPath]), fakeRepository(files))
}

func toolchainRow() map[string]any {
	pin := func(host, version string) map[string]string {
		return map[string]string{"version": version, "url": "https://" + host + "/" + version, "sha256": strings.Repeat("a", 64)}
	}
	return map[string]any{
		"label": "//:environmentToolchain", "package": "", "rule": "Environment.Toolchain", "inputs": []any{},
		"destinations": []string{"nodejs.org", "registry.npmjs.org", "github.com", "go.dev", "static.rust-lang.org", "www.postgresql.org", "apt.postgresql.org"},
		"toolchain": map[string]any{
			"downloads": map[string]any{
				"node": pin("nodejs.org", "26.5.0"), "pnpm": pin("registry.npmjs.org", "11.25.0"), "bun": pin("github.com", "1.4.1"),
				"go": pin("go.dev", "1.26.8"), "jj": pin("github.com", "0.39.0"), "rg": pin("github.com", "14.1.1"),
				"fd": pin("github.com", "10.2.0"), "jq": pin("github.com", "1.7.1"), "rustup": pin("static.rust-lang.org", "1.28.2"),
			},
			"rust":     map[string]any{"channel": "1.98.0", "components": []string{"rustfmt", "clippy"}, "targets": []string{"wasm32-wasip1"}},
			"postgres": "18",
		},
	}
}

func encodeRows(t *testing.T, rows ...map[string]any) []indexTarget {
	t.Helper()
	encoded, err := json.Marshal(rows)
	require.NoError(t, err)
	return indexRows(t, string(encoded))
}

func TestToolchainRecipeReadsTheIndexToolchainRow(t *testing.T) {
	recipe, err := toolchainRecipe("image@sha256:x", encodeRows(t, toolchainRow()))
	require.NoError(t, err)
	require.Equal(t, "26.5.0", recipe.Downloads["node"].Version)
	require.Equal(t, "https://registry.npmjs.org/11.25.0", recipe.Downloads["pnpm"].URL)
	require.Equal(t, "1.98.0", recipe.Rust)
	require.Equal(t, []string{"clippy", "rustfmt"}, recipe.RustParts)
	require.Equal(t, []string{"wasm32-wasip1"}, recipe.RustTargs)
	require.Equal(t, "18", recipe.Postgres)
	require.Equal(t, []string{"apt.postgresql.org", "github.com", "go.dev", "nodejs.org", "registry.npmjs.org", "static.rust-lang.org", "www.postgresql.org"}, recipe.allowlist())
	require.Contains(t, recipe.script(), "postgresql-18")
	require.Contains(t, recipe.script(), "--default-toolchain '1.98.0'")

	// Without Rust or PostgreSQL the script installs neither, and rustup is not required.
	row := toolchainRow()
	data := row["toolchain"].(map[string]any)
	delete(data, "rust")
	delete(data, "postgres")
	delete(data["downloads"].(map[string]any), "rustup")
	recipe, err = toolchainRecipe("image", encodeRows(t, row))
	require.NoError(t, err)
	require.NotContains(t, recipe.script(), "rustup-init")
	require.NotContains(t, recipe.script(), "postgresql")
	require.NotContains(t, recipe.script(), "inventory postgres")
}

func TestToolchainRecipeRefusesUndeclaredData(t *testing.T) {
	_, err := toolchainRecipe("image", nil)
	require.EqualError(t, err, ".smithers/target-index.json declares 0 Environment.Toolchain targets; a prepared environment needs exactly one")
	_, err = toolchainRecipe("image", encodeRows(t, toolchainRow(), toolchainRow()))
	require.ErrorContains(t, err, "declares 2 Environment.Toolchain targets")
	for _, row := range []struct {
		name       string
		mutate     func(map[string]any)
		diagnostic string
	}{
		{"no destinations", func(row map[string]any) { delete(row, "destinations") }, "//:environmentToolchain declares no network destinations"},
		{"no pins", func(row map[string]any) { delete(row, "toolchain") }, "//:environmentToolchain carries no toolchain pins"},
		{"missing tool", func(row map[string]any) {
			delete(row["toolchain"].(map[string]any)["downloads"].(map[string]any), "jq")
		}, "//:environmentToolchain pins no jq download"},
		{"missing rustup", func(row map[string]any) {
			delete(row["toolchain"].(map[string]any)["downloads"].(map[string]any), "rustup")
		}, "//:environmentToolchain pins no rustup download"},
		{"host outside destinations", func(row map[string]any) { row["destinations"] = []string{"nodejs.org"} },
			"//:environmentToolchain fetches"},
		{"postgres without its repository", func(row map[string]any) {
			row["destinations"] = []string{"nodejs.org", "registry.npmjs.org", "github.com", "go.dev", "static.rust-lang.org", "www.postgresql.org"}
		}, "//:environmentToolchain installs from apt.postgresql.org, which is not among its destinations"},
		{"rust without its dist server", func(row map[string]any) {
			data := row["toolchain"].(map[string]any)
			delete(data, "postgres")
			data["downloads"].(map[string]any)["rustup"] = map[string]string{"version": "1.28.2", "url": "https://github.com/rustup", "sha256": strings.Repeat("a", 64)}
			row["destinations"] = []string{"nodejs.org", "registry.npmjs.org", "github.com", "go.dev"}
		}, "//:environmentToolchain installs from static.rust-lang.org, which is not among its destinations"},
		{"invalid destination", func(row map[string]any) { row["destinations"] = []string{"Evil Host"} },
			`//:environmentToolchain declares an invalid network destination "Evil Host"`},
		{"http url", func(row map[string]any) {
			row["toolchain"].(map[string]any)["downloads"].(map[string]any)["node"] = map[string]string{"version": "26.5.0", "url": "http://nodejs.org/x", "sha256": strings.Repeat("a", 64)}
		}, "not an https URL"},
		{"short digest", func(row map[string]any) {
			row["toolchain"].(map[string]any)["downloads"].(map[string]any)["go"] = map[string]string{"version": "1.26.8", "url": "https://go.dev/x", "sha256": "abc"}
		}, "pins go without an exact version and SHA-256"},
		{"empty rust channel", func(row map[string]any) {
			row["toolchain"].(map[string]any)["rust"] = map[string]any{"channel": " ", "components": []string{}, "targets": []string{}}
		}, "declares a Rust toolchain with no channel"},
		{"postgres range", func(row map[string]any) { row["toolchain"].(map[string]any)["postgres"] = ">=17" },
			`declares PostgreSQL ">=17", not a major version`},
	} {
		t.Run(row.name, func(t *testing.T) {
			value := toolchainRow()
			row.mutate(value)
			layer, err := toolchainRecipe("image", encodeRows(t, value))
			require.ErrorContains(t, err, row.diagnostic)
			require.Equal(t, toolchainLayer{}, layer)
		})
	}
}

func TestTargetIndexAbsentAllowsDetection(t *testing.T) {
	_, err := readTargetIndex(fakeRepository(map[string]string{"Cargo.toml": "[package]\n", "go.mod": "module x\n"}))
	require.NoError(t, err)
	failure := &fs.PathError{Op: "read", Path: targetIndexPath, Err: fs.ErrPermission}
	_, err = readTargetIndex(func(string) ([]byte, bool, error) { return nil, false, failure })
	require.ErrorIs(t, err, failure)
	for _, raw := range []string{"{", `true`, `{"label":"object instead of list"}`} {
		_, err := readTargetIndex(fakeRepository(map[string]string{targetIndexPath: raw}))
		require.ErrorContains(t, err, "decode .smithers/target-index.json:")
	}
}

// A layer key follows the graph: a change to an install node's declared
// input or destinations changes the dependency key; an unrelated file does not.

func TestDependencyKeyFollowsDeclaredInputs(t *testing.T) {
	files := map[string]string{"pnpm-workspace.yaml": "packages: []\n", "pnpm-lock.yaml": "lock-1\n  playwright-core@1.62.1:\n", ".pnpmfile.mjs": "hook", "patches/fix.patch": "patch",
		"go.mod": "module x\n", "go.sum": "sum\n", "README.md": "one"}
	index := func(npmHosts string) string {
		return `[{"label":"//:nodeModules","rule":"Install","destinations":[` + npmHosts + `],"inputs":[{"kind":"pnpm-workspace","path":"pnpm-workspace.yaml"},{"kind":"file","path":"pnpm-lock.yaml"},{"kind":"file","path":".pnpmfile.mjs"},{"kind":"file","path":"patches/fix.patch"}]},
	{"label":"//:backendGoModules","rule":"Go.ModDownload","destinations":["proxy.golang.org","sum.golang.org"],"inputs":[{"kind":"file","path":"go.mod"},{"kind":"file","path":"go.sum"}]},
	{"label":"//:docs","rule":"Generate","inputs":[{"kind":"file","path":"README.md"}]}]`
	}
	files[targetIndexPath] = index(`"registry.npmjs.org","cdn.playwright.dev"`)
	key := func() string {
		recipe, _, err := dependencies(t, files)
		require.NoError(t, err)
		value, _, err := recipeKey("toolchain", recipe)
		require.NoError(t, err)
		return value
	}
	base := key()
	files["patches/fix.patch"] = "changed patch"
	require.NotEqual(t, base, key(), "a declared patch must change the install key")
	files["patches/fix.patch"] = "patch"
	files[".pnpmfile.mjs"] = "changed hook"
	require.NotEqual(t, base, key(), "a declared hook must change the install key")
	files[".pnpmfile.mjs"] = "hook"
	files["README.md"] = "two"
	require.Equal(t, base, key(), "a file outside the install nodes changed the key")
	files[targetIndexPath] = index(`"registry.npmjs.org"`)
	require.NotEqual(t, base, key(), "a changed destination must change the install key")
	files[targetIndexPath] = index(`"registry.npmjs.org","cdn.playwright.dev"`)
	files["go.sum"] = "sum-2\n"
	require.NotEqual(t, base, key())
	recipe, _, err := dependencies(t, files)
	require.NoError(t, err)
	require.Equal(t, []string{"1.62.1"}, recipe.Playwright)
	require.Equal(t, []string{"pnpm", "install", "--offline", "--frozen-lockfile"}, recipe.link())
	require.Len(t, recipe.Nodes, 2)
	require.Equal(t, []string{"cdn.playwright.dev", "proxy.golang.org", "registry.npmjs.org", "sum.golang.org"}, recipe.allowlist())
}

// A repository with no install nodes plants nothing, so the layer script
// makes its own working directory instead of failing on `cd`.
func TestDependencyScriptWithoutInputsHasItsDirectory(t *testing.T) {
	recipe, inputs, err := dependencies(t, map[string]string{targetIndexPath: "[]", "README.md": "notes"})
	require.NoError(t, err)
	require.Empty(t, inputs)
	require.Empty(t, recipe.allowlist())
	require.Contains(t, recipe.script(), "mkdir -p "+cacheRoot+"/prepare/src\ncd "+cacheRoot+"/prepare/src")
}

func TestLockImportersAndToolNodes(t *testing.T) {
	lock := "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    devDependencies: {}\n\n  apps/app:\n    dependencies: {}\n\n  packages/a:\n    dependencies: {}\n\npackages:\n\n  x@1.0.0:\n    resolution: {}\n"
	require.Equal(t, []string{".", "apps/app", "packages/a"}, lockImporters([]byte(lock)))
	index := `[{"label":"//:nodeModules","rule":"Install","destinations":["registry.npmjs.org"],"inputs":[{"kind":"pnpm-workspace","path":"pnpm-workspace.yaml"},{"kind":"file","path":"pnpm-lock.yaml"}]},
	{"label":"//apps/app:devkit","package":"apps/app","rule":"NodeBinary","destinations":["hutch.blackboard.sh","github.com"],"inputs":[{"kind":"file","path":"apps/app/scripts/ensure-devkit.mjs"},{"kind":"file","path":"pnpm-lock.yaml"}]}]`
	recipe, inputs, err := dependencies(t, map[string]string{targetIndexPath: index,
		"pnpm-workspace.yaml": "packages: []\n", "pnpm-lock.yaml": lock, "apps/app/package.json": "{}", "packages/a/package.json": "{}",
		"apps/app/scripts/ensure-devkit.mjs": "//"})
	require.NoError(t, err)
	require.Contains(t, inputs, "apps/app/package.json")
	require.Contains(t, inputs, "packages/a/package.json")
	require.Equal(t, []toolNode{{Label: "//apps/app:devkit", Package: "apps/app", Entry: "scripts/ensure-devkit.mjs"}}, recipe.Tools)
	require.Equal(t, []string{"github.com", "hutch.blackboard.sh", "registry.npmjs.org"}, recipe.allowlist())
}

// A download-performing node that declares no destinations is refused by
// name; it never inherits hosts from the backend.
func TestDependencyRecipeRejectsToolWithoutDestinations(t *testing.T) {
	index := `[{"label":"//apps/app:devkit","package":"apps/app","rule":"NodeBinary","inputs":[{"kind":"file","path":"apps/app/scripts/ensure-devkit.mjs"},{"kind":"file","path":"pnpm-lock.yaml"}]}]`
	layer, inputs, err := dependencies(t, map[string]string{targetIndexPath: index, "apps/app/scripts/ensure-devkit.mjs": "//", "pnpm-lock.yaml": "lock"})
	require.ErrorContains(t, err, "//apps/app:devkit")
	require.ErrorContains(t, err, "destination")
	require.Nil(t, inputs)
	require.Empty(t, layer.Tools)

	for _, rule := range []string{"Install", "Go.ModDownload"} {
		index := `[{"label":"//:install","rule":"` + rule + `","inputs":[{"kind":"file","path":"go.mod"}]}]`
		_, _, err := dependencies(t, map[string]string{targetIndexPath: index, "go.mod": "module x\n"})
		require.EqualError(t, err, "//:install declares no network destinations; add destinations to its declaration", rule)
	}
	// A declared empty list is a statement, not an omission.
	index = `[{"label":"//:install","rule":"Install","destinations":[],"inputs":[{"kind":"file","path":"pnpm-lock.yaml"}]}]`
	layer, _, err = dependencies(t, map[string]string{targetIndexPath: index, "pnpm-lock.yaml": "lock"})
	require.NoError(t, err)
	require.Empty(t, layer.allowlist())
	index = `[{"label":"//:install","rule":"Install","destinations":["registry.npmjs.org","bad_host"],"inputs":[]}]`
	_, _, err = dependencies(t, map[string]string{targetIndexPath: index})
	require.EqualError(t, err, `//:install declares an invalid network destination "bad_host"`)
}

func TestCargoFetchUsesTheCargoNodesDestinations(t *testing.T) {
	files := map[string]string{"Cargo.toml": "[workspace]\n", "Cargo.lock": "lock", "crates/ffi/Cargo.toml": "[package]\n"}
	files[targetIndexPath] = `[{"label":"//crates/a:fmt","rule":"Cargo.Fmt","inputs":[{"kind":"file","path":"Cargo.toml"}]},
	{"label":"//:nativeFfi","rule":"Shell.Build","inputs":[{"kind":"file","path":"crates/ffi/Cargo.toml"}]}]`
	_, _, err := dependencies(t, files)
	require.EqualError(t, err, "//crates/a:fmt, //:nativeFfi declare no network destinations for the cargo fetch; add destinations to a Cargo declaration")
	files[targetIndexPath] = `[{"label":"//crates/a:fmt","rule":"Cargo.Fmt","inputs":[{"kind":"file","path":"Cargo.toml"}]},
	{"label":"//crates/a:test","rule":"Cargo.Test","destinations":["static.crates.io","index.crates.io"],"inputs":[{"kind":"file","path":"Cargo.lock"}]},
	{"label":"//crates/a:clippy","rule":"Cargo.Clippy","destinations":["github.com","index.crates.io"],"inputs":[{"kind":"file","path":"Cargo.lock"}]},
	{"label":"//:nativeFfi","rule":"Shell.Build","inputs":[{"kind":"file","path":"crates/ffi/Cargo.toml"}]}]`
	layer, inputs, err := dependencies(t, files)
	require.NoError(t, err)
	require.Equal(t, []string{"github.com", "index.crates.io", "static.crates.io"}, layer.allowlist())
	require.Len(t, layer.Nodes, 1)
	require.Equal(t, "Cargo.Fetch", layer.Nodes[0].Rule)
	require.Len(t, inputs, 3)
	require.Contains(t, layer.script(), "cargo fetch --locked")
}

func TestDprintPluginsComeFromDprintNodes(t *testing.T) {
	index := `[{"label":"//a:fmt","package":"a","rule":"Dprint","inputs":[{"kind":"file","path":"a/dprint.json"}]},
	{"label":"//b:fmt","package":"b","rule":"Dprint","inputs":[{"kind":"file","path":"b/dprint.json"}]}]`
	recipe, _, err := dependencies(t, map[string]string{targetIndexPath: index,
		"a/dprint.json": `{"plugins":["https://plugins.dprint.dev/json-0.21.1.wasm"]}`,
		"b/dprint.json": `{"plugins":["https://plugins.dprint.dev/json-0.21.1.wasm@abc","https://plugins.dprint.dev/markdown-0.20.0.wasm"]}`})
	require.NoError(t, err)
	require.Equal(t, "a", recipe.Dprint)
	require.Equal(t, []string{"https://plugins.dprint.dev/json-0.21.1.wasm@abc", "https://plugins.dprint.dev/markdown-0.20.0.wasm"}, recipe.DprintPlugins)
	require.Equal(t, []string{"plugins.dprint.dev"}, recipe.allowlist())
}

func TestUnixMode(t *testing.T) {
	require.Equal(t, fs.ModeDir|0o755, unixMode(0o040755))
	require.Equal(t, fs.ModeSymlink|0o777, unixMode(0o120777))
	require.Equal(t, fs.FileMode(0o644), unixMode(0o100644))
}

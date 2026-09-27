package microsandbox

import (
	"io/fs"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestPatchedDependencies(t *testing.T) {
	workspace := []byte("packages:\n  - a\npatchedDependencies:\n  '@x/y@1.0.0': patches/@x__y@1.0.0.patch\n  z@2.0.0: \"patches/z@2.0.0.patch\"\nonlyBuilt:\n  - q\n")
	require.Equal(t, []string{"patches/@x__y@1.0.0.patch", "patches/z@2.0.0.patch"}, patchedDependencies(workspace))
}

func fakeRepository(files map[string]string) func(string) ([]byte, bool, error) {
	return func(path string) ([]byte, bool, error) {
		contents, ok := files[path]
		if !ok {
			return nil, false, nil
		}
		return []byte(contents), true, nil
	}
}

func TestToolchainRecipeReadsRepositoryPins(t *testing.T) {
	recipe, err := toolchainRecipe("image@sha256:x", fakeRepository(map[string]string{
		".node-version":          "26.5.0\n",
		"package.json":           `{"packageManager":"pnpm@11.25.0+sha512.abc"}`,
		"go.mod":                 "module x\n\ngo 1.26.8\n",
		".smithers/WORKSPACE.ts": `export const jjVersion = "0.39.0"` + "\n" + `export const bunVersion = "1.4.1"`,
		"rust-toolchain.toml":    "[toolchain]\nchannel = \"1.89.0\"\ncomponents = [\"rustfmt\", \"clippy\"]\ntargets = [\"wasm32-wasip1\"]\n",
	}))
	require.NoError(t, err)
	require.Equal(t, "26.5.0", recipe.Versions["node"])
	require.Equal(t, "11.25.0", recipe.Versions["pnpm"])
	require.Equal(t, "1.89.0", recipe.Rust)
	require.Equal(t, []string{"clippy", "rustfmt"}, recipe.RustParts)

	_, err = toolchainRecipe("image", fakeRepository(map[string]string{".node-version": "27.0.0"}))
	require.ErrorContains(t, err, "no reviewed linux/arm64 checksum")
}

// A layer key follows the graph: a change to an install node's declared
// input changes the dependency key; an unrelated file does not.
func TestDependencyKeyFollowsDeclaredInputs(t *testing.T) {
	index := `[{"label":"//:nodeModules","rule":"Install","inputs":[{"kind":"pnpm-workspace","path":"pnpm-workspace.yaml"},{"kind":"file","path":"pnpm-lock.yaml"}]},
	{"label":"//:backendGoModules","rule":"Go.ModDownload","inputs":[{"kind":"file","path":"go.mod"},{"kind":"file","path":"go.sum"}]},
	{"label":"//:docs","rule":"Generate","inputs":[{"kind":"file","path":"README.md"}]}]`
	files := map[string]string{".smithers/target-index.json": index, "pnpm-workspace.yaml": "packages: []\n", "pnpm-lock.yaml": "lock-1\n  playwright-core@1.62.1:\n",
		"go.mod": "module x\n", "go.sum": "sum\n", "README.md": "one"}
	key := func() string {
		recipe, _, err := dependencyRecipe("toolchain", fakeRepository(files))
		require.NoError(t, err)
		value, _, err := recipeKey("toolchain", recipe)
		require.NoError(t, err)
		return value
	}
	base := key()
	files["README.md"] = "two"
	require.Equal(t, base, key(), "a file outside the install nodes changed the key")
	files["go.sum"] = "sum-2\n"
	changed := key()
	require.NotEqual(t, base, changed)
	recipe, _, err := dependencyRecipe("toolchain", fakeRepository(files))
	require.NoError(t, err)
	require.Equal(t, []string{"1.62.1"}, recipe.Playwright)
	require.Equal(t, []string{"pnpm", "install", "--offline", "--frozen-lockfile"}, recipe.link())
	require.Len(t, recipe.Nodes, 2)
}

func TestLockImportersAndToolNodes(t *testing.T) {
	lock := "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    devDependencies: {}\n\n  apps/app:\n    dependencies: {}\n\n  packages/a:\n    dependencies: {}\n\npackages:\n\n  x@1.0.0:\n    resolution: {}\n"
	require.Equal(t, []string{".", "apps/app", "packages/a"}, lockImporters([]byte(lock)))
	index := `[{"label":"//:nodeModules","rule":"Install","inputs":[{"kind":"pnpm-workspace","path":"pnpm-workspace.yaml"},{"kind":"file","path":"pnpm-lock.yaml"}]},
	{"label":"//apps/app:devkit","package":"apps/app","rule":"NodeBinary","inputs":[{"kind":"file","path":"apps/app/scripts/ensure-devkit.mjs"},{"kind":"file","path":"pnpm-lock.yaml"}]}]`
	recipe, inputs, err := dependencyRecipe("toolchain", fakeRepository(map[string]string{".smithers/target-index.json": index,
		"pnpm-workspace.yaml": "packages: []\n", "pnpm-lock.yaml": lock, "apps/app/package.json": "{}", "packages/a/package.json": "{}",
		"apps/app/scripts/ensure-devkit.mjs": "//"}))
	require.NoError(t, err)
	require.Contains(t, inputs, "apps/app/package.json")
	require.Contains(t, inputs, "packages/a/package.json")
	require.Equal(t, []toolNode{{Label: "//apps/app:devkit", Package: "apps/app", Entry: "scripts/ensure-devkit.mjs"}}, recipe.Tools)
}

func TestUnixMode(t *testing.T) {
	require.Equal(t, fs.ModeDir|0o755, unixMode(0o040755))
	require.Equal(t, fs.ModeSymlink|0o777, unixMode(0o120777))
	require.Equal(t, fs.FileMode(0o644), unixMode(0o100644))
}

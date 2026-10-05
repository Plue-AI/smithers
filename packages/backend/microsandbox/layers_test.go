package microsandbox

import (
	"archive/zip"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
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
	require.Equal(t, []string{"apt.postgresql.org", "cdn-fastly.deb.debian.org", "deb.debian.org", "debian.map.fastly.net", "debian.map.fastlydns.net", "dualstack.k.sni.global.fastly.net", "github.com", "go.dev", "nodejs.org", "registry.npmjs.org", "security.debian.org", "static.rust-lang.org", "www.postgresql.org"}, recipe.allowlist())
	require.Contains(t, recipe.systemScript(), `"postgresql-$postgres"`)
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

// #3439: destinations must be clean relative paths within the toolchain prefix.
func TestToolchainRecipeRefusesEscapingDownloadDestination(t *testing.T) {
	for _, destination := range []string{"../../usr/bin/x", "/usr/bin", "a/../b", "a//b", "."} {
		t.Run(destination, func(t *testing.T) {
			row := toolchainRow()
			row["toolchain"].(map[string]any)["downloads"].(map[string]any)["node"].(map[string]string)["destination"] = destination
			_, err := toolchainRecipe("image", encodeRows(t, row))
			var refusal *RecipeError
			require.ErrorAs(t, err, &refusal)
			require.Equal(t, "invalid_download_destination", refusal.Code)
		})
	}
}

func TestToolchainRecipeAcceptsContainedDestinationAndSeparatesPrivilege(t *testing.T) {
	row := toolchainRow()
	row["toolchain"].(map[string]any)["downloads"].(map[string]any)["node"].(map[string]string)["destination"] = "node/bin"
	layer, err := toolchainRecipe("image", encodeRows(t, row))
	require.NoError(t, err)
	user, system := recipePreparation(layer)
	require.Equal(t, guestUser, user) // M-29 / #3439: no artifact gets root authority.
	require.Contains(t, system, fmt.Sprintf("chown -R %d:%d %s", guestUID, guestUID, toolchainRoot))
	require.NotContains(t, system, "fetch()")
	require.NotContains(t, system, "--version")
	require.NotContains(t, layer.script(), "apt-get")
	require.NotContains(t, layer.script(), "chown")
	require.NotContains(t, layer.script(), "env.json")
	require.Contains(t, system, "chmod 0644 /opt/smithers/env.json")
	require.NotContains(t, system, fmt.Sprintf("chown %d:%d /opt/smithers/env.json", guestUID, guestUID))
	require.Contains(t, layer.script(), "inventory toolchain-uid $(id -u)")
	layer.Packages = []string{"libssl-dev"}
	require.Contains(t, layer.systemScript(), `"$@"`)
	require.Equal(t, []string{"libssl-dev"}, layer.Packages)
	before, _, err := recipeKey("", layer)
	require.NoError(t, err)
	layer.Packages = []string{"libyaml-dev"}
	after, _, err := recipeKey("", layer)
	require.NoError(t, err)
	require.NotEqual(t, before, after, "shipped system script remains in the cache identity")
}

// Dispatch oracle: the actual output write must refuse .. and symlink escapes,
// independently of the host recipe's lexical validation.
func TestToolchainDestinationConfinesActualWrite(t *testing.T) {
	for _, destination := range []string{"../outside", "bin/jq", "escaped/jq", "hardlink", "bin", "a/../outside", "custom/jq"} {
		t.Run(destination, func(t *testing.T) {
			root, err := filepath.EvalSymlinks(t.TempDir())
			require.NoError(t, err)
			prefix := filepath.Join(root, "toolchain")
			require.NoError(t, os.MkdirAll(filepath.Join(prefix, "bin"), 0755))
			sentinel := filepath.Join(root, "outside")
			require.NoError(t, os.WriteFile(sentinel, []byte("untouched"), 0600))
			require.NoError(t, os.Symlink(sentinel, filepath.Join(prefix, "bin/jq")))
			require.NoError(t, os.Symlink(root, filepath.Join(prefix, "escaped")))
			require.NoError(t, os.Link(sentinel, filepath.Join(prefix, "hardlink")))
			mock := filepath.Join(root, "mock")
			require.NoError(t, os.Mkdir(mock, 0755))
			// Real shell/Python, fake network only: no download in this confinement test.
			require.NoError(t, os.WriteFile(filepath.Join(mock, "curl"), []byte("#!/bin/sh\nwhile [ \"$#\" -gt 0 ]; do if [ \"$1\" = -o ]; then printf payload > \"$2\"; exit; fi; shift; done\nprintf payload\n"), 0755))
			require.NoError(t, os.WriteFile(filepath.Join(mock, "sha256sum"), []byte("#!/bin/sh\ncat >/dev/null\n"), 0755))
			layer := toolchainLayer{Downloads: map[string]download{"jq": {URL: "https://example.com/jq", SHA256: digest("payload"), Destination: destination}}}
			script := strings.ReplaceAll(layer.script(), toolchainRoot, prefix)
			script = strings.ReplaceAll(script, cacheRoot, filepath.Join(root, "cache"))
			script = strings.ReplaceAll(script, "/var/tmp/dl", filepath.Join(root, "dl"))
			script = strings.ReplaceAll(script, `echo "inventory jq $(jq --version)"`, ":")
			cmd := exec.Command("/bin/bash", "-c", script)
			cmd.Env = append(os.Environ(), "PATH="+mock+":/usr/bin:/bin")
			output, err := cmd.CombinedOutput()
			if destination == "custom/jq" {
				require.NoError(t, err, string(output))
				body, err := os.ReadFile(filepath.Join(prefix, destination))
				require.NoError(t, err)
				require.Equal(t, "payload", string(body))
			} else {
				require.Error(t, err, string(output))
				require.Contains(t, string(output), "invalid_download_destination")
			}
			body, err := os.ReadFile(sentinel)
			require.NoError(t, err)
			require.Equal(t, "untouched", string(body))
		})
	}
}

func TestDependencyPreparationCannotSelectRootInputs(t *testing.T) {
	// Dispatch gate: branch lockfiles cannot select even a shipped root script.
	user, system := recipePreparation(dependencyLayer{Playwright: []string{"1.52.0"}})
	require.Equal(t, guestUser, user)
	require.Empty(t, system)
	require.Contains(t, toolchainSystemScript, playwrightSystemPackages)
}

// Unit CLI transport fake records the guest execution contract. Real VM
// fixtures below exercise the requested Unix identity through actual hooks.
// M-29: every detected dependency path must request the unprivileged identity.
func TestDetectedDependencyPreparationRequestsAgentIdentity(t *testing.T) {
	for _, command := range [][]string{
		{"toolchain"},
		{"npm", "ci"}, {"pnpm", "install"}, {"yarn", "install"}, {"bun", "install"},
		{"python", "-m", "pip", "install", "-r", "requirements.txt"},
		{"uv", "sync", "--frozen"}, {"go", "mod", "download"}, {"cargo", "fetch"},
	} {
		t.Run(command[0], func(t *testing.T) {
			root := t.TempDir()
			log := filepath.Join(root, "requests")
			removals := filepath.Join(root, "removals")
			binary := filepath.Join(root, "msb")
			script := fmt.Sprintf(`#!/bin/sh
case "$*" in
  remove\ *) echo "$*" >> %s ;;
  *run\ root-recipe*) cat >/dev/null; printf '\000SMITHERS-EXIT 0\000' >&2 ;;
  *run\ exec\ *) cat >> %s; printf '\n' >> %s; printf '\000SMITHERS-EXIT 0\000' >&2 ;;
esac
`, shellQuote(removals), shellQuote(log), shellQuote(log))
			require.NoError(t, os.WriteFile(binary, []byte(script), 0o755))
			runtime := &Runtime{config: Config{CPUs: 2, MemoryMiB: 2048, DiskMiB: 8192, MaxRunningVMs: 1}, root: root, owner: "smithers-backend-0123456789abcdef", cli: &cli{binary: binary, home: root}}
			env := environments{runtime: runtime, config: EnvironmentConfig{Image: DefaultImage, PrepareTimeout: time.Minute}}
			var layer recipe = dependencyLayer{DetectorVersion: DetectorVersion, Installs: []DetectedInstall{{Command: command}}}
			if command[0] == "toolchain" {
				layer = toolchainLayer{Downloads: map[string]download{"node": {Version: "22.14.0", URL: "https://nodejs.org/main", SHA256: strings.Repeat("a", 64)}}, Packages: []string{"libssl-dev"}}
			}
			_, err := env.buildLayer(t.Context(), layerRecord{Kind: layerDependency, Key: strings.Repeat("a", 64), Name: "layer-fixture"}, layer, "", nil)
			require.NoError(t, err)
			removed, err := os.ReadFile(removals)
			require.NoError(t, err)
			require.Len(t, strings.Split(strings.TrimSpace(string(removed)), "\n"), 1, "one confirmed cleanup releases the prepare machine")
			require.Zero(t, runtime.InUse())
			requests, err := os.ReadFile(log)
			require.NoError(t, err)
			found := false
			for _, line := range strings.Split(strings.TrimSpace(string(requests)), "\n") {
				var request execRequest
				require.NoError(t, json.Unmarshal([]byte(line), &request))
				if strings.Contains(request.Argv[2], "set -eEuo pipefail") || strings.Contains(request.Argv[2], "fetch()") {
					found = true
					require.Equal(t, guestUser, request.User)
					require.Equal(t, guestHome, request.Env["HOME"])
				}
			}
			require.True(t, found)
		})
	}
}
func TestLayerEnsureReturnsSnapshotBeforeWorkspaceReferencesIt(t *testing.T) {
	root := t.TempDir()
	artifact := filepath.Join(root, ".microsandbox", "snapshot")
	require.NoError(t, os.MkdirAll(artifact, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(artifact, "disk"), []byte(strings.Repeat("x", 8192)), 0o644))
	layer := dependencyLayer{DetectorVersion: DetectorVersion}
	key, _, err := recipeKey("", layer)
	require.NoError(t, err)
	runtime := &Runtime{config: Config{CPUs: 2, MemoryMiB: 2048, DiskMiB: 8192, MaxRunningVMs: 1}, root: root, owner: "smithers-backend-0123456789abcdef", workspaces: map[string]*workspace{}}
	env := environments{runtime: runtime, config: EnvironmentConfig{Image: DefaultImage, PrepareTimeout: time.Minute, KeepPerFamily: 1}}
	name := env.layerName(layerDependency, key)
	state := filepath.Join(root, "snapshot-created")
	removals := filepath.Join(root, "removals")
	binary := filepath.Join(root, "msb")
	listing, err := json.Marshal([]map[string]string{{"name": name, "artifact_path": artifact}})
	require.NoError(t, err)
	marker, err := json.Marshal(map[string]string{"kind": layerDependency, "key": key})
	require.NoError(t, err)
	script := fmt.Sprintf(`#!/bin/sh
case "$*" in
  remove\ *) echo "$*" >> %s ;;
  "snapshot list --format json") if [ -e %s ]; then printf '%%s' %s; else echo '[]'; fi ;;
  "snapshot create "*) touch %s ;;
  "snapshot remove "*) rm %s ;;
  *smthrs-vfy-*run\ exec\ *) cat >/dev/null; printf '%%s' %s; printf '\000SMITHERS-EXIT 0\000' >&2 ;;
  *run\ exec\ *|*run\ root-recipe*) cat >/dev/null; printf '\000SMITHERS-EXIT 0\000' >&2 ;;
esac
`, shellQuote(removals), shellQuote(state), shellQuote(string(listing)), shellQuote(state), shellQuote(state), shellQuote(string(marker)))
	require.NoError(t, os.WriteFile(binary, []byte(script), 0o755))
	runtime.cli = &cli{binary: binary, home: root}
	record, err := env.ensure(t.Context(), layerDependency, layer, "", "fixture", nil, false)
	require.NoError(t, err)
	require.Equal(t, name, record.Name)
	removed, err := os.ReadFile(removals)
	require.NoError(t, err)
	require.Len(t, strings.Split(strings.TrimSpace(string(removed)), "\n"), 2, "prepare and verification each have one confirmed cleanup")
	require.Zero(t, runtime.InUse())
	_, err = os.Stat(state)
	require.NoError(t, err, "ensure returned a snapshot it already evicted")
	_, err = os.Stat(env.recordPath(name))
	require.NoError(t, err)
	// Once handed back and no workspace references it, the cache may evict it.
	report, err := env.collect(t.Context())
	require.NoError(t, err)
	require.Equal(t, []string{name}, report.Removed)
}

// Pause at the internal resolve/create handoff while a concurrent collector
// applies pressure. No workspace references the returned snapshot yet.
func TestWorkspaceLayerHandoffRetainsSnapshotUntilRegistered(t *testing.T) {
	for _, dependencies := range []bool{false, true} {
		t.Run(fmt.Sprint(dependencies), func(t *testing.T) {
			root := t.TempDir()
			artifact := filepath.Join(root, ".microsandbox", "snapshot")
			require.NoError(t, os.MkdirAll(artifact, 0o755))
			require.NoError(t, os.WriteFile(filepath.Join(artifact, "disk"), []byte(strings.Repeat("x", 8192)), 0o644))
			files := map[string]string{".node-version": "22.14.0"}
			if dependencies {
				files["package.json"] = `{"name":"handoff","version":"1.0.0"}`
			}
			detected, err := DetectRecipe(fakeRepository(files))
			require.NoError(t, err)
			tc, err := toolchainRecipeDetected(DefaultImage, detected, nil)
			require.NoError(t, err)
			tcKey, _, err := recipeKey("", tc)
			require.NoError(t, err)
			runtime := &Runtime{config: Config{CPUs: 2, MemoryMiB: 2048, DiskMiB: 8192, MaxRunningVMs: 1}, root: root, owner: "smithers-backend-0123456789abcdef", workspaces: map[string]*workspace{}}
			env := &environments{runtime: runtime, verified: map[string]bool{}, config: EnvironmentConfig{Image: DefaultImage, KeepPerFamily: 1}}
			runtime.environments = env
			runtime.BindSourceFiles(&revisionLayerReader{files: files, reads: map[string][]string{}})
			records := []layerRecord{{Schema: layerSchema, Kind: layerToolchain, Key: tcKey, Name: env.layerName(layerToolchain, tcKey)}}
			if dependencies {
				dp, _, err := dependencyRecipeDetected(tcKey, detected, fakeRepository(files))
				require.NoError(t, err)
				dpKey, _, err := recipeKey(tcKey, dp)
				require.NoError(t, err)
				records = append(records, layerRecord{Schema: layerSchema, Kind: layerDependency, Key: dpKey, ParentKey: tcKey, Name: env.layerName(layerDependency, dpKey)})
			}
			require.NoError(t, os.MkdirAll(env.layerDir(), 0o700))
			var listing []map[string]string
			for _, record := range records {
				require.NoError(t, writeJSON(env.recordPath(record.Name), record))
				env.verified[record.Name] = true
				listing = append(listing, map[string]string{"name": record.Name, "artifact_path": artifact})
			}
			encoded, err := json.Marshal(listing)
			require.NoError(t, err)
			binary := filepath.Join(root, "msb")
			require.NoError(t, os.WriteFile(binary, []byte("#!/bin/sh\ncase \"$*\" in\n  \"snapshot list --format json\") printf '%s' "+shellQuote(string(encoded))+" ;;\nesac\n"), 0o755))
			runtime.cli = &cli{binary: binary, home: root}
			layer, release, err := runtime.resolveWorkspaceLayerForCreate(t.Context(), workspaceapi.WorkspaceSpec{ID: "handoff", Source: &workspaceapi.WorkspaceSource{Repository: "fixture", Revision: "main"}})
			require.NoError(t, err)
			defer func() { release() }()
			type collection struct {
				report CollectReport
				err    error
			}
			collected := make(chan collection, 1)
			go func() {
				report, err := runtime.CollectLayers(t.Context())
				collected <- collection{report, err}
			}()
			result := <-collected
			require.NoError(t, result.err)
			require.Empty(t, result.report.Removed, "collector evicted a resolved snapshot before workspace registration")
			runtime.mu.Lock()
			runtime.workspaces["handoff"] = newWorkspace(metadata{ID: "handoff", Snapshot: layer.Snapshot}, "")
			runtime.mu.Unlock()
			release()
			release = func() {}
			report, err := runtime.CollectLayers(t.Context())
			require.NoError(t, err)
			require.Empty(t, report.Removed)
			runtime.mu.Lock()
			delete(runtime.workspaces, "handoff")
			runtime.mu.Unlock()
			if dependencies {
				// A recipe failure after resolving the toolchain releases its
				// retained pin, allowing a later retry to rebuild normally.
				files["package.json"] = `{"name":"handoff","workspaces":12}`
				_, releaseFailure, err := runtime.resolveWorkspaceLayerForCreate(t.Context(), workspaceapi.WorkspaceSpec{Source: &workspaceapi.WorkspaceSource{Repository: "fixture", Revision: "main"}})
				require.ErrorContains(t, err, "decode package.json workspaces")
				releaseFailure()
			}
			report, err = runtime.CollectLayers(t.Context())
			require.NoError(t, err)
			require.Len(t, report.Removed, len(records), "handoff leaked preparation pins")
		})
	}
}

func TestLayerVerificationRetainsSnapshotAndParentWhenDiskFloorRefuses(t *testing.T) {
	root := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(root, ".microsandbox"), 0o755))
	require.NoError(t, os.MkdirAll(filepath.Join(root, "layers"), 0o755))
	log := filepath.Join(root, "removals")
	binary := filepath.Join(root, "msb")
	script := fmt.Sprintf(`#!/bin/sh
case "$*" in
  *run\ root-recipe*) cat >/dev/null; printf '\000SMITHERS-EXIT 0\000' >&2 ;;
 "snapshot list --format json") echo '[]' ;;
  "snapshot remove "*) printf '%%s\n' "$*" >> %s ;;
esac
`, shellQuote(log))
	require.NoError(t, os.WriteFile(binary, []byte(script), 0o755))
	runtime := &Runtime{config: Config{CPUs: 2, MemoryMiB: 2048, DiskMiB: 8192, MaxRunningVMs: 1}, root: root, owner: "smithers-backend-0123456789abcdef", cli: &cli{binary: binary, home: root}, workspaces: map[string]*workspace{}}
	env := environments{runtime: runtime, config: EnvironmentConfig{Image: DefaultImage, MinFreeBytes: 1 << 62, KeepPerFamily: 1}}
	parentKey := strings.Repeat("a", 64)
	parent := layerRecord{Schema: layerSchema, Kind: layerToolchain, Key: parentKey, Name: env.layerName(layerToolchain, parentKey)}
	childKey := strings.Repeat("b", 64)
	child := layerRecord{Schema: layerSchema, Kind: layerDependency, Key: childKey, Name: env.layerName(layerDependency, childKey), ParentKey: parentKey}
	for _, record := range []layerRecord{parent, child} {
		require.NoError(t, writeJSON(env.recordPath(record.Name), record))
	}
	require.ErrorContains(t, env.verify(t.Context(), child), "disk budget:")
	for _, record := range []layerRecord{parent, child} {
		_, err := os.Stat(env.recordPath(record.Name))
		require.NoError(t, err, "admission collection deleted an active verification layer")
	}
	_, err := os.Stat(log)
	require.ErrorIs(t, err, fs.ErrNotExist)
	// A failed verification releases both pins; ordinary collection may now
	// remove unused layers to recover disk capacity.
	report, err := env.collect(t.Context())
	require.NoError(t, err)
	require.ElementsMatch(t, []string{parent.Name, child.Name}, report.Removed)
}

// Block the transport during snapshot deletion to reproduce the scan-to-pin
// race deterministically, without a production timing knob or a real VM.
func TestLayerPinCannotRegisterDuringSnapshotDeletion(t *testing.T) {
	root := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(root, ".microsandbox"), 0o755))
	require.NoError(t, os.MkdirAll(filepath.Join(root, "layers"), 0o755))
	started, gate := filepath.Join(root, "deletion-started"), filepath.Join(root, "allow-deletion")
	binary := filepath.Join(root, "msb")
	script := fmt.Sprintf(`#!/bin/sh
case "$*" in
  *run\ root-recipe*) cat >/dev/null; printf '\000SMITHERS-EXIT 0\000' >&2 ;;
 "snapshot list --format json") echo '[]' ;;
  "snapshot remove "*) touch %s; while [ ! -e %s ]; do sleep 0.01; done ;;
esac
`, shellQuote(started), shellQuote(gate))
	require.NoError(t, os.WriteFile(binary, []byte(script), 0o755))
	runtime := &Runtime{config: Config{CPUs: 2, MemoryMiB: 2048, DiskMiB: 8192, MaxRunningVMs: 1}, root: root, owner: "smithers-backend-0123456789abcdef", cli: &cli{binary: binary, home: root}, workspaces: map[string]*workspace{}}
	env := environments{runtime: runtime, config: EnvironmentConfig{Image: DefaultImage, MinFreeBytes: 1 << 62, KeepPerFamily: 1}}
	key := strings.Repeat("a", 64)
	record := layerRecord{Schema: layerSchema, Kind: layerDependency, Key: key, Name: env.layerName(layerDependency, key)}
	require.NoError(t, writeJSON(env.recordPath(record.Name), record))
	t.Cleanup(func() { _ = os.WriteFile(gate, nil, 0o644) })
	collected := make(chan error, 1)
	go func() { _, err := env.collect(t.Context()); collected <- err }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(started); err == nil {
			break
		}
		require.True(t, time.Now().Before(deadline), "collector never began deletion")
		time.Sleep(10 * time.Millisecond)
	}
	registered := make(chan func(), 1)
	go func() { registered <- env.pin(record.Name) }()
	select {
	case release := <-registered:
		release()
		t.Fatal("registered a live preparation pin while its snapshot was being deleted")
	case <-time.After(50 * time.Millisecond):
	}
	require.NoError(t, os.WriteFile(gate, nil, 0o644))
	require.NoError(t, <-collected)
	select {
	case release := <-registered:
		defer release()
	case <-time.After(5 * time.Second):
		t.Fatal("pin remained blocked after deletion finished")
	}
	_, err := os.Stat(env.recordPath(record.Name))
	require.ErrorIs(t, err, fs.ErrNotExist, "a subsequent ensure must observe absence and rebuild")
}

// The transport fake emits the actual guest exit protocol or loses it. These
// are host failure-path tests; they do not replace real package installs.
func TestLayerRecipeExecutionPreservesFailuresAndCancellation(t *testing.T) {
	for _, fixture := range []struct {
		name, body, want string
		failure          error
	}{
		{"success", "printf 'inventory python 3.12.9\\n'; printf '\\000SMITHERS-EXIT 0\\000' >&2", "inventory python 3.12.9\n", nil},
		{"nonzero guest exit", "printf 'build output'; printf 'build failed\\000SMITHERS-EXIT 7\\000' >&2", "exited 7: build outputbuild failed", nil},
		{"lost exit receipt", "printf 'transport lost' >&2", "prepare command lost", ErrUnavailable},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			root := t.TempDir()
			binary := filepath.Join(root, "msb")
			require.NoError(t, os.WriteFile(binary, []byte("#!/bin/sh\n"+fixture.body+"\n"), 0o755))
			env := environments{runtime: &Runtime{cli: &cli{binary: binary, home: root}}}
			output, err := env.runRecipe(t.Context(), "fixture", "build", guestUser, guestHome)
			if fixture.name == "success" {
				require.NoError(t, err)
				require.Equal(t, fixture.want, output)
			} else {
				require.Empty(t, output)
				require.ErrorContains(t, err, fixture.want)
				if fixture.failure != nil {
					require.ErrorIs(t, err, fixture.failure)
				}
			}
		})
	}
	t.Run("start failure", func(t *testing.T) {
		env := environments{runtime: &Runtime{cli: &cli{binary: filepath.Join(t.TempDir(), "missing"), home: t.TempDir()}}}
		output, err := env.runRecipe(t.Context(), "fixture", "build", guestUser, guestHome)
		require.Empty(t, output)
		require.ErrorContains(t, err, "start msb:")
	})
	t.Run("already cancelled", func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		cancel()
		env := environments{runtime: &Runtime{cli: &cli{binary: "/must-not-start", home: t.TempDir()}}}
		output, err := env.runRecipe(ctx, "fixture", "build", guestUser, guestHome)
		require.Empty(t, output)
		require.ErrorIs(t, err, context.Canceled)
	})
	t.Run("runaway command", func(t *testing.T) {
		root := t.TempDir()
		binary := filepath.Join(root, "msb")
		require.NoError(t, os.WriteFile(binary, []byte("#!/bin/sh\nexec /bin/sleep 30\n"), 0o755))
		ctx, cancel := context.WithTimeout(t.Context(), time.Second)
		defer cancel()
		env := environments{runtime: &Runtime{cli: &cli{binary: binary, home: root}}}
		output, err := env.runRecipe(ctx, "fixture", "build", guestUser, guestHome)
		require.Empty(t, output)
		require.ErrorIs(t, err, ErrCommandRunaway)
		require.ErrorContains(t, err, "prepare exceeded its runaway guard")
	})
}

func TestDetectedCargoStringDependenciesAndPathDependencies(t *testing.T) {
	files := map[string]string{
		"Cargo.toml":                    "[package]\nname='fixture'\nversion='0.1.0'\n[dependencies]\nserde='1.0'\nlocal={path='crates/local'}\n[dev-dependencies]\ntest-local={path='crates/test-local'}\n[build-dependencies]\nbuild-local={path='crates/build-local'}\n",
		"crates/local/Cargo.toml":       "[package]\nname='local'\nversion='0.1.0'\n",
		"crates/test-local/Cargo.toml":  "[package]\nname='test-local'\nversion='0.1.0'\n",
		"crates/build-local/Cargo.toml": "[package]\nname='build-local'\nversion='0.1.0'\n",
	}
	detected := Recipe{DetectorVersion: DetectorVersion, Installs: []DetectedInstall{{Command: []string{"cargo", "fetch"}, Files: []string{"Cargo.toml"}}}}
	layer, inputs, err := dependencyRecipeDetected("tc", detected, fakeRepository(files))
	require.NoError(t, err)
	for name := range files {
		require.Equal(t, []byte(files[name]), inputs[name], name)
		require.Contains(t, layer.Nodes[0].Files, name)
	}
}

func TestDetectedNodePreparationSuppressesLifecycleHooks(t *testing.T) {
	for _, manager := range []string{"npm", "pnpm", "yarn", "bun"} {
		t.Run(manager, func(t *testing.T) {
			layer := dependencyLayer{DetectorVersion: DetectorVersion, Installs: []DetectedInstall{{Command: []string{manager, "install"}}}}
			require.Contains(t, layer.script(), "'"+manager+"' 'install' '--ignore-scripts'")
		})
	}
}

// Exercise npm itself with repository lifecycle hooks. Preparation must not
// bake hook effects; linking in the unprivileged checkout runs both hooks.
func TestDetectedNpmLifecycleHooksRunOnlyAtOfflineLink(t *testing.T) {
	_, err := exec.LookPath("npm")
	require.NoError(t, err)
	repo := t.TempDir()
	manifest := `{"name":"lifecycle-fixture","version":"1.0.0","scripts":{"postinstall":"node -e \"require('fs').appendFileSync('hooks.jsonl',JSON.stringify({hook:'postinstall',uid:process.getuid()})+'\\n')\"","prepare":"node -e \"require('fs').appendFileSync('hooks.jsonl',JSON.stringify({hook:'prepare',uid:process.getuid()})+'\\n')\""}}`
	require.NoError(t, os.WriteFile(filepath.Join(repo, "package.json"), []byte(manifest), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(repo, "package-lock.json"), []byte(`{"name":"lifecycle-fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"lifecycle-fixture","version":"1.0.0"}}}`), 0o644))
	layer := dependencyLayer{DetectorVersion: DetectorVersion, Installs: []DetectedInstall{{Command: []string{"npm", "ci"}, Offline: []string{"npm", "ci", "--offline"}}}}
	var prepare string
	for _, line := range strings.Split(layer.script(), "\n") {
		if strings.HasPrefix(line, "'npm' ") {
			prepare = line
		}
	}
	require.NotEmpty(t, prepare)
	command := exec.Command("/bin/sh", "-ec", prepare)
	command.Dir = repo
	output, err := command.CombinedOutput()
	require.NoError(t, err, string(output))
	_, err = os.Stat(filepath.Join(repo, "hooks.jsonl"))
	require.ErrorIs(t, err, fs.ErrNotExist, "preparation baked repository lifecycle effects")
	link := layer.link()
	command = exec.Command(link[0], link[1:]...)
	command.Dir = repo
	output, err = command.CombinedOutput()
	require.NoError(t, err, string(output))
	receipt, err := os.ReadFile(filepath.Join(repo, "hooks.jsonl"))
	require.NoError(t, err)
	lines := strings.Split(strings.TrimSpace(string(receipt)), "\n")
	require.Len(t, lines, 2)
	for i, hook := range []string{"postinstall", "prepare"} {
		var got struct {
			Hook string
			UID  int
		}
		require.NoError(t, json.Unmarshal([]byte(lines[i]), &got))
		require.Equal(t, hook, got.Hook)
		require.Equal(t, os.Getuid(), got.UID)
		require.NotZero(t, got.UID)
	}
}

func detectedTestEnvironment(t *testing.T, root string) map[string]string {
	t.Helper()
	env := (toolchainLayer{}).environment()
	for key, value := range env {
		env[key] = strings.ReplaceAll(value, cacheRoot, root)
	}
	return env
}

// A real wheel and pip process exercise the machine's exported environment:
// entry points must work by name after the offline install, including imports.
func TestDetectedPythonOfflineConsoleScriptRunsOnMachinePath(t *testing.T) {
	python, err := exec.LookPath("python3")
	require.NoError(t, err)
	cache := t.TempDir()
	wheels := filepath.Join(cache, "wheels")
	require.NoError(t, os.MkdirAll(wheels, 0o755))
	file, err := os.Create(filepath.Join(wheels, "fixture_cli-1.0.0-py3-none-any.whl"))
	require.NoError(t, err)
	archive := zip.NewWriter(file)
	for name, content := range map[string]string{
		"fixture_cli.py":                               "def main():\n    print('installed console script ran')\n",
		"fixture_cli-1.0.0.dist-info/METADATA":         "Metadata-Version: 2.1\nName: fixture-cli\nVersion: 1.0.0\n",
		"fixture_cli-1.0.0.dist-info/WHEEL":            "Wheel-Version: 1.0\nGenerator: smithers-test\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
		"fixture_cli-1.0.0.dist-info/entry_points.txt": "[console_scripts]\nfixture-cli = fixture_cli:main\n",
		"fixture_cli-1.0.0.dist-info/RECORD":           "",
	} {
		writer, err := archive.Create(name)
		require.NoError(t, err)
		_, err = writer.Write([]byte(content))
		require.NoError(t, err)
	}
	require.NoError(t, archive.Close())
	require.NoError(t, file.Close())
	bin := t.TempDir()
	require.NoError(t, os.Symlink(python, filepath.Join(bin, "python")))
	env := detectedTestEnvironment(t, cache)
	env["PATH"] = bin + ":" + env["PATH"] + ":" + os.Getenv("PATH")
	variables := os.Environ()
	for key, value := range env {
		variables = append(variables, key+"="+value)
	}
	layer := dependencyLayer{DetectorVersion: DetectorVersion, Installs: []DetectedInstall{{Offline: []string{"python", "-m", "pip", "install", "--no-index", "fixture-cli==1.0.0"}}}}
	link := layer.link()
	link[2] = strings.ReplaceAll(link[2], cacheRoot, cache)
	command := exec.Command(link[0], link[1:]...)
	command.Env = variables
	output, err := command.CombinedOutput()
	require.NoError(t, err, string(output))
	command = exec.Command("/bin/sh", "-ec", "fixture-cli")
	command.Env = variables
	output, err = command.CombinedOutput()
	require.NoError(t, err, string(output))
	require.Equal(t, "installed console script ran\n", string(output))
}

// A local backend wheel keeps this real-uv fixture offline. Preparation must
// cache build requirements as well as ordinary dependencies for a new checkout.
func TestDetectedUVPreparationCachesProjectBuildBackend(t *testing.T) {
	uv, err := exec.LookPath("uv")
	require.NoError(t, err)
	python, err := exec.LookPath("python3")
	require.NoError(t, err)
	root := t.TempDir()
	repo := filepath.Join(root, "repo")
	wheels := filepath.Join(root, "wheels")
	for _, directory := range []string{repo, wheels} {
		require.NoError(t, os.Mkdir(directory, 0o755))
	}
	backend := `import os, pathlib, zipfile

def build_wheel(wheel_directory, config_settings=None, metadata_directory=None):
    if os.getuid() == 0:
        raise RuntimeError("root build backend")
    if not pathlib.Path("src/fixture_project.py").exists():
        raise RuntimeError("project source is absent")
    pathlib.Path("build-uid").write_text(str(os.getuid()))
    name = "fixture_project-1.0.0-py3-none-any.whl"
    with zipfile.ZipFile(pathlib.Path(wheel_directory) / name, "w") as wheel:
        wheel.writestr("fixture_project.py", "VALUE = 42\n")
        wheel.writestr("fixture_project-1.0.0.dist-info/METADATA", "Metadata-Version: 2.1\nName: fixture-project\nVersion: 1.0.0\n")
        wheel.writestr("fixture_project-1.0.0.dist-info/WHEEL", "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n")
        wheel.writestr("fixture_project-1.0.0.dist-info/RECORD", "")
    return name
`
	wheelFile, err := os.Create(filepath.Join(wheels, "fixture_backend-1.0.0-py3-none-any.whl"))
	require.NoError(t, err)
	archive := zip.NewWriter(wheelFile)
	for name, content := range map[string]string{
		"fixture_backend.py":                       backend,
		"fixture_backend-1.0.0.dist-info/METADATA": "Metadata-Version: 2.1\nName: fixture-backend\nVersion: 1.0.0\n",
		"fixture_backend-1.0.0.dist-info/WHEEL":    "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
		"fixture_backend-1.0.0.dist-info/RECORD":   "",
	} {
		writer, err := archive.Create(name)
		require.NoError(t, err)
		_, err = writer.Write([]byte(content))
		require.NoError(t, err)
	}
	require.NoError(t, archive.Close())
	require.NoError(t, wheelFile.Close())
	project := "[project]\nname='fixture-project'\nversion='1.0.0'\nrequires-python='>=3.12'\n[build-system]\nrequires=['fixture-backend==1.0.0']\nbuild-backend='fixture_backend'\n"
	require.NoError(t, os.WriteFile(filepath.Join(repo, "pyproject.toml"), []byte(project), 0o644))
	detected := Recipe{DetectorVersion: DetectorVersion, Installs: []DetectedInstall{{Command: []string{"uv", "sync", "--no-editable"}, Offline: []string{uv, "sync", "--offline", "--no-editable"}, Files: []string{"pyproject.toml"}}}}
	layer, _, err := dependencyRecipeDetected("tc", detected, fakeRepository(map[string]string{"pyproject.toml": project}))
	require.NoError(t, err)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/fixture-backend/" {
			_, _ = fmt.Fprint(w, `<a href="/fixture_backend-1.0.0-py3-none-any.whl">fixture_backend-1.0.0-py3-none-any.whl</a>`)
			return
		}
		http.FileServer(http.Dir(wheels)).ServeHTTP(w, request)
	}))
	defer server.Close()
	variables := append(os.Environ(), "UV_CACHE_DIR="+filepath.Join(root, "cache"), "UV_PYTHON="+python, "UV_PYTHON_DOWNLOADS=never", "UV_INDEX_URL="+server.URL)
	var prepare string
	for _, line := range strings.Split(layer.script(), "\n") {
		if strings.HasPrefix(line, "'uv' ") {
			prepare += line + "\n"
		}
	}
	prepare = strings.ReplaceAll(prepare, cacheRoot+"/prepare", filepath.Join(root, "prepare"))
	// The guest toolchain supplies "python"; host fixtures use the discovered
	// python3 directly, without requiring a PATH alias.
	prepare = strings.ReplaceAll(prepare, "'--python' 'python'", "'--python' "+shellQuote(python))
	require.NotEmpty(t, prepare)
	command := exec.Command("/bin/sh", "-ec", prepare)
	command.Dir, command.Env = repo, variables
	output, err := command.CombinedOutput()
	require.NoError(t, err, string(output))
	_, err = os.Stat(filepath.Join(repo, "build-uid"))
	require.ErrorIs(t, err, fs.ErrNotExist, "preparation must leave project builds to the checkout")
	// A different workspace has no prepared virtualenv or checkout wheel.
	fresh := filepath.Join(root, "fresh")
	require.NoError(t, os.Mkdir(fresh, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(fresh, "pyproject.toml"), []byte(project), 0o644))
	require.NoError(t, os.Mkdir(filepath.Join(fresh, "src"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(fresh, "src", "fixture_project.py"), []byte("VALUE = 42\n"), 0o644))
	lock, err := os.ReadFile(filepath.Join(repo, "uv.lock"))
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(fresh, "uv.lock"), lock, 0o644))
	server.Close()
	require.NoError(t, os.RemoveAll(wheels))
	link := layer.link()
	command = exec.Command(link[0], link[1:]...)
	command.Dir, command.Env = fresh, variables
	output, err = command.CombinedOutput()
	require.NoError(t, err, string(output))
	command = exec.Command(filepath.Join(fresh, ".venv", "bin", "python"), "-c", "import fixture_project; print(fixture_project.VALUE)")
	output, err = command.CombinedOutput()
	require.NoError(t, err, string(output))
	require.Equal(t, "42\n", string(output))
	uid, err := os.ReadFile(filepath.Join(fresh, "build-uid"))
	require.NoError(t, err)
	require.Equal(t, fmt.Sprint(os.Getuid()), string(uid))
	require.NotZero(t, os.Getuid())
}

func TestDetectedLayersSelectOnlyRecipeToolsAndKeyEveryInput(t *testing.T) {
	detected, err := DetectRecipe(fakeRepository(map[string]string{".node-version": "22.14.0", "package.json": `{"packageManager":"pnpm@9.15.9"}`, "pnpm-lock.yaml": "lockfileVersion: '9.0'\n"}))
	require.NoError(t, err)
	tc, err := toolchainRecipeDetected("image", detected, []string{"libssl-dev"})
	require.NoError(t, err)
	require.Len(t, tc.Downloads, 2)
	require.Contains(t, tc.Downloads, "node")
	require.Contains(t, tc.Downloads, "pnpm")
	for _, tool := range []string{"go", "bun", "rust", "python", "jj"} {
		require.NotContains(t, tc.script(), "/var/tmp/dl/"+tool+".")
	}
	require.Contains(t, tc.systemScript(), `apt-get install -y -qq --no-install-recommends "$@"`)
	require.Equal(t, []string{"libssl-dev"}, tc.Packages)
	require.Contains(t, tc.allowlist(), "deb.debian.org")
	key, _, err := recipeKey("", tc)
	require.NoError(t, err)
	tc.DetectorVersion += "changed"
	changed, _, err := recipeKey("", tc)
	require.NoError(t, err)
	require.NotEqual(t, key, changed)
	tc.DetectorVersion = detected.DetectorVersion
	tc.Packages = []string{"libyaml-dev"}
	changed, _, err = recipeKey("", tc)
	require.NoError(t, err)
	require.NotEqual(t, key, changed)
	detected.Tools["node"] = DetectedTool{Version: "0.0.1", File: ".node-version"}
	_, err = toolchainRecipeDetected("image", detected, nil)
	var refusal *RecipeError
	require.ErrorAs(t, err, &refusal)
	require.Equal(t, "user", refusal.Class)
	require.Contains(t, err.Error(), ".node-version")
}

func TestDetectedDependencyInputsAndOfflineLink(t *testing.T) {
	files := map[string]string{"package.json": `{"packageManager":"pnpm@9.15.9"}`, "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters:\n  .:\n  packages/member:\npackages:\n", "packages/member/package.json": "{}", "go.mod": "module fixture\ngo 1.26.8\n", "go.sum": "first", "README.md": "first"}
	detected, err := DetectRecipe(fakeRepository(files))
	require.NoError(t, err)
	build := func() dependencyLayer {
		layer, inputs, err := dependencyRecipeDetected("tc", detected, fakeRepository(files))
		require.NoError(t, err)
		require.Contains(t, inputs, "packages/member/package.json")
		require.Equal(t, []byte(files["go.sum"]), inputs["go.sum"])
		return layer
	}
	layer := build()
	require.Len(t, layer.Nodes, 2)
	require.Equal(t, []string{"pnpm", "install", "--offline", "--frozen-lockfile"}, layer.link())
	require.Contains(t, layer.script(), "GOPROXY=https://proxy.golang.org GOFLAGS=-mod=mod 'go' 'mod' 'download'")
	original, _, err := recipeKey("tc", layer)
	require.NoError(t, err)
	files["README.md"] = "second"
	key, _, err := recipeKey("tc", build())
	require.NoError(t, err)
	require.Equal(t, original, key)
	files["go.sum"] = "second"
	key, _, err = recipeKey("tc", build())
	require.NoError(t, err)
	require.NotEqual(t, original, key)
	files["go.sum"] = "first"
	files["packages/member/package.json"] = `{"name":"changed"}`
	key, _, err = recipeKey("tc", build())
	require.NoError(t, err)
	require.NotEqual(t, original, key)
	layer.DetectorVersion += "second"
	key, _, err = recipeKey("tc", layer)
	require.NoError(t, err)
	require.NotEqual(t, original, key)
}

func TestDetectedInstallCommandsQuoteArgumentsAndComposeOffline(t *testing.T) {
	layer := dependencyLayer{DetectorVersion: DetectorVersion, Installs: []DetectedInstall{{Command: []string{"pnpm", "install", "$(touch /bad)"}, Offline: []string{"pnpm", "install", "--offline"}}, {Command: []string{"uv", "sync"}, Offline: []string{"uv", "sync", "--offline"}}}}
	require.Contains(t, layer.script(), "'pnpm' 'install' '$(touch /bad)'")
	require.Equal(t, []string{"/bin/sh", "-ec", "'pnpm' 'install' '--offline'\n'uv' 'sync' '--offline'"}, layer.link())
	layer.Installs = []DetectedInstall{{Command: []string{"go", "mod", "download"}}}
	require.Nil(t, layer.link())
}

func TestDetectedDependencyRefusesUnsafeInputsAndPreservesReadErrors(t *testing.T) {
	for _, name := range []string{"../escape", "/absolute", "", "a/../b"} {
		detected := Recipe{DetectorVersion: DetectorVersion, Installs: []DetectedInstall{{Files: []string{name}}}}
		_, inputs, err := dependencyRecipeDetected("tc", detected, func(string) ([]byte, bool, error) { t.Fatal("unsafe file reached reader"); return nil, false, nil })
		require.Error(t, err)
		require.Nil(t, inputs)
	}
	failure := &fs.PathError{Op: "read", Path: "go.sum", Err: fs.ErrPermission}
	detected := Recipe{DetectorVersion: DetectorVersion, Installs: []DetectedInstall{{Command: []string{"go", "mod", "download"}}}}
	_, inputs, err := dependencyRecipeDetected("tc", detected, func(string) ([]byte, bool, error) { return nil, false, failure })
	require.ErrorIs(t, err, failure)
	require.Nil(t, inputs)
	detected.Installs[0].Destinations = []string{"bad host"}
	_, _, err = dependencyRecipeDetected("tc", detected, fakeRepository(nil))
	require.ErrorContains(t, err, "invalid network destination")
}

type revisionLayerReader struct {
	branchFiles map[string]string
	files       map[string]string
	reads       map[string][]string
	mainErr     error
}

func (r *revisionLayerReader) ResolveSourceRevision(_ context.Context, _ string, rev string) (string, error) {
	if rev == "main" {
		return strings.Repeat("b", 40), r.mainErr
	}
	return strings.Repeat("a", 40), nil
}
func (r *revisionLayerReader) ReadSourceFile(_ context.Context, source workspaceapi.WorkspaceSource, name string) ([]byte, error) {
	r.reads[name] = append(r.reads[name], source.Revision)
	content, ok := r.files[name]
	if source.Revision == strings.Repeat("a", 40) && r.branchFiles != nil {
		content, ok = r.branchFiles[name]
	}
	if !ok {
		return nil, fs.ErrNotExist
	}
	return []byte(content), nil
}

func TestDetectedLayerResolutionBaseOnlyMainAndIndexPrecedence(t *testing.T) {
	for _, raw := range []string{"", "[]", "null", "{"} {
		t.Run(raw, func(t *testing.T) {
			reader := &revisionLayerReader{files: map[string]string{}, reads: map[string][]string{}}
			if raw != "" {
				reader.files[targetIndexPath] = raw
				reader.files["package.json"] = `{"packageManager":"unknown@1.0.0"}`
			}
			runtime := &Runtime{}
			runtime.environments = &environments{runtime: runtime}
			runtime.BindSourceFiles(reader)
			layer, err := runtime.ResolveWorkspaceLayer(t.Context(), workspaceapi.WorkspaceSpec{Source: &workspaceapi.WorkspaceSource{Repository: "fixture", Revision: "branch"}})
			require.Equal(t, Layer{}, layer)
			if raw == "" {
				require.NoError(t, err)
				require.Equal(t, []string{strings.Repeat("b", 40)}, reader.reads[".smithers/machine.json"])
			} else {
				require.ErrorContains(t, err, targetIndexPath)
				require.NotContains(t, reader.reads, "package.json", "present index must never invoke detection")
			}
		})
	}
	reader := &revisionLayerReader{files: map[string]string{}, reads: map[string][]string{}, mainErr: errors.New("mirror missing main")}
	runtime := &Runtime{}
	runtime.environments = &environments{runtime: runtime}
	runtime.BindSourceFiles(reader)
	_, err := runtime.ResolveWorkspaceLayer(t.Context(), workspaceapi.WorkspaceSpec{Source: &workspaceapi.WorkspaceSource{Repository: "fixture", Revision: "branch"}})
	require.ErrorIs(t, err, reader.mainErr)
}

func TestDetectedDependencyCollectsMemberManifestsAtRevision(t *testing.T) {
	for _, fixture := range []struct {
		command string
		files   map[string]string
		members []string
	}{
		{"cargo", map[string]string{"Cargo.toml": "[workspace]\nmembers = [\"crates/*\"]\n", "crates/*/Cargo.toml": `{"crates/a/Cargo.toml":"[package]\nname='a'\nversion='0.1.0'\n"}`}, []string{"crates/a/Cargo.toml"}},
		{"npm", map[string]string{"package.json": `{"workspaces":["packages/*"]}`, "packages/*/package.json": `{"packages/a/package.json":"{\"name\":\"a\"}"}`}, []string{"packages/a/package.json"}},
		{"yarn", map[string]string{"package.json": `{"workspaces":{"packages":["packages/a"]}}`, "packages/a/package.json": `{"name":"a"}`}, []string{"packages/a/package.json"}},
	} {
		t.Run(fixture.command, func(t *testing.T) {
			manifest := "package.json"
			if fixture.command == "cargo" {
				manifest = "Cargo.toml"
			}
			detected := Recipe{DetectorVersion: DetectorVersion, Installs: []DetectedInstall{{Command: []string{fixture.command, "install"}, Files: []string{manifest}}}}
			layer, inputs, err := dependencyRecipeDetected("tc", detected, fakeRepository(fixture.files))
			require.NoError(t, err)
			for _, member := range fixture.members {
				require.Contains(t, inputs, member)
				require.Contains(t, layer.Nodes[0].Files, member)
			}
			if fixture.command == "cargo" {
				require.Contains(t, layer.script(), "find . -name Cargo.toml")
			}
		})
	}
	bad := Recipe{DetectorVersion: DetectorVersion, Installs: []DetectedInstall{{Command: []string{"cargo", "fetch"}, Files: []string{"Cargo.toml"}}}}
	for _, raw := range []string{"{", `{"outside/Cargo.toml":"evil"}`} {
		_, _, err := dependencyRecipeDetected("tc", bad, fakeRepository(map[string]string{"Cargo.toml": "[workspace]\nmembers=['crates/*']\n", "crates/*/Cargo.toml": raw}))
		require.Error(t, err)
	}
}

func TestDetectedToolScriptsInstallPinnedLanguagesAndExternalCaches(t *testing.T) {
	for _, tool := range []string{"npm", "yarn", "bun", "go", "rust", "python", "uv"} {
		t.Run(tool, func(t *testing.T) {
			layer, err := toolchainRecipeDetected("image", Recipe{DetectorVersion: DetectorVersion, Tools: map[string]DetectedTool{tool: {Version: defaultToolVersion(tool), File: "manifest"}}}, nil)
			require.NoError(t, err)
			require.Contains(t, layer.script(), layer.Downloads[tool].SHA256)
			require.Contains(t, layer.script(), layer.Downloads[tool].URL)
			if tool == "rust" {
				require.Contains(t, layer.script(), "--prefix=$T/rust")
				require.NotContains(t, layer.script(), "rustup-init")
			}

			require.Contains(t, layer.environment()["npm_config_cache"], "/var/cache/smithers/npm")
			require.Contains(t, layer.environment()["npm_config_store_dir"], "/var/cache/smithers/pnpm-store")
			require.Contains(t, layer.environment()["PIP_TARGET"], "/var/cache/smithers/python-site")
		})
	}
	layer := dependencyLayer{DetectorVersion: DetectorVersion, Installs: []DetectedInstall{{Command: []string{"python", "-m", "pip", "install", "-r", "requirements.txt"}, Offline: []string{"python", "-m", "pip", "install", "--no-index", "-r", "requirements.txt"}}, {Command: []string{"uv", "sync", "--frozen"}, Offline: []string{"uv", "sync", "--offline", "--frozen"}}}}
	require.Contains(t, layer.script(), `python -m pip wheel --wheel-dir "$PIP_FIND_LINKS" '-r' 'requirements.txt'`)
	require.Contains(t, layer.script(), "'uv' 'sync' '--frozen' --no-install-project")
	require.Contains(t, layer.link()[2], "'uv' 'sync' '--offline' '--frozen'")
	require.Contains(t, layer.link()[2], "rm -rf '/var/cache/smithers/python-site'; mkdir -p '/var/cache/smithers/python-site'")
	require.NotContains(t, layer.script(), "'python' '-m' 'pip' 'install'")
}

// This unit executable records pip's invocation so the test isolates link
// ordering and stale-site recovery, without running a package installer.
func TestDetectedPythonOfflineLinkClearsSiteButRetainsWheelCache(t *testing.T) {
	root := t.TempDir()
	cache := filepath.Join(root, "cache")
	site := filepath.Join(cache, "python-site")
	wheels := filepath.Join(cache, "wheels")
	bin := filepath.Join(root, "bin")
	for _, directory := range []string{site, wheels, bin} {
		require.NoError(t, os.MkdirAll(directory, 0o755))
	}
	require.NoError(t, os.WriteFile(filepath.Join(wheels, "wheel.whl"), []byte("retained"), 0o644))
	stub := `#!/bin/sh
set -eu
[ -d "$PIP_TARGET" ]
[ ! -e "$PIP_TARGET/obsolete.py" ]
printf '%s' "$*" > "$PIP_TARGET/installed"
`
	require.NoError(t, os.WriteFile(filepath.Join(bin, "python"), []byte(stub), 0o755))
	layer := dependencyLayer{DetectorVersion: DetectorVersion, Installs: []DetectedInstall{{Offline: []string{"python", "-m", "pip", "install", "--no-index", "-r", "requirements.txt"}}}}
	link := layer.link()
	require.Equal(t, "/bin/sh", link[0])
	link[2] = strings.ReplaceAll(link[2], cacheRoot, cache)
	for attempt := 0; attempt < 2; attempt++ {
		require.NoError(t, os.WriteFile(filepath.Join(site, "obsolete.py"), []byte("stale dependency"), 0o644))
		command := exec.Command(link[0], link[1:]...)
		command.Env = []string{"PATH=" + bin + ":/usr/bin:/bin", "PIP_TARGET=" + site}
		output, err := command.CombinedOutput()
		require.NoError(t, err, string(output))
		_, err = os.Stat(filepath.Join(site, "obsolete.py"))
		require.ErrorIs(t, err, fs.ErrNotExist)
		receipt, err := os.ReadFile(filepath.Join(site, "installed"))
		require.NoError(t, err)
		require.Equal(t, "-m pip install --no-index -r requirements.txt", string(receipt))
		cached, err := os.ReadFile(filepath.Join(wheels, "wheel.whl"))
		require.NoError(t, err)
		require.Equal(t, "retained", string(cached))
	}
}

// M-29 and security fix #3439: unreviewed index bytes must never reach preparation.
func TestToolchainIndexIgnoresAttackerBranch(t *testing.T) {
	mainRow := toolchainRow()
	mainBytes, err := json.Marshal([]any{mainRow})
	require.NoError(t, err)
	attacker := toolchainRow()
	attacker["destinations"] = []string{"attacker.example"}
	for _, pin := range attacker["toolchain"].(map[string]any)["downloads"].(map[string]any) {
		p := pin.(map[string]string)
		p["url"] = "https://attacker.example/root"
		p["sha256"] = strings.Repeat("f", 64)
		p["destination"] = "/usr/bin"
	}
	branchBytes, err := json.Marshal([]any{attacker})
	require.NoError(t, err)
	reader := &revisionLayerReader{files: map[string]string{targetIndexPath: string(mainBytes)}, branchFiles: map[string]string{targetIndexPath: string(branchBytes)}, reads: map[string][]string{}}
	root := t.TempDir()
	log := filepath.Join(root, "requests")
	binary := filepath.Join(root, "msb")
	// Unit transport records requests; real VM authority is checked separately.
	require.NoError(t, os.WriteFile(binary, []byte(fmt.Sprintf(`#!/bin/sh
case "$*" in
 *run\ exec\ *) cat >> %s; printf '\n' >> %s; printf '\000SMITHERS-EXIT 0\000' >&2 ;;
 *run\ root-recipe*) cat >/dev/null; printf '\000SMITHERS-EXIT 0\000' >&2 ;;
 "snapshot list --format json") echo '[]' ;;
esac
`, shellQuote(log), shellQuote(log))), 0755))
	runtime := &Runtime{config: Config{CPUs: 2, MemoryMiB: 2048, DiskMiB: 8192, MaxRunningVMs: 1}, root: root, owner: "smithers-backend-0123456789abcdef", cli: &cli{binary: binary, home: root}}
	runtime.environments = &environments{runtime: runtime, config: EnvironmentConfig{Image: DefaultImage, PrepareCPUs: 2, PrepareMemoryMiB: 2048, PrepareTimeout: time.Minute}}
	require.NoError(t, os.MkdirAll(runtime.microsandboxHome(), 0o700))
	runtime.BindSourceFiles(reader)
	_, resolveErr := runtime.ResolveWorkspaceLayer(t.Context(), workspaceapi.WorkspaceSpec{Source: &workspaceapi.WorkspaceSource{Repository: "fixture", Revision: "branch"}})
	require.ErrorContains(t, resolveErr, "does not hold what was prepared", "fake intentionally supplies no snapshot; preparation must have completed")
	require.Equal(t, []string{strings.Repeat("b", 40)}, reader.reads[targetIndexPath])
	requests, err := os.ReadFile(log)
	require.NoError(t, err)
	require.Contains(t, string(requests), "https://nodejs.org/26.5.0")
	require.NotContains(t, string(requests), "attacker.example")
}

// Dispatch security gate: branch bytes cross only the agent boundary. The CLI
// fake observes transport, while a real npm process tests lifecycle suppression.
func TestBranchDependencyInputsOnlyReachAgentWithScriptsDisabled(t *testing.T) {
	if _, err := exec.LookPath("npm"); err != nil {
		t.Skip("npm is absent: dependency lifecycle-script isolation requires the real npm executable")
	}
	root := t.TempDir()
	log := filepath.Join(root, "calls")
	binary := filepath.Join(root, "msb")
	require.NoError(t, os.WriteFile(binary, []byte(fmt.Sprintf(`#!/bin/sh
printf '%%s\n' "$*" >> %s
case "$*" in
 *run\ exec\ *) cat >> %s; printf '\n' >> %s; printf '\000SMITHERS-EXIT 0\000' >&2 ;;
 *run\ root-recipe*) cat >> %s; printf '\n' >> %s; printf '\000SMITHERS-EXIT 0\000' >&2 ;;
 *) cat >/dev/null ;;
esac
`, shellQuote(log), shellQuote(log), shellQuote(log), shellQuote(log), shellQuote(log))), 0755))
	manifest := []byte(`{"name":"hostile","version":"1.0.0","scripts":{"install":"touch ROOT-INSTALL","postinstall":"touch ROOT-POSTINSTALL"}}`)
	runtime := &Runtime{config: Config{CPUs: 2, MemoryMiB: 2048, DiskMiB: 8192, MaxRunningVMs: 1}, root: root, owner: "smithers-backend-0123456789abcdef", cli: &cli{binary: binary, home: root}}
	env := environments{runtime: runtime, config: EnvironmentConfig{Image: DefaultImage, PrepareCPUs: 2, PrepareMemoryMiB: 2048, PrepareTimeout: time.Minute}}
	layer := dependencyLayer{DetectorVersion: DetectorVersion, Installs: []DetectedInstall{{Command: []string{"npm", "install", "--package-lock=false"}}}}
	_, err := env.buildLayer(t.Context(), layerRecord{Kind: layerDependency, Key: strings.Repeat("a", 64), Name: "fixture"}, layer, "warm", map[string][]byte{"package.json": manifest})
	require.NoError(t, err)
	body, err := os.ReadFile(log)
	require.NoError(t, err)
	require.NotContains(t, string(body), "-- sh -c", "raw root planting is forbidden")
	found := false
	for _, line := range strings.Split(string(body), "\n") {
		if !strings.HasPrefix(line, "{") {
			continue
		}
		var request execRequest
		require.NoError(t, json.Unmarshal([]byte(line), &request))
		if len(request.Argv) < 3 {
			var rootRequest map[string]any
			require.NoError(t, json.Unmarshal([]byte(line), &rootRequest))
			require.Equal(t, rootSyncScript, rootRequest["script"])
			require.NotContains(t, rootRequest, "marker")
			continue
		}
		if strings.Contains(request.Argv[2], base64.StdEncoding.EncodeToString(manifest)) {
			found = true
			require.Equal(t, guestUser, request.User)
		}
		if strings.Contains(request.Argv[2], "'npm' 'install'") {
			require.Equal(t, guestUser, request.User)
			require.Contains(t, request.Argv[2], "--ignore-scripts")
		}
	}
	require.True(t, found, "manifest must be planted inside agent exec")
	npm, err := exec.LookPath("npm")
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(root, "package.json"), manifest, 0600))
	cmd := exec.Command(npm, "install", "--package-lock=false", "--ignore-scripts", "--offline", "--no-audit", "--no-fund")
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "npm_config_cache="+filepath.Join(root, "npm-cache"))
	output, err := cmd.CombinedOutput()
	require.NoError(t, err, string(output))
	for _, name := range []string{"ROOT-INSTALL", "ROOT-POSTINSTALL"} {
		_, err = os.Stat(filepath.Join(root, name))
		require.True(t, os.IsNotExist(err), name)
	}
}

func TestToolchainWriteTimeDestinationRefusalIsTyped(t *testing.T) {
	root := t.TempDir()
	binary := filepath.Join(root, "msb")
	// Mock only the unavailable VM transport; the real write boundary is tested
	// by TestToolchainDestinationConfinesActualWrite using real filesystem calls.
	require.NoError(t, os.WriteFile(binary, []byte("#!/bin/sh\ncat >/dev/null\necho invalid_download_destination >&2\nprintf '\\000SMITHERS-EXIT 3\\000' >&2\n"), 0700))
	env := environments{runtime: &Runtime{cli: &cli{binary: binary, home: root}}}
	_, err := env.runRecipe(t.Context(), "machine", "branch-independent-toolchain-script", guestUser, guestHome)
	var refusal *RecipeError
	require.ErrorAs(t, err, &refusal)
	require.Equal(t, "invalid_download_destination", refusal.Code)
	require.Equal(t, "user", refusal.Class)
}

func TestLayerCompletedBuildSurvivesCapacityRefusal(t *testing.T) {
	root := t.TempDir()
	artifact := filepath.Join(root, ".microsandbox", "snapshot")
	require.NoError(t, os.MkdirAll(artifact, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(artifact, "disk"), []byte(strings.Repeat("x", 8192)), 0o644))
	layer := dependencyLayer{DetectorVersion: DetectorVersion}
	key, _, err := recipeKey("", layer)
	require.NoError(t, err)
	runtime := &Runtime{config: Config{CPUs: 2, MemoryMiB: 2048, DiskMiB: 8192, MaxRunningVMs: 1}, root: root, owner: "smithers-backend-0123456789abcdef", workspaces: map[string]*workspace{}}
	env := environments{runtime: runtime, config: EnvironmentConfig{Image: DefaultImage, PrepareTimeout: time.Minute, KeepPerFamily: 1}}
	name := env.layerName(layerDependency, key)
	state := filepath.Join(root, "snapshot-created")
	removals := filepath.Join(root, "removals")
	binary := filepath.Join(root, "msb")
	listing, err := json.Marshal([]map[string]string{{"name": name, "artifact_path": artifact}})
	require.NoError(t, err)
	marker, err := json.Marshal(map[string]string{"kind": layerDependency, "key": key})
	require.NoError(t, err)
	script := fmt.Sprintf(`#!/bin/sh
request=""
case "$*" in *run\ exec*) request=$(cat); printf '\000SMITHERS-EXIT 0\000' >&2 ;; esac
case "$* $request" in
  remove\ *) echo "$*" >> %s ;;
  "snapshot list --format json ") if [ -e %s ]; then printf '%%s' %s; else echo '[]'; fi ;;
  "snapshot create "*) touch %s ;;
  "snapshot remove "*) rm %s ;;
  *"cat "*) printf '%%s' %s ;;
  *run\ root-recipe*|*run\ exec*) :; printf '\000SMITHERS-EXIT 0\000' >&2 ;;

esac
`, shellQuote(removals), shellQuote(state), shellQuote(string(listing)), shellQuote(state), shellQuote(state), shellQuote(string(marker)))
	require.NoError(t, os.WriteFile(binary, []byte(script), 0o755))
	runtime.cli = &cli{binary: binary, home: root}
	// spec §8.2.2: a different machine can take capacity between build and verify.
	runtime.SetCapacityReader(func(context.Context) (int, error) {
		if _, err := os.Stat(state); err == nil {
			return 0, nil
		}
		return 1, nil
	})
	_, err = env.ensure(t.Context(), layerDependency, layer, "", "fixture", nil, false)
	require.ErrorContains(t, err, "capacity reached")
	require.FileExists(t, state)
	require.FileExists(t, env.recordPath(name))
	runtime.SetCapacityReader(nil)
	record, err := env.ensure(t.Context(), layerDependency, layer, "", "fixture", nil, false)
	require.NoError(t, err)
	require.Equal(t, name, record.Name)
	removed, err := os.ReadFile(removals)
	require.NoError(t, err)
	require.Len(t, strings.Split(strings.TrimSpace(string(removed)), "\n"), 2, "prepare and verification each have one confirmed cleanup")
	require.Zero(t, runtime.InUse())
	_, err = os.Stat(state)
	require.NoError(t, err, "ensure returned a snapshot it already evicted")
	_, err = os.Stat(env.recordPath(name))
	require.NoError(t, err)
	// Once handed back and no workspace references it, the cache may evict it.
	report, err := env.collect(t.Context())
	require.NoError(t, err)
	require.Equal(t, []string{name}, report.Removed)
}

// Pause at the internal resolve/create handoff while a concurrent collector
// applies pressure. No workspace references the returned snapshot yet.

func dependencyRecipeDetected(key string, evidence Recipe, read func(string) ([]byte, bool, error)) (dependencyLayer, map[string][]byte, error) {
	return dependencyRecipe(key, nil, read, evidence)
}
func toolchainRecipeDetected(image string, evidence Recipe, packages []string) (toolchainLayer, error) {
	layer, err := toolchainRecipe(image, nil, evidence)
	layer.Packages = sortedCopy(packages)
	return layer, err
}

// An index remains authoritative even if a caller also supplies evidence.
func TestCanonicalRecipesKeepIndexPrecedence(t *testing.T) {
	row := toolchainRow()
	body, err := json.Marshal([]any{row})
	require.NoError(t, err)
	targets, err := readTargetIndex(fakeRepository(map[string]string{targetIndexPath: string(body)}))
	require.NoError(t, err)
	poison := Recipe{DetectorVersion: "untrusted", Tools: map[string]DetectedTool{"node": {Version: "invalid", File: ".node-version"}}, Installs: []DetectedInstall{{Destinations: []string{"bad host"}}}}
	expected, err := toolchainRecipe("image", targets)
	require.NoError(t, err)
	actual, err := toolchainRecipe("image", targets, poison)
	require.NoError(t, err)
	require.Equal(t, expected, actual)
	expectedKey, _, err := recipeKey("", expected)
	require.NoError(t, err)
	actualKey, _, err := recipeKey("", actual)
	require.NoError(t, err)
	require.Equal(t, expectedKey, actualKey)
	want, wantInputs, err := dependencyRecipe("tc", targets, fakeRepository(nil))
	require.NoError(t, err)
	got, gotInputs, err := dependencyRecipe("tc", targets, fakeRepository(nil), poison)
	require.NoError(t, err)
	require.Equal(t, want, got)
	require.Equal(t, wantInputs, gotInputs)
	for _, invalid := range [][]indexTarget{{}} {
		_, err := toolchainRecipe("image", invalid, poison)
		require.ErrorContains(t, err, "exactly one")
	}
}

// T-INS-06 R4 (C4): a dependency build warm-starts only from the toolchain
// layer or a main-built dependency layer of the same repository, never from a
// branch-built one, whose caches could carry one member's build outputs into
// main's and other members' machines.
func TestLayerWarmParentIsMainBuilt(t *testing.T) {
	tcKey := strings.Repeat("c", 64)
	branchKey, mainKey := strings.Repeat("d", 64), strings.Repeat("e", 64)
	for _, test := range []struct {
		name         string
		mainL2, main bool
		want         string
	}{
		{name: "main build beside a branch layer boots the toolchain", main: true, want: "toolchain"},
		{name: "second branch boots main's layer", mainL2: true, want: "main"},
		{name: "main build boots main's layer", mainL2: true, main: true, want: "main"},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			artifact := filepath.Join(root, ".microsandbox", "snapshot")
			require.NoError(t, os.MkdirAll(artifact, 0o755))
			runtime := &Runtime{config: Config{CPUs: 2, MemoryMiB: 2048, DiskMiB: 8192, MaxRunningVMs: 1}, root: root, owner: "smithers-backend-0123456789abcdef", workspaces: map[string]*workspace{}}
			env := &environments{runtime: runtime, verified: map[string]bool{}, config: EnvironmentConfig{Image: DefaultImage, PrepareCPUs: 2, PrepareMemoryMiB: 2048, PrepareTimeout: time.Minute, KeepPerFamily: 8}}
			names := map[string]string{"toolchain": env.layerName(layerToolchain, tcKey), "branch": env.layerName(layerDependency, branchKey), "main": env.layerName(layerDependency, mainKey)}
			now := time.Now().UTC()
			records := []layerRecord{
				{Schema: layerSchema, Kind: layerToolchain, Key: tcKey, Name: names["toolchain"], Repository: "fixture", Main: true, CreatedAt: now.Add(-2 * time.Hour)},
				// The branch layer is the newest sibling: only its Main bit keeps it out.
				{Schema: layerSchema, Kind: layerDependency, Key: branchKey, ParentKey: tcKey, Name: names["branch"], Repository: "fixture", CreatedAt: now},
			}
			if test.mainL2 {
				records = append(records, layerRecord{Schema: layerSchema, Kind: layerDependency, Key: mainKey, ParentKey: tcKey, Name: names["main"], Repository: "fixture", Main: true, CreatedAt: now.Add(-time.Hour)})
			}
			layer := dependencyLayer{DetectorVersion: DetectorVersion, Installs: []DetectedInstall{{Command: []string{"pnpm", "install", "--frozen-lockfile"}}}}
			key, _, err := recipeKey(tcKey, layer)
			require.NoError(t, err)
			built := env.layerName(layerDependency, key)
			require.NoError(t, os.MkdirAll(env.layerDir(), 0o700))
			listing := []map[string]string{{"name": built, "artifact_path": artifact}}
			for _, record := range records {
				require.NoError(t, writeJSON(env.recordPath(record.Name), record))
				env.verified[record.Name] = true
				listing = append(listing, map[string]string{"name": record.Name, "artifact_path": artifact})
			}
			encoded, err := json.Marshal(listing)
			require.NoError(t, err)
			marker, err := json.Marshal(map[string]string{"kind": layerDependency, "key": key})
			require.NoError(t, err)
			calls := filepath.Join(root, "calls")
			binary := filepath.Join(root, "msb")
			require.NoError(t, os.WriteFile(binary, []byte(fmt.Sprintf(`#!/bin/sh
printf '%%s\n' "$*" >> %s
case "$*" in
  "snapshot list --format json") printf '%%s' %s ;;
  *smthrs-vfy-*run\ exec\ *) cat >/dev/null; printf '%%s' %s; printf '\000SMITHERS-EXIT 0\000' >&2 ;;
  *run\ exec\ *|*run\ root-recipe*) cat >/dev/null; printf '\000SMITHERS-EXIT 0\000' >&2 ;;
esac
`, shellQuote(calls), shellQuote(string(encoded)), shellQuote(string(marker)))), 0o755))
			runtime.cli = &cli{binary: binary, home: root}
			record, err := env.ensure(t.Context(), layerDependency, layer, tcKey, "fixture", nil, test.main)
			require.NoError(t, err)
			require.Equal(t, test.main, record.Main)
			saved, err := env.readRecord(built)
			require.NoError(t, err)
			require.Equal(t, test.main, saved.Main, "the durable record keeps who the layer was built for")
			log, err := os.ReadFile(calls)
			require.NoError(t, err)
			var parents []string
			for _, line := range strings.Split(string(log), "\n") {
				if fields := strings.Fields(line); len(fields) > 2 && fields[0] == "run" && fields[1] == "--from-snapshot" && strings.Contains(line, "smthrs-prep-") {
					parents = append(parents, fields[2])
				}
			}
			require.Equal(t, []string{names[test.want]}, parents)
			require.NotContains(t, string(log), "--from-snapshot "+names["branch"])
		})
	}
}

package microsandbox

import (
	"archive/zip"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

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
			binary := filepath.Join(root, "msb")
			script := fmt.Sprintf(`#!/bin/sh
case "$*" in
  *run\ root-recipe*) cat >/dev/null; printf '\000SMITHERS-EXIT 0\000' >&2 ;;
  *run\ exec\ *) cat >> %s; printf '\n' >> %s; printf '\000SMITHERS-EXIT 0\000' >&2 ;;
esac
`, shellQuote(log), shellQuote(log))
			require.NoError(t, os.WriteFile(binary, []byte(script), 0o755))
			runtime := &Runtime{root: root, owner: "smithers-backend-0123456789abcdef", cli: &cli{binary: binary, home: root}}
			env := environments{runtime: runtime, config: EnvironmentConfig{PrepareTimeout: time.Minute}}
			var layer recipe = dependencyLayer{DetectorVersion: DetectorVersion, Installs: []DetectedInstall{{Command: command}}}
			if command[0] == "toolchain" {
				layer = toolchainLayer{Downloads: map[string]download{"node": {Version: "22.14.0", URL: "https://nodejs.org/main", SHA256: strings.Repeat("a", 64)}}, Packages: []string{"libssl-dev"}}
			}
			_, err := env.buildLayer(t.Context(), layerRecord{Kind: layerDependency, Key: strings.Repeat("a", 64), Name: "layer-fixture"}, layer, "", nil)
			require.NoError(t, err)
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
	runtime := &Runtime{root: root, owner: "smithers-backend-0123456789abcdef", workspaces: map[string]*workspace{}}
	env := environments{runtime: runtime, config: EnvironmentConfig{PrepareTimeout: time.Minute, KeepPerFamily: 1}}
	name := env.layerName(layerDependency, key)
	state := filepath.Join(root, "snapshot-created")
	binary := filepath.Join(root, "msb")
	listing, err := json.Marshal([]map[string]string{{"name": name, "artifact_path": artifact}})
	require.NoError(t, err)
	marker, err := json.Marshal(map[string]string{"kind": layerDependency, "key": key})
	require.NoError(t, err)
	script := fmt.Sprintf(`#!/bin/sh
case "$*" in
  "snapshot list --format json") if [ -e %s ]; then printf '%%s' %s; else echo '[]'; fi ;;
  "snapshot create "*) touch %s ;;
  "snapshot remove "*) rm %s ;;
  *smthrs-vfy-*run\ exec\ *) cat >/dev/null; printf '%%s' %s; printf '\000SMITHERS-EXIT 0\000' >&2 ;;
  *run\ exec\ *|*run\ root-recipe*) cat >/dev/null; printf '\000SMITHERS-EXIT 0\000' >&2 ;;
esac
`, shellQuote(state), shellQuote(string(listing)), shellQuote(state), shellQuote(state), shellQuote(string(marker)))
	require.NoError(t, os.WriteFile(binary, []byte(script), 0o755))
	runtime.cli = &cli{binary: binary, home: root}
	record, err := env.ensure(t.Context(), layerDependency, layer, "", "fixture", nil)
	require.NoError(t, err)
	require.Equal(t, name, record.Name)
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
			tc, err := detectedToolchainRecipe("", detected, nil)
			require.NoError(t, err)
			tcKey, _, err := recipeKey("", tc)
			require.NoError(t, err)
			runtime := &Runtime{root: root, owner: "smithers-backend-0123456789abcdef", workspaces: map[string]*workspace{}}
			env := &environments{runtime: runtime, verified: map[string]bool{}, config: EnvironmentConfig{KeepPerFamily: 1}}
			runtime.environments = env
			runtime.BindSourceFiles(&revisionLayerReader{files: files, reads: map[string][]string{}})
			records := []layerRecord{{Schema: layerSchema, Kind: layerToolchain, Key: tcKey, Name: env.layerName(layerToolchain, tcKey)}}
			if dependencies {
				dp, _, err := detectedDependencyRecipe(tcKey, detected, fakeRepository(files))
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
	runtime := &Runtime{root: root, owner: "smithers-backend-0123456789abcdef", cli: &cli{binary: binary, home: root}, workspaces: map[string]*workspace{}}
	env := environments{runtime: runtime, config: EnvironmentConfig{MinFreeBytes: 1 << 62, KeepPerFamily: 1}}
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
	runtime := &Runtime{root: root, owner: "smithers-backend-0123456789abcdef", cli: &cli{binary: binary, home: root}, workspaces: map[string]*workspace{}}
	env := environments{runtime: runtime, config: EnvironmentConfig{MinFreeBytes: 1 << 62, KeepPerFamily: 1}}
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
	layer, inputs, err := detectedDependencyRecipe("tc", detected, fakeRepository(files))
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
	layer, _, err := detectedDependencyRecipe("tc", detected, fakeRepository(map[string]string{"pyproject.toml": project}))
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
	tc, err := detectedToolchainRecipe("image", detected, []string{"libssl-dev"})
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
	_, err = detectedToolchainRecipe("image", detected, nil)
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
		layer, inputs, err := detectedDependencyRecipe("tc", detected, fakeRepository(files))
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
		_, inputs, err := detectedDependencyRecipe("tc", detected, func(string) ([]byte, bool, error) { t.Fatal("unsafe file reached reader"); return nil, false, nil })
		require.Error(t, err)
		require.Nil(t, inputs)
	}
	failure := &fs.PathError{Op: "read", Path: "go.sum", Err: fs.ErrPermission}
	detected := Recipe{DetectorVersion: DetectorVersion, Installs: []DetectedInstall{{Command: []string{"go", "mod", "download"}}}}
	_, inputs, err := detectedDependencyRecipe("tc", detected, func(string) ([]byte, bool, error) { return nil, false, failure })
	require.ErrorIs(t, err, failure)
	require.Nil(t, inputs)
	detected.Installs[0].Destinations = []string{"bad host"}
	_, _, err = detectedDependencyRecipe("tc", detected, fakeRepository(nil))
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
			layer, inputs, err := detectedDependencyRecipe("tc", detected, fakeRepository(fixture.files))
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
		_, _, err := detectedDependencyRecipe("tc", bad, fakeRepository(map[string]string{"Cargo.toml": "[workspace]\nmembers=['crates/*']\n", "crates/*/Cargo.toml": raw}))
		require.Error(t, err)
	}
}

func TestDetectedToolScriptsInstallPinnedLanguagesAndExternalCaches(t *testing.T) {
	for _, tool := range []string{"npm", "yarn", "bun", "go", "rust", "python", "uv"} {
		t.Run(tool, func(t *testing.T) {
			layer, err := detectedToolchainRecipe("image", Recipe{DetectorVersion: DetectorVersion, Tools: map[string]DetectedTool{tool: {Version: defaultToolVersion(tool), File: "manifest"}}}, nil)
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
	runtime := &Runtime{root: root, owner: "smithers-backend-0123456789abcdef", cli: &cli{binary: binary, home: root}}
	runtime.environments = &environments{runtime: runtime, config: EnvironmentConfig{PrepareTimeout: time.Minute}}
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
	runtime := &Runtime{root: root, owner: "smithers-backend-0123456789abcdef", cli: &cli{binary: binary, home: root}}
	env := environments{runtime: runtime, config: EnvironmentConfig{PrepareTimeout: time.Minute}}
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

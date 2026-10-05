package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/hostexec"
	"github.com/smithersai/smithers/packages/backend/installbundle/bundletest"
)

// markerLibrary builds a shared library whose initializer writes marker the
// moment it is loaded, before any symbol is resolved.
func markerLibrary(t *testing.T, marker string) []byte {
	t.Helper()
	compiler, err := exec.LookPath("cc")
	if err != nil {
		t.Fatalf("a C compiler is required to build the marker library: %v", err)
	}
	directory := t.TempDir()
	source := filepath.Join(directory, "marker.c")
	if err := os.WriteFile(source, []byte(`#include <fcntl.h>
#include <unistd.h>
__attribute__((constructor)) static void smithers_test_marker(void) {
	int fd = open(MARKER, O_WRONLY | O_CREAT | O_TRUNC, 0600);
	if (fd >= 0) { (void)write(fd, "loaded", 6); close(fd); }
}
`), 0o600); err != nil {
		t.Fatal(err)
	}
	library := filepath.Join(directory, "libmarker.dylib")
	output, err := exec.Command(compiler, "-shared", "-fPIC", "-o", library, "-DMARKER="+strconv.Quote(marker), source).CombinedOutput()
	if err != nil {
		t.Fatalf("build the marker library: %v\n%s", err, output)
	}
	body, err := os.ReadFile(library)
	if err != nil {
		t.Fatal(err)
	}
	return body
}

// startupChild is set in a test process this file starts for one case.
const startupChild = "SMITHERS_STARTUP_TEST_CHILD"

// inChild runs the calling (sub)test alone in a fresh test process and
// answers false there, in the parent; the child answers true and runs the
// case. The repository engine loads one library per process, and an earlier
// test in this process may already have loaded another.
func inChild(t *testing.T) bool {
	t.Helper()
	if os.Getenv(startupChild) == "1" {
		return true
	}
	var pattern []string
	for _, part := range strings.Split(t.Name(), "/") {
		pattern = append(pattern, "^"+regexp.QuoteMeta(part)+"$")
	}
	command := exec.Command(os.Args[0], "-test.run", strings.Join(pattern, "/"), "-test.count=1", "-test.v")
	command.Env = append(os.Environ(), startupChild+"=1")
	output, err := command.CombinedOutput()
	if err != nil || !strings.Contains(string(output), "--- PASS: "+t.Name()) {
		t.Fatalf("%s in a fresh process: %v\n%s", t.Name(), err, output)
	}
	return false
}

// TestMain stands in for an assembled backend, which the assembler signs
// with the hardened runtime; the go test binary is not signed with it.
// TestHardenedRuntimeIsRequired checks the real flags.
func TestMain(m *testing.M) {
	codeSigningFlags = func() (uint32, error) { return codeSigningRuntime, nil }
	os.Exit(m.Run())
}

// serveInstalled runs production startup (serve) as the backend executable
// of b, with the launcher's environment and the given changes. Startup ends
// at the first failure; none of these fixtures can serve. serve replaces the
// process environment, so it runs only in a fresh test process (inChild).
func serveInstalled(t *testing.T, b testBundle, change func(env map[string]string)) error {
	t.Helper()
	if os.Getenv(startupChild) != "1" {
		t.Fatal("serveInstalled runs only in a fresh test process")
	}
	env := b.installedEnvironment(t)
	env["SMITHERS_WORKSPACE_ISOLATION"] = "microvm"
	env["SMITHERS_AUTH_MODE"] = "selfhost"
	if change != nil {
		change(env)
	}
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(name, "SMITHERS_") || strings.HasPrefix(name, "GIT_") {
			if err := os.Unsetenv(name); err != nil {
				t.Fatal(err)
			}
		}
	}
	for name, value := range env {
		if err := os.Setenv(name, value); err != nil {
			t.Fatal(err)
		}
	}
	return serve(context.Background(), nil, func() (string, error) { return b.backend, nil }, flowhost.WorkspaceLauncherConfig{})
}

// Ruling §17.3 (a), Fable round 3 B1 and N1, Astra round 3 X1 and X3: beside
// a bundle the backend refuses to start, naming the variable, when the
// environment holds a dynamic-loader variable or a git injection variable,
// before anything is loaded: the approved engine library never loads.
func TestStartupRefusesLoaderAndGitInjection(t *testing.T) {
	for _, name := range []string{"DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH",
		"LD_PRELOAD", "LD_LIBRARY_PATH", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0",
		"GIT_SSH", "GIT_SSH_COMMAND", "GIT_ASKPASS", "GIT_DIR", "GIT_PROXY_COMMAND", "GIT_EXTERNAL_DIFF"} {
		t.Run(name, func(t *testing.T) {
			if !inChild(t) {
				return
			}
			bundle := installedBundleFixture(t)
			loaded := filepath.Join(t.TempDir(), "approved-loaded")
			bundle.approve(t, bundle.ffi, markerLibrary(t, loaded))
			err := serveInstalled(t, bundle, func(env map[string]string) { env[name] = "/hostile/" + name })
			if err == nil || !strings.Contains(err.Error(), "refuses to start") || !strings.Contains(err.Error(), name+" is set") {
				t.Fatalf("startup = %v; want a refusal naming %s", err, name)
			}
			if _, statErr := os.Stat(loaded); !os.IsNotExist(statErr) {
				t.Fatalf("the engine library loaded before the refusal: %v", statErr)
			}
		})
	}
}

// Lead ruling 2026-10-04 (#3455): the GitHub base URLs name no file, so the
// backend keeps them as it keeps the proxy variables; no program it starts
// gets them, and a loader variable beside them is still refused.
func TestInstalledEnvironmentKeepsGitHubBaseURLs(t *testing.T) {
	bundle := installedBundleFixture(t)
	env := bundle.installedEnvironment(t)
	bases := map[string]string{"SMITHERS_GITHUB_APP_API_BASE_URL": "http://127.0.0.1:47401",
		"SMITHERS_AUTH_GITHUB_API_BASE_URL": "http://127.0.0.1:47402", "SMITHERS_AUTH_GITHUB_OAUTH_BASE_URL": "http://127.0.0.1:47403"}
	for name, value := range bases {
		env[name] = value
	}
	env["SMITHERS_GITHUB_APP_PRIVATE_KEY"] = "canary"
	environ := func() []string {
		var entries []string
		for name, value := range env {
			entries = append(entries, name+"="+value)
		}
		return entries
	}
	if err := refuseInjected(environ()); err != nil {
		t.Fatalf("GitHub base URLs were refused: %v", err)
	}
	inputs, err := installedInputs(bundle.backend, func(name string) string { return env[name] })
	if err != nil {
		t.Fatal(err)
	}
	for name, want := range bases {
		if got := inputs.environment[name]; got != want {
			t.Errorf("%s = %q; want %q", name, got, want)
		}
	}
	if got, kept := inputs.environment["SMITHERS_GITHUB_APP_PRIVATE_KEY"]; kept {
		t.Errorf("SMITHERS_GITHUB_APP_PRIVATE_KEY = %q; only allowlisted variables are kept", got)
	}
	for _, entry := range inputs.host.Environment {
		if strings.HasPrefix(entry, "SMITHERS_") {
			t.Errorf("a host program gets %q", entry)
		}
	}
	env["DYLD_INSERT_LIBRARIES"] = "/hostile/DYLD_INSERT_LIBRARIES"
	if err := refuseInjected(environ()); err == nil || !strings.Contains(err.Error(), "DYLD_INSERT_LIBRARIES is set") {
		t.Fatalf("refuseInjected = %v; want a refusal naming DYLD_INSERT_LIBRARIES", err)
	}
}

// Ruling §17.3 (a), Astra round 3 X3: production startup refuses a backend
// running without the hardened runtime before anything is loaded.
func TestStartupRefusesABackendWithoutTheHardenedRuntime(t *testing.T) {
	if !inChild(t) {
		return
	}
	codeSigningFlags = func() (uint32, error) { return 0x22000201, nil }
	bundle := installedBundleFixture(t)
	loaded := filepath.Join(t.TempDir(), "approved-loaded")
	bundle.approve(t, bundle.ffi, markerLibrary(t, loaded))
	err := serveInstalled(t, bundle, nil)
	if err == nil || !strings.Contains(err.Error(), "refuses to start") || !strings.Contains(err.Error(), "without the hardened runtime") {
		t.Fatalf("startup = %v; want a refusal of a backend without the hardened runtime", err)
	}
	if _, statErr := os.Stat(loaded); !os.IsNotExist(statErr) {
		t.Fatalf("the engine library loaded before the refusal: %v", statErr)
	}
}

// Ruling §17.3 (b) and (c), Fable round 3 B1, Astra round 3 X1, X2 and X4:
// beside a bundle the backend does not inherit its environment. After
// startup its whole environment is the one it built: PATH fixed to the
// bundle's bin and the system directories, HOME from the user database,
// every path the canonical one it verified, and nothing else the launcher
// did not pass. Every program it starts gets git and an environment from
// that, never the inherited one.
func TestInstalledBackendDoesNotInheritItsEnvironment(t *testing.T) {
	if !inChild(t) {
		return
	}
	bundle := installedBundleFixture(t)
	loaded := filepath.Join(t.TempDir(), "approved-loaded")
	bundle.approve(t, bundle.ffi, markerLibrary(t, loaded))
	hostile := t.TempDir()
	err := serveInstalled(t, bundle, func(env map[string]string) {
		env["PATH"] = hostile + ":/usr/bin:/bin"
		env["HOME"] = hostile
		env["XDG_CONFIG_HOME"] = hostile
		env["SMITHERS_PLATFORM_MODEL_KEYS_FILE"] = hostile + "/keys.json"
		env["SMITHERS_DATABASE_URL"] = "postgres://hostile.invalid/db"
		env["NODE_OPTIONS"] = "--require=" + hostile + "/x.js"
		env["LANG"] = "C"
	})
	if err == nil || strings.Contains(err.Error(), "refuses to start") {
		t.Fatalf("startup = %v; the intact bundle passes every check", err)
	}
	if _, statErr := os.Stat(loaded); statErr != nil {
		t.Fatalf("startup did not reach the engine library: %v", statErr)
	}
	pinned := bundle.pin(t)
	home, homeErr := accountHome()
	if homeErr != nil {
		t.Fatal(homeErr)
	}
	for name, want := range map[string]string{
		"PATH": pinned.Path("bin") + ":/usr/bin:/bin:/usr/sbin:/sbin", "HOME": home, "LANG": "C",
		"XDG_CONFIG_HOME": "", "SMITHERS_PLATFORM_MODEL_KEYS_FILE": "", "SMITHERS_DATABASE_URL": "", "NODE_OPTIONS": "",
		"SMITHERS_FFI_LIBRARY_PATH": pinned.Path("bin/libsmithers_ffi.dylib"), "SMITHERS_NODE_BINARY": pinned.Path("bin/node"),
		"GIT_EXEC_PATH": pinned.Path("libexec/git-core"),
	} {
		if got := os.Getenv(name); got != want {
			t.Errorf("after startup %s = %q; want %q", name, got, want)
		}
	}
	git, argv, gitErr := hostexec.GitArgv("status")
	if gitErr != nil || git != pinned.Path("bin/git") || argv[0] != "-c" || argv[1] != "core.hooksPath=/dev/null" {
		t.Errorf("git = %s %v %v; want the bundle's bin/git with hooks off", git, argv, gitErr)
	}
	for _, entry := range hostexec.GitEnvironment() {
		if strings.HasPrefix(entry, "SMITHERS_") || strings.Contains(entry, hostile) {
			t.Errorf("a child's environment holds %s", entry)
		}
	}
}

// Astra round 3, X4: a path handed through an alias is verified once, and
// every consumer is handed the verified target, so an alias changed after
// verification redirects nothing.
func TestConsumersGetTheVerifiedTargets(t *testing.T) {
	bundle := installedBundleFixture(t)
	env := bundle.installedEnvironment(t)
	parent := bundletest.ProtectedTempDir(t)
	alias := func(name, target string) string {
		link := filepath.Join(parent, name)
		if err := os.Symlink(target, link); err != nil {
			t.Fatal(err)
		}
		return link
	}
	data, repos := filepath.Join(parent, "data"), filepath.Join(parent, "repos")
	for _, directory := range []string{data, repos} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	env["SMITHERS_DATA_ROOT"] = alias("data-alias", data)
	env["SMITHERS_REPO_STORAGE_PATH"] = alias("repos-alias", repos)
	env["SMITHERS_WEB_ROOT"] = alias("web-alias", bundle.webRoot)
	env["SMITHERS_FFI_LIBRARY_PATH"] = alias("ffi-alias", bundle.ffi)
	env["SMITHERS_NODE_BINARY"] = alias("node-alias", bundle.node)
	env["SMITHERS_NATIVE_POSTGRES_BIN"] = alias("postgres-alias", bundle.postgres)
	inputs, err := installedInputs(bundle.backend, func(name string) string { return env[name] })
	if err != nil {
		t.Fatal(err)
	}
	// Every alias now names a directory or file outside the bundle.
	elsewhere := t.TempDir()
	for _, name := range []string{"data-alias", "repos-alias", "web-alias", "ffi-alias", "node-alias", "postgres-alias"} {
		link := filepath.Join(parent, name)
		if err := os.Remove(link); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(elsewhere, link); err != nil {
			t.Fatal(err)
		}
	}
	canonical := func(path string) string {
		resolved, err := filepath.EvalSymlinks(path)
		if err != nil {
			t.Fatal(err)
		}
		return resolved
	}
	for name, want := range map[string]string{
		"SMITHERS_DATA_ROOT": canonical(data), "SMITHERS_REPO_STORAGE_PATH": canonical(repos), "SMITHERS_WEB_ROOT": canonical(bundle.webRoot),
		"SMITHERS_FFI_LIBRARY_PATH": canonical(bundle.ffi), "SMITHERS_NODE_BINARY": canonical(bundle.node),
		"SMITHERS_NATIVE_POSTGRES_BIN": canonical(bundle.postgres),
	} {
		if got := inputs.environment[name]; got != want {
			t.Errorf("%s handed to its consumer = %q; want the verified %q", name, got, want)
		}
	}
	if inputs.dataRoot != canonical(data) || inputs.node != canonical(bundle.node) || inputs.postgresBin != canonical(bundle.postgres) || inputs.ffi.Path() != canonical(bundle.ffi) {
		t.Errorf("inputs = %+v; want the verified targets", inputs)
	}
}

// Ruling §17.3 (a), Astra round 3 X3: the backend refuses to run without the
// hardened runtime, which makes the dynamic loader ignore DYLD_* variables,
// and refuses a bundle whose manifest does not record it for the backend.
func TestHardenedRuntimeIsRequired(t *testing.T) {
	bundle := installedBundleFixture(t)
	pinned := bundle.pin(t)
	previous := codeSigningFlags
	t.Cleanup(func() { codeSigningFlags = previous })
	codeSigningFlags = func() (uint32, error) { return 0x22000201, nil }
	if err := requireHardenedRuntime(pinned); err == nil || !strings.Contains(err.Error(), "without the hardened runtime (code-signing flags 0x22000201)") {
		t.Fatalf("no runtime flag = %v", err)
	}
	codeSigningFlags = func() (uint32, error) { return codeSigningRuntime | 0x22000201, nil }
	if err := requireHardenedRuntime(pinned); err != nil {
		t.Fatalf("runtime flag and recorded signature = %v", err)
	}
	if err := os.WriteFile(filepath.Join(bundle.root, "manifest.json"), []byte(strings.Replace(string(mustRead(t, filepath.Join(bundle.root, "manifest.json"))), `"codeSignature":"adhoc,runtime",`, "", 1)), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := requireHardenedRuntime(bundle.pin(t)); err == nil || !strings.Contains(err.Error(), "records no hardened runtime") {
		t.Fatalf("manifest without the signature = %v", err)
	}
	// The real flags of this process, a go test binary signed by the linker
	// without the hardened runtime.
	flags, err := processCodeSigningFlags()
	if runtime.GOOS != "darwin" {
		if err == nil {
			t.Fatal("code-signing flags off macOS")
		}
		return
	}
	if err != nil || flags == 0 || flags&codeSigningRuntime != 0 {
		t.Fatalf("this test binary's flags = %#x, %v; want valid flags without the runtime", flags, err)
	}
}

// withoutInjected removes, for the test, any loader or git variable the test
// process inherited (a developer's GIT_* settings).
func withoutInjected(t *testing.T) {
	t.Helper()
	for _, entry := range os.Environ() {
		if name, _, _ := strings.Cut(entry, "="); hostexec.Injected(name) {
			t.Setenv(name, "")
			if err := os.Unsetenv(name); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return body
}

// Fable round 2, B1 and Astra round 2, N1 (spec §17.3 ruling items 1 and 3):
// production startup pins the bundle before anything is loaded and loads the
// repository engine library only after verifying it against the pinned
// manifest. A library outside the bundle, the bundle's library with other
// bytes, or one in the working directory is never loaded: its initializer
// never runs. The approved library is loaded (its marker appears), which is
// what makes the refusals meaningful.
func TestStartupVerifiesTheEngineLibraryBeforeLoadingIt(t *testing.T) {
	t.Run("approved library is loaded", func(t *testing.T) {
		if !inChild(t) {
			return
		}
		bundle := installedBundleFixture(t)
		approved := filepath.Join(t.TempDir(), "approved-loaded")
		bundle.approve(t, bundle.ffi, markerLibrary(t, approved))
		err := serveInstalled(t, bundle, nil)
		if err == nil || strings.Contains(err.Error(), "refuses to start") {
			t.Fatalf("startup = %v; the approved library must pass verification", err)
		}
		if _, statErr := os.Stat(approved); statErr != nil {
			t.Fatalf("the approved library was not loaded: %v (startup: %v)", statErr, err)
		}
	})
	for name, test := range map[string]struct {
		names string
		apply func(t *testing.T, b *testBundle, hostile []byte, env map[string]string)
	}{
		"library outside the bundle": {"SMITHERS_FFI_LIBRARY_PATH=", func(t *testing.T, _ *testBundle, hostile []byte, env map[string]string) {
			path := filepath.Join(t.TempDir(), "libsmithers_ffi.dylib")
			if err := os.WriteFile(path, hostile, 0o755); err != nil {
				t.Fatal(err)
			}
			env["SMITHERS_FFI_LIBRARY_PATH"] = path
		}},
		"library relative to the working directory": {"SMITHERS_FFI_LIBRARY_PATH=libsmithers_ffi.dylib is not an absolute path", func(t *testing.T, _ *testBundle, hostile []byte, env map[string]string) {
			directory := t.TempDir()
			if err := os.WriteFile(filepath.Join(directory, "libsmithers_ffi.dylib"), hostile, 0o755); err != nil {
				t.Fatal(err)
			}
			t.Chdir(directory)
			env["SMITHERS_FFI_LIBRARY_PATH"] = "libsmithers_ffi.dylib"
		}},
		"bundle library replaced after the install": {"bin/libsmithers_ffi.dylib differs", func(t *testing.T, b *testBundle, hostile []byte, _ map[string]string) {
			if err := os.WriteFile(b.ffi, hostile, 0o755); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(name, func(t *testing.T) {
			if !inChild(t) {
				return
			}
			bundle := installedBundleFixture(t)
			bundle.approve(t, bundle.ffi, markerLibrary(t, filepath.Join(t.TempDir(), "approved-loaded")))
			marker := filepath.Join(t.TempDir(), "hostile-loaded")
			hostile := markerLibrary(t, marker)
			err := serveInstalled(t, bundle, func(env map[string]string) { test.apply(t, &bundle, hostile, env) })
			if err == nil || !strings.Contains(err.Error(), "refuses to start") || !strings.Contains(err.Error(), test.names) {
				t.Fatalf("startup = %v; want a refusal naming %q", err, test.names)
			}
			if _, statErr := os.Stat(marker); !os.IsNotExist(statErr) {
				t.Fatalf("the hostile library was loaded: %v", statErr)
			}
		})
	}
	// Unset, the bundle's own library is the one loaded; a library in the
	// working directory's target/ (the development fallback) is never read.
	t.Run("no working-directory fallback beside a bundle", func(t *testing.T) {
		if !inChild(t) {
			return
		}
		bundle := installedBundleFixture(t)
		approved := filepath.Join(t.TempDir(), "approved-loaded")
		bundle.approve(t, bundle.ffi, markerLibrary(t, approved))
		directory := t.TempDir()
		fallback := filepath.Join(t.TempDir(), "fallback-loaded")
		for _, build := range []string{"debug", "release"} {
			if err := os.MkdirAll(filepath.Join(directory, "target", build), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(directory, "target", build, "libsmithers_ffi.dylib"), markerLibrary(t, fallback), 0o755); err != nil {
				t.Fatal(err)
			}
		}
		t.Chdir(directory)
		err := serveInstalled(t, bundle, func(env map[string]string) { delete(env, "SMITHERS_FFI_LIBRARY_PATH") })
		if err == nil || strings.Contains(err.Error(), "refuses to start") {
			t.Fatalf("startup = %v; the bundle's own library must pass", err)
		}
		if _, statErr := os.Stat(fallback); !os.IsNotExist(statErr) {
			t.Fatalf("the working directory's library was loaded: %v", statErr)
		}
		if _, statErr := os.Stat(approved); statErr != nil {
			t.Fatalf("the bundle's library was not the one loaded: %v", statErr)
		}
	})
}

// Fable round 3, N5: `microvm doctor` holds the data root to the chain
// serve does and reports the microVM metadata New would refuse, before msb
// is asked anything.
func TestMicroVMDoctorChecksTheStateChain(t *testing.T) {
	for name, test := range map[string]struct {
		names   string
		prepare func(t *testing.T, data string)
	}{
		"group-writable data root": {"is not owned by root or this user", func(t *testing.T, data string) {
			if err := os.Chmod(data, 0o770); err != nil {
				t.Fatal(err)
			}
		}},
		"world-writable layer records": {"microVM isolation is not ready", func(t *testing.T, data string) {
			layers := filepath.Join(data, "microvm", "layers")
			if err := os.MkdirAll(layers, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(layers, 0o777); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(name, func(t *testing.T) {
			bundle := installedBundleFixture(t)
			data := filepath.Join(bundletest.ProtectedTempDir(t), "data")
			if err := os.MkdirAll(data, 0o700); err != nil {
				t.Fatal(err)
			}
			test.prepare(t, data)
			withoutInjected(t)
			t.Setenv("SMITHERS_DATA_ROOT", data)
			err := runMicroVM(context.Background(), []string{"doctor"}, func() (string, error) { return bundle.backend, nil })
			if err == nil || !strings.Contains(err.Error(), test.names) {
				t.Fatalf("doctor = %v; want %q", err, test.names)
			}
			if _, statErr := os.Stat(bundle.ran); !os.IsNotExist(statErr) {
				t.Fatalf("msb ran: %v", statErr)
			}
		})
	}
}

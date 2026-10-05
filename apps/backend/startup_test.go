package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/flowhost"
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

// serveInstalled runs production startup (serve) as the backend executable
// of b, with the launcher's environment and the given changes. Startup ends
// at the first failure; none of these fixtures can serve.
func serveInstalled(t *testing.T, b testBundle, change func(env map[string]string)) error {
	t.Helper()
	env := b.installedEnvironment(t)
	delete(env, "SMITHERS_NATIVE_POSTGRES_BIN")
	env["SMITHERS_WORKSPACE_ISOLATION"] = "microvm"
	env["SMITHERS_DATABASE_URL"] = "postgres://unused.invalid/smithers"
	env["SMITHERS_AUTH_MODE"] = "selfhost"
	// localbootstrap exports these when they are absent; preset them so the
	// test restores them.
	for _, name := range []string{"SMITHERS_AUTH_SESSION_SECRET", "SMITHERS_LFS_SIGNING_SECRET", "SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY",
		"SMITHERS_REPO_HOST_AUTH_TOKEN", "SMITHERS_PUSH_HOOK_CALLBACK_TOKEN"} {
		env[name] = "startup-test-secret"
	}
	if change != nil {
		change(env)
	}
	for _, name := range []string{"SMITHERS_DATA_ROOT", "SMITHERS_FLOW_HOST_MANIFEST", "SMITHERS_FFI_LIBRARY_PATH", "SMITHERS_NODE_BINARY",
		"SMITHERS_MODEL_HOST_BUNDLE", "SMITHERS_NATIVE_POSTGRES_BIN", "SMITHERS_NATIVE_STATE_DIR", "SMITHERS_REPO_STORAGE_PATH",
		"SMITHERS_BLOB_DATA_DIR", "SMITHERS_INSTALL_STATE_DIR", "SMITHERS_SSH_HOST_KEY_DIR", "SMITHERS_PACK_OBJECTS_CACHE_DIR",
		"SMITHERS_REPO_HOST_PACK_CACHE_DIR", "SMITHERS_PUSH_HOOK_CALLBACK_URL", "SMITHERS_WEB_ROOT", "GIT_EXEC_PATH", "GIT_TEMPLATE_DIR",
		"GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"} {
		t.Setenv(name, "")
		if err := os.Unsetenv(name); err != nil {
			t.Fatal(err)
		}
	}
	for name, value := range env {
		t.Setenv(name, value)
	}
	return serve(context.Background(), nil, func() (string, error) { return b.backend, nil }, flowhost.WorkspaceLauncherConfig{})
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

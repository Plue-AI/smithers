package repohostserver

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/hostexec"
)

// hostileProgram writes an executable script that records its name in
// markers when anything runs it.
func hostileProgram(t *testing.T, directory, name, markers string) string {
	t.Helper()
	path := filepath.Join(directory, name)
	require.NoError(t, os.MkdirAll(directory, 0o755))
	require.NoError(t, os.WriteFile(path, []byte("#!/bin/sh\necho ran > '"+filepath.Join(markers, name)+"'\ncat >/dev/null 2>&1\nexit 0\n"), 0o755))
	return path
}

// ranPrograms lists the hostile programs that ran.
func ranPrograms(t *testing.T, markers string) []string {
	t.Helper()
	entries, err := os.ReadDir(markers)
	require.NoError(t, err)
	var ran []string
	for _, entry := range entries {
		ran = append(ran, entry.Name())
	}
	return ran
}

// cleanGit runs the test's own client git with no GIT_* variable, so a
// hostile variable the test sets reaches only the server.
func cleanGit(args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(entry, "GIT_") {
			cmd.Env = append(cmd.Env, entry)
		}
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %v: %w: %s", args, err, out)
	}
	return strings.TrimSpace(string(out)), nil
}

// laneProxy serves the fixture's repository at <url>/demo.git over smart HTTP
// as pusher 42.
func laneProxy(t *testing.T, f *laneHTTPFixture) string {
	t.Helper()
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/info/refs"):
			r.URL.Path = "/repos/alice/demo/git/info-refs"
		case strings.HasSuffix(r.URL.Path, "/git-upload-pack"):
			r.URL.Path = "/repos/alice/demo/git/upload-pack"
		case strings.HasSuffix(r.URL.Path, "/git-receive-pack"):
			r.URL.Path = "/repos/alice/demo/git/receive-pack"
		default:
			http.NotFound(w, r)
			return
		}
		r.RequestURI = ""
		r.Header.Set("Authorization", validAuth())
		r.Header.Set("X-Smithers-Pusher-Id", "42")
		f.srv.Handler().ServeHTTP(w, r)
	}))
	t.Cleanup(proxy.Close)
	return proxy.URL + "/demo.git"
}

// Ruling §17.3 (a) to (c), Fable round 3 B1 and Astra round 3 X1: no git the
// repository host starts runs a hook or a pack-objects program that the
// process environment names. A real push (receive-pack), a real clone
// (upload-pack), a reference update and maintenance (pack-refs, gc) run
// with each injection channel set to hostile programs; none of them runs.
func TestRepositoryHostGitRunsNothingTheEnvironmentNames(t *testing.T) {
	hostileGitEnvironment(t, func(*testing.T) {})
}

// The same push, clone, reference update and maintenance with an installed
// bundle's own git (SMITHERS_INSTALLED_BUNDLE), as an installed backend
// configures it.
func TestRealBundleGitRunsNothingTheEnvironmentNames(t *testing.T) {
	bundle := os.Getenv("SMITHERS_INSTALLED_BUNDLE")
	if bundle == "" {
		if os.Getenv("SMITHERS_REQUIRE_MICROVM_TESTS") == "1" {
			t.Fatal("SMITHERS_INSTALLED_BUNDLE is required for the bundle git receipt")
		}
		t.Skip("SMITHERS_INSTALLED_BUNDLE is not set")
	}
	hostileGitEnvironment(t, func(t *testing.T) {
		restore, err := hostexec.Configure(hostexec.Config{Git: filepath.Join(bundle, "bin", "git"),
			GitExecPath: filepath.Join(bundle, "libexec", "git-core"), GitTemplateDir: filepath.Join(bundle, "share", "git-core", "templates"),
			Environment: []string{"PATH=" + filepath.Join(bundle, "bin") + ":/usr/bin:/bin:/usr/sbin:/sbin", "HOME=" + t.TempDir()}})
		require.NoError(t, err)
		t.Cleanup(restore)
	})
}

func hostileGitEnvironment(t *testing.T, configure func(*testing.T)) {
	for name, hostile := range map[string]func(hooks string) map[string]string{
		"GIT_CONFIG_PARAMETERS": func(hooks string) map[string]string {
			return map[string]string{"GIT_CONFIG_PARAMETERS": "'core.hookspath'='" + hooks + "' 'uploadpack.packobjectshook'='" + filepath.Join(hooks, "pack-objects") + "' 'core.sshcommand'='" + filepath.Join(hooks, "ssh") + "'"}
		},
		"GIT_CONFIG_COUNT": func(hooks string) map[string]string {
			return map[string]string{"GIT_CONFIG_COUNT": "3", "GIT_CONFIG_KEY_0": "core.hooksPath", "GIT_CONFIG_VALUE_0": hooks,
				"GIT_CONFIG_KEY_1": "uploadpack.packObjectsHook", "GIT_CONFIG_VALUE_1": filepath.Join(hooks, "pack-objects"),
				"GIT_CONFIG_KEY_2": "core.sshCommand", "GIT_CONFIG_VALUE_2": filepath.Join(hooks, "ssh")}
		},
		"GIT_SSH_COMMAND and GIT_ASKPASS": func(hooks string) map[string]string {
			return map[string]string{"GIT_SSH_COMMAND": filepath.Join(hooks, "ssh"), "GIT_SSH": filepath.Join(hooks, "ssh"), "GIT_ASKPASS": filepath.Join(hooks, "askpass")}
		},
	} {
		t.Run(name, func(t *testing.T) {
			configure(t)
			f := newLaneHTTPFixture(t, nil)
			remote := laneProxy(t, f)
			markers, hooks := t.TempDir(), filepath.Join(t.TempDir(), "hooks")
			for _, program := range []string{"pre-receive", "update", "post-receive", "post-update", "reference-transaction", "push-to-checkout", "pre-auto-gc", "post-checkout", "pack-objects", "ssh", "askpass"} {
				hostileProgram(t, hooks, program, markers)
			}
			tip := f.commit("hostile environment", func(dir string) {
				require.NoError(t, os.WriteFile(filepath.Join(dir, "src", "env.go"), []byte("package env\n"), 0o644))
			})
			for key, value := range hostile(hooks) {
				t.Setenv(key, value)
			}
			// Every step runs; what ran is checked before whether they worked.
			var failures []error
			step := func(err error) {
				if err != nil {
					failures = append(failures, err)
				}
			}
			_, err := cleanGit("-C", f.clientDir, "push", "--quiet", remote, "HEAD:refs/heads/main")
			step(err)
			clone := filepath.Join(t.TempDir(), "clone.git")
			_, err = cleanGit("clone", "--quiet", "--bare", remote, clone)
			step(err)
			cloned, err := cleanGit("--git-dir", clone, "rev-parse", "refs/heads/main")
			step(err)
			_, err = cleanGit("--git-dir", f.repo.gitDir, "update-ref", "refs/smithers-test/hostile", tip)
			step(err)
			step(deleteGitRef(context.Background(), f.repo.gitDir, "refs/smithers-test/hostile", tip))
			step(runMaintenanceGit(context.Background(), f.repo.gitDir, packRefsArgs))
			step(runMaintenanceGit(context.Background(), f.repo.gitDir, []string{"-c", "gc.auto=1", "gc", "--auto", "--quiet"}))

			require.Empty(t, ranPrograms(t, markers), "a program the environment named ran")
			require.Empty(t, failures)
			require.Equal(t, tip, f.repo.refs()["refs/heads/main"], "the push landed")
			require.Equal(t, tip, cloned, "the clone holds the pushed tip")
		})
	}
}

// Ruling §17.3 (c), Astra round 3 X2: the repository host runs git by its
// configured absolute path and its system tools by fixed absolute paths. A
// directory first on PATH holding sh, git and lsof is never used, by a push,
// a clone, maintenance or the process inspection orphan cleanup uses.
func TestRepositoryHostNeverRunsAProgramFoundThroughPATH(t *testing.T) {
	git, err := exec.LookPath("git")
	require.NoError(t, err)
	git, err = filepath.Abs(git)
	require.NoError(t, err)
	restore, err := hostexec.Configure(hostexec.Config{Git: git, Environment: []string{"PATH=/usr/bin:/bin:/usr/sbin:/sbin", "HOME=" + t.TempDir()}})
	require.NoError(t, err)
	t.Cleanup(restore)

	f := newLaneHTTPFixture(t, nil)
	remote := laneProxy(t, f)
	tip := f.commit("hostile path", func(dir string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "src", "path.go"), []byte("package path\n"), 0o644))
	})
	markers, hostile := t.TempDir(), t.TempDir()
	for _, program := range []string{"sh", "git", "lsof"} {
		hostileProgram(t, hostile, program, markers)
	}
	original := os.Getenv("PATH")
	t.Setenv("PATH", hostile+string(filepath.ListSeparator)+original)

	push := exec.Command(git, "-C", f.clientDir, "push", "--quiet", remote, "HEAD:refs/heads/main")
	push.Env = []string{"PATH=/usr/bin:/bin", "HOME=" + t.TempDir()}
	pushed, pushErr := push.CombinedOutput()
	maintenanceErr := runMaintenanceGit(context.Background(), f.repo.gitDir, packRefsArgs)
	var cwd string
	var cwdErr error
	if runtime.GOOS == "darwin" {
		cwd, cwdErr = processCwd(os.Getpid())
	}

	require.Empty(t, ranPrograms(t, markers), "a program found through PATH ran")
	require.NoError(t, pushErr, "%s", pushed)
	t.Setenv("PATH", original)
	require.Equal(t, tip, f.repo.refs()["refs/heads/main"])
	require.NoError(t, maintenanceErr)
	if runtime.GOOS == "darwin" {
		require.NoError(t, cwdErr)
		require.NotEmpty(t, cwd)
	}
}

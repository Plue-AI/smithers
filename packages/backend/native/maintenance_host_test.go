package native

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/installbundle"
	"github.com/smithersai/smithers/packages/backend/installbundle/bundletest"
	"github.com/smithersai/smithers/packages/backend/postgres"
	"github.com/stretchr/testify/require"
)

// maintenanceBundle is an installed bundle fixture: the members a maintenance
// command runs, declared in a manifest the way the assembler declares them.
type maintenanceBundle struct {
	t    *testing.T
	root string
}

// newMaintenanceBundle writes a bundle whose backend, CLI and PostgreSQL
// programs are the given shell scripts. programs maps a bundle path to its
// script body.
func newMaintenanceBundle(t *testing.T, programs map[string]string) maintenanceBundle {
	t.Helper()
	b := maintenanceBundle{t: t, root: filepath.Join(bundletest.ProtectedTempDir(t), "libexec")}
	files := map[string]string{
		"bin/smithers-backend": "#!/bin/sh\nexit 0\n",
		"bin/smthrs":           "#!/bin/sh\nexit 0\n",
		"postgres/bundle.json": `{"version":1,"bin":"root/bin"}`,
	}
	for _, program := range postgresPrograms {
		files["postgres/root/bin/"+program] = "#!/bin/sh\nexit 0\n"
	}
	for path, body := range programs {
		files[path] = body
	}
	for path, body := range files {
		b.write(path, body)
	}
	b.declare()
	return b
}

func (b maintenanceBundle) path(relative string) string {
	return filepath.Join(b.root, filepath.FromSlash(relative))
}
func (b maintenanceBundle) write(relative, body string) {
	b.t.Helper()
	mode := os.FileMode(0755)
	if strings.HasSuffix(relative, ".json") {
		mode = 0644
	}
	require.NoError(b.t, os.MkdirAll(filepath.Dir(b.path(relative)), 0755))
	require.NoError(b.t, os.WriteFile(b.path(relative), []byte(body), mode))
}

// declare writes manifest.json for the files the bundle holds now.
func (b maintenanceBundle) declare() {
	b.t.Helper()
	var files []map[string]any
	require.NoError(b.t, filepath.WalkDir(b.root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() || entry.Name() == "manifest.json" {
			return err
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		relative, _ := filepath.Rel(b.root, path)
		sum := sha256.Sum256(body)
		files = append(files, map[string]any{"path": filepath.ToSlash(relative), "sha256": hex.EncodeToString(sum[:]), "stage": "fixture", "mode": int(info.Mode().Perm())})
		return nil
	}))
	manifest, err := json.Marshal(map[string]any{"version": 1, "platform": "darwin-arm64", "revision": strings.Repeat("a", 40), "files": files})
	require.NoError(b.t, err)
	require.NoError(b.t, os.WriteFile(b.path("manifest.json"), manifest, 0644))
}
func (b maintenanceBundle) executable() (string, error) { return b.path("bin/smithers-backend"), nil }

type bundledRun struct {
	program string
	args    []string
	env     []string
}

// host opens the fixture as a maintenance command would, recording every
// program it runs instead of running it. during runs while a child would.
func (b maintenanceBundle) host(state string, status int, runErr error, during func()) (*maintenanceHost, *[]bundledRun) {
	b.t.Helper()
	host, err := openMaintenanceHost(b.executable, state)
	require.NoError(b.t, err)
	runs := &[]bundledRun{}
	host.run = func(_ context.Context, program string, args, env []string) (int, error) {
		*runs = append(*runs, bundledRun{program, args, env})
		if during != nil {
			during()
		}
		return status, runErr
	}
	return host, runs
}

// hostile sets variables a maintenance child must never inherit.
func hostile(t *testing.T) {
	t.Helper()
	for name, value := range map[string]string{
		"SMITHERS_DATABASE_URL": "postgres://attacker.example/db", "DYLD_INSERT_LIBRARIES": "/hostile/inject.dylib",
		"GIT_SSH_COMMAND": "/hostile/ssh", "ANTHROPIC_API_KEY": "sk-hostile", "PGPASSFILE": "/hostile/pgpass",
		"PATH": "/hostile/bin:" + os.Getenv("PATH"),
	} {
		t.Setenv(name, value)
	}
}

// The isolation check runs the bundle's own backend, `microvm doctor`, with
// an environment that holds the installing user's home, the bundle's programs
// and the install state, and nothing the caller exported.
func TestMaintenanceIsolationRunsTheBundlesOwnDoctor(t *testing.T) {
	bundle := newMaintenanceBundle(t, nil)
	home := t.TempDir()
	t.Setenv("HOME", home)
	hostile(t)
	state := filepath.Join(home, "Library/Application Support/Smithers")

	host, runs := bundle.host(state, 0, nil, nil)
	require.NoError(t, host.isolation(t.Context()))
	require.Equal(t, []bundledRun{{
		program: bundle.path("bin/smithers-backend"),
		args:    []string{"microvm", "doctor"},
		env:     []string{"HOME=" + home, "PATH=" + bundle.path("bin") + ":/usr/bin:/bin:/usr/sbin:/sbin", "SMITHERS_DATA_ROOT=" + state},
	}}, *runs)

	const refusal = "host_maintenance_unavailable: microVM isolation is not ready on this Mac; run smthrs host status"
	host, _ = bundle.host(state, 1, nil, nil)
	require.EqualError(t, host.isolation(t.Context()), refusal)
	host, _ = bundle.host(state, -1, errors.New("exec format error"), nil)
	require.EqualError(t, host.isolation(t.Context()), refusal)

	// A backend whose bytes changed after the bundle was pinned never runs.
	host, runs = bundle.host(state, 0, nil, nil)
	bundle.write("bin/smithers-backend", "#!/bin/sh\necho replaced\n")
	err := host.isolation(t.Context())
	require.ErrorContains(t, err, "host_maintenance_unavailable: ")
	require.ErrorContains(t, err, "bin/smithers-backend differs from the bundle manifest")
	require.Empty(t, *runs)

	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	bundle.declare()
	host, _ = bundle.host(state, 0, nil, nil)
	require.ErrorIs(t, host.isolation(cancelled), context.Canceled)
}

// The start step grants its own start, runs the bundle's `smthrs host start
// --bundle`, and revokes the grant when it returns. While the child runs a
// start is allowed; before and after, the marker refuses it.
func TestMaintenanceStartGrantsOnlyItsOwnStart(t *testing.T) {
	bundle := newMaintenanceBundle(t, nil)
	home := t.TempDir()
	t.Setenv("HOME", home)
	hostile(t)
	state, backup := incompleteInstall(t, currentRelease(t))
	grant := filepath.Join(state, recoveryGrantPath)
	require.Error(t, requireStartAllowed(state))

	for _, tc := range []struct {
		name, target string
		status       int
		runErr       error
		refusal      string
	}{
		{name: "an unclaimed install prints setup URLs", status: 0},
		{name: "a claimed install is already set up", status: 3},
		{name: "the backup's bundle starts", status: 0, target: filepath.Join(state, "bundle")},
		{name: "the start failed", status: 1, refusal: "host_start_failed: the restored install did not start on "},
		{name: "setup minting failed", status: 4, refusal: "host_start_failed: the restored install did not start on "},
		{name: "the CLI did not run", status: -1, runErr: errors.New("exec format error"), refusal: "host_start_failed: the restored install did not start on "},
	} {
		t.Run(tc.name, func(t *testing.T) {
			granted := false
			host, runs := bundle.host(state, tc.status, tc.runErr, func() {
				granted = recoveryStartGranted(state, backup) && requireStartAllowed(state) == nil
			})
			err := host.start(backup)(t.Context(), tc.target)
			want := tc.target
			if want == "" {
				want = bundle.root
			}
			require.Equal(t, []bundledRun{{
				program: bundle.path("bin/smthrs"),
				args:    []string{"host", "start", "--bundle", want},
				env:     []string{"HOME=" + home, "PATH=" + bundle.path("bin") + ":/usr/bin:/bin:/usr/sbin:/sbin"},
			}}, *runs)
			require.True(t, granted, "the child's start is granted while it runs")
			if tc.refusal == "" {
				require.NoError(t, err)
			} else {
				require.ErrorContains(t, err, tc.refusal+want)
			}
			require.NoFileExists(t, grant, "the grant never outlives the start step")
			require.Error(t, requireStartAllowed(state), "the marker refuses every later start")
		})
	}

	// A CLI whose bytes changed never runs, and no start was ever granted.
	host, runs := bundle.host(state, 0, nil, nil)
	bundle.write("bin/smthrs", "#!/bin/sh\necho replaced\n")
	err := host.start(backup)(t.Context(), "")
	require.ErrorContains(t, err, "bin/smthrs differs from the bundle manifest")
	require.Empty(t, *runs)
	require.NoFileExists(t, grant)
}

func TestMaintenanceHostFindsTheBundledPostgres(t *testing.T) {
	bundle := newMaintenanceBundle(t, nil)
	host, _ := bundle.host(t.TempDir(), 0, nil, nil)
	config, err := host.postgres()
	require.NoError(t, err)
	require.Equal(t, postgres.Config{BinDir: bundle.path("postgres/root/bin"), Major: 18}, config)

	for name, index := range map[string]string{
		"absolute":      `{"version":1,"bin":"/opt/homebrew/opt/postgresql@18/bin"}`,
		"climb":         `{"version":1,"bin":"../../outside/bin"}`,
		"unclean":       `{"version":1,"bin":"root/../root/bin"}`,
		"empty":         `{"version":1,"bin":""}`,
		"other version": `{"version":2,"bin":"root/bin"}`,
		"unknown field": `{"version":1,"bin":"root/bin","path":"/usr/bin"}`,
		"not json":      `root/bin`,
	} {
		t.Run(name, func(t *testing.T) {
			bundle := newMaintenanceBundle(t, map[string]string{"postgres/bundle.json": index})
			host, _ := bundle.host(t.TempDir(), 0, nil, nil)
			_, err := host.postgres()
			require.ErrorIs(t, err, installbundle.ErrUnapproved)
		})
	}
	t.Run("a program the manifest does not declare", func(t *testing.T) {
		bundle := newMaintenanceBundle(t, nil)
		require.NoError(t, os.Remove(bundle.path("postgres/root/bin/pg_restore")))
		bundle.declare()
		host, _ := bundle.host(t.TempDir(), 0, nil, nil)
		_, err := host.postgres()
		require.ErrorIs(t, err, installbundle.ErrUnapproved)
		require.ErrorContains(t, err, "pg_restore")
	})
	t.Run("a program replaced after the manifest", func(t *testing.T) {
		bundle := newMaintenanceBundle(t, nil)
		host, _ := bundle.host(t.TempDir(), 0, nil, nil)
		bundle.write("postgres/root/bin/initdb", "#!/bin/sh\necho replaced\n")
		_, err := host.postgres()
		require.ErrorIs(t, err, installbundle.ErrUnapproved)
		require.ErrorContains(t, err, "initdb differs from the bundle manifest")
	})
}

func TestMaintenanceHostRequiresAnInstalledBundle(t *testing.T) {
	_, err := openMaintenanceHost(os.Executable, t.TempDir())
	require.ErrorContains(t, err, "does not run from an installed bundle's bin/smithers-backend")
	_, err = openMaintenanceHost(nil, t.TempDir())
	require.EqualError(t, err, "the backend executable is unknown")
	_, err = openMaintenanceHost(func() (string, error) { return "", errors.New("unreadable") }, t.TempDir())
	require.EqualError(t, err, "locate the backend executable: unreadable")
	// A backend copied beside an undeclared bundle is not that bundle's.
	bundle := newMaintenanceBundle(t, nil)
	bundle.write("bin/smithers-backend", "#!/bin/sh\necho another backend\n")
	_, err = openMaintenanceHost(bundle.executable, t.TempDir())
	require.ErrorIs(t, err, installbundle.ErrUnapproved)
}

// runBundled gives a child exactly the environment it is handed, reports its
// exit status and keeps its output off the command's own.
func TestRunBundledIsolatesTheChild(t *testing.T) {
	hostile(t)
	directory := t.TempDir()
	seen := filepath.Join(directory, "environment")
	script := filepath.Join(directory, "child")
	require.NoError(t, os.WriteFile(script, []byte("#!/bin/sh\n/usr/bin/env > \"$SEEN\"\necho noisy output\necho noisy error >&2\nexit \"$1\"\n"), 0755))
	for _, status := range []int{0, 3, 7} {
		got, err := runBundled(t.Context(), script, []string{map[int]string{0: "0", 3: "3", 7: "7"}[status]}, []string{"HOME=/Users/owner", "PATH=/usr/bin:/bin", "SEEN=" + seen})
		require.NoError(t, err)
		require.Equal(t, status, got)
	}
	environment, err := os.ReadFile(seen)
	require.NoError(t, err)
	for _, line := range strings.Split(strings.TrimSpace(string(environment)), "\n") {
		name, _, _ := strings.Cut(line, "=")
		// The shell adds its own bookkeeping; nothing of the caller's crosses.
		require.Contains(t, []string{"HOME", "PATH", "SEEN", "PWD", "SHLVL", "_", "OLDPWD"}, name, line)
	}
	require.Contains(t, string(environment), "HOME=/Users/owner\n")
	require.Contains(t, string(environment), "PATH=/usr/bin:/bin\n")
	_, err = runBundled(t.Context(), filepath.Join(directory, "absent"), nil, nil)
	require.Error(t, err)
}

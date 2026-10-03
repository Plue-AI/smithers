package microsandbox

import (
	"encoding/json"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestGuestFSRemoveCLI(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 is not installed")
	}
	root := t.TempDir()
	remove := func(path string) (string, error) {
		cmd := exec.Command(python, "-B", filepath.Join("guest", "smithers-guest.py"), "fs", "agent", "remove", root, path)
		cmd.Env = append(os.Environ(), "SMITHERS_GUEST_USER=")
		output, err := cmd.CombinedOutput()
		return string(output), err
	}
	assertMissing := func(t *testing.T, path string) {
		t.Helper()
		output, err := remove(path)
		var exit *exec.ExitError
		require.ErrorAs(t, err, &exit)
		require.Equal(t, 2, exit.ExitCode(), output)
		require.Contains(t, strings.ToLower(output), "no such file or directory")
	}
	assertRemoved := func(t *testing.T, path string) {
		t.Helper()
		output, err := remove(path)
		require.NoError(t, err, output)
		_, err = os.Lstat(filepath.Join(root, path))
		require.True(t, errors.Is(err, os.ErrNotExist), "path still exists: %s; stat error: %v", path, err)
	}

	t.Run("missing path", func(t *testing.T) { assertMissing(t, "missing") })
	t.Run("dangling symlink", func(t *testing.T) {
		require.NoError(t, os.Symlink("absent-target", filepath.Join(root, "dangling")))
		assertRemoved(t, "dangling")
	})
	t.Run("existing file and repeated removal", func(t *testing.T) {
		require.NoError(t, os.WriteFile(filepath.Join(root, "file"), []byte("data"), 0o600))
		assertRemoved(t, "file")
		assertMissing(t, "file")
	})
	t.Run("nonempty directory", func(t *testing.T) {
		require.NoError(t, os.Mkdir(filepath.Join(root, "directory"), 0o700))
		require.NoError(t, os.WriteFile(filepath.Join(root, "directory", "child"), []byte("data"), 0o600))
		assertRemoved(t, "directory")
	})
	t.Run("FIFO", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("FIFO is unsupported on Windows")
		}
		path := filepath.Join(root, "fifo")
		output, err := exec.Command(python, "-c", "import os, sys; os.mkfifo(sys.argv[1])", path).CombinedOutput()
		require.NoError(t, err, string(output))
		info, err := os.Lstat(path)
		require.NoError(t, err)
		require.NotZero(t, info.Mode()&os.ModeNamedPipe)
		assertRemoved(t, "fifo")
	})
	t.Run("UNIX socket", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("UNIX socket is unsupported on Windows")
		}
		// macOS socket paths can exceed sun_path's limit under t.TempDir.
		shortRoot, err := os.MkdirTemp("/tmp", "gfs-")
		require.NoError(t, err)
		t.Cleanup(func() { require.NoError(t, os.RemoveAll(shortRoot)) })
		path := filepath.Join(shortRoot, "socket")
		listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
		require.NoError(t, err)
		listener.SetUnlinkOnClose(false)
		require.NoError(t, listener.Close())
		info, err := os.Lstat(path)
		require.NoError(t, err)
		require.NotZero(t, info.Mode()&os.ModeSocket)
		cmd := exec.Command(python, "-B", filepath.Join("guest", "smithers-guest.py"), "fs", "agent", "remove", shortRoot, "socket")
		cmd.Env = append(os.Environ(), "SMITHERS_GUEST_USER=")
		output, err := cmd.CombinedOutput()
		require.NoError(t, err, string(output))
		_, err = os.Lstat(path)
		require.ErrorIs(t, err, os.ErrNotExist)
	})
	t.Run("symlink to outside nonempty directory", func(t *testing.T) {
		outside := t.TempDir()
		child := filepath.Join(outside, "child")
		require.NoError(t, os.WriteFile(child, []byte("outside data"), 0o600))
		link := filepath.Join(root, "outside-link")
		require.NoError(t, os.Symlink(outside, link))
		assertRemoved(t, "outside-link")
		contents, err := os.ReadFile(child)
		require.NoError(t, err)
		require.Equal(t, "outside data", string(contents))
	})
}

// A Flow host's tools keep only PATH and HOME, so the guest's setup leaves
// the layer's caches and offline Go settings where each tool looks by
// default under the user's home.
func TestGuestSetupLeavesLayerEnvironmentAtHomeDefaults(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 is not installed")
	}
	root := t.TempDir()
	home := filepath.Join(root, "home")
	require.NoError(t, os.Mkdir(home, 0o755))
	environment := map[string]string{
		"PATH": "/opt/smithers/toolchain/bin:/usr/bin", "GOTOOLCHAIN": "local", "GOPROXY": "off", "GOFLAGS": "-mod=readonly",
		"GOMODCACHE": "/var/cache/smithers/gomod", "GOCACHE": "/var/cache/smithers/gocache",
		"PLAYWRIGHT_BROWSERS_PATH": "/var/cache/smithers/ms-playwright", "CARGO_HOME": "/var/cache/smithers/cargo",
		"RUSTUP_HOME": "/opt/smithers/rust/rustup", "pnpm_config_store_dir": "/var/cache/smithers/pnpm-store",
		"pnpm_config_cache_dir": "/var/cache/smithers/pnpm-cache", "DPRINT_CACHE_DIR": "/var/cache/smithers/dprint",
	}
	encoded, err := json.Marshal(environment)
	require.NoError(t, err)
	envFile := filepath.Join(root, "env.json")
	require.NoError(t, os.WriteFile(envFile, encoded, 0o644))
	script := `import importlib.util, os, pwd, sys
spec = importlib.util.spec_from_file_location("guest", sys.argv[1])
guest = importlib.util.module_from_spec(spec); spec.loader.exec_module(guest)
guest.ENV_FILE = sys.argv[2]
guest.TOOL_HOME = os.path.dirname(os.path.realpath(sys.argv[3])) + "/absent-tool-home"
me = pwd.getpwuid(os.getuid())
entry = pwd.struct_passwd((me.pw_name, "x", me.pw_uid, me.pw_gid, "", os.path.realpath(sys.argv[3]), "/bin/sh"))
guest.home_defaults(entry)
guest.home_defaults(entry)  # idempotent across restarts
`
	output, err := exec.Command(python, "-c", script, filepath.Join("guest", "smithers-guest.py"), envFile, home).CombinedOutput()
	require.NoError(t, err, string(output))
	for relative, target := range map[string]string{
		".cache/ms-playwright": environment["PLAYWRIGHT_BROWSERS_PATH"], ".cache/dprint": environment["DPRINT_CACHE_DIR"],
		".cargo": environment["CARGO_HOME"], ".rustup": environment["RUSTUP_HOME"],
		".local/share/pnpm/store": environment["pnpm_config_store_dir"], ".cache/pnpm": environment["pnpm_config_cache_dir"],
	} {
		link, err := os.Readlink(filepath.Join(home, relative))
		require.NoError(t, err, relative)
		require.Equal(t, target, link, relative)
	}
	goEnv, err := os.ReadFile(filepath.Join(home, ".config", "go", "env"))
	require.NoError(t, err)
	require.Equal(t, "GOTOOLCHAIN=local\nGOPROXY=off\nGOFLAGS=-mod=readonly\nGOMODCACHE=/var/cache/smithers/gomod\nGOCACHE=/var/cache/smithers/gocache\n", string(goEnv))
}

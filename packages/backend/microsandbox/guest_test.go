package microsandbox

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

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
me = pwd.getpwuid(os.getuid())
entry = pwd.struct_passwd((me.pw_name, "x", me.pw_uid, me.pw_gid, "", sys.argv[3], "/bin/sh"))
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

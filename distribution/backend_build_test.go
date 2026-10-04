package distribution_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestBackendReleaseBuildStampsCLIVersion(t *testing.T) {
	root := t.TempDir()
	manifest := filepath.Join(root, "packages", "smithers", "package.json")
	require.NoError(t, os.MkdirAll(filepath.Dir(manifest), 0755))
	require.NoError(t, os.WriteFile(manifest, []byte("{\n  \"name\": \"@smthrs/cli\",\n  \"version\": \"2.3.4-rc.5\"\n}\n"), 0644))
	bin := filepath.Join(root, "bin")
	require.NoError(t, os.Mkdir(bin, 0755))
	executable(t, filepath.Join(bin, "go"), `printf '%s\n' "$@" > "$GO_ARGS_FILE"`)
	argsFile := filepath.Join(root, "go-args")
	script, err := filepath.Abs("../scripts/build-backend.sh")
	require.NoError(t, err)
	cmd := exec.Command("sh", script, filepath.Join(root, "backend"), strings.Repeat("a", 40))
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "PATH="+bin+":"+os.Getenv("PATH"), "GO_ARGS_FILE="+argsFile)
	out, err := cmd.CombinedOutput()
	require.NoError(t, err, string(out))
	args, err := os.ReadFile(argsFile)
	require.NoError(t, err)
	require.Equal(t, []string{
		"build", "-trimpath",
		"-ldflags=-s -w -X github.com/smithersai/smithers/packages/backend/internal/compose.BuildSHA=" + strings.Repeat("a", 40) + " -X github.com/smithersai/smithers/packages/backend/internal/compose.BuildVersion=2.3.4-rc.5",
		"-o", filepath.Join(root, "backend"), "./apps/backend",
	}, strings.Split(strings.TrimSpace(string(args)), "\n"))

}

func TestBackendBuildModes(t *testing.T) {
	for _, mode := range []string{"preview", "unknown", ""} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			require.NoError(t, os.MkdirAll(filepath.Join(root, "packages", "smithers"), 0755))
			require.NoError(t, os.WriteFile(filepath.Join(root, "packages", "smithers", "package.json"), []byte("{\n  \"version\": \"2.3.4\"\n}\n"), 0644))
			bin := filepath.Join(root, "bin")
			require.NoError(t, os.Mkdir(bin, 0755))
			argsFile := filepath.Join(root, "args")
			executable(t, filepath.Join(bin, "go"), `printf '%s\n' "$@" > "$GO_ARGS_FILE"`)
			script, err := filepath.Abs("../scripts/build-backend.sh")
			require.NoError(t, err)
			cmd := exec.Command("sh", script, "backend", strings.Repeat("a", 40), mode)
			cmd.Dir = root
			cmd.Env = append(os.Environ(), "PATH="+bin+":"+os.Getenv("PATH"), "GO_ARGS_FILE="+argsFile)
			out, err := cmd.CombinedOutput()
			if mode != "preview" {
				require.Error(t, err)
				_, err = os.Stat(argsFile)
				require.True(t, os.IsNotExist(err), "unknown mode must fail before invoking go")
			} else {
				require.NoError(t, err, string(out))
				args, err := os.ReadFile(argsFile)
				require.NoError(t, err)
				require.Contains(t, string(args), "-tags\nsmithers_preview\n")
			}
		})
	}
}

func TestEntrypointExecutesBackendWithoutExternalDatabase(t *testing.T) {
	backend := filepath.Join(t.TempDir(), "backend")
	executable(t, backend, `printf '%s\n' "$$" "$SMITHERS_AUTH_MODE" "$@"`)
	cmd := exec.Command("sh", "entrypoint.sh", "argument with spaces", "--flag")
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "SMITHERS_BACKEND_BINARY=" + backend}
	out, err := cmd.Output()
	require.NoError(t, err)
	require.Equal(t, []string{strconv.Itoa(cmd.Process.Pid), "selfhost", "argument with spaces", "--flag"}, strings.Split(strings.TrimSpace(string(out)), "\n"))
}

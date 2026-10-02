package distribution_test

import (
	"os"
	"os/exec"
	"path/filepath"
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

	dockerfile, err := os.ReadFile("Dockerfile")
	require.NoError(t, err)
	require.Contains(t, string(dockerfile), "COPY packages/smithers/package.json packages/smithers/package.json")
	require.Contains(t, string(dockerfile), `sh scripts/build-backend.sh /out/smithers-backend "$BUILD_SHA"`)
}

package microsandbox

import (
	"bytes"
	"context"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// gitSourceFiles reads files at a commit of a local Git checkout: the same
// data the product repository reader serves.
type gitSourceFiles struct{ dir string }

func (g gitSourceFiles) ResolveSourceRevision(ctx context.Context, _ string, revision string) (string, error) {
	output, err := exec.CommandContext(ctx, "git", "-C", g.dir, "rev-parse", "--verify", revision+"^{commit}").Output()
	return strings.TrimSpace(string(output)), err
}

func (g gitSourceFiles) ReadSourceFile(ctx context.Context, source workspaceapi.WorkspaceSource, path string) ([]byte, error) {
	var stdout, stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, "git", "-C", g.dir, "show", source.Revision+":"+path)
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		if strings.Contains(stderr.String(), "does not exist") || strings.Contains(stderr.String(), "exists on disk, but not in") {
			return nil, fs.ErrNotExist
		}
		return nil, fmt.Errorf("git show %s: %v: %s", path, err, stderr.String())
	}
	return stdout.Bytes(), nil
}

func repositoryRoot(t *testing.T) (string, string) {
	t.Helper()
	root, err := filepath.Abs("../../..")
	require.NoError(t, err)
	revision, err := exec.Command("git", "-C", root, "rev-parse", "HEAD").Output()
	require.NoError(t, err)
	return root, strings.TrimSpace(string(revision))
}

// layerRuntime keeps its state under SMITHERS_MICROVM_LAYER_ROOT so built
// layers are reused between runs; the directory's owner label scopes cleanup.
func layerRuntime(t *testing.T) *Runtime {
	t.Helper()
	binary := os.Getenv("SMITHERS_MICROSANDBOX_BIN")
	root := os.Getenv("SMITHERS_MICROVM_LAYER_ROOT")
	if binary == "" || root == "" {
		t.Skip("SMITHERS_MICROSANDBOX_BIN and SMITHERS_MICROVM_LAYER_ROOT are required for layer builds")
	}
	runtime, err := New(context.Background(), Config{Binary: binary, Root: root, CPUs: 4, MemoryMiB: 8192, DiskMiB: 32768,
		Environments: &EnvironmentConfig{MinFreeBytes: 30 << 30}})
	require.NoError(t, err)
	t.Cleanup(func() { _ = runtime.Close() })
	return runtime
}

func TestRealMicroVMEnvironmentLayers(t *testing.T) {
	runtime := layerRuntime(t)
	repo, revision := repositoryRoot(t)
	runtime.BindSourceFiles(gitSourceFiles{dir: repo})
	ctx := operation("layers")
	started := time.Now()
	layer, err := runtime.ResolveWorkspaceLayer(ctx, workspaceapi.WorkspaceSpec{ID: "layers", Source: &workspaceapi.WorkspaceSource{Repository: "smithersai/smithers", Revision: revision}})
	require.NoError(t, err)
	t.Logf("resolved %s (key %s) in %s; link %v", layer.Snapshot, layer.Key[:12], time.Since(started).Round(time.Millisecond), layer.Link)
	records, err := runtime.environments.records()
	require.NoError(t, err)
	for _, record := range records {
		t.Logf("layer %s kind=%s build=%.0fs inventory=%v", record.Name, record.Kind, record.BuildSecs, record.Inventory)
	}
}

// A workspace boots from the dependency layer, receives the source, links
// dependencies offline, and runs a package's real test suite in the VM.
func TestRealMicroVMWorkspaceFromLayers(t *testing.T) {
	runtime := layerRuntime(t)
	repo, revision := repositoryRoot(t)
	runtime.BindSourceFiles(gitSourceFiles{dir: repo})
	ctx := operation("layered-workspace")
	id := "layered-" + newExecID()[1:9]
	started := time.Now()
	workspace, err := runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: id, Source: &workspaceapi.WorkspaceSource{Repository: "smithersai/smithers", Revision: revision}})
	require.NoError(t, err)
	t.Logf("warm create from layers: %s", time.Since(started).Round(time.Millisecond))
	defer func() { require.NoError(t, runtime.DeleteWorkspace(operation("delete"), id)) }()
	require.Equal(t, workspaceapi.WorkspaceRunning, workspace.State)

	archive, err := exec.Command("git", "-C", repo, "archive", "--format=tar", revision).Output()
	require.NoError(t, err)
	started = time.Now()
	require.NoError(t, runtime.WriteFile(ctx, id, ".seed.tar", archive, 0o600))
	result, err := runtime.ExecuteCommand(ctx, id, workspaceapi.Command{Args: []string{"sh", "-c", "tar -xf .seed.tar && rm .seed.tar"}})
	require.NoError(t, err)
	require.Equal(t, 0, result.ExitCode, result.Stderr)
	t.Logf("seed %d MiB source: %s", len(archive)>>20, time.Since(started).Round(time.Millisecond))

	started = time.Now()
	require.NoError(t, runtime.LinkWorkspaceEnvironment(ctx, id))
	t.Logf("offline link: %s", time.Since(started).Round(time.Millisecond))

	started = time.Now()
	result, err = runtime.ExecuteCommand(ctx, id, workspaceapi.Command{Args: []string{"sh", "-c",
		"cd packages/smithers/flows/canonical && pnpm exec vitest run --coverage.enabled=false 2>&1 | grep -E 'Test Files|Tests '"}, Environment: map[string]string{"NO_COLOR": "1"}})
	require.NoError(t, err)
	t.Logf("canonical tests (%s):\n%s", time.Since(started).Round(time.Millisecond), result.Stdout)
	require.Equal(t, 0, result.ExitCode)
	require.Regexp(t, `Tests\s+[0-9]+ passed`, result.Stdout)
}

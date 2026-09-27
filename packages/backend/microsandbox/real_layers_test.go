package microsandbox

import (
	"bytes"
	"context"
	"encoding/binary"
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

	// eslint and dprint from the workspace, offline: dprint's plugins come
	// from the dependency layer's cache.
	started = time.Now()
	result, err = runtime.ExecuteCommand(ctx, id, workspaceapi.Command{Directory: "packages/smithers/flows/canonical", Args: []string{"pnpm", "run", "lint"}})
	require.NoError(t, err)
	require.Equal(t, 0, result.ExitCode, result.Stdout+result.Stderr)
	t.Logf("canonical lint (eslint + dprint check, %s)", time.Since(started).Round(time.Millisecond))

	if evidence := os.Getenv("SMITHERS_MICROVM_SCREENSHOT"); evidence != "" {
		screenshotApp(t, runtime, id, evidence)
	}
}

// screenshotApp builds the app's SPA, serves it with its browser test host and
// captures it with Playwright's Chromium, all inside the VM, offline.
func screenshotApp(t *testing.T, runtime *Runtime, id, evidence string) {
	ctx := operation("screenshot")
	started := time.Now()
	result, err := runtime.ExecuteCommand(ctx, id, workspaceapi.Command{Directory: "apps/app", Args: []string{"sh", "-c",
		"node scripts/ensure-devkit.mjs && pnpm exec vite build --configLoader runner 2>&1 | tail -3"}})
	require.NoError(t, err)
	require.Equal(t, 0, result.ExitCode, result.Stdout+result.Stderr)
	t.Logf("devkit + vite build (%s): %s", time.Since(started).Round(time.Millisecond), strings.TrimSpace(result.Stdout))
	_, err = runtime.StartService(ctx, id, workspaceapi.ServiceSpec{Name: "app", ReadyAddress: "127.0.0.1:47311", ReadyTimeout: 2 * time.Minute,
		Command: workspaceapi.Command{Directory: "apps/app", Args: []string{"bun", "e2e/playwright/webserver.ts"},
			Environment: map[string]string{"SMITHERS_SKIP_SPA_BUILD": "1", "SMITHERS_LOCAL_PORT": "47311", "SMITHERS_CHAT_STUB": "1"}}})
	require.NoError(t, err)
	script := `const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto("http://127.0.0.1:47311/", { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "/workspace/.acceptance/app.png" });
  console.log(JSON.stringify({ title: await page.title(), browser: browser.version() }));
  await browser.close();
})().catch((error) => { console.error(error); process.exit(1); });`
	require.NoError(t, runtime.WriteFile(ctx, id, "apps/app/.acceptance-screenshot.cjs", []byte(script), 0o644))
	started = time.Now()
	result, err = runtime.ExecuteCommand(ctx, id, workspaceapi.Command{Directory: "apps/app", Args: []string{"sh", "-c",
		"mkdir -p /workspace/.acceptance && node .acceptance-screenshot.cjs"}})
	require.NoError(t, err)
	require.Equal(t, 0, result.ExitCode, result.Stdout+result.Stderr)
	t.Logf("screenshot (%s): %s", time.Since(started).Round(time.Millisecond), strings.TrimSpace(result.Stdout))
	png, err := runtime.ReadFile(ctx, id, ".acceptance/app.png")
	require.NoError(t, err)
	require.True(t, bytes.HasPrefix(png, []byte("\x89PNG\r\n\x1a\n")), "not a PNG")
	width, height := binary.BigEndian.Uint32(png[16:20]), binary.BigEndian.Uint32(png[20:24])
	require.Equal(t, uint32(1280), width)
	require.Equal(t, uint32(800), height)
	require.NoError(t, os.WriteFile(evidence, png, 0o644))
	t.Logf("screenshot %dx%d, %d bytes → %s", width, height, len(png), evidence)
	require.NoError(t, runtime.StopService(ctx, id, "app"))
}

// Garbage collection keeps referenced layers and the newest per family, and
// evicts least recently used layers until the owner's budget is met. The
// evidence is the host's free space, not an index row.
func TestRealMicroVMLayerGarbageCollection(t *testing.T) {
	binary, root := os.Getenv("SMITHERS_MICROSANDBOX_BIN"), os.Getenv("SMITHERS_MICROVM_LAYER_ROOT")
	if binary == "" || root == "" || os.Getenv("SMITHERS_MICROVM_GC_TEST") != "1" {
		t.Skip("SMITHERS_MICROVM_GC_TEST=1 with a layer root runs layer eviction")
	}
	runtime, err := New(context.Background(), Config{Binary: binary, Root: root,
		Environments: &EnvironmentConfig{KeepPerFamily: 1, LayerBudgetBytes: 12 << 30, MinFreeBytes: 10 << 30}})
	require.NoError(t, err)
	defer runtime.Close()
	before, err := runtime.environments.records()
	require.NoError(t, err)
	report, err := runtime.CollectLayers(context.Background())
	require.NoError(t, err)
	after, err := runtime.environments.records()
	require.NoError(t, err)
	t.Logf("layers %d → %d; removed %v", len(before), len(after), report.Removed)
	t.Logf("owner layer bytes (allocated, clone-inclusive) %.1f GiB → %.1f GiB; host free %.1f GiB → %.1f GiB",
		float64(report.LayerBytesBefore)/(1<<30), float64(report.LayerBytesAfter)/(1<<30),
		float64(report.FreeBytesBefore)/(1<<30), float64(report.FreeBytesAfter)/(1<<30))
	require.LessOrEqual(t, report.LayerBytesAfter, int64(12<<30))
	names, err := runtime.cli.listSnapshots(context.Background())
	require.NoError(t, err)
	for _, removed := range report.Removed {
		for _, snapshot := range names {
			require.NotEqual(t, removed, *snapshot.Name, "removed layer still indexed")
		}
	}
}

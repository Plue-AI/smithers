package microsandbox

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/smithersai/smithers/packages/backend/workspaceconformance"
)

// realRuntime boots against the real Microsandbox on this host. It is skipped
// unless SMITHERS_MICROSANDBOX_BIN names msb; a release gate sets
// SMITHERS_REQUIRE_MICROVM_TESTS=1 so a missing msb fails instead.
func realRuntime(t *testing.T, root string) *Runtime {
	t.Helper()
	binary := os.Getenv("SMITHERS_MICROSANDBOX_BIN")
	if binary == "" {
		if os.Getenv("SMITHERS_REQUIRE_MICROVM_TESTS") == "1" {
			t.Fatal("SMITHERS_MICROSANDBOX_BIN is required for microVM tests")
		}
		t.Skip("SMITHERS_MICROSANDBOX_BIN is not set")
	}
	runtime, err := New(context.Background(), Config{Binary: binary, Root: root, CPUs: 2, MemoryMiB: 2048, DiskMiB: 8192, MaxRunningVMs: 3})
	require.NoError(t, err)
	t.Cleanup(func() { sweepOwner(t, runtime) })
	return runtime
}

// sweepOwner removes every machine and snapshot this test's owner created,
// whatever the test did, so a failure never leaks disk.
func sweepOwner(t *testing.T, runtime *Runtime) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	_ = runtime.Close()
	records, err := runtime.cli.listSandboxes(ctx, map[string]string{ownerLabel: runtime.owner})
	if err == nil {
		for _, record := range records {
			_ = runtime.removeMachine(ctx, record.Name)
		}
	}
	snapshots, err := runtime.cli.listSnapshots(ctx)
	if err == nil {
		prefix := strings.TrimPrefix(runtime.owner, "smithers-backend-")[:8]
		for _, snapshot := range snapshots {
			if snapshot.Name != nil && strings.Contains(*snapshot.Name, "-"+prefix+"-") {
				_, _ = runtime.cli.run(ctx, nil, "snapshot", "remove", "-q", *snapshot.Name)
			}
		}
	}
	remaining, _ := runtime.cli.listSandboxes(ctx, map[string]string{ownerLabel: runtime.owner})
	if len(remaining) != 0 {
		t.Errorf("owner %s still has %d machines after cleanup", runtime.owner, len(remaining))
	}
}

func operation(id string) context.Context {
	return workspaceapi.WithOperation(context.Background(), workspaceapi.Operation{TenantID: "owner", PrincipalID: "owner", OperationID: id})
}

func TestRealMicroVMWorkspaceConformance(t *testing.T) {
	runtime := realRuntime(t, t.TempDir())
	workspaceconformance.RunCore(t, workspaceconformance.CoreHarness{
		Runtime:       runtime,
		Context:       operation,
		Spec:          workspaceapi.WorkspaceSpec{ID: "microvm-conformance"},
		CreateStates:  []workspaceapi.WorkspaceState{workspaceapi.WorkspaceRunning},
		Command:       workspaceapi.Command{Args: []string{"/bin/sh", "-c", "printf conformance-ok"}},
		WantStdout:    "conformance-ok",
		FilePath:      "nested/fixture.txt",
		FileContent:   []byte("persistent fixture\n"),
		FileMode:      0o640,
		WantIsolation: workspaceapi.IsolationSandboxed,
		WantCapabilities: workspaceapi.WorkspaceCapabilities{
			PersistentFiles: true, Execution: true, ManagedServices: true, ManagedHTTPHosts: true, SourceRevision: true,
			Terminal: true, LoopbackPreview: true, FileOperations: true, ColdSnapshots: true,
		},
	})
	workspaceconformance.RunColdSnapshots(t, workspaceconformance.SnapshotHarness{
		Runtime: runtime, Snapshots: runtime, Context: operation,
		Source:   workspaceapi.WorkspaceSpec{ID: "microvm-snapshot-source"},
		Fork:     workspaceapi.WorkspaceSpec{ID: "microvm-snapshot-fork"},
		Snapshot: workspaceapi.ColdSnapshotSpec{ID: "microvm-snapshot"},
		FilePath: "snapshot/fixture.txt", FileContent: []byte("snapshot fixture\n"), FileMode: 0o600,
	})
}

func TestRealMicroVMGuestFacts(t *testing.T) {
	runtime := realRuntime(t, t.TempDir())
	ctx := operation("facts")
	_, err := runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: "microvm-facts"})
	require.NoError(t, err)
	defer func() { require.NoError(t, runtime.DeleteWorkspace(operation("delete"), "microvm-facts")) }()

	result, err := runtime.ExecuteCommand(ctx, "microvm-facts", workspaceapi.Command{Args: []string{"/bin/sh", "-c",
		`uname -sm; id -un; pwd; echo "$TMPDIR"; echo err >&2; exit 3`}})
	require.NoError(t, err)
	require.Equal(t, 3, result.ExitCode)
	require.Equal(t, "Linux aarch64\nagent\n/workspace\n/var/tmp/smithers\n", result.Stdout)
	require.Equal(t, "err\n", result.Stderr)

	// The host is unreachable except through the declared bridge ports, and
	// the internet is denied.
	result, err = runtime.ExecuteCommand(ctx, "microvm-facts", workspaceapi.Command{Args: []string{"/bin/sh", "-c",
		`curl -s -m 5 -o /dev/null https://registry.npmjs.org/ && echo reachable || echo denied`}})
	require.NoError(t, err)
	require.Equal(t, "denied\n", result.Stdout)

	_, err = runtime.ExecuteCommand(ctx, "microvm-facts", workspaceapi.Command{Args: []string{"/does/not/exist"}})
	require.NoError(t, err)
	result, err = runtime.ExecuteCommand(ctx, "microvm-facts", workspaceapi.Command{Args: []string{"true"}, Directory: "../etc"})
	require.Error(t, err)

	result, err = runtime.ExecuteCommand(ctx, "microvm-facts", workspaceapi.Command{Args: []string{"sh", "-c", "echo $SECRET_SHAPED"},
		Environment: map[string]string{"SECRET_SHAPED": "sentinel-value"}})
	require.NoError(t, err)
	require.Equal(t, "sentinel-value\n", result.Stdout)

	_, err = runtime.ReadFile(ctx, "microvm-facts", "../../etc/passwd")
	require.Error(t, err)
	require.NoError(t, runtime.WriteFile(ctx, "microvm-facts", "a/b.txt", []byte("x"), 0o644))
	entries, err := runtime.ListFiles(ctx, "microvm-facts", "a")
	require.NoError(t, err)
	require.Len(t, entries, 1)
	require.Equal(t, "b.txt", entries[0].Name)
}

// Cancellation must end the command and everything it started, including a
// descendant that detached into its own session.
func TestRealMicroVMCancellationKillsGuestWork(t *testing.T) {
	runtime := realRuntime(t, t.TempDir())
	ctx := operation("cancel")
	_, err := runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: "microvm-cancel"})
	require.NoError(t, err)
	defer func() { require.NoError(t, runtime.DeleteWorkspace(operation("delete"), "microvm-cancel")) }()

	runCtx, cancel := context.WithCancel(ctx)
	finished := make(chan error, 1)
	go func() {
		_, err := runtime.ExecuteCommand(runCtx, "microvm-cancel", workspaceapi.Command{Args: []string{"/bin/sh", "-c",
			`setsid sleep 3011 </dev/null >/dev/null 2>&1 & exec sleep 3012`}})
		finished <- err
	}()
	require.Eventually(t, func() bool {
		result, err := runtime.ExecuteCommand(ctx, "microvm-cancel", workspaceapi.Command{Args: []string{"sh", "-c", "ps -eo args | grep -c '^sleep 301[12]$'"}})
		return err == nil && strings.TrimSpace(result.Stdout) == "2"
	}, 30*time.Second, 200*time.Millisecond)
	cancel()
	select {
	case err := <-finished:
		require.ErrorIs(t, err, context.Canceled)
	case <-time.After(30 * time.Second):
		t.Fatal("cancelled command did not return")
	}
	result, err := runtime.ExecuteCommand(ctx, "microvm-cancel", workspaceapi.Command{Args: []string{"sh", "-c", "ps -eo args | grep -c '^sleep 301[12]$' || true"}})
	require.NoError(t, err)
	require.Equal(t, "0", strings.TrimSpace(result.Stdout), "guest processes survived cancellation")

	// A command that exits while a daemon it started is still running does not
	// leave the daemon behind.
	result, err = runtime.ExecuteCommand(ctx, "microvm-cancel", workspaceapi.Command{Args: []string{"/bin/sh", "-c",
		`setsid sleep 3013 </dev/null >/dev/null 2>&1 & echo started`}})
	require.NoError(t, err)
	require.Equal(t, "started\n", result.Stdout)
	result, err = runtime.ExecuteCommand(ctx, "microvm-cancel", workspaceapi.Command{Args: []string{"sh", "-c", "ps -eo args | grep -c '^sleep 3013$' || true"}})
	require.NoError(t, err)
	require.Equal(t, "0", strings.TrimSpace(result.Stdout))
}

func TestRealMicroVMServicePreviewAndRestart(t *testing.T) {
	root := t.TempDir()
	runtime := realRuntime(t, root)
	ctx := operation("service")
	_, err := runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: "microvm-service"})
	require.NoError(t, err)
	require.NoError(t, runtime.WriteFile(ctx, "microvm-service", "index.html", []byte("hello from the guest\n"), 0o644))
	_, err = runtime.StartService(ctx, "microvm-service", workspaceapi.ServiceSpec{Name: "web",
		Command:      workspaceapi.Command{Args: []string{"python3", "-m", "http.server", "18080", "--bind", "127.0.0.1"}},
		ReadyAddress: "127.0.0.1:18080", ReadyTimeout: 30 * time.Second})
	require.NoError(t, err)
	target, err := runtime.PreviewTarget(ctx, "microvm-service", 18080)
	require.NoError(t, err)
	response, err := http.Get(target.URL + "/index.html")
	require.NoError(t, err)
	body, _ := io.ReadAll(response.Body)
	_ = response.Body.Close()
	require.Equal(t, "hello from the guest\n", string(body))

	client := runtime.httpClient("microvm-service", 18080)
	response, err = client.Get("http://guest/index.html")
	require.NoError(t, err)
	body, _ = io.ReadAll(response.Body)
	_ = response.Body.Close()
	require.Equal(t, "hello from the guest\n", string(body))

	// A new backend process over the same state reattaches the same VM and
	// its files; the previous process's services are not inferred alive.
	require.NoError(t, runtime.Close())
	restarted, err := New(context.Background(), Config{Binary: runtime.config.Binary, Root: root, CPUs: 2, MemoryMiB: 2048, DiskMiB: 8192})
	require.NoError(t, err)
	t.Cleanup(func() { sweepOwner(t, restarted) })
	observed, err := restarted.InspectWorkspace(ctx, "microvm-service")
	require.NoError(t, err)
	require.Equal(t, workspaceapi.WorkspaceStopped, observed.State)
	_, err = restarted.StartWorkspace(ctx, "microvm-service")
	require.NoError(t, err)
	content, err := restarted.ReadFile(ctx, "microvm-service", "index.html")
	require.NoError(t, err)
	require.Equal(t, "hello from the guest\n", string(content))
	require.NoError(t, restarted.DeleteWorkspace(ctx, "microvm-service"))
}

func TestRealMicroVMTerminalAndManagedHost(t *testing.T) {
	runtime := realRuntime(t, t.TempDir())
	ctx := operation("terminal")
	_, err := runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: "microvm-terminal"})
	require.NoError(t, err)
	defer func() { require.NoError(t, runtime.DeleteWorkspace(operation("delete"), "microvm-terminal")) }()

	terminal, err := runtime.OpenWorkspaceTerminal(ctx, "microvm-terminal", workspaceapi.Command{Args: []string{"/bin/bash", "--norc", "-i"}})
	require.NoError(t, err)
	require.NoError(t, terminal.Resize(ctx, 120, 40))
	_, err = terminal.Write([]byte("echo tty-$((40+2)) $(tput cols); id -un\n"))
	require.NoError(t, err)
	var seen strings.Builder
	deadline := time.Now().Add(20 * time.Second)
	buffer := make([]byte, 4096)
	for !strings.Contains(seen.String(), "tty-42 120") && time.Now().Before(deadline) {
		n, err := terminal.Read(buffer)
		seen.Write(buffer[:n])
		if err != nil {
			break
		}
	}
	require.Contains(t, seen.String(), "tty-42 120")
	require.NoError(t, terminal.Close())

	expected := workspaceapi.ManagedHostIdentity{Protocol: "test/v1", ArtifactDigest: strings.Repeat("a", 64), SourceRevision: strings.Repeat("b", 40), OwnerGeneration: 1}
	spec := workspaceapi.ManagedHostSpec{ID: "binding-1", Name: "flow-host", Identity: "identity-1", Expected: expected, ReadyTimeout: 30 * time.Second,
		Builder: workspaceapi.ManagedHostBuilderFunc(func(_ context.Context, placement workspaceapi.ManagedHostPlacement) (workspaceapi.Command, error) {
			require.Equal(t, "127.0.0.1", placement.Host)
			require.True(t, strings.HasPrefix(placement.StateDir, "/var/lib/smithers/state/managed-hosts/"))
			return workspaceapi.Command{Args: []string{"python3", "-m", "http.server", fmt.Sprint(placement.Port), "--bind", "127.0.0.1", "--directory", placement.StateDir}}, nil
		}),
		Probe: workspaceapi.ManagedHostProbeFunc(func(ctx context.Context, connection workspaceapi.ManagedHostConnection) (workspaceapi.ManagedHostIdentity, error) {
			request, _ := http.NewRequestWithContext(ctx, http.MethodGet, connection.Endpoint+"/binding.json", nil)
			response, err := connection.HTTPClient.Do(request)
			if err != nil {
				return workspaceapi.ManagedHostIdentity{}, err
			}
			defer response.Body.Close()
			body, _ := io.ReadAll(response.Body)
			if !strings.Contains(string(body), "binding-1") {
				return workspaceapi.ManagedHostIdentity{}, fmt.Errorf("unexpected body %q", body)
			}
			return expected, nil
		}),
	}
	_, err = runtime.InspectManagedHost(ctx, "microvm-terminal", spec)
	require.ErrorIs(t, err, workspaceapi.ErrManagedHostNotRunning)
	connection, err := runtime.StartManagedHost(ctx, "microvm-terminal", spec)
	require.NoError(t, err)
	require.NotNil(t, connection.HTTPClient)
	again, err := runtime.InspectManagedHost(ctx, "microvm-terminal", spec)
	require.NoError(t, err)
	require.Equal(t, connection.Endpoint, again.Endpoint)
	require.NoError(t, runtime.StopService(ctx, "microvm-terminal", "flow-host"))
	_, err = runtime.InspectManagedHost(ctx, "microvm-terminal", spec)
	require.ErrorIs(t, err, workspaceapi.ErrManagedHostNotRunning)
}

// A workspace whose microVM disappears fails its operations; nothing runs on
// the host in its place.
func TestRealMicroVMLostMachineRefusesWithoutHostFallback(t *testing.T) {
	runtime := realRuntime(t, t.TempDir())
	ctx := operation("lost")
	_, err := runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: "microvm-lost"})
	require.NoError(t, err)
	machine := runtime.machineName("microvm-lost")
	require.NoError(t, runtime.removeMachine(context.Background(), machine))

	sentinel := filepath.Join(t.TempDir(), "ran-on-host")
	_, err = runtime.ExecuteCommand(ctx, "microvm-lost", workspaceapi.Command{Args: []string{"/bin/sh", "-c", "touch " + sentinel}})
	require.ErrorIs(t, err, ErrUnavailable)
	_, statErr := os.Stat(sentinel)
	require.True(t, errors.Is(statErr, fs.ErrNotExist), "the command ran on the host")
	_, err = runtime.ReadFile(ctx, "microvm-lost", "anything")
	require.Error(t, err)

	// A restart marks the workspace as needing recovery instead of inventing one.
	require.NoError(t, runtime.Close())
	restarted, err := New(context.Background(), Config{Binary: runtime.config.Binary, Root: runtime.root})
	require.NoError(t, err)
	observed, err := restarted.InspectWorkspace(ctx, "microvm-lost")
	require.NoError(t, err)
	require.Equal(t, workspaceapi.WorkspaceRecoveryRequired, observed.State)
	require.NoError(t, restarted.DeleteWorkspace(ctx, "microvm-lost"))
	require.NoError(t, restarted.Close())
}

package microsandbox

import (
	"bufio"
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

	"github.com/smithersai/smithers/packages/backend/installbundle"
	"github.com/smithersai/smithers/packages/backend/installbundle/bundletest"
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
	config := Config{Binary: binary, Root: root, CPUs: 2, MemoryMiB: 2048, DiskMiB: 8192, MaxRunningVMs: 3}
	if bundlePath := os.Getenv("SMITHERS_CHECK_BUNDLE"); bundlePath != "" {
		bundle, err := installbundle.Open(bundlePath)
		require.NoError(t, err)
		config.Bundle, config.Binary = bundle, ""
		config.Root = bundletest.ProtectedTempDir(t)
	}
	runtime, err := New(context.Background(), config)
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
		Runtime: runtime,
		Reopen: func() (workspaceapi.WorkspaceRuntime, error) {
			if err := runtime.Close(); err != nil {
				return nil, err
			}
			reopened, err := New(context.Background(), runtime.config)
			if err == nil {
				runtime = reopened
				t.Cleanup(func() { sweepOwner(t, reopened) })
			}
			return reopened, err
		},
		Context:       operation,
		Spec:          workspaceapi.WorkspaceSpec{ID: "microvm-conformance"},
		CreateStates:  []workspaceapi.WorkspaceState{workspaceapi.WorkspaceRunning},
		Command:       workspaceapi.Command{Args: []string{"/bin/sh", "-c", "printf conformance-ok"}},
		WantStdout:    "conformance-ok",
		DeniedEgress:  &workspaceapi.Command{Args: []string{"/bin/sh", "-c", "curl -sS -m 5 -o /dev/null https://registry.npmjs.org/ && printf reachable || printf denied"}},
		FilePath:      "nested/fixture.txt",
		FileContent:   []byte("persistent fixture\n"),
		FileMode:      0o640,
		WantIsolation: workspaceapi.IsolationSandboxed,
		TerminalError: ErrUnavailable,
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

func TestRealMicroVMCapacityConformance(t *testing.T) {
	runtime := realRuntime(t, t.TempDir())
	runtime.SetCapacityReader(func(context.Context) (int, error) { return 0, nil })
	workspaceconformance.RunCapacityRefusal(t, runtime, operation("capacity-refusal"), workspaceapi.WorkspaceSpec{ID: "capacity-refused"}, func(err error) bool {
		var refusal *CapacityError
		return errors.As(err, &refusal) && refusal.Code == "machine_capacity" && refusal.Class == "capacity"
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
	require.NoError(t, writeGuestFixture(runtime, ctx, "microvm-facts", "a/b.txt", []byte("x"), 0o644))
	entries, err := runtime.ListFiles(ctx, "microvm-facts", "a")
	require.NoError(t, err)
	require.Len(t, entries, 1)
	require.Equal(t, "b.txt", entries[0].Name)
}

// C-APP-03's failure must originate in the guest, rather than a served TODO
// fixture. The public runner must retain the guest exit and the image action's
// literal package/file attribution together.
func TestRealMicroVMMissingImagePackage(t *testing.T) {
	runtime := realRuntime(t, t.TempDir())
	ctx := operation("missing-image-package")
	const id = "missing-image-package"
	_, err := runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: id})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.DeleteWorkspace(operation("delete"), id)) })

	result, err := runtime.ExecuteCommand(ctx, id, workspaceapi.Command{Args: []string{"/bin/sh", "-c", "figlet ok"}})
	var failure *RecipeError
	require.ErrorAs(t, err, &failure)
	require.Equal(t, 127, result.ExitCode)
	require.Contains(t, result.Stderr, "figlet")
	require.Equal(t, "missing_machine_tool", failure.Code)
	require.Equal(t, "user", failure.Class)
	require.Equal(t, &MissingTool{Name: "figlet", File: ".smithers/machine.json"}, failure.MissingTool)
	require.Contains(t, failure.Message, "figlet")
	require.Contains(t, failure.Message, ".smithers/machine.json")
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
	require.NoError(t, writeGuestFixture(runtime, ctx, "microvm-service", "index.html", []byte("hello from the guest\n"), 0o644))
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
	restarted, err := New(context.Background(), runtime.config)
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

func TestRealMicroVMManagedHost(t *testing.T) {
	runtime := realRuntime(t, t.TempDir())
	ctx := operation("terminal")
	_, err := runtime.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: "microvm-terminal"})
	require.NoError(t, err)
	defer func() { require.NoError(t, runtime.DeleteWorkspace(operation("delete"), "microvm-terminal")) }()

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
	if runtime.config.Bundle != nil {
		// Installed managed hosts require the composed run admission providers.
		// This adapter fixture has none: prove refusal, then exercise the R3
		// service relay through its ordinary unprivileged execution boundary.
		_, err = runtime.StartManagedHost(ctx, "microvm-terminal", spec)
		require.EqualError(t, err, "session credential: invalid token")
		require.NoError(t, writeGuestFixture(runtime, ctx, "microvm-terminal", "relay-control.txt", []byte("guest-relay-control\n"), 0o644))
		_, err = runtime.StartService(ctx, "microvm-terminal", workspaceapi.ServiceSpec{
			Name: "relay-control", Command: workspaceapi.Command{Args: []string{"/usr/bin/python3", "-I", "-S", "-m", "http.server", "18081", "--bind", "127.0.0.1", "--directory", "/workspace"}},
			ReadyAddress: "127.0.0.1:18081", ReadyTimeout: 30 * time.Second,
		})
		require.NoError(t, err)
		connection, err := runtime.DialWorkspacePort(ctx, "microvm-terminal", workspaceapi.PortRequest{Port: 18081})
		require.NoError(t, err)
		defer connection.Close()
		require.NoError(t, connection.SetDeadline(time.Now().Add(30*time.Second)))
		_, err = io.WriteString(connection, "GET /relay-control.txt HTTP/1.0\r\nHost: guest\r\n\r\n")
		require.NoError(t, err)
		response, err := http.ReadResponse(bufio.NewReader(connection), nil)
		require.NoError(t, err)
		defer response.Body.Close()
		require.Equal(t, http.StatusOK, response.StatusCode)
		body, err := io.ReadAll(response.Body)
		require.NoError(t, err)
		require.Equal(t, "guest-relay-control\n", string(body))
		require.NoError(t, runtime.StopService(ctx, "microvm-terminal", "relay-control"))
		return
	}
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
	restarted, err := New(context.Background(), runtime.config)
	require.NoError(t, err)
	observed, err := restarted.InspectWorkspace(ctx, "microvm-lost")
	require.NoError(t, err)
	require.Equal(t, workspaceapi.WorkspaceRecoveryRequired, observed.State)
	require.NoError(t, restarted.DeleteWorkspace(ctx, "microvm-lost"))
	require.NoError(t, restarted.Close())
}

// This reference-host campaign measures real stopped disks, not model usage or
// TODO admission. Run separately from conformance: twenty 32 GiB sparse disks
// are retained simultaneously while at most one guest runs.
func TestRealMicroVMTwentyRetainedDisks(t *testing.T) {
	if os.Getenv("SMITHERS_TWENTY_DISK_CHECK") != "1" {
		t.Skip("set SMITHERS_TWENTY_DISK_CHECK=1 for the reference-host campaign")
	}
	binary := os.Getenv("SMITHERS_MICROSANDBOX_BIN")
	require.NotEmpty(t, binary)
	r, err := New(context.Background(), Config{Binary: binary, Root: t.TempDir(), CPUs: 2, MemoryMiB: 2048, DiskMiB: 32768, MaxRunningVMs: 1})
	require.NoError(t, err)
	t.Cleanup(func() { sweepOwner(t, r) })
	ctx, cancel := context.WithTimeout(operation("twenty-retained-disks"), 15*time.Minute)
	defer cancel()
	var allocated, private int64
	for i := 0; i < 20; i++ {
		id := fmt.Sprintf("held-todo-%02d", i)
		_, err := r.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: id})
		require.NoError(t, err)
		content := []byte(fmt.Sprintf("uncommitted notes for TODO %02d\n", i))
		require.NoError(t, writeGuestFixture(r, ctx, id, "notes.txt", content, 0o600))
		require.NoError(t, r.StopWorkspace(ctx, id))
		observed, err := r.InspectWorkspace(ctx, id)
		require.NoError(t, err)
		require.Equal(t, workspaceapi.WorkspaceStopped, observed.State)
		r.mu.Lock()
		machine := r.workspaces[id].Machine
		r.mu.Unlock()
		directory := machineDirectory(r.cli.home, machine)
		info, err := os.Stat(directory)
		require.NoError(t, err)
		require.True(t, info.IsDir())
		a, p := allocatedBytes(directory), privateBytes(directory)
		require.Positive(t, a)
		allocated += a
		private += p
		t.Logf("disk=%s logical_capacity_bytes=%d allocated_bytes=%d private_bytes=%d", id, int64(32)<<30, a, p)
	}
	t.Logf("retained_disks=20 allocated_bytes=%d private_bytes=%d; allocated blocks can double-count APFS clones; excludes shared images and layers", allocated, private)
	require.NoError(t, r.Close())
	reopened, err := New(context.Background(), r.config)
	require.NoError(t, err)
	t.Cleanup(func() { sweepOwner(t, reopened) })
	for i := 0; i < 20; i++ {
		id := fmt.Sprintf("held-todo-%02d", i)
		observed, err := reopened.InspectWorkspace(ctx, id)
		require.NoError(t, err)
		require.Equal(t, workspaceapi.WorkspaceStopped, observed.State)
		_, err = reopened.StartWorkspace(ctx, id)
		require.NoError(t, err)
		content, err := reopened.ReadFile(ctx, id, "notes.txt")
		require.NoError(t, err)
		require.Equal(t, fmt.Sprintf("uncommitted notes for TODO %02d\n", i), string(content))
		require.NoError(t, reopened.StopWorkspace(ctx, id))
	}
}

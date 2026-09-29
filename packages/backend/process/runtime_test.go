//go:build unix

package process

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

func newTestRuntime(t *testing.T, root string, options ...func(*Config)) *Runtime {
	t.Helper()
	config := Config{Root: root, MaxConcurrent: 2, OutputLimit: 64, TerminationGrace: 100 * time.Millisecond}
	for _, option := range options {
		option(&config)
	}
	runtime, err := New(config)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	return runtime
}

func TestInterruptedCreateDoesNotBrickRuntime(t *testing.T) {
	root := t.TempDir()
	runtime := newTestRuntime(t, root)
	healthy, err := runtime.CreateWorkspace(context.Background(), workspaceapi.WorkspaceSpec{ID: "healthy"})
	require.NoError(t, err)
	require.NoError(t, runtime.Close())

	interrupted := filepath.Join(root, "workspaces", workspaceDirectoryName("interrupted"))
	require.NoError(t, os.Mkdir(interrupted, 0o700))
	require.NoError(t, ensureWorkspaceDirectories(interrupted))
	require.NoError(t, os.WriteFile(filepath.Join(interrupted, "root", "uncommitted"), []byte("preserve"), 0o600))

	reopened := newTestRuntime(t, root)
	loaded, err := reopened.InspectWorkspace(context.Background(), healthy.ID)
	require.NoError(t, err)
	assert.Equal(t, healthy.Root, loaded.Root)
	_, err = reopened.CreateWorkspace(context.Background(), workspaceapi.WorkspaceSpec{ID: "interrupted"})
	require.NoError(t, err)
	entries, err := os.ReadDir(filepath.Join(root, "workspaces"))
	require.NoError(t, err)
	found := false
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), ".incomplete-") {
			continue
		}
		contents, readErr := os.ReadFile(filepath.Join(root, "workspaces", entry.Name(), workspaceDirectoryName("interrupted"), "root", "uncommitted"))
		if readErr == nil && string(contents) == "preserve" {
			found = true
		}
	}
	assert.True(t, found, "incomplete workspace data must be retained for recovery")
}

func TestRuntimePersistentLifecycleControlledEnvironmentAndFiles(t *testing.T) {
	dataRoot := t.TempDir()
	t.Setenv("SMITHERS_UNSAFE_INHERITED", "must-not-leak")
	runtime := newTestRuntime(t, dataRoot, func(config *Config) { config.OutputLimit = 512 })
	assert.Equal(t, workspaceapi.IsolationTrustedProcess, runtime.Isolation())
	capabilities := runtime.Capabilities()
	assert.True(t, capabilities.PersistentFiles)
	assert.True(t, capabilities.Terminal)
	assert.False(t, capabilities.ColdSnapshots)

	workspace, err := runtime.CreateWorkspace(context.Background(), workspaceapi.WorkspaceSpec{ID: "owner/repository/workspace"})
	require.NoError(t, err)
	assert.Equal(t, workspaceapi.WorkspaceStopped, workspace.State)
	assert.NotEqual(t, workspace.Root, workspace.Home)
	_, err = runtime.ExecuteCommand(context.Background(), workspace.ID, workspaceapi.Command{Args: []string{"/bin/sh", "-c", "true"}})
	require.ErrorIs(t, err, workspaceapi.ErrWorkspaceStopped)

	workspace, err = runtime.StartWorkspace(context.Background(), workspace.ID)
	require.NoError(t, err)
	require.NoError(t, os.Mkdir(filepath.Join(workspace.Root, "src"), 0o700))
	require.NoError(t, runtime.WriteFile(context.Background(), workspace.ID, "src/main.txt", []byte("persistent"), 0o640))
	contents, err := runtime.ReadFile(context.Background(), workspace.ID, "src/main.txt")
	require.NoError(t, err)
	assert.Equal(t, "persistent", string(contents))
	entries, err := runtime.ListFiles(context.Background(), workspace.ID, "src")
	require.NoError(t, err)
	require.Len(t, entries, 1)
	assert.Equal(t, "main.txt", entries[0].Name)
	assert.Equal(t, os.FileMode(0o640), entries[0].Mode.Perm())

	result, err := runtime.ExecuteCommand(context.Background(), workspace.ID, workspaceapi.Command{
		Args:        []string{"/bin/sh", "-c", `printf '%s\n%s\n%s\n' "$HOME" "${SMITHERS_UNSAFE_INHERITED-unset}" "$XDG_CONFIG_HOME"; i=0; while [ "$i" -lt 600 ]; do printf x; i=$((i+1)); done`},
		Environment: map[string]string{"HOME": "/untrusted/override"},
	})
	require.NoError(t, err)
	assert.Equal(t, 0, result.ExitCode)
	assert.Contains(t, result.Stdout, workspace.Home)
	assert.NotContains(t, result.Stdout, "must-not-leak")
	assert.True(t, result.OutputTruncated)

	outside := filepath.Join(dataRoot, "outside")
	require.NoError(t, os.WriteFile(outside, []byte("outside"), 0o600))
	require.NoError(t, os.Symlink(outside, filepath.Join(workspace.Root, "escape")))
	_, err = runtime.ReadFile(context.Background(), workspace.ID, "escape")
	require.Error(t, err)
	require.Error(t, runtime.WriteFile(context.Background(), workspace.ID, "escape", []byte("overwrite"), 0o600))
	outsideContents, err := os.ReadFile(outside)
	require.NoError(t, err)
	assert.Equal(t, "outside", string(outsideContents))
	require.NoError(t, os.Symlink(filepath.Join(workspace.Root, "src", "main.txt"), filepath.Join(workspace.Root, "inside-link")))
	require.Error(t, runtime.WriteFile(context.Background(), workspace.ID, "inside-link", []byte("overwrite"), 0o600))
	require.NoError(t, runtime.RemoveFile(context.Background(), workspace.ID, "inside-link"))
	_, err = os.Lstat(filepath.Join(workspace.Root, "inside-link"))
	require.ErrorIs(t, err, os.ErrNotExist)
	contents, err = runtime.ReadFile(context.Background(), workspace.ID, "src/main.txt")
	require.NoError(t, err)
	assert.Equal(t, "persistent", string(contents))

	runtime.fileReadLimit = 4
	_, err = runtime.ReadFile(context.Background(), workspace.ID, "src/main.txt")
	require.ErrorContains(t, err, "exceeds read limit")
	runtime.fileReadLimit = 16 << 20

	require.NoError(t, runtime.StopWorkspace(context.Background(), workspace.ID))
	require.NoError(t, runtime.Close())
	reloaded, err := New(Config{Root: dataRoot})
	require.NoError(t, err)
	defer func() { require.NoError(t, reloaded.Close()) }()
	observed, err := reloaded.InspectWorkspace(context.Background(), workspace.ID)
	require.NoError(t, err)
	assert.Equal(t, workspaceapi.WorkspaceStopped, observed.State)
	contents, err = reloaded.ReadFile(context.Background(), workspace.ID, "src/main.txt")
	require.NoError(t, err)
	assert.Equal(t, "persistent", string(contents))
	require.NoError(t, reloaded.DeleteWorkspace(context.Background(), workspace.ID))
	_, err = reloaded.InspectWorkspace(context.Background(), workspace.ID)
	require.ErrorIs(t, err, workspaceapi.ErrWorkspaceNotFound)
}

func TestRuntimeCancellationTerminatesAndReapsProcessGroup(t *testing.T) {
	runtime := newTestRuntime(t, t.TempDir())
	workspace, err := runtime.CreateWorkspace(context.Background(), workspaceapi.WorkspaceSpec{ID: "cancel"})
	require.NoError(t, err)
	_, err = runtime.StartWorkspace(context.Background(), workspace.ID)
	require.NoError(t, err)

	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		_, executeErr := runtime.ExecuteCommand(ctx, workspace.ID, workspaceapi.Command{Args: []string{"/bin/sh", "-c", "sleep 30 & echo $! > child.pid; wait"}})
		result <- executeErr
	}()
	pidPath := filepath.Join(workspace.Root, "child.pid")
	require.Eventually(t, func() bool {
		contents, readErr := os.ReadFile(pidPath)
		return readErr == nil && strings.TrimSpace(string(contents)) != ""
	}, 2*time.Second, 10*time.Millisecond)
	pidBytes, err := os.ReadFile(pidPath)
	require.NoError(t, err)
	pid, err := strconv.Atoi(strings.TrimSpace(string(pidBytes)))
	require.NoError(t, err)
	cancel()
	require.ErrorIs(t, <-result, context.Canceled)
	require.Eventually(t, func() bool {
		err := syscall.Kill(pid, 0)
		return errors.Is(err, syscall.ESRCH)
	}, 2*time.Second, 10*time.Millisecond, "child process %d survived cancellation", pid)
}

func TestRuntimeSerializesStopAgainstRestart(t *testing.T) {
	runtime := newTestRuntime(t, t.TempDir(), func(config *Config) { config.TerminationGrace = 300 * time.Millisecond })
	workspace, err := runtime.CreateWorkspace(context.Background(), workspaceapi.WorkspaceSpec{ID: "lifecycle"})
	require.NoError(t, err)
	_, err = runtime.StartWorkspace(context.Background(), workspace.ID)
	require.NoError(t, err)
	_, err = runtime.StartService(context.Background(), workspace.ID, workspaceapi.ServiceSpec{
		Name: "stubborn", Command: workspaceapi.Command{Args: []string{"/bin/sh", "-c", "trap '' TERM; : > stubborn.ready; while :; do sleep 1; done"}},
	})
	require.NoError(t, err)
	require.Eventually(t, func() bool {
		_, statErr := os.Stat(filepath.Join(workspace.Root, "stubborn.ready"))
		return statErr == nil
	}, time.Second, 5*time.Millisecond)

	stopped := make(chan error, 1)
	go func() { stopped <- runtime.StopWorkspace(context.Background(), workspace.ID) }()
	require.Eventually(t, func() bool {
		observed, inspectErr := runtime.InspectWorkspace(context.Background(), workspace.ID)
		return inspectErr == nil && observed.State == workspaceapi.WorkspaceStopping
	}, time.Second, 5*time.Millisecond)
	_, err = runtime.StartWorkspace(context.Background(), workspace.ID)
	require.ErrorContains(t, err, "stop is in progress")
	require.NoError(t, <-stopped)
	observed, err := runtime.InspectWorkspace(context.Background(), workspace.ID)
	require.NoError(t, err)
	assert.Equal(t, workspaceapi.WorkspaceStopped, observed.State)
}

func TestRuntimeManagedServiceDistinguishesStopFromFailure(t *testing.T) {
	runtime := newTestRuntime(t, t.TempDir())
	workspace, err := runtime.CreateWorkspace(context.Background(), workspaceapi.WorkspaceSpec{ID: "service-state"})
	require.NoError(t, err)
	_, err = runtime.StartWorkspace(context.Background(), workspace.ID)
	require.NoError(t, err)

	_, err = runtime.StartService(context.Background(), workspace.ID, workspaceapi.ServiceSpec{
		Name: "stopped", Command: workspaceapi.Command{Args: []string{"/bin/sh", "-c", "sleep 30"}},
	})
	require.NoError(t, err)
	require.NoError(t, runtime.StopService(context.Background(), workspace.ID, "stopped"))
	stopped, err := runtime.InspectService(context.Background(), workspace.ID, "stopped")
	require.NoError(t, err)
	assert.Equal(t, workspaceapi.ServiceStopped, stopped.State)

	_, err = runtime.StartService(context.Background(), workspace.ID, workspaceapi.ServiceSpec{
		Name: "failed", Command: workspaceapi.Command{Args: []string{"/bin/sh", "-c", "sleep 0.05; exit 7"}},
	})
	require.NoError(t, err)
	require.Eventually(t, func() bool {
		failed, inspectErr := runtime.InspectService(context.Background(), workspace.ID, "failed")
		return inspectErr == nil && failed.State == workspaceapi.ServiceFailed && failed.ExitCode == 7
	}, time.Second, 10*time.Millisecond)
}

func TestRuntimeServicePreviewAndTerminal(t *testing.T) {
	runtime := newTestRuntime(t, t.TempDir())
	workspace, err := runtime.CreateWorkspace(context.Background(), workspaceapi.WorkspaceSpec{ID: "interactive"})
	require.NoError(t, err)
	_, err = runtime.StartWorkspace(context.Background(), workspace.ID)
	require.NoError(t, err)

	address := reserveTestAddress(t)
	service, err := runtime.StartService(context.Background(), workspace.ID, workspaceapi.ServiceSpec{
		Name: "preview", Command: helperCommand("serve", map[string]string{"SMITHERS_TEST_ADDRESS": address}),
		ReadyAddress: address, ReadyTimeout: 2 * time.Second,
	})
	require.NoError(t, err)
	assert.Positive(t, service.PID)
	port, err := strconv.Atoi(strings.TrimPrefix(address, "127.0.0.1:"))
	require.NoError(t, err)
	target, err := runtime.PreviewTarget(context.Background(), workspace.ID, uint16(port))
	require.NoError(t, err)
	response, err := http.Get(target.URL + "/ready")
	require.NoError(t, err)
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	assert.Equal(t, "ready", string(body))
	observation, err := runtime.InspectService(context.Background(), workspace.ID, "preview")
	require.NoError(t, err)
	assert.Equal(t, workspaceapi.ServiceRunning, observation.State)
	assert.Equal(t, service.PID, observation.PID)

	terminal, err := runtime.OpenWorkspaceTerminal(context.Background(), workspace.ID, workspaceapi.Command{Args: []string{"/bin/sh", "-c", `read value; printf 'reply:%s\n' "$value"`}})
	require.NoError(t, err)
	require.NoError(t, terminal.Resize(context.Background(), 100, 40))
	_, err = terminal.Write([]byte("hello\n"))
	require.NoError(t, err)
	read := make(chan string, 1)
	go func() {
		reader := bufio.NewReader(terminal)
		var output strings.Builder
		for {
			line, readErr := reader.ReadString('\n')
			output.WriteString(line)
			if strings.Contains(output.String(), "reply:hello") || readErr != nil {
				read <- output.String()
				return
			}
		}
	}()
	select {
	case output := <-read:
		assert.Contains(t, output, "reply:hello")
	case <-time.After(2 * time.Second):
		t.Fatal("terminal did not return command output")
	}
	require.NoError(t, terminal.Close())
	require.NoError(t, runtime.StopService(context.Background(), workspace.ID, "preview"))
	require.Eventually(t, func() bool {
		connection, dialErr := net.DialTimeout("tcp", address, 20*time.Millisecond)
		if dialErr == nil {
			_ = connection.Close()
		}
		return dialErr != nil
	}, 2*time.Second, 20*time.Millisecond)
}

func TestManagedHostAllocatesAddressPersistsBindingAndVerifiesIdentity(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "managed-host.json")
	runtime := newTestRuntime(t, t.TempDir())
	workspace, err := runtime.CreateWorkspace(context.Background(), workspaceapi.WorkspaceSpec{ID: "flow-host"})
	require.NoError(t, err)
	_, err = runtime.StartWorkspace(context.Background(), workspace.ID)
	require.NoError(t, err)
	assert.True(t, runtime.Capabilities().ManagedHTTPHosts)

	expected := workspaceapi.ManagedHostIdentity{
		Protocol: "smithers.flow-runtime/v1", ArtifactDigest: strings.Repeat("a", 64),
		SourceRevision: strings.Repeat("b", 40), OwnerGeneration: 7,
	}
	var placements []workspaceapi.ManagedHostPlacement
	spec := workspaceapi.ManagedHostSpec{
		ID: "12345678-1234-1234-1234-123456789abc", Name: "flow-coding",
		Identity: "flow-host:fixture-owner-7", Expected: expected, ReadyTimeout: 2 * time.Second,
		Builder: workspaceapi.ManagedHostBuilderFunc(func(_ context.Context, placement workspaceapi.ManagedHostPlacement) (workspaceapi.Command, error) {
			placements = append(placements, placement)
			return helperCommand("managed-host", map[string]string{
				"SMITHERS_TEST_ADDRESS":          placement.Address,
				"SMITHERS_TEST_MARKER":           marker,
				"SMITHERS_TEST_STATE_DIR":        placement.StateDir,
				"SMITHERS_TEST_PROTOCOL":         expected.Protocol,
				"SMITHERS_TEST_ARTIFACT_DIGEST":  expected.ArtifactDigest,
				"SMITHERS_TEST_SOURCE_REVISION":  expected.SourceRevision,
				"SMITHERS_TEST_OWNER_GENERATION": strconv.FormatInt(expected.OwnerGeneration, 10),
			}), nil
		}),
		Probe: workspaceapi.ManagedHostProbeFunc(func(ctx context.Context, connection workspaceapi.ManagedHostConnection) (workspaceapi.ManagedHostIdentity, error) {
			request, requestErr := http.NewRequestWithContext(ctx, http.MethodGet, connection.Endpoint+"/health", nil)
			if requestErr != nil {
				return workspaceapi.ManagedHostIdentity{}, requestErr
			}
			request.Header.Set("Authorization", "Bearer private")
			client := connection.HTTPClient
			if client == nil {
				client = http.DefaultClient
			}
			response, requestErr := client.Do(request)
			if requestErr != nil {
				return workspaceapi.ManagedHostIdentity{}, requestErr
			}
			defer response.Body.Close()
			if response.StatusCode != http.StatusOK {
				return workspaceapi.ManagedHostIdentity{}, fmt.Errorf("health returned %s", response.Status)
			}
			var identity workspaceapi.ManagedHostIdentity
			return identity, json.NewDecoder(response.Body).Decode(&identity)
		}),
	}

	first, err := runtime.StartManagedHost(context.Background(), workspace.ID, spec)
	require.NoError(t, err)
	second, err := runtime.StartManagedHost(context.Background(), workspace.ID, spec)
	require.NoError(t, err)
	assert.Equal(t, first.Endpoint, second.Endpoint)
	require.Len(t, placements, 1, "an idempotent ensure must not allocate another port")
	assert.Equal(t, workspace.Root, placements[0].Workspace.Root)
	assert.Equal(t, "127.0.0.1", placements[0].Host)
	assert.NotZero(t, placements[0].Port)
	assert.Equal(t, first.Endpoint, "http://"+placements[0].Address)
	assert.DirExists(t, placements[0].StateDir)
	assert.FileExists(t, filepath.Join(placements[0].StateDir, managedHostMetadataName))

	var receipt struct {
		Address  string `json:"address"`
		StateDir string `json:"stateDir"`
		Home     string `json:"home"`
	}
	contents, err := os.ReadFile(marker)
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(contents, &receipt))
	assert.Equal(t, placements[0].Address, receipt.Address)
	assert.Equal(t, placements[0].StateDir, receipt.StateDir)
	assert.Equal(t, workspace.Home, receipt.Home)
	require.NoError(t, os.WriteFile(filepath.Join(receipt.StateDir, "journal"), []byte("durable"), 0o600))

	inspected, err := runtime.InspectManagedHost(context.Background(), workspace.ID, spec)
	require.NoError(t, err)
	assert.Equal(t, first.Endpoint, inspected.Endpoint)
	mismatch := spec
	mismatch.Expected.OwnerGeneration++
	_, err = runtime.InspectManagedHost(context.Background(), workspace.ID, mismatch)
	require.ErrorIs(t, err, workspaceapi.ErrManagedHostIdentityConflict)

	require.NoError(t, runtime.StopService(context.Background(), workspace.ID, spec.Name))
	_, err = runtime.InspectManagedHost(context.Background(), workspace.ID, spec)
	require.ErrorIs(t, err, workspaceapi.ErrManagedHostNotRunning)
	_, err = runtime.StartManagedHost(context.Background(), workspace.ID, spec)
	require.NoError(t, err)
	require.Len(t, placements, 2)
	assert.Equal(t, placements[0].StateDir, placements[1].StateDir)
	journal, err := os.ReadFile(filepath.Join(placements[1].StateDir, "journal"))
	require.NoError(t, err)
	assert.Equal(t, "durable", string(journal))

	// A host-bundle upgrade: the same binding gets a new artifact, owner
	// generation, fingerprint, and service name. The live old service is a
	// conflict until it is stopped; after that the new identity starts and
	// keeps the binding's durable state.
	upgraded := spec
	upgraded.Name = "flow-coding-v2"
	upgraded.Identity = "flow-host:fixture-owner-8"
	upgraded.Expected.ArtifactDigest = strings.Repeat("c", 64)
	upgraded.Expected.OwnerGeneration = 8
	upgraded.Builder = workspaceapi.ManagedHostBuilderFunc(func(_ context.Context, placement workspaceapi.ManagedHostPlacement) (workspaceapi.Command, error) {
		placements = append(placements, placement)
		return helperCommand("managed-host", map[string]string{
			"SMITHERS_TEST_ADDRESS":          placement.Address,
			"SMITHERS_TEST_MARKER":           marker,
			"SMITHERS_TEST_STATE_DIR":        placement.StateDir,
			"SMITHERS_TEST_PROTOCOL":         upgraded.Expected.Protocol,
			"SMITHERS_TEST_ARTIFACT_DIGEST":  upgraded.Expected.ArtifactDigest,
			"SMITHERS_TEST_SOURCE_REVISION":  upgraded.Expected.SourceRevision,
			"SMITHERS_TEST_OWNER_GENERATION": strconv.FormatInt(upgraded.Expected.OwnerGeneration, 10),
		}), nil
	})
	sameName := upgraded
	sameName.Name = spec.Name
	_, err = runtime.InspectManagedHost(context.Background(), workspace.ID, sameName)
	require.ErrorIs(t, err, workspaceapi.ErrManagedHostIdentityConflict, "an unstopped old host blocks its replacement")
	require.NoError(t, runtime.StopService(context.Background(), workspace.ID, spec.Name))
	_, err = runtime.StartManagedHost(context.Background(), workspace.ID, upgraded)
	require.NoError(t, err)
	require.Len(t, placements, 3)
	assert.Equal(t, placements[0].StateDir, placements[2].StateDir)
	journal, err = os.ReadFile(filepath.Join(placements[2].StateDir, "journal"))
	require.NoError(t, err)
	assert.Equal(t, "durable", string(journal))
	_, err = runtime.InspectManagedHost(context.Background(), workspace.ID, upgraded)
	require.NoError(t, err)
}

func TestWorkspaceSourceRevisionUsesJujutsuSnapshotOrCleanGitHead(t *testing.T) {
	revision := strings.Repeat("c", 40)

	t.Run("Jujutsu working-copy commit", func(t *testing.T) {
		bin := t.TempDir()
		writeTestExecutable(t, filepath.Join(bin, "jj"), "#!/bin/sh\nprintf '%s\\n' \"$SMITHERS_TEST_REVISION\"\n")
		runtime := newTestRuntime(t, t.TempDir(), func(config *Config) {
			config.Environment = map[string]string{"PATH": bin + ":/usr/bin:/bin", "SMITHERS_TEST_REVISION": revision}
		})
		workspace, err := runtime.CreateWorkspace(context.Background(), workspaceapi.WorkspaceSpec{ID: "source-jj"})
		require.NoError(t, err)
		_, err = runtime.StartWorkspace(context.Background(), workspace.ID)
		require.NoError(t, err)
		require.NoError(t, os.Mkdir(filepath.Join(workspace.Root, ".jj"), 0o700))
		resolved, err := runtime.ResolveWorkspaceSourceRevision(context.Background(), workspace.ID)
		require.NoError(t, err)
		assert.Equal(t, revision, resolved)
	})

	t.Run("clean Git HEAD", func(t *testing.T) {
		bin := t.TempDir()
		git := filepath.Join(bin, "git")
		cleanScript := "#!/bin/sh\ncase \"$1\" in\nrev-parse) printf '%s\\n' \"$SMITHERS_TEST_REVISION\" ;;\nstatus) : ;;\n*) exit 2 ;;\nesac\n"
		writeTestExecutable(t, git, cleanScript)
		runtime := newTestRuntime(t, t.TempDir(), func(config *Config) {
			config.Environment = map[string]string{"PATH": bin + ":/usr/bin:/bin", "SMITHERS_TEST_REVISION": revision}
		})
		workspace, err := runtime.CreateWorkspace(context.Background(), workspaceapi.WorkspaceSpec{ID: "source-git"})
		require.NoError(t, err)
		_, err = runtime.StartWorkspace(context.Background(), workspace.ID)
		require.NoError(t, err)
		require.NoError(t, os.Mkdir(filepath.Join(workspace.Root, ".git"), 0o700))
		resolved, err := runtime.ResolveWorkspaceSourceRevision(context.Background(), workspace.ID)
		require.NoError(t, err)
		assert.Equal(t, revision, resolved)

		dirtyScript := "#!/bin/sh\ncase \"$1\" in\nrev-parse) printf '%s\\n' \"$SMITHERS_TEST_REVISION\" ;;\nstatus) printf '%s\\n' ' M changed.txt' ;;\n*) exit 2 ;;\nesac\n"
		writeTestExecutable(t, git, dirtyScript)
		_, err = runtime.ResolveWorkspaceSourceRevision(context.Background(), workspace.ID)
		require.ErrorIs(t, err, workspaceapi.ErrWorkspaceSourceUnavailable)
	})
}

func writeTestExecutable(t *testing.T, path, contents string) {
	t.Helper()
	require.NoError(t, os.WriteFile(path, []byte(contents), 0o700))
}

func helperCommand(mode string, environment map[string]string) workspaceapi.Command {
	copy := make(map[string]string, len(environment)+1)
	for name, value := range environment {
		copy[name] = value
	}
	copy["SMITHERS_TEST_HELPER"] = mode
	return workspaceapi.Command{Args: []string{os.Args[0], "-test.run=^TestProcessHelper$", "--"}, Environment: copy}
}

func reserveTestAddress(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	address := listener.Addr().String()
	require.NoError(t, listener.Close())
	return address
}

func portFromAddress(t *testing.T, address string) int {
	t.Helper()
	_, rawPort, err := net.SplitHostPort(address)
	require.NoError(t, err)
	port, err := strconv.Atoi(rawPort)
	require.NoError(t, err)
	return port
}

func argumentValue(args []string, name string) string {
	for index := range args {
		if args[index] == name && index+1 < len(args) {
			return args[index+1]
		}
	}
	return ""
}

func TestProcessHelper(t *testing.T) {
	mode := os.Getenv("SMITHERS_TEST_HELPER")
	if mode == "" {
		return
	}
	var address string
	var handler http.Handler
	switch mode {
	case "serve":
		address = os.Getenv("SMITHERS_TEST_ADDRESS")
		handler = http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) { _, _ = response.Write([]byte("ready")) })
	case "managed-host":
		address = os.Getenv("SMITHERS_TEST_ADDRESS")
		receipt := map[string]any{"address": address, "stateDir": os.Getenv("SMITHERS_TEST_STATE_DIR"), "home": os.Getenv("HOME")}
		contents, err := json.Marshal(receipt)
		if err != nil {
			panic(err)
		}
		if err := os.WriteFile(os.Getenv("SMITHERS_TEST_MARKER"), contents, 0o600); err != nil {
			panic(err)
		}
		identity := workspaceapi.ManagedHostIdentity{
			Protocol: os.Getenv("SMITHERS_TEST_PROTOCOL"), ArtifactDigest: os.Getenv("SMITHERS_TEST_ARTIFACT_DIGEST"),
			SourceRevision: os.Getenv("SMITHERS_TEST_SOURCE_REVISION"),
		}
		identity.OwnerGeneration, err = strconv.ParseInt(os.Getenv("SMITHERS_TEST_OWNER_GENERATION"), 10, 64)
		if err != nil {
			panic(err)
		}
		handler = http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			if request.URL.Path != "/health" || request.Header.Get("Authorization") != "Bearer private" {
				http.Error(response, "forbidden", http.StatusForbidden)
				return
			}
			response.Header().Set("Content-Type", "application/json")
			if err := json.NewEncoder(response).Encode(identity); err != nil {
				panic(err)
			}
		})
	default:
		panic(fmt.Sprintf("unknown helper mode %q", mode))
	}
	listener, err := net.Listen("tcp", address)
	if err != nil {
		panic(err)
	}
	if err := http.Serve(listener, handler); err != nil {
		panic(err)
	}
}

func flagArguments(args []string) []string {
	for index, value := range args {
		if value == "--" {
			return args[index+1:]
		}
	}
	return nil
}

func TestDeleteWorkspaceRetainsFailedRemovalForRetry(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("permission refusal requires an unprivileged user")
	}
	root := t.TempDir()
	runtime := newTestRuntime(t, root)
	ws, err := runtime.CreateWorkspace(context.Background(), workspaceapi.WorkspaceSpec{ID: "cleanup-retry"})
	require.NoError(t, err)
	require.NoError(t, os.Chmod(filepath.Join(root, "workspaces"), 0500))
	t.Cleanup(func() { require.NoError(t, os.Chmod(filepath.Join(root, "workspaces"), 0700)) })
	require.ErrorContains(t, runtime.DeleteWorkspace(context.Background(), ws.ID), "delete process workspace")
	_, err = runtime.InspectWorkspace(context.Background(), ws.ID)
	require.NoError(t, err, "failed removal must retain its retry handle")
	require.NoError(t, os.Chmod(filepath.Join(root, "workspaces"), 0700))
	require.NoError(t, runtime.DeleteWorkspace(context.Background(), ws.ID))
	require.NoError(t, runtime.DeleteWorkspace(context.Background(), ws.ID), "successful cleanup is idempotent")
	_, err = runtime.InspectWorkspace(context.Background(), ws.ID)
	require.ErrorIs(t, err, workspaceapi.ErrWorkspaceNotFound)
}

func TestDefaultConfigRunsCommandsInDifferentWorkspacesConcurrently(t *testing.T) {
	runtime, err := New(Config{Root: t.TempDir(), TerminationGrace: 100 * time.Millisecond})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	start := func(id string) {
		_, err := runtime.CreateWorkspace(context.Background(), workspaceapi.WorkspaceSpec{ID: id})
		require.NoError(t, err)
		_, err = runtime.StartWorkspace(context.Background(), id)
		require.NoError(t, err)
	}
	start("slow")
	start("fast")
	slowDone := make(chan error, 1)
	go func() {
		_, err := runtime.ExecuteCommand(context.Background(), "slow", workspaceapi.Command{Args: []string{"/bin/sh", "-c", "sleep 3"}})
		slowDone <- err
	}()
	require.Eventually(t, func() bool { return len(runtime.semaphore) == 1 }, time.Second, time.Millisecond)
	began := time.Now()
	result, err := runtime.ExecuteCommand(context.Background(), "fast", workspaceapi.Command{Args: []string{"/bin/sh", "-c", "true"}})
	require.NoError(t, err)
	assert.Equal(t, 0, result.ExitCode)
	assert.Less(t, time.Since(began), time.Second, "a command in one workspace waited behind another workspace's command")
	require.NoError(t, <-slowDone)
}

package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowmanifest"
	"github.com/smithersai/smithers/packages/backend/process"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// C-SEC-02's negative boundary uses a real trusted-process runtime and real
// repository files. Rejection must precede source loading, host startup and
// database/configuration access. Positive microVM and TODO lifecycle evidence
// is collected by the separate reference-host canary.
func TestCSEC02TrustedProcessRefusesRepositoryFlowsBeforeComposition(t *testing.T) {
	runtime, err := process.New(process.Config{Root: t.TempDir()})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	observed, err := runtime.CreateWorkspace(context.Background(), workspaceapi.WorkspaceSpec{ID: "csec02-repository"})
	require.NoError(t, err)
	marker := filepath.Join(t.TempDir(), "host-imported")
	listener, err := net.ListenTCP("tcp", &net.TCPAddr{IP: net.ParseIP("127.0.0.1")})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, listener.Close()) })
	markerJSON, err := json.Marshal(marker)
	require.NoError(t, err)
	port := listener.Addr().(*net.TCPAddr).Port
	for _, name := range []string{"todo", "learning", "review", "release-notes", "merge"} {
		path := filepath.Join(observed.Root, "flows", name, "flow.ts")
		require.NoError(t, os.MkdirAll(filepath.Dir(path), 0755))
		body := fmt.Sprintf(`import { writeFileSync } from "node:fs"
import { connect } from "node:net"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
writeFileSync(%s, "imported")
connect({ host: "127.0.0.1", port: %d }).end()
export default Flow.make(%q, {
  description: "Isolation canary",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
  payload: {}, success: Schema.String,
  body: () => Node.succeed("canary")
})
`, markerJSON, port, name)
		require.NoError(t, os.WriteFile(path, []byte(body), 0644))
	}
	assertIsolation := func(err error) {
		t.Helper()
		var typed interface {
			FlowRuntimeCode() string
			FlowRuntimeClass() string
		}
		require.ErrorAs(t, err, &typed)
		require.Equal(t, "isolation_required", typed.FlowRuntimeCode())
		require.Equal(t, "infra", typed.FlowRuntimeClass())
	}
	launcher, err := flowhost.NewWorkspaceLauncher(runtime)
	assertIsolation(err)
	require.Nil(t, launcher)
	for _, role := range []topology{localTopology, hostedAPITopology, hostedWorkerTopology} {
		options := runOptions{topology: role, Options: Options{Workspace: runtime, FlowHostRegistry: &flowmanifest.Registry{}}}
		// Nil config, pool and services make any pre-isolation access a panic.
		composition, err := newFlowComposition(options, nil, nil, nil, nil, nil, nil, nil, nil, nil)
		assertIsolation(err)
		require.Nil(t, composition)
	}
	_, err = os.Stat(marker)
	require.ErrorIs(t, err, os.ErrNotExist, "repository module never executed on host")
	require.NoError(t, listener.SetDeadline(time.Now().Add(25*time.Millisecond)))
	connection, err := listener.AcceptTCP()
	if connection != nil {
		_ = connection.Close()
		t.Fatal("repository import reached host TCP canary")
	}
	var timeout net.Error
	require.ErrorAs(t, err, &timeout)
	require.True(t, timeout.Timeout())
}

// TestCSEC02BundledInstallIsolation refuses to substitute the in-process rig
// for the production install. No absent prerequisite is a successful skip.
func TestCSEC02BundledInstallIsolation(t *testing.T) {
	bundle := os.Getenv("SMITHERS_CHECK_BUNDLE")
	if bundle == "" {
		t.Fatal("prerequisite: dependency: built-bundle: SMITHERS_CHECK_BUNDLE required")
	}
	if _, err := os.Stat(filepath.Join(bundle, "manifest.json")); err != nil {
		t.Fatalf("prerequisite: dependency: built-bundle: %v", err)
	}
	if runtime.GOOS != "darwin" || runtime.GOARCH != "arm64" {
		t.Fatal("prerequisite: environment: darwin-arm64 required")
	}
	msb := os.Getenv("SMITHERS_MICROSANDBOX_BIN")
	if !filepath.IsAbs(msb) {
		t.Fatal("prerequisite: environment: msb: absolute verified runtime required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	version, err := exec.CommandContext(ctx, msb, "--version").CombinedOutput()
	if err != nil || !strings.Contains(string(version), "0.6.16") {
		t.Fatal("prerequisite: environment: msb: version 0.6.16 required")
	}
	database := os.Getenv("SMITHERS_TEST_DATABASE_URL")
	if database == "" {
		t.Fatal("prerequisite: environment: PG18: allocated database required")
	}
	command := exec.CommandContext(ctx, "psql", "-Atqc", "SHOW server_version_num")
	command.Env = append(os.Environ(), "PGDATABASE="+database)
	version, err = command.CombinedOutput()
	if err != nil || !strings.HasPrefix(strings.TrimSpace(string(version)), "18") {
		t.Fatal("prerequisite: environment: PG18: server version 18 required")
	}
	t.Fatal("prerequisite: dependency: T-INS-01/T-INS-08: bundled launcher and production install lifecycle harness unavailable; steps 1-5 and 7 unexecuted")
}

// The listener records every accepted connection, even a connection carrying
// no nonce. Its shutdown waits for the accept loop before reading evidence.
type isolationCanaryListener struct {
	listener    net.Listener
	done        chan struct{}
	mu          sync.Mutex
	connections []string
}

func newIsolationCanaryListener(t *testing.T) *isolationCanaryListener {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	canary := &isolationCanaryListener{listener: listener, done: make(chan struct{})}
	go func() {
		defer close(canary.done)
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			canary.mu.Lock()
			canary.connections = append(canary.connections, connection.RemoteAddr().String())
			canary.mu.Unlock()
			_ = connection.SetReadDeadline(time.Now().Add(time.Second))
			data, _ := io.ReadAll(io.LimitReader(connection, 4096))
			_ = connection.Close()
			canary.mu.Lock()
			canary.connections[len(canary.connections)-1] += " " + string(data)
			canary.mu.Unlock()
		}
	}()
	t.Cleanup(func() { _ = listener.Close(); <-canary.done })
	return canary
}
func TestCSEC02CanaryListenerRecordsConnections(t *testing.T) {
	canary := newIsolationCanaryListener(t)
	connection, err := net.Dial("tcp", canary.listener.Addr().String())
	require.NoError(t, err)
	_, err = connection.Write([]byte("fixture-nonce"))
	require.NoError(t, err)
	require.NoError(t, connection.Close())
	require.Eventually(t, func() bool {
		canary.mu.Lock()
		defer canary.mu.Unlock()
		return len(canary.connections) == 1 && strings.HasSuffix(canary.connections[0], " fixture-nonce")
	}, time.Second, time.Millisecond)
	require.NoError(t, canary.listener.Close())
	<-canary.done
	canary.mu.Lock()
	defer canary.mu.Unlock()
	require.Len(t, canary.connections, 1)
}

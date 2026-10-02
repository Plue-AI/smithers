package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
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

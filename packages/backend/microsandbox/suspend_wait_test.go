package microsandbox

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

func TestWorkspaceSuspendWaitsForObservedStop(t *testing.T) {
	r, policy := admissionFixture()
	root := t.TempDir()
	binary := filepath.Join(root, "msb")
	status := filepath.Join(root, "status")
	observed := filepath.Join(root, "observed")
	require.NoError(t, os.WriteFile(status, []byte(`[{"name":"vm-a","status":"stopping"}]`), 0600))
	script := fmt.Sprintf("#!/bin/sh\ncase \"$1\" in\nlist) cat %q; touch %q;;\nesac\n", status, observed)
	require.NoError(t, os.WriteFile(binary, []byte(script), 0700))
	r.cli = &cli{binary: binary, home: root}
	_, err := r.Request("person", "workspace:A", "Alice", "terminal")
	require.NoError(t, err)
	_, err = r.GrantNext(t.Context(), policy)
	require.NoError(t, err)
	require.NoError(t, r.BindAdmissionMachine("workspace:A", "vm-a"))
	ws := newWorkspace(metadata{ID: "A", Machine: "vm-a", State: "running"}, root)
	r.workspaces["A"] = ws
	notes := filepath.Join(root, "notes.txt")
	require.NoError(t, os.WriteFile(notes, []byte("retained notes\n"), 0600))
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- r.StopWorkspace(ctx, "A") }()
	require.Eventually(t, func() bool { _, err := os.Stat(observed); return err == nil }, time.Second, time.Millisecond)
	select {
	case err := <-done:
		t.Fatalf("suspension returned before stop: %v", err)
	default:
	}
	require.Equal(t, 1, r.InUse(), "capacity remains occupied until observed stop")
	state, err := r.InspectWorkspace(t.Context(), "A")
	require.NoError(t, err)
	require.Equal(t, workspaceapi.WorkspaceStopping, state.State)
	// Rename atomically so a status probe never sees a partial JSON document.
	next := filepath.Join(root, "next")
	require.NoError(t, os.WriteFile(next, []byte(`[{"name":"vm-a","status":"stopped"}]`), 0600))
	require.NoError(t, os.Rename(next, status))
	require.NoError(t, <-done)
	require.Equal(t, 0, r.InUse())
	require.Equal(t, string(workspaceapi.WorkspaceStopped), readReclaimMetadata(t, ws).State)
	content, err := os.ReadFile(notes)
	require.NoError(t, err)
	require.Equal(t, "retained notes\n", string(content))
}

package microsandbox

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

func TestDaemonCompareWriteNeverFallsBackToGuest(t *testing.T) {
	// No CLI is installed in this fixture. Any attempt to borrow the guest's
	// unqualified candidate or unconditional writer would panic.
	r := &Runtime{workspaces: map[string]*workspace{"a": newWorkspace(metadata{ID: "a", Machine: "vm", State: string(workspaceapi.WorkspaceRunning)}, "")}}
	ctx := workspaceapi.WithOperation(t.Context(), workspaceapi.Operation{TenantID: "1", PrincipalID: "2", OperationID: "write"})
	_, err := r.CompareWriteFiles(ctx, "a", []workspaceapi.FileMutation{{Path: "a", BaseDigest: "absent", Content: []byte("new")}})
	require.ErrorIs(t, err, workspaceapi.ErrCompareWriteUnavailable)
}

func TestDaemonFilesNeverFallBackToGuest(t *testing.T) {
	for _, state := range []string{"running", "stopped"} {
		t.Run(state, func(t *testing.T) {
			// A nil CLI makes any fallback observable as a panic.
			r := &Runtime{workspaces: map[string]*workspace{"a": newWorkspace(metadata{ID: "a", Machine: "vm", State: state}, "")}}
			data, err := r.ReadFile(t.Context(), "a", "README.md")
			require.Error(t, err)
			require.Nil(t, data)
			ctx := workspaceapi.WithOperation(t.Context(), workspaceapi.Operation{TenantID: "1", PrincipalID: "2", OperationID: "write"})
			_, err = r.CompareWriteFiles(ctx, "a", []workspaceapi.FileMutation{{Path: "README.md", BaseDigest: "absent", Content: []byte("new")}})
			require.Error(t, err)
			cancelled, cancel := context.WithCancel(t.Context())
			cancel()
			_, err = r.ReadFile(cancelled, "a", "README.md")
			require.ErrorIs(t, err, context.Canceled)
			_, err = r.CompareWriteFiles(cancelled, "a", nil)
			require.ErrorIs(t, err, context.Canceled)
		})
	}
}

func TestRepositoryPreparationReceiptUsesFixedPath(t *testing.T) {
	root := t.TempDir()
	binary := filepath.Join(root, "msb")
	argv := filepath.Join(root, "argv")
	body := filepath.Join(root, "body")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > " + shellQuote(argv) + "\ncat > " + shellQuote(body) + "\nprintf 'receipt'\n"
	require.NoError(t, os.WriteFile(binary, []byte(script), 0700))
	r := &Runtime{cli: &cli{binary: binary, home: root}, workspaces: map[string]*workspace{"a": newWorkspace(metadata{ID: "a", Machine: "vm", State: "running"}, "")}}
	require.NoError(t, r.WriteRepositoryReceipt(t.Context(), "a", []byte("fixed bytes")))
	args, err := os.ReadFile(argv)
	require.NoError(t, err)
	require.Contains(t, string(args), "fs\nagent\nreceipt-write\n/workspace\n.git/smithers-workspace-initialization.json\n")
	content, err := os.ReadFile(body)
	require.NoError(t, err)
	require.Equal(t, []byte("fixed bytes"), content)
	content, err = r.ReadRepositoryReceipt(t.Context(), "a")
	require.NoError(t, err)
	require.Equal(t, []byte("receipt"), content)
	args, err = os.ReadFile(argv)
	require.NoError(t, err)
	require.Contains(t, string(args), "receipt-read\n/workspace\n.git/smithers-workspace-initialization.json\n")
	before := string(args)
	require.Error(t, r.WriteRepositoryReceipt(t.Context(), "a", []byte(strings.Repeat("x", 65537))))
	args, err = os.ReadFile(argv)
	require.NoError(t, err)
	require.Equal(t, before, string(args))
}

package services

import (
	"context"
	"net/http"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// countingWorkspaces records every machine the importer asks for.
type countingWorkspaces struct {
	calls int
	err   error
}

func (w *countingWorkspaces) CreateWorkspaceAsync(context.Context, CreateWorkspaceInput) (WorkspaceResponse, error) {
	w.calls++
	if w.err != nil {
		return WorkspaceResponse{}, w.err
	}
	return WorkspaceResponse{ID: "11111111-1111-1111-1111-111111111111", TargetBookmark: "main"}, nil
}

// Spec §8.6.3: Source ready means the mirror holds main. The self-hosted
// install composes no provisioner, so its import ends with the bookmark and
// asks for no machine.
func TestGitHubImportWithoutProvisionerEndsAtSourceReady(t *testing.T) {
	api := githubImportHAPI(t, http.StatusOK, map[string]any{"private": false, "default_branch": "main"})
	svc := githubImportHService(api, withGitHubImportCloneMirror(func(context.Context, string, string, string, string, string, string) error { return nil }))
	repository, workspace, err := svc.runImport(context.Background(), 7, "octo", "demo", "alice", "main", "job")
	require.NoError(t, err)
	assert.Equal(t, "demo", repository.Name)
	assert.Equal(t, WorkspaceResponse{TargetBookmark: "main"}, workspace, "source ready carries the bookmark and no machine")
}

// The hosted composition wires a provisioner: the import provisions the bound
// machine once, a refusal fails the import, and a full allowance defers the
// machine to first open while the import still succeeds.
func TestGitHubImportWithProvisionerProvisionsTheBoundMachine(t *testing.T) {
	repository := db.Repository{ID: 42, Name: "demo"}
	for name, test := range map[string]struct {
		err     error
		want    WorkspaceResponse
		wantErr string
	}{
		"provisioned": {want: WorkspaceResponse{ID: "11111111-1111-1111-1111-111111111111", TargetBookmark: "main"}},
		"refused":     {err: assert.AnError, wantErr: "create bound workspace"},
		"allowance":   {err: pkgerrors.New(pkgerrors.CodeQuotaExceeded, "sandbox allowance full"), want: WorkspaceResponse{TargetBookmark: "main"}},
	} {
		t.Run(name, func(t *testing.T) {
			workspaces := &countingWorkspaces{err: test.err}
			svc := NewGitHubImportService(nil, nil, nil, nil, nil, "", WithGitHubImportWorkspaceProvisioner(workspaces))
			workspace, err := svc.createBoundWorkspace(context.Background(), 7, repository, "alice", "demo", "main")
			assert.Equal(t, 1, workspaces.calls)
			if test.wantErr != "" {
				require.ErrorContains(t, err, test.wantErr)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, test.want, workspace)
		})
	}
}

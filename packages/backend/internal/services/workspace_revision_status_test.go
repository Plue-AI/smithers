package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestWorkspaceResponseIncludesRevisionEnvironmentAndLifecycle(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	workspace := sampleDBWorkspace("ws-1")
	workspace.Kind = "desktop"
	workspace.EnvironmentSource = defaultWorkspaceEnvironmentSource
	workspace.EnvironmentRevision = "b775d9"
	workspace.EnvironmentClosureHash = "sha256-closure"
	workspace.HeadChangeID = "change-1"
	workspace.HeadCommitID = "commit-1"
	workspace.Ahead = 3
	workspace.Behind = 1
	workspace.StartedAt = pgtype.Timestamptz{Time: now.Add(-time.Hour), Valid: true}
	workspace.ResumedAt = pgtype.Timestamptz{Time: now.Add(-time.Minute), Valid: true}

	response := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}).toWorkspaceResponse(workspace)
	assert.Equal(t, "desktop", response.Kind)
	assert.Equal(t, WorkspaceEnvironment{Source: defaultWorkspaceEnvironmentSource, Revision: "b775d9", ClosureHash: "sha256-closure"}, response.Environment)
	assert.Equal(t, WorkspaceHead{ChangeID: "change-1", CommitID: "commit-1"}, response.Head)
	assert.Equal(t, int32(3), response.Ahead)
	assert.Equal(t, int32(1), response.Behind)
	require.NotNil(t, response.StartedAt)
	require.NotNil(t, response.ResumedAt)
}

func TestWorkspaceVMRequestCarriesSelectedKind(t *testing.T) {
	// vm/desktop kinds boot a registered NixOS closure image (see
	// workspace_nix_test.go); without a registry they are refused.
	service := newWorkspaceServiceForTests(&mockWorkspaceQuerier{})
	WithWorkspaceEnvironmentImages(&stubEnvironmentImageResolver{image: nixTestImage("vm")})(service)
	vmReq, err := service.buildWorkspaceVMRequest(context.Background(), "", nil, 101, "", "vm")
	require.NoError(t, err)
	assert.Equal(t, "vm", vmReq.Kind)
	desktopReq, err := service.buildWorkspaceVMRequest(context.Background(), "", nil, 101, "", "desktop")
	require.NoError(t, err)
	assert.Equal(t, "desktop", desktopReq.Kind)
}

func TestWorkspaceServiceUpdateWorkspaceHead(t *testing.T) {
	var got db.UpdateWorkspaceHeadParams
	service := newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		updateWorkspaceHeadFn: func(_ context.Context, arg db.UpdateWorkspaceHeadParams) (db.Workspace, error) {
			got = arg
			return sampleDBWorkspace(arg.ID), nil
		},
	})
	require.NoError(t, service.UpdateWorkspaceHead(context.Background(), UpdateWorkspaceHeadInput{
		WorkspaceID: " ws-1 ", ChangeID: " change-1 ", CommitID: " commit-1 ", Ahead: 4, Behind: 2,
	}))
	assert.Equal(t, "ws-1", got.ID)
	assert.Equal(t, "change-1", got.HeadChangeID)
	assert.Equal(t, "commit-1", got.HeadCommitID)
	assert.Equal(t, int32(4), got.Ahead)
	assert.Equal(t, int32(2), got.Behind)
}

func TestWorkspaceServiceUpdateWorkspaceHeadValidatesAndMapsErrors(t *testing.T) {
	service := newWorkspaceServiceForTests(&mockWorkspaceQuerier{})
	for _, input := range []UpdateWorkspaceHeadInput{
		{},
		{WorkspaceID: "ws", CommitID: "commit"},
		{WorkspaceID: "ws", ChangeID: "change", CommitID: "commit", Ahead: -1},
	} {
		err := service.UpdateWorkspaceHead(context.Background(), input)
		require.Error(t, err)
		assert.Equal(t, 400, apiStatus(t, err))
	}

	notFound := newWorkspaceServiceForTests(&mockWorkspaceQuerier{updateWorkspaceHeadFn: func(context.Context, db.UpdateWorkspaceHeadParams) (db.Workspace, error) {
		return db.Workspace{}, pgx.ErrNoRows
	}})
	err := notFound.UpdateWorkspaceHead(context.Background(), UpdateWorkspaceHeadInput{WorkspaceID: "ws", ChangeID: "change", CommitID: "commit"})
	require.Error(t, err)
	assert.Equal(t, 404, apiStatus(t, err))

	failed := newWorkspaceServiceForTests(&mockWorkspaceQuerier{updateWorkspaceHeadFn: func(context.Context, db.UpdateWorkspaceHeadParams) (db.Workspace, error) {
		return db.Workspace{}, errors.New("write failed")
	}})
	err = failed.UpdateWorkspaceHead(context.Background(), UpdateWorkspaceHeadInput{WorkspaceID: "ws", ChangeID: "change", CommitID: "commit"})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestWorkspaceCreateMetadataValidation(t *testing.T) {
	require.NoError(t, validateWorkspaceCreateMetadata(CreateWorkspaceInput{Kind: "vm", Environment: WorkspaceEnvironment{
		Source: defaultWorkspaceEnvironmentSource, Revision: "revision", ClosureHash: "closure",
	}}))
	for _, input := range []CreateWorkspaceInput{
		{Kind: "process"},
		{Environment: WorkspaceEnvironment{Source: "shell.nix"}},
		{Environment: WorkspaceEnvironment{Revision: "revision"}},
	} {
		err := validateWorkspaceCreateMetadata(input)
		require.Error(t, err)
		assert.Equal(t, 400, apiStatus(t, err))
	}
}

func TestCreatePrimaryWorkspacePersistsKindAndEnvironment(t *testing.T) {
	var got db.CreateWorkspaceParams
	service := newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		createWorkspaceFn: func(_ context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
			got = arg
			return sampleDBWorkspace("ws-1"), nil
		},
	})
	environment := WorkspaceEnvironment{Source: defaultWorkspaceEnvironmentSource, Revision: "b775d9", ClosureHash: "sha256-closure"}
	_, err := service.createPrimaryWorkspace(context.Background(), 101, 7, "dev", "main", workspaceCreateMetadata{kind: "vm", environment: environment})
	require.NoError(t, err)
	assert.Equal(t, "vm", got.Kind)
	assert.Equal(t, environment.Source, got.EnvironmentSource)
	assert.Equal(t, environment.Revision, got.EnvironmentRevision)
	assert.Equal(t, environment.ClosureHash, got.EnvironmentClosureHash)
}

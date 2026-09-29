package services

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

func TestWorkflowSync_H_LoadDefinitionsErrorBranches(t *testing.T) {
	ctx := context.Background()

	svc := NewWorkflowSyncService(nil, nil, nil)
	_, err := svc.LoadDefinitionsFromCommit(ctx, 0, "sha")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "repository id")

	_, err = svc.LoadDefinitionsFromCommit(ctx, 1, " ")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "commit sha")

	_, err = svc.LoadDefinitionsFromCommit(ctx, 1, "sha")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "dependencies")

	svc = NewWorkflowSyncService(&mockWorkflowSyncQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{}, errors.New("repo failed")
		},
	}, &mockWorkflowSyncRepoHost{}, &mockWorkflowSyncParser{})
	_, err = svc.LoadDefinitionsFromCommit(ctx, 1, "sha")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "load repository")

	svc = NewWorkflowSyncService(&mockWorkflowSyncQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 1}, nil
		},
	}, &mockWorkflowSyncRepoHost{}, &mockWorkflowSyncParser{})
	_, err = svc.LoadDefinitionsFromCommit(ctx, 1, "sha")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "no owner namespace")

	svc = NewWorkflowSyncService(&mockWorkflowSyncQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 1, Name: "repo", UserID: pgtype.Int8{Int64: 2, Valid: true}}, nil
		},
		getUserByIDFn: func(context.Context, int64) (db.User, error) {
			return db.User{}, errors.New("user failed")
		},
	}, &mockWorkflowSyncRepoHost{}, &mockWorkflowSyncParser{})
	_, err = svc.LoadDefinitionsFromCommit(ctx, 1, "sha")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "load repository owner user")

	svc = NewWorkflowSyncService(&mockWorkflowSyncQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 1, Name: "repo", UserID: pgtype.Int8{Int64: 2, Valid: true}}, nil
		},
		getUserByIDFn: func(context.Context, int64) (db.User, error) {
			return db.User{Username: "owner"}, nil
		},
	}, &mockWorkflowSyncRepoHost{
		listFilesAtChangeFn: func(context.Context, string, string, string, string) ([]repohost.ChangeFile, error) {
			return nil, errors.New("list failed")
		},
	}, &mockWorkflowSyncParser{})
	_, err = svc.LoadDefinitionsFromCommit(ctx, 1, "sha")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "list workflow files")

	svc = NewWorkflowSyncService(&mockWorkflowSyncQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 1, Name: "repo", UserID: pgtype.Int8{Int64: 2, Valid: true}}, nil
		},
		getUserByIDFn: func(context.Context, int64) (db.User, error) {
			return db.User{Username: "owner"}, nil
		},
	}, &mockWorkflowSyncRepoHost{
		listFilesAtChangeFn: func(context.Context, string, string, string, string) ([]repohost.ChangeFile, error) {
			return []repohost.ChangeFile{{Path: ".smithers/workflows/read.ts"}, {Path: ".smithers/workflows/parse.ts"}}, nil
		},
		getFileAtChangeFn: func(_ context.Context, _, _, _, p string) (repohost.FileContent, error) {
			if p == ".smithers/workflows/read.ts" {
				return repohost.FileContent{}, errors.New("read failed")
			}
			return repohost.FileContent{Path: p, Content: "bad"}, nil
		},
	}, &mockWorkflowSyncParser{
		parseFn: func(context.Context, string, []byte) (*WorkflowConfig, error) {
			return nil, errors.New("parse failed")
		},
	})
	result, err := svc.LoadDefinitionsFromCommit(ctx, 1, "sha")
	require.NoError(t, err)
	require.Len(t, result.FileErrors, 2)
}

func TestWorkflowSync_H_PersistDefinitionsErrorBranches(t *testing.T) {
	ctx := context.Background()

	err := NewWorkflowSyncService(nil, nil, nil).PersistDefinitions(ctx, 0, WorkflowLoadResult{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "repository id")

	err = NewWorkflowSyncService(nil, nil, nil).PersistDefinitions(ctx, 1, WorkflowLoadResult{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "dependencies")

	baseDef := LoadedWorkflowDefinition{
		Name:   "ci",
		Path:   ".smithers/workflows/ci.ts",
		Config: json.RawMessage(`{"on":{"push":{}}}`),
	}

	err = NewWorkflowSyncService(&mockWorkflowSyncQuerier{
		listWorkflowDefinitionsByRepoFn: func(context.Context, db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return nil, errors.New("list failed")
		},
	}, nil, nil).PersistDefinitions(ctx, 1, WorkflowLoadResult{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "list workflow definitions")

	err = NewWorkflowSyncService(&mockWorkflowSyncQuerier{}, nil, nil).PersistDefinitions(ctx, 1, WorkflowLoadResult{
		Definitions: []LoadedWorkflowDefinition{{Name: "bad", Path: ".smithers/workflows/bad.ts", Config: json.RawMessage(`{`)}},
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "decode workflow config")

	err = NewWorkflowSyncService(&mockWorkflowSyncQuerier{
		upsertWorkflowDefinitionFn: func(context.Context, db.UpsertWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return db.WorkflowDefinition{}, errors.New("upsert failed")
		},
	}, nil, nil).PersistDefinitions(ctx, 1, WorkflowLoadResult{Definitions: []LoadedWorkflowDefinition{baseDef}})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "upsert workflow definition")

	err = NewWorkflowSyncService(&mockWorkflowSyncQuerier{
		upsertWorkflowDefinitionFn: func(context.Context, db.UpsertWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return db.WorkflowDefinition{ID: 9, RepositoryID: 1, Path: ".smithers/workflows/ci.ts"}, nil
		},
		disableWorkflowTriggersByRepositoryPathFn: func(context.Context, db.DisableWorkflowTriggersByRepositoryPathParams) error {
			return errors.New("disable failed")
		},
	}, nil, nil).PersistDefinitions(ctx, 1, WorkflowLoadResult{Definitions: []LoadedWorkflowDefinition{baseDef}})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "sync workflow triggers")

	err = NewWorkflowSyncService(&mockWorkflowSyncQuerier{
		upsertWorkflowDefinitionFn: func(context.Context, db.UpsertWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return db.WorkflowDefinition{ID: 9, RepositoryID: 1, Path: ".smithers/workflows/ci.ts"}, nil
		},
		createWorkflowTriggerFn: func(context.Context, db.CreateWorkflowTriggerParams) (db.WorkflowTrigger, error) {
			return db.WorkflowTrigger{}, errors.New("trigger failed")
		},
	}, nil, nil).PersistDefinitions(ctx, 1, WorkflowLoadResult{Definitions: []LoadedWorkflowDefinition{baseDef}})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "sync workflow triggers")

	err = NewWorkflowSyncService(&mockWorkflowSyncQuerier{
		upsertWorkflowDefinitionFn: func(context.Context, db.UpsertWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return db.WorkflowDefinition{ID: 9, RepositoryID: 1, Path: ".smithers/workflows/ci.ts"}, nil
		},
		deleteWorkflowScheduleSpecsByDefinitionFn: func(context.Context, int64) error {
			return errors.New("delete schedule failed")
		},
	}, nil, nil).PersistDefinitions(ctx, 1, WorkflowLoadResult{Definitions: []LoadedWorkflowDefinition{baseDef}})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "sync schedule specs")
}

func TestWorkflowSync_H_StaleAndScheduleBranches(t *testing.T) {
	ctx := context.Background()
	stale := db.WorkflowDefinition{ID: 4, RepositoryID: 1, Path: ".smithers/workflows/stale.ts"}

	assert.False(t, isTypeScriptWorkflowPath("README.md"))
	assert.False(t, isTypeScriptWorkflowPath(".github/workflows/ci.ts"))
	assert.Equal(t, "ci", workflowNameFromPath(".smithers/workflows/ci.ts"))
	assert.Equal(t, "release", workflowNameFromPath(".smithers/workflows/release.tsx"))

	for _, tc := range []struct {
		name string
		q    *mockWorkflowSyncQuerier
		want string
	}{
		{
			name: "delete specs",
			q: &mockWorkflowSyncQuerier{
				listWorkflowDefinitionsByRepoFn: func(context.Context, db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
					return []db.WorkflowDefinition{stale}, nil
				},
				deleteWorkflowScheduleSpecsByDefinitionFn: func(context.Context, int64) error { return errors.New("delete failed") },
			},
			want: "delete schedule specs",
		},
		{
			name: "disable triggers",
			q: &mockWorkflowSyncQuerier{
				listWorkflowDefinitionsByRepoFn: func(context.Context, db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
					return []db.WorkflowDefinition{stale}, nil
				},
				disableWorkflowTriggersByRepositoryPathFn: func(context.Context, db.DisableWorkflowTriggersByRepositoryPathParams) error {
					return errors.New("disable failed")
				},
			},
			want: "disable workflow triggers",
		},
		{
			name: "deactivate",
			q: &mockWorkflowSyncQuerier{
				listWorkflowDefinitionsByRepoFn: func(context.Context, db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
					return []db.WorkflowDefinition{stale}, nil
				},
				deactivateWorkflowDefinitionByPathFn: func(context.Context, db.DeactivateWorkflowDefinitionByPathParams) error {
					return errors.New("deactivate failed")
				},
			},
			want: "deactivate workflow definition",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := NewWorkflowSyncService(tc.q, nil, nil).PersistDefinitions(ctx, 1, WorkflowLoadResult{})
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.want)
		})
	}

	q := &mockWorkflowSyncQuerier{
		upsertWorkflowScheduleSpecFn: func(context.Context, db.UpsertWorkflowScheduleSpecParams) error {
			return errors.New("schedule upsert failed")
		},
	}
	svc := NewWorkflowSyncService(q, nil, nil)
	require.NoError(t, svc.syncScheduleSpecs(ctx, db.WorkflowDefinition{ID: 8, RepositoryID: 1}, &WorkflowConfig{}))
	err := svc.syncScheduleSpecs(ctx, db.WorkflowDefinition{ID: 9, RepositoryID: 1}, &WorkflowConfig{
		On: WorkflowOnConfig{Schedule: []ScheduleTrigger{{Cron: ""}, {Cron: "not cron"}, {Cron: "* * * * *"}}},
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "upsert schedule spec")
}

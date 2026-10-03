package services

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestWorkflowSync_Cov_SyncAndOwnerErrorBranches(t *testing.T) {
	svc := NewWorkflowSyncService(nil, nil, nil)
	err := svc.SyncWorkflowsFromCommit(context.Background(), 0, "abc")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "repository id")

	q := &mockWorkflowSyncQuerier{}
	svc = NewWorkflowSyncService(q, &mockWorkflowSyncRepoHost{}, &mockWorkflowSyncParser{})
	_, err = svc.resolveRepoOwner(context.Background(), db.Repository{ID: 77})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "no owner namespace")

	q.getOrgByIDFn = func(context.Context, int64) (db.Organization, error) {
		return db.Organization{}, assert.AnError
	}
	_, err = svc.resolveRepoOwner(context.Background(), db.Repository{ID: 78, OrgID: pgtype.Int8{Int64: 5, Valid: true}})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "load repository owner org")
}

func TestWorkflowSync_Cov_PersistDecodeScheduleAndStaleBranches(t *testing.T) {
	var deletedSpecs []int64
	var upsertedCrons []string
	queries := &mockWorkflowSyncQuerier{
		listWorkflowDefinitionsByRepoFn: func(context.Context, db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{
				{ID: 1, RepositoryID: 42, Path: ".smithers/workflows/old.ts"},
				{ID: 2, RepositoryID: 42, Path: ".smithers/workflows/bad.ts"},
			}, nil
		},
		upsertWorkflowDefinitionFn: func(ctx context.Context, arg db.UpsertWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return db.WorkflowDefinition{ID: 10, RepositoryID: arg.RepositoryID, Path: arg.Path}, nil
		},
		deleteWorkflowScheduleSpecsByDefinitionFn: func(ctx context.Context, workflowDefinitionID int64) error {
			deletedSpecs = append(deletedSpecs, workflowDefinitionID)
			return nil
		},
		upsertWorkflowScheduleSpecFn: func(ctx context.Context, arg db.UpsertWorkflowScheduleSpecParams) error {
			upsertedCrons = append(upsertedCrons, arg.CronExpression)
			return nil
		},
	}
	svc := NewWorkflowSyncService(queries, nil, nil)
	config := WorkflowConfig{
		On: WorkflowOnConfig{
			Schedule: []ScheduleTrigger{
				{Cron: ""},
				{Cron: "not cron"},
				{Cron: "*/15 * * * *"},
			},
			Push: &PushTrigger{},
		},
	}
	configJSON, err := json.Marshal(config)
	require.NoError(t, err)

	err = svc.persistCurrentDefinitions(context.Background(), 42, WorkflowLoadResult{
		Definitions: []LoadedWorkflowDefinition{{
			Name:   "ci",
			Path:   ".smithers/workflows/ci.ts",
			Config: configJSON,
		}},
		FileErrors: []WorkflowLoadFileError{{Path: ".smithers/workflows/bad.ts", Error: "parse failed"}},
	})
	require.NoError(t, err)
	assert.Contains(t, deletedSpecs, int64(10), "current definition specs are cleared before resync")
	assert.Contains(t, deletedSpecs, int64(1), "stale definitions have specs removed")
	assert.Contains(t, deletedSpecs, int64(2), "file-error definitions have specs removed")
	assert.Equal(t, []string{"*/15 * * * *"}, upsertedCrons)
	assert.NotEmpty(t, queries.disableWorkflowTriggerCalls)
	assert.NotEmpty(t, queries.deactivateCalls)
	assert.NotEmpty(t, queries.createWorkflowTriggerCalls)

	err = svc.persistCurrentDefinitions(context.Background(), 42, WorkflowLoadResult{
		Definitions: []LoadedWorkflowDefinition{{Name: "bad", Path: ".smithers/workflows/bad.ts", Config: []byte(`{`)}},
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "decode workflow config")
}

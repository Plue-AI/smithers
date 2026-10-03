package services

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

func TestWorkflowTransportUnreadableResponsesPreserveDatabaseRows(t *testing.T) {
	for _, tc := range workflowTransportCases() {
		t.Run(tc.name, func(t *testing.T) {
			pool := servicesSuite.Pool(t)
			_, repoID := setupTestUserAndRepo(t, pool)
			ctx := context.Background()
			queries := db.New(pool)
			oldConfig := json.RawMessage(`{"on":{"push":{}},"jobs":{"old":{"runs-on":"ubuntu-latest"}}}`)
			old, err := queries.UpsertWorkflowDefinition(ctx, db.UpsertWorkflowDefinitionParams{
				RepositoryID: repoID, Name: "existing", Path: transportBadPath, Config: oldConfig,
			})
			require.NoError(t, err)
			_, err = queries.CreateWorkflowTrigger(ctx, db.CreateWorkflowTriggerParams{
				RepositoryID: repoID, WorkflowDefinitionID: old.ID, WorkflowPath: transportBadPath,
				EventType: "push", Enabled: true,
			})
			require.NoError(t, err)
			require.NoError(t, queries.UpsertWorkflowScheduleSpec(ctx, db.UpsertWorkflowScheduleSpecParams{
				WorkflowDefinitionID: old.ID, RepositoryID: repoID, CronExpression: "0 0 * * *", NextFireAt: time.Now().Add(time.Hour),
			}))

			// A fake repo-host can return malformed transport metadata that a real
			// repo-host would normally prevent; the parser records any unsafe call.
			host := &mockWorkflowSyncRepoHost{
				getBookmarkFn: func(context.Context, string, string, string) (repohost.Bookmark, error) {
					return repohost.Bookmark{TargetCommitID: "commit-1"}, nil
				},
				listFilesAtChangeFn: func(_ context.Context, _, _, _, _ string) ([]repohost.ChangeFile, error) {
					return []repohost.ChangeFile{{Path: transportBadPath}}, nil
				},
				getFileAtChangeFn: func(_ context.Context, _, _, _, path string) (repohost.FileContent, error) {
					require.Equal(t, transportBadPath, path)
					return tc.file, tc.err
				},
			}
			parser := &mockWorkflowSyncParser{parseFn: func(_ context.Context, _ string, _ []byte) (*WorkflowConfig, error) {
				return &WorkflowConfig{Jobs: map[string]JobConfig{"replacement": {RunsOn: "ubuntu-latest"}}}, nil
			}}
			require.NoError(t, NewWorkflowSyncService(queries, host, parser).SyncWorkflowsFromCommit(ctx, repoID, "commit-1"))
			assert.Empty(t, parser.calls)

			got, err := queries.GetWorkflowDefinitionByPath(ctx, db.GetWorkflowDefinitionByPathParams{RepositoryID: repoID, Path: transportBadPath})
			require.NoError(t, err)
			assert.Equal(t, old.ID, got.ID)
			assert.True(t, got.IsActive)
			assert.JSONEq(t, string(oldConfig), string(got.Config))
			assert.Equal(t, old.UpdatedAt, got.UpdatedAt)
			var enabled bool
			require.NoError(t, pool.QueryRow(ctx, `SELECT enabled FROM workflow_triggers WHERE workflow_definition_id = $1`, old.ID).Scan(&enabled))
			assert.True(t, enabled)
			var scheduleCount int
			require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM workflow_schedule_specs WHERE workflow_definition_id = $1`, old.ID).Scan(&scheduleCount))
			assert.Equal(t, 1, scheduleCount)
		})
	}
}

func TestWorkflowTransportReadFailureRetryAndRemoval(t *testing.T) {
	pool := servicesSuite.Pool(t)
	_, repoID := setupTestUserAndRepo(t, pool)
	ctx := context.Background()
	queries := db.New(pool)
	old, err := queries.UpsertWorkflowDefinition(ctx, db.UpsertWorkflowDefinitionParams{
		RepositoryID: repoID, Name: "existing", Path: transportBadPath,
		Config: json.RawMessage(`{"on":{"push":{}},"jobs":{"old":{"runs-on":"ubuntu-latest"}}}`),
	})
	require.NoError(t, err)
	_, err = queries.CreateWorkflowTrigger(ctx, db.CreateWorkflowTriggerParams{
		RepositoryID: repoID, WorkflowDefinitionID: old.ID, WorkflowPath: transportBadPath,
		EventType: "push", Enabled: true,
	})
	require.NoError(t, err)
	require.NoError(t, queries.UpsertWorkflowScheduleSpec(ctx, db.UpsertWorkflowScheduleSpecParams{
		WorkflowDefinitionID: old.ID, RepositoryID: repoID, CronExpression: "0 0 * * *", NextFireAt: time.Now().Add(time.Hour),
	}))
	phase := "unreadable"
	// The fake host controls three commit snapshots; the parser receives only the retry.
	host := &mockWorkflowSyncRepoHost{
		getBookmarkFn: func(context.Context, string, string, string) (repohost.Bookmark, error) {
			if phase == "removed" {
				return repohost.Bookmark{TargetCommitID: "removal-commit"}, nil
			}
			return repohost.Bookmark{TargetCommitID: phase + "-commit"}, nil
		},
		listFilesAtChangeFn: func(_ context.Context, _, _, _, _ string) ([]repohost.ChangeFile, error) {
			if phase == "removed" {
				return nil, nil
			}
			return []repohost.ChangeFile{{Path: transportBadPath}}, nil
		},
		getFileAtChangeFn: func(_ context.Context, _, _, _, path string) (repohost.FileContent, error) {
			require.Equal(t, transportBadPath, path)
			if phase == "unreadable" {
				return repohost.FileContent{Path: path, TooLarge: true}, nil
			}
			return repohost.FileContent{Path: path, Content: "new source", Encoding: "utf8"}, nil
		},
	}
	parser := &mockWorkflowSyncParser{parseFn: func(_ context.Context, path string, content []byte) (*WorkflowConfig, error) {
		require.Equal(t, transportBadPath, path)
		require.Equal(t, []byte("new source"), content)
		return &WorkflowConfig{
			On:   WorkflowOnConfig{Push: &PushTrigger{}, Schedule: []ScheduleTrigger{{Cron: "30 6 * * *"}}},
			Jobs: map[string]JobConfig{"replacement": {RunsOn: "ubuntu-latest"}},
		}, nil
	}}
	svc := NewWorkflowSyncService(queries, host, parser)
	require.NoError(t, svc.SyncWorkflowsFromCommit(ctx, repoID, "unreadable-commit"))
	assert.Empty(t, parser.calls)
	got, err := queries.GetWorkflowDefinitionByPath(ctx, db.GetWorkflowDefinitionByPathParams{RepositoryID: repoID, Path: transportBadPath})
	require.NoError(t, err)
	assert.Equal(t, old.UpdatedAt, got.UpdatedAt)
	assert.True(t, got.IsActive)

	phase = "retry"
	require.NoError(t, svc.SyncWorkflowsFromCommit(ctx, repoID, "retry-commit"))
	require.Len(t, parser.calls, 1)
	got, err = queries.GetWorkflowDefinitionByPath(ctx, db.GetWorkflowDefinitionByPathParams{RepositoryID: repoID, Path: transportBadPath})
	require.NoError(t, err)
	assert.True(t, got.IsActive)
	assert.Contains(t, string(got.Config), "replacement")
	var cron string
	require.NoError(t, pool.QueryRow(ctx, `SELECT cron_expression FROM workflow_schedule_specs WHERE workflow_definition_id = $1`, old.ID).Scan(&cron))
	assert.Equal(t, "30 6 * * *", cron)
	var enabled bool
	require.NoError(t, pool.QueryRow(ctx, `SELECT enabled FROM workflow_triggers WHERE workflow_definition_id = $1 AND event_type = 'push'`, old.ID).Scan(&enabled))
	assert.True(t, enabled)

	phase = "removed"
	require.NoError(t, svc.SyncWorkflowsFromCommit(ctx, repoID, "removal-commit"))
	got, err = queries.GetWorkflowDefinitionByPath(ctx, db.GetWorkflowDefinitionByPathParams{RepositoryID: repoID, Path: transportBadPath})
	require.NoError(t, err)
	assert.False(t, got.IsActive)
	require.NoError(t, pool.QueryRow(ctx, `SELECT enabled FROM workflow_triggers WHERE workflow_definition_id = $1 AND event_type = 'push'`, old.ID).Scan(&enabled))
	assert.False(t, enabled)
	var remainingSchedules int
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM workflow_schedule_specs WHERE workflow_definition_id = $1`, old.ID).Scan(&remainingSchedules))
	assert.Zero(t, remainingSchedules)
}

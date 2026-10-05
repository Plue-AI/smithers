package services

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

func TestWorkflowDefaultHeadDeletionPostgres(t *testing.T) {
	pool := servicesSuite.Pool(t)
	_, repoID := setupTestUserAndRepo(t, pool)
	ctx := context.Background()
	q := db.New(pool)
	const workflowPath = ".smithers/workflows/ci.tsx"
	def, err := q.UpsertWorkflowDefinition(ctx, db.UpsertWorkflowDefinitionParams{
		RepositoryID: repoID, Name: "ci", Path: workflowPath,
		Config: json.RawMessage(`{"on":{"push":{}},"jobs":{"build":{}}}`),
	})
	require.NoError(t, err)
	_, err = q.CreateWorkflowTrigger(ctx, db.CreateWorkflowTriggerParams{
		RepositoryID: repoID, WorkflowDefinitionID: def.ID, WorkflowPath: workflowPath, EventType: "push", Enabled: true,
	})
	require.NoError(t, err)
	// The DB is real. Controlled repository snapshots reproduce late delivery
	// without depending on webhook timing or moving a live repository's refs.
	// main moved older-main-push -> deletion-head; the feature ref forked
	// from older-main-push. Neither late commit descends from the head.
	host := &mockWorkflowSyncRepoHost{
		parents: map[string][]string{
			"older-main-push":     nil,
			"deletion-head":       {"older-main-push"},
			"feature-ref-with-ci": {"older-main-push"},
		},
		getBookmarkFn: func(context.Context, string, string, string) (repohost.Bookmark, error) {
			return repohost.Bookmark{TargetCommitID: "deletion-head"}, nil
		},
		listFilesAtChangeFn: func(_ context.Context, _, _, commit, _ string) ([]repohost.ChangeFile, error) {
			if commit == "deletion-head" {
				return nil, nil
			}
			return []repohost.ChangeFile{{Path: workflowPath}}, nil
		},
		getFileAtChangeFn: func(context.Context, string, string, string, string) (repohost.FileContent, error) {
			return repohost.FileContent{Path: workflowPath, Content: "ci"}, nil
		},
	}
	parser := &mockWorkflowSyncParser{parseFn: func(context.Context, string, []byte) (*WorkflowConfig, error) {
		return &WorkflowConfig{On: WorkflowOnConfig{Push: &PushTrigger{}}, Jobs: map[string]JobConfig{"build": {}}}, nil
	}}
	syncer := NewWorkflowSyncService(q, host, parser)
	require.NoError(t, syncer.SyncWorkflowsFromCommit(ctx, repoID, "deletion-head"))
	deleted, err := q.GetWorkflowDefinition(ctx, db.GetWorkflowDefinitionParams{ID: def.ID, RepositoryID: repoID})
	require.NoError(t, err)
	require.False(t, deleted.IsActive)
	for _, commit := range []string{"older-main-push", "feature-ref-with-ci"} {
		require.NoError(t, syncer.SyncWorkflowsFromCommit(ctx, repoID, commit))
		loaded, err := syncer.LoadDefinitionsFromCommit(ctx, repoID, commit)
		require.NoError(t, err)
		require.NoError(t, syncer.PersistDefinitions(ctx, repoID, loaded))
		runs, err := NewWorkflowRunService(q, WithWorkflowRunDefinitionCommitLoader(syncer), WithWorkflowRunBookmarkCommitResolver(syncer)).DispatchForEvent(ctx, DispatchForEventInput{
			RepositoryID: repoID, Event: TriggerEvent{Type: "push", Ref: "refs/heads/main", CommitSHA: commit},
			UseLoadedDefinitions: true, LoadedDefinitions: loaded.Definitions,
		})
		require.NoError(t, err)
		assert.Empty(t, runs)
		got, err := q.GetWorkflowDefinition(ctx, db.GetWorkflowDefinitionParams{ID: def.ID, RepositoryID: repoID})
		require.NoError(t, err)
		assert.False(t, got.IsActive)
		assert.Equal(t, deleted.UpdatedAt, got.UpdatedAt)
	}
	var enabled, runCount int
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM workflow_triggers WHERE workflow_definition_id = $1 AND enabled`, def.ID).Scan(&enabled))
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM workflow_runs WHERE repository_id = $1`, repoID).Scan(&runCount))
	assert.Zero(t, enabled)
	assert.Zero(t, runCount)
}

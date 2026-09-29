package services

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

const (
	transportBadPath  = ".smithers/workflows/existing.tsx"
	transportGoodPath = ".smithers/workflows/fresh.tsx"
)

type workflowTransportCase struct {
	name string
	file repohost.FileContent
	err  error
}

func workflowTransportCases() []workflowTransportCase {
	return []workflowTransportCase{
		{name: "too large with empty content", file: repohost.FileContent{Path: transportBadPath, TooLarge: true}},
		{name: "too large with populated content", file: repohost.FileContent{Path: transportBadPath, Content: "valid workflow", Encoding: "utf8", TooLarge: true}},
		{name: "binary base64 content", file: repohost.FileContent{Path: transportBadPath, Content: "AGJpbmFyeQ==", Encoding: "base64"}},
		{name: "unknown encoding", file: repohost.FileContent{Path: transportBadPath, Content: "valid workflow", Encoding: "latin1"}},
		{name: "zero value incomplete response", file: repohost.FileContent{}},
		{name: "missing path", file: repohost.FileContent{Content: "valid workflow", Encoding: "utf8"}},
		{name: "mismatched path", file: repohost.FileContent{Path: transportGoodPath, Content: "valid workflow", Encoding: "utf8"}},
		{name: "content exceeds byte limit", file: repohost.FileContent{Path: transportBadPath, Content: strings.Repeat("a", maxWorkflowFileBytes+1), Encoding: "utf8"}},
		{name: "repo-host read error", err: errors.New("temporary read failure")},
	}
}

func workflowTransportRepoAndHost(t *testing.T, bad workflowTransportCase, withGood bool) (*mockWorkflowSyncQuerier, *mockWorkflowSyncRepoHost) {
	t.Helper()
	queries := &mockWorkflowSyncQuerier{
		getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			require.Equal(t, int64(42), id)
			return db.Repository{ID: id, Name: "demo", UserID: pgtype.Int8{Int64: 7, Valid: true}}, nil
		},
		getUserByIDFn: func(_ context.Context, id int64) (db.User, error) {
			require.Equal(t, int64(7), id)
			return db.User{ID: id, Username: "alice"}, nil
		},
	}
	host := &mockWorkflowSyncRepoHost{
		listFilesAtChangeFn: func(_ context.Context, owner, repo, changeID, prefix string) ([]repohost.ChangeFile, error) {
			require.Equal(t, "alice", owner)
			require.Equal(t, "demo", repo)
			require.Equal(t, "commit-1", changeID)
			require.Equal(t, ".smithers/workflows", prefix)
			files := []repohost.ChangeFile{{Path: transportBadPath}}
			if withGood {
				files = append(files, repohost.ChangeFile{Path: transportGoodPath})
			}
			return files, nil
		},
		getFileAtChangeFn: func(_ context.Context, owner, repo, changeID, path string) (repohost.FileContent, error) {
			require.Equal(t, "alice", owner)
			require.Equal(t, "demo", repo)
			require.Equal(t, "commit-1", changeID)
			if path == transportGoodPath {
				return repohost.FileContent{Path: path, Content: "valid workflow", Encoding: "utf8"}, nil
			}
			require.Equal(t, transportBadPath, path)
			return bad.file, bad.err
		},
	}
	return queries, host
}

func TestWorkflowTransportUnreadableFilesAreNotParsed(t *testing.T) {
	for _, tc := range workflowTransportCases() {
		t.Run(tc.name, func(t *testing.T) {
			queries, host := workflowTransportRepoAndHost(t, tc, false)
			parser := &mockWorkflowSyncParser{parseFn: func(_ context.Context, _ string, _ []byte) (*WorkflowConfig, error) {
				t.Fatal("unreadable response reached parser")
				return nil, nil
			}}
			result, err := NewWorkflowSyncService(queries, host, parser).LoadDefinitionsFromCommit(context.Background(), 42, "commit-1")
			require.NoError(t, err)
			assert.Empty(t, result.Definitions)
			assert.Empty(t, parser.calls)
			require.Len(t, result.FileErrors, 1)
			assert.Equal(t, transportBadPath, result.FileErrors[0].Path)
			assert.NotEmpty(t, result.FileErrors[0].Error)
		})
	}
}

func TestWorkflowTransportUnreadableResponsePreservesExistingStateDuringSync(t *testing.T) {
	for _, tc := range workflowTransportCases() {
		t.Run(tc.name, func(t *testing.T) {
			queries, host := workflowTransportRepoAndHost(t, tc, true)
			oldConfig := json.RawMessage(`{"on":{"push":{}},"jobs":{"old":{"runs-on":"ubuntu-latest"}}}`)
			stored := db.WorkflowDefinition{ID: 1001, RepositoryID: 42, Name: "existing", Path: transportBadPath, Config: oldConfig, IsActive: true}
			triggerEnabled := true
			schedulePresent := true
			queries.listWorkflowDefinitionsByRepoFn = func(_ context.Context, arg db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
				require.Equal(t, int64(42), arg.RepositoryID)
				return []db.WorkflowDefinition{stored}, nil
			}
			queries.upsertWorkflowDefinitionFn = func(_ context.Context, arg db.UpsertWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
				if arg.Path == transportBadPath {
					stored.Config = append(json.RawMessage(nil), arg.Config...)
				}
				return db.WorkflowDefinition{ID: 1002, RepositoryID: 42, Path: arg.Path}, nil
			}
			queries.deactivateWorkflowDefinitionByPathFn = func(_ context.Context, arg db.DeactivateWorkflowDefinitionByPathParams) error {
				if arg.Path == transportBadPath {
					stored.IsActive = false
				}
				return nil
			}
			queries.disableWorkflowTriggersByRepositoryPathFn = func(_ context.Context, arg db.DisableWorkflowTriggersByRepositoryPathParams) error {
				if arg.WorkflowPath == transportBadPath {
					triggerEnabled = false
				}
				return nil
			}
			queries.deleteWorkflowScheduleSpecsByDefinitionFn = func(_ context.Context, id int64) error {
				if id == stored.ID {
					schedulePresent = false
				}
				return nil
			}
			parser := &mockWorkflowSyncParser{parseFn: func(_ context.Context, path string, content []byte) (*WorkflowConfig, error) {
				if path == transportGoodPath {
					require.Equal(t, []byte("valid workflow"), content)
				}
				return &WorkflowConfig{Jobs: map[string]JobConfig{"fresh": {RunsOn: "ubuntu-latest"}}}, nil
			}}
			err := NewWorkflowSyncService(queries, host, parser).SyncWorkflowsFromCommit(context.Background(), 42, "commit-1")
			require.NoError(t, err)
			assert.Len(t, parser.calls, 1)
			assert.Len(t, queries.upsertCalls, 1)
			for _, call := range parser.calls {
				assert.NotEqual(t, transportBadPath, call.filePath)
			}
			for _, call := range queries.upsertCalls {
				assert.NotEqual(t, transportBadPath, call.Path)
			}
			assert.Equal(t, oldConfig, stored.Config, "existing workflow config changed")
			assert.True(t, stored.IsActive, "existing workflow was deactivated")
			assert.True(t, triggerEnabled, "existing trigger was disabled")
			assert.True(t, schedulePresent, "existing schedule was deleted")
		})
	}
}

func TestWorkflowTransportReadableEncodingsAndByteLimit(t *testing.T) {
	for _, tc := range []struct {
		name string
		file repohost.FileContent
	}{
		{"legacy empty encoding", repohost.FileContent{Path: transportBadPath, Content: "valid workflow"}},
		{"explicit utf8", repohost.FileContent{Path: transportBadPath, Content: "valid workflow", Encoding: "utf8"}},
		{"empty utf8 content reaches parser", repohost.FileContent{Path: transportBadPath, Encoding: "utf8"}},
		{"exact byte limit", repohost.FileContent{Path: transportBadPath, Content: strings.Repeat("a", maxWorkflowFileBytes), Encoding: "utf8"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			queries, host := workflowTransportRepoAndHost(t, workflowTransportCase{file: tc.file}, false)
			parser := &mockWorkflowSyncParser{parseFn: func(_ context.Context, path string, content []byte) (*WorkflowConfig, error) {
				require.Equal(t, transportBadPath, path)
				require.Equal(t, []byte(tc.file.Content), content)
				return &WorkflowConfig{Jobs: map[string]JobConfig{"valid": {RunsOn: "ubuntu-latest"}}}, nil
			}}
			result, err := NewWorkflowSyncService(queries, host, parser).LoadDefinitionsFromCommit(context.Background(), 42, "commit-1")
			require.NoError(t, err)
			require.Len(t, parser.calls, 1)
			require.Len(t, result.Definitions, 1)
			assert.Equal(t, transportBadPath, result.Definitions[0].Path)
			assert.Empty(t, result.FileErrors)
		})
	}
}

func TestWorkflowTransportPreservationWinsDuplicateDefinition(t *testing.T) {
	queries := &mockWorkflowSyncQuerier{
		listWorkflowDefinitionsByRepoFn: func(_ context.Context, _ db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			return []db.WorkflowDefinition{{ID: 1001, RepositoryID: 42, Path: transportBadPath, IsActive: true}}, nil
		},
	}
	result := WorkflowLoadResult{
		Definitions: []LoadedWorkflowDefinition{{
			Name: "existing", Path: transportBadPath,
			Config: json.RawMessage(`{"on":{"push":{}}}`),
		}},
		FileErrors: []WorkflowLoadFileError{{Path: transportBadPath, Error: "incomplete response", PreserveExisting: true}},
	}
	require.NoError(t, NewWorkflowSyncService(queries, nil, nil).PersistDefinitions(context.Background(), 42, result))
	assert.Empty(t, queries.upsertCalls)
	assert.Empty(t, queries.deactivateCalls)
	assert.Empty(t, queries.disableWorkflowTriggerCalls)
}

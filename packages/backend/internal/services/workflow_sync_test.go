package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type mockWorkflowSyncRepoHost struct {
	getBookmarkFn       func(context.Context, string, string, string) (repohost.Bookmark, error)
	listFilesAtChangeFn func(ctx context.Context, owner, repo, changeID, prefix string) ([]repohost.ChangeFile, error)
	getFileAtChangeFn   func(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error)
	listBookmarksFn     func(ctx context.Context, owner, repo, cursor string, limit int) ([]repohost.Bookmark, string, error)

	listFilesAtChangeCalls []struct {
		owner    string
		repo     string
		changeID string
		prefix   string
	}
	getFileAtChangeCalls []struct {
		owner    string
		repo     string
		changeID string
		path     string
	}
	listBookmarkCursors []string
}

func (m *mockWorkflowSyncRepoHost) ListBookmarks(ctx context.Context, owner, repo, cursor string, limit int) ([]repohost.Bookmark, string, error) {
	m.listBookmarkCursors = append(m.listBookmarkCursors, cursor)
	if m.listBookmarksFn != nil {
		return m.listBookmarksFn(ctx, owner, repo, cursor, limit)
	}
	return nil, "", nil
}

func (m *mockWorkflowSyncRepoHost) ListFilesAtChange(ctx context.Context, owner, repo, changeID, prefix string) ([]repohost.ChangeFile, error) {
	m.listFilesAtChangeCalls = append(m.listFilesAtChangeCalls, struct {
		owner    string
		repo     string
		changeID string
		prefix   string
	}{owner: owner, repo: repo, changeID: changeID, prefix: prefix})
	if m.listFilesAtChangeFn != nil {
		return m.listFilesAtChangeFn(ctx, owner, repo, changeID, prefix)
	}
	return nil, nil
}

func (m *mockWorkflowSyncRepoHost) GetFileAtChange(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error) {
	m.getFileAtChangeCalls = append(m.getFileAtChangeCalls, struct {
		owner    string
		repo     string
		changeID string
		path     string
	}{owner: owner, repo: repo, changeID: changeID, path: path})
	if m.getFileAtChangeFn != nil {
		return m.getFileAtChangeFn(ctx, owner, repo, changeID, path)
	}
	return repohost.FileContent{}, nil
}

func TestWorkflowSyncService_ResolveBookmarkCommitUsesAuthoritativeRepoHost(t *testing.T) {
	t.Parallel()

	queries := &mockWorkflowSyncQuerier{
		getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			return db.Repository{ID: id, Name: "demo", UserID: pgtype.Int8{Int64: 7, Valid: true}}, nil
		},
		getUserByIDFn: func(_ context.Context, id int64) (db.User, error) {
			return db.User{ID: id, Username: "alice"}, nil
		},
	}
	commitID := strings.Repeat("a", 40)
	calls := 0
	bookmarks := map[string]repohost.Bookmark{}
	for i := range 601 {
		name := fmt.Sprintf("branch-%d", i)
		bookmarks[name] = repohost.Bookmark{Name: name, TargetCommitID: strings.Repeat("b", 40)}
	}
	bookmarks["main"] = repohost.Bookmark{Name: "main", TargetCommitID: commitID}
	repoHost := &mockWorkflowSyncRepoHost{
		getBookmarkFn: func(_ context.Context, owner, repo, name string) (repohost.Bookmark, error) {
			calls++
			assert.Equal(t, "alice", owner)
			assert.Equal(t, "demo", repo)
			return bookmarks[name], nil
		}, listBookmarksFn: func(context.Context, string, string, string, int) ([]repohost.Bookmark, string, error) {
			t.Fatal("named resolution must not list bookmarks")
			return nil, "", nil
		},
	}

	got, err := NewWorkflowSyncService(queries, repoHost, nil).ResolveBookmarkCommit(context.Background(), 42, " main ")
	require.NoError(t, err)
	assert.Equal(t, commitID, got)
	assert.Equal(t, 1, calls)
	assert.Empty(t, repoHost.listBookmarkCursors)
}

type mockWorkflowSyncParser struct {
	parseFn func(ctx context.Context, filePath string, content []byte) (*WorkflowConfig, error)

	calls []struct {
		filePath string
		content  []byte
	}
}

func (m *mockWorkflowSyncParser) Parse(ctx context.Context, filePath string, content []byte) (*WorkflowConfig, error) {
	m.calls = append(m.calls, struct {
		filePath string
		content  []byte
	}{filePath: filePath, content: append([]byte(nil), content...)})
	if m.parseFn != nil {
		return m.parseFn(ctx, filePath, content)
	}
	return nil, nil
}

type mockWorkflowSyncQuerier struct {
	getRepoByIDFn                             func(ctx context.Context, id int64) (db.Repository, error)
	getUserByIDFn                             func(ctx context.Context, id int64) (db.User, error)
	getOrgByIDFn                              func(ctx context.Context, id int64) (db.Organization, error)
	listWorkflowDefinitionsByRepoFn           func(ctx context.Context, arg db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error)
	upsertWorkflowDefinitionFn                func(ctx context.Context, arg db.UpsertWorkflowDefinitionParams) (db.WorkflowDefinition, error)
	deactivateWorkflowDefinitionByPathFn      func(ctx context.Context, arg db.DeactivateWorkflowDefinitionByPathParams) error
	createWorkflowTriggerFn                   func(ctx context.Context, arg db.CreateWorkflowTriggerParams) (db.WorkflowTrigger, error)
	disableWorkflowTriggersByRepositoryPathFn func(ctx context.Context, arg db.DisableWorkflowTriggersByRepositoryPathParams) error
	upsertWorkflowScheduleSpecFn              func(ctx context.Context, arg db.UpsertWorkflowScheduleSpecParams) error
	deleteWorkflowScheduleSpecsByDefinitionFn func(ctx context.Context, workflowDefinitionID int64) error

	upsertCalls                 []db.UpsertWorkflowDefinitionParams
	deactivateCalls             []db.DeactivateWorkflowDefinitionByPathParams
	createWorkflowTriggerCalls  []db.CreateWorkflowTriggerParams
	disableWorkflowTriggerCalls []db.DisableWorkflowTriggersByRepositoryPathParams
}

func (m *mockWorkflowSyncQuerier) GetRepoByID(ctx context.Context, id int64) (db.Repository, error) {
	if m.getRepoByIDFn != nil {
		return m.getRepoByIDFn(ctx, id)
	}
	return db.Repository{}, nil
}

func (m *mockWorkflowSyncQuerier) GetUserByID(ctx context.Context, id int64) (db.User, error) {
	if m.getUserByIDFn != nil {
		return m.getUserByIDFn(ctx, id)
	}
	return db.User{}, nil
}

func (m *mockWorkflowSyncQuerier) GetOrgByID(ctx context.Context, id int64) (db.Organization, error) {
	if m.getOrgByIDFn != nil {
		return m.getOrgByIDFn(ctx, id)
	}
	return db.Organization{}, nil
}

func (m *mockWorkflowSyncQuerier) ListWorkflowDefinitionsByRepo(ctx context.Context, arg db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
	if m.listWorkflowDefinitionsByRepoFn != nil {
		return m.listWorkflowDefinitionsByRepoFn(ctx, arg)
	}
	return nil, nil
}

func (m *mockWorkflowSyncQuerier) UpsertWorkflowDefinition(ctx context.Context, arg db.UpsertWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
	m.upsertCalls = append(m.upsertCalls, arg)
	if m.upsertWorkflowDefinitionFn != nil {
		return m.upsertWorkflowDefinitionFn(ctx, arg)
	}
	return db.WorkflowDefinition{}, nil
}

func (m *mockWorkflowSyncQuerier) DeactivateWorkflowDefinitionByPath(ctx context.Context, arg db.DeactivateWorkflowDefinitionByPathParams) error {
	m.deactivateCalls = append(m.deactivateCalls, arg)
	if m.deactivateWorkflowDefinitionByPathFn != nil {
		return m.deactivateWorkflowDefinitionByPathFn(ctx, arg)
	}
	return nil
}

func (m *mockWorkflowSyncQuerier) CreateWorkflowTrigger(ctx context.Context, arg db.CreateWorkflowTriggerParams) (db.WorkflowTrigger, error) {
	m.createWorkflowTriggerCalls = append(m.createWorkflowTriggerCalls, arg)
	if m.createWorkflowTriggerFn != nil {
		return m.createWorkflowTriggerFn(ctx, arg)
	}
	return db.WorkflowTrigger{}, nil
}

func (m *mockWorkflowSyncQuerier) DisableWorkflowTriggersByRepositoryPath(ctx context.Context, arg db.DisableWorkflowTriggersByRepositoryPathParams) error {
	m.disableWorkflowTriggerCalls = append(m.disableWorkflowTriggerCalls, arg)
	if m.disableWorkflowTriggersByRepositoryPathFn != nil {
		return m.disableWorkflowTriggersByRepositoryPathFn(ctx, arg)
	}
	return nil
}

func (m *mockWorkflowSyncQuerier) UpsertWorkflowScheduleSpec(ctx context.Context, arg db.UpsertWorkflowScheduleSpecParams) error {
	if m.upsertWorkflowScheduleSpecFn != nil {
		return m.upsertWorkflowScheduleSpecFn(ctx, arg)
	}
	return nil
}

func (m *mockWorkflowSyncQuerier) DeleteWorkflowScheduleSpecsByDefinition(ctx context.Context, workflowDefinitionID int64) error {
	if m.deleteWorkflowScheduleSpecsByDefinitionFn != nil {
		return m.deleteWorkflowScheduleSpecsByDefinitionFn(ctx, workflowDefinitionID)
	}
	return nil
}

func TestWorkflowSyncService_LoadDefinitionsFromCommit_DiscoversParsesAndReturnsBestEffort(t *testing.T) {
	t.Parallel()

	queries := &mockWorkflowSyncQuerier{
		getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			assert.Equal(t, int64(42), id)
			return db.Repository{
				ID:     42,
				Name:   "demo",
				UserID: pgtype.Int8{Int64: 7, Valid: true},
			}, nil
		},
		getUserByIDFn: func(_ context.Context, id int64) (db.User, error) {
			assert.Equal(t, int64(7), id)
			return db.User{ID: 7, Username: "alice"}, nil
		},
	}

	repoHost := &mockWorkflowSyncRepoHost{
		listFilesAtChangeFn: func(_ context.Context, owner, repo, changeID, prefix string) ([]repohost.ChangeFile, error) {
			assert.Equal(t, "alice", owner)
			assert.Equal(t, "demo", repo)
			assert.Equal(t, "abc123", changeID)
			assert.Equal(t, ".smithers/workflows", prefix)
			return []repohost.ChangeFile{
				{Path: ".smithers/workflows/build.tsx"},
				{Path: ".smithers/workflows/deploy.tsx"},
				{Path: ".smithers/workflows/bad.tsx"},
			}, nil
		},
		getFileAtChangeFn: func(_ context.Context, owner, repo, changeID, path string) (repohost.FileContent, error) {
			assert.Equal(t, "alice", owner)
			assert.Equal(t, "demo", repo)
			assert.Equal(t, "abc123", changeID)
			return repohost.FileContent{
				Path:    path,
				Content: "export default {}",
			}, nil
		},
	}

	parser := &mockWorkflowSyncParser{
		parseFn: func(_ context.Context, filePath string, _ []byte) (*WorkflowConfig, error) {
			switch filePath {
			case ".smithers/workflows/build.tsx":
				return &WorkflowConfig{
					On: WorkflowOnConfig{
						Push: &PushTrigger{},
					},
					Jobs: map[string]JobConfig{
						"build": {RunsOn: "ubuntu-latest"},
					},
				}, nil
			case ".smithers/workflows/deploy.tsx":
				return &WorkflowConfig{
					On: WorkflowOnConfig{
						WorkflowDispatch: &WorkflowDispatchTrigger{},
					},
					Jobs: map[string]JobConfig{
						"deploy": {RunsOn: "ubuntu-latest"},
					},
				}, nil
			case ".smithers/workflows/bad.tsx":
				return nil, errors.New("unexpected token")
			default:
				return nil, errors.New("unexpected file")
			}
		},
	}

	svc := NewWorkflowSyncService(queries, repoHost, parser)
	result, err := svc.LoadDefinitionsFromCommit(context.Background(), 42, "abc123")
	require.NoError(t, err)

	require.Len(t, parser.calls, 3)
	assert.Equal(t, ".smithers/workflows/build.tsx", parser.calls[0].filePath)
	assert.Equal(t, ".smithers/workflows/deploy.tsx", parser.calls[1].filePath)

	require.Len(t, result.Definitions, 2)
	assert.Equal(t, "build", result.Definitions[0].Name)
	assert.Equal(t, ".smithers/workflows/build.tsx", result.Definitions[0].Path)
	assert.Equal(t, "deploy", result.Definitions[1].Name)
	assert.Equal(t, ".smithers/workflows/deploy.tsx", result.Definitions[1].Path)

	require.Len(t, result.FileErrors, 1)
	assert.Equal(t, ".smithers/workflows/bad.tsx", result.FileErrors[0].Path)

	var buildConfig map[string]any
	require.NoError(t, json.Unmarshal(result.Definitions[0].Config, &buildConfig))
	assert.Contains(t, buildConfig, "on")
	assert.Contains(t, buildConfig, "jobs")
}

func TestWorkflowSyncService_LoadDefinitionsFromCommit_RejectsInvalidGraph(t *testing.T) {
	t.Parallel()

	queries := &mockWorkflowSyncQuerier{
		getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
			return db.Repository{ID: id, Name: "demo", UserID: pgtype.Int8{Int64: 7, Valid: true}}, nil
		},
		getUserByIDFn: func(_ context.Context, _ int64) (db.User, error) {
			return db.User{ID: 7, Username: "alice"}, nil
		},
	}
	repoHost := &mockWorkflowSyncRepoHost{
		listFilesAtChangeFn: func(_ context.Context, _, _, _, _ string) ([]repohost.ChangeFile, error) {
			return []repohost.ChangeFile{{Path: ".smithers/workflows/ci.tsx"}}, nil
		},
		getFileAtChangeFn: func(_ context.Context, _, _, _, path string) (repohost.FileContent, error) {
			return repohost.FileContent{Path: path, Content: "workflow"}, nil
		},
	}
	parser := &mockWorkflowSyncParser{
		parseFn: func(_ context.Context, _ string, _ []byte) (*WorkflowConfig, error) {
			return &WorkflowConfig{
				On: WorkflowOnConfig{Push: &PushTrigger{}},
				Jobs: map[string]JobConfig{
					"build":  {Needs: []string{"deploy"}},
					"deploy": {Needs: []string{"build"}},
				},
			}, nil
		},
	}

	result, err := NewWorkflowSyncService(queries, repoHost, parser).LoadDefinitionsFromCommit(context.Background(), 42, "abc123")
	require.NoError(t, err)
	assert.Empty(t, result.Definitions)
	require.Len(t, result.FileErrors, 1)
	assert.Contains(t, result.FileErrors[0].Error, "cycle")
}

func TestWorkflowSyncService_PersistDefinitions_UpsertsSchedulesAndDeactivatesInvalidAndMissingPaths(t *testing.T) {
	t.Parallel()

	var deletedScheduleDefIDs []int64
	var upsertedSpecs []db.UpsertWorkflowScheduleSpecParams

	queries := &mockWorkflowSyncQuerier{
		getRepoByIDFn: func(_ context.Context, _ int64) (db.Repository, error) {
			return db.Repository{
				ID:     42,
				Name:   "demo",
				UserID: pgtype.Int8{Int64: 7, Valid: true},
			}, nil
		},
		getUserByIDFn: func(_ context.Context, _ int64) (db.User, error) {
			return db.User{ID: 7, Username: "alice"}, nil
		},
		listWorkflowDefinitionsByRepoFn: func(_ context.Context, arg db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
			assert.Equal(t, int64(42), arg.RepositoryID)
			return []db.WorkflowDefinition{
				{ID: 1001, RepositoryID: 42, Path: ".smithers/workflows/build.tsx", IsActive: true},
				{ID: 1002, RepositoryID: 42, Path: ".smithers/workflows/stale.tsx", IsActive: true},
				{ID: 1003, RepositoryID: 42, Path: ".smithers/workflows/bad.tsx", IsActive: true},
			}, nil
		},
		upsertWorkflowDefinitionFn: func(_ context.Context, arg db.UpsertWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
			return db.WorkflowDefinition{ID: 1001, RepositoryID: arg.RepositoryID, Path: arg.Path}, nil
		},
		deactivateWorkflowDefinitionByPathFn: func(_ context.Context, arg db.DeactivateWorkflowDefinitionByPathParams) error {
			assert.Equal(t, int64(42), arg.RepositoryID)
			return nil
		},
		deleteWorkflowScheduleSpecsByDefinitionFn: func(_ context.Context, workflowDefinitionID int64) error {
			deletedScheduleDefIDs = append(deletedScheduleDefIDs, workflowDefinitionID)
			return nil
		},
		upsertWorkflowScheduleSpecFn: func(_ context.Context, arg db.UpsertWorkflowScheduleSpecParams) error {
			upsertedSpecs = append(upsertedSpecs, arg)
			return nil
		},
	}

	svc := NewWorkflowSyncService(queries, &mockWorkflowSyncRepoHost{}, &mockWorkflowSyncParser{})
	err := svc.PersistDefinitions(context.Background(), 42, WorkflowLoadResult{
		Definitions: []LoadedWorkflowDefinition{
			{
				Name:   "build",
				Path:   ".smithers/workflows/build.tsx",
				Config: json.RawMessage(`{"on":{"schedule":[{"cron":"0 0 * * *"}]}}`),
			},
		},
		FileErrors: []WorkflowLoadFileError{
			{Path: ".smithers/workflows/bad.tsx", Error: "unexpected token"},
		},
	})
	require.NoError(t, err)

	require.Len(t, queries.upsertCalls, 1)
	assert.Equal(t, "build", queries.upsertCalls[0].Name)
	assert.Equal(t, ".smithers/workflows/build.tsx", queries.upsertCalls[0].Path)
	assert.ElementsMatch(t, []int64{1001, 1002, 1003}, deletedScheduleDefIDs)
	require.Len(t, upsertedSpecs, 1)
	assert.Equal(t, int64(1001), upsertedSpecs[0].WorkflowDefinitionID)
	require.Len(t, queries.createWorkflowTriggerCalls, 1)
	assert.Equal(t, int64(42), queries.createWorkflowTriggerCalls[0].RepositoryID)
	assert.Equal(t, int64(1001), queries.createWorkflowTriggerCalls[0].WorkflowDefinitionID)
	assert.Equal(t, "schedule", queries.createWorkflowTriggerCalls[0].EventType)

	require.Len(t, queries.deactivateCalls, 2)
	assert.ElementsMatch(t, []string{
		".smithers/workflows/stale.tsx",
		".smithers/workflows/bad.tsx",
	}, []string{
		queries.deactivateCalls[0].Path,
		queries.deactivateCalls[1].Path,
	})
	require.Len(t, queries.disableWorkflowTriggerCalls, 3)
	assert.ElementsMatch(t, []string{
		".smithers/workflows/build.tsx",
		".smithers/workflows/stale.tsx",
		".smithers/workflows/bad.tsx",
	}, []string{
		queries.disableWorkflowTriggerCalls[0].WorkflowPath,
		queries.disableWorkflowTriggerCalls[1].WorkflowPath,
		queries.disableWorkflowTriggerCalls[2].WorkflowPath,
	})
}

func TestWorkflowSyncService_SyncWorkflowsFromCommit_OrgRepo_UsesOrgAsOwner(t *testing.T) {
	t.Parallel()

	queries := &mockWorkflowSyncQuerier{
		getRepoByIDFn: func(_ context.Context, _ int64) (db.Repository, error) {
			return db.Repository{
				ID:    99,
				Name:  "platform",
				OrgID: pgtype.Int8{Int64: 11, Valid: true},
			}, nil
		},
		getOrgByIDFn: func(_ context.Context, id int64) (db.Organization, error) {
			assert.Equal(t, int64(11), id)
			return db.Organization{ID: 11, Name: "acme"}, nil
		},
	}

	repoHost := &mockWorkflowSyncRepoHost{
		listFilesAtChangeFn: func(_ context.Context, owner, repo, changeID, prefix string) ([]repohost.ChangeFile, error) {
			assert.Equal(t, "acme", owner)
			assert.Equal(t, "platform", repo)
			return nil, nil
		},
	}

	parser := &mockWorkflowSyncParser{}
	svc := NewWorkflowSyncService(queries, repoHost, parser)

	require.NoError(t, svc.SyncWorkflowsFromCommit(context.Background(), 99, "change-1"))
}

func TestIsTypeScriptWorkflowPath(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		path     string
		expected bool
	}{
		{"tsx file in smithers workflows dir", ".smithers/workflows/build.tsx", true},
		{"ts file in smithers workflows dir", ".smithers/workflows/ci.ts", true},
		{"tsx file in workflows dir", ".smithers/workflows/build.tsx", true},
		{"ts file in workflows dir", ".smithers/workflows/ci.ts", true},
		{"tsx in subdirectory", ".smithers/workflows/sub/deploy.tsx", true},
		{"ts in subdirectory", ".smithers/workflows/sub/lint.ts", true},
		{"yaml file rejected", ".smithers/workflows/build.yaml", false},
		{"yml file rejected", ".smithers/workflows/build.yml", false},
		{"js file rejected", ".smithers/workflows/build.js", false},
		{"json file rejected", ".smithers/workflows/build.json", false},
		{"md file rejected", ".smithers/workflows/README.md", false},
		{"tsx outside workflows dir", "src/build.tsx", false},
		{"ts outside workflows dir", "src/build.ts", false},
		{"tsx in wrong prefix", ".github/workflows/build.tsx", false},
		{"empty path", "", false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tc.expected, isTypeScriptWorkflowPath(tc.path))
		})
	}
}

func TestWorkflowNameFromPath(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		path     string
		expected string
	}{
		{"tsx file", ".smithers/workflows/build.tsx", "build"},
		{"ts file", ".smithers/workflows/ci.ts", "ci"},
		{"tsx in subdirectory", ".smithers/workflows/sub/deploy.tsx", "deploy"},
		{"ts in subdirectory", ".smithers/workflows/sub/lint.ts", "lint"},
		{"hyphenated name tsx", ".smithers/workflows/my-workflow.tsx", "my-workflow"},
		{"hyphenated name ts", ".smithers/workflows/my-workflow.ts", "my-workflow"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tc.expected, workflowNameFromPath(tc.path))
		})
	}
}

func TestWorkflowSyncService_LoadDefinitionsFromCommit_DiscoversTS(t *testing.T) {
	t.Parallel()

	queries := &mockWorkflowSyncQuerier{
		getRepoByIDFn: func(_ context.Context, _ int64) (db.Repository, error) {
			return db.Repository{
				ID:     42,
				Name:   "demo",
				UserID: pgtype.Int8{Int64: 7, Valid: true},
			}, nil
		},
		getUserByIDFn: func(_ context.Context, _ int64) (db.User, error) {
			return db.User{ID: 7, Username: "alice"}, nil
		},
	}

	repoHost := &mockWorkflowSyncRepoHost{
		listFilesAtChangeFn: func(_ context.Context, _, _, _, _ string) ([]repohost.ChangeFile, error) {
			return []repohost.ChangeFile{
				{Path: ".smithers/workflows/lint.ts"},
			}, nil
		},
		getFileAtChangeFn: func(_ context.Context, _, _, _, path string) (repohost.FileContent, error) {
			return repohost.FileContent{
				Path:    path,
				Content: "export default { on: { push: {} }, jobs: {} };",
			}, nil
		},
	}

	parser := &mockWorkflowSyncParser{
		parseFn: func(_ context.Context, filePath string, _ []byte) (*WorkflowConfig, error) {
			assert.Equal(t, ".smithers/workflows/lint.ts", filePath)
			return &WorkflowConfig{
				On: WorkflowOnConfig{Push: &PushTrigger{}},
			}, nil
		},
	}

	svc := NewWorkflowSyncService(queries, repoHost, parser)
	result, err := svc.LoadDefinitionsFromCommit(context.Background(), 42, "abc123")
	require.NoError(t, err)

	require.Len(t, result.Definitions, 1)
	assert.Equal(t, "lint", result.Definitions[0].Name)
	assert.Equal(t, ".smithers/workflows/lint.ts", result.Definitions[0].Path)
	assert.Empty(t, result.FileErrors)
}

func TestWorkflowSyncService_LoadDefinitionsFromCommit_MixedTSXAndTS(t *testing.T) {
	t.Parallel()

	queries := &mockWorkflowSyncQuerier{
		getRepoByIDFn: func(_ context.Context, _ int64) (db.Repository, error) {
			return db.Repository{
				ID:     42,
				Name:   "demo",
				UserID: pgtype.Int8{Int64: 7, Valid: true},
			}, nil
		},
		getUserByIDFn: func(_ context.Context, _ int64) (db.User, error) {
			return db.User{ID: 7, Username: "alice"}, nil
		},
	}

	repoHost := &mockWorkflowSyncRepoHost{
		listFilesAtChangeFn: func(_ context.Context, _, _, _, _ string) ([]repohost.ChangeFile, error) {
			return []repohost.ChangeFile{
				{Path: ".smithers/workflows/build.tsx"},
				{Path: ".smithers/workflows/lint.ts"},
				{Path: ".smithers/workflows/README.md"},
				{Path: ".smithers/workflows/helpers.js"},
			}, nil
		},
		getFileAtChangeFn: func(_ context.Context, _, _, _, path string) (repohost.FileContent, error) {
			return repohost.FileContent{
				Path:    path,
				Content: "export default {}",
			}, nil
		},
	}

	parser := &mockWorkflowSyncParser{
		parseFn: func(_ context.Context, filePath string, _ []byte) (*WorkflowConfig, error) {
			switch filePath {
			case ".smithers/workflows/build.tsx":
				return &WorkflowConfig{
					On:   WorkflowOnConfig{Push: &PushTrigger{}},
					Jobs: map[string]JobConfig{"build": {RunsOn: "ubuntu-latest"}},
				}, nil
			case ".smithers/workflows/lint.ts":
				return &WorkflowConfig{
					On:   WorkflowOnConfig{Push: &PushTrigger{}},
					Jobs: map[string]JobConfig{"lint": {RunsOn: "ubuntu-latest"}},
				}, nil
			default:
				return nil, errors.New("unexpected file: " + filePath)
			}
		},
	}

	svc := NewWorkflowSyncService(queries, repoHost, parser)
	result, err := svc.LoadDefinitionsFromCommit(context.Background(), 42, "abc123")
	require.NoError(t, err)

	// Only .tsx and .ts files should be processed; .md and .js are ignored
	require.Len(t, parser.calls, 2)
	assert.Equal(t, ".smithers/workflows/build.tsx", parser.calls[0].filePath)
	assert.Equal(t, ".smithers/workflows/lint.ts", parser.calls[1].filePath)

	require.Len(t, result.Definitions, 2)
	assert.Equal(t, "build", result.Definitions[0].Name)
	assert.Equal(t, ".smithers/workflows/build.tsx", result.Definitions[0].Path)
	assert.Equal(t, "lint", result.Definitions[1].Name)
	assert.Equal(t, ".smithers/workflows/lint.ts", result.Definitions[1].Path)

	assert.Empty(t, result.FileErrors)
}

func TestLoadDefinitionsFromCommit_CapsWorkflowFileCount(t *testing.T) {
	t.Parallel()

	const overCap = maxWorkflowFilesPerSync + 2

	queries := &mockWorkflowSyncQuerier{
		getRepoByIDFn: func(_ context.Context, _ int64) (db.Repository, error) {
			return db.Repository{
				ID:     42,
				Name:   "demo",
				UserID: pgtype.Int8{Int64: 7, Valid: true},
			}, nil
		},
		getUserByIDFn: func(_ context.Context, _ int64) (db.User, error) {
			return db.User{ID: 7, Username: "alice"}, nil
		},
	}

	var files []repohost.ChangeFile
	for i := 0; i < overCap; i++ {
		files = append(files, repohost.ChangeFile{Path: fmt.Sprintf(".smithers/workflows/wf%02d.tsx", i)})
	}

	repoHost := &mockWorkflowSyncRepoHost{
		listFilesAtChangeFn: func(_ context.Context, _, _, _, _ string) ([]repohost.ChangeFile, error) {
			return files, nil
		},
		getFileAtChangeFn: func(_ context.Context, _, _, _, path string) (repohost.FileContent, error) {
			return repohost.FileContent{
				Path:    path,
				Content: "export default { on: { push: {} }, jobs: { build: { runsOn: \"ubuntu-latest\" } } };",
			}, nil
		},
	}

	parser := &mockWorkflowSyncParser{
		parseFn: func(_ context.Context, filePath string, _ []byte) (*WorkflowConfig, error) {
			return &WorkflowConfig{
				On:   WorkflowOnConfig{Push: &PushTrigger{}},
				Jobs: map[string]JobConfig{"build": {RunsOn: "ubuntu-latest"}},
			}, nil
		},
	}

	svc := NewWorkflowSyncService(queries, repoHost, parser)
	result, err := svc.LoadDefinitionsFromCommit(context.Background(), 42, "abc123")
	require.NoError(t, err)

	assert.Len(t, parser.calls, maxWorkflowFilesPerSync)
	assert.Len(t, repoHost.getFileAtChangeCalls, maxWorkflowFilesPerSync)
	require.Len(t, result.FileErrors, 2)
	for _, fileErr := range result.FileErrors {
		assert.Contains(t, fileErr.Error, "workflow file limit exceeded")
	}

	// The over-cap paths must never have been fetched from repo-host.
	fetchedPaths := make(map[string]bool, len(repoHost.getFileAtChangeCalls))
	for _, call := range repoHost.getFileAtChangeCalls {
		fetchedPaths[call.path] = true
	}
	for _, fileErr := range result.FileErrors {
		assert.False(t, fetchedPaths[fileErr.Path], "over-cap path %q should not have been fetched", fileErr.Path)
	}
}

func TestLoadDefinitionsFromCommit_RejectsOversizedFile(t *testing.T) {
	t.Parallel()

	queries := &mockWorkflowSyncQuerier{
		getRepoByIDFn: func(_ context.Context, _ int64) (db.Repository, error) {
			return db.Repository{
				ID:     42,
				Name:   "demo",
				UserID: pgtype.Int8{Int64: 7, Valid: true},
			}, nil
		},
		getUserByIDFn: func(_ context.Context, _ int64) (db.User, error) {
			return db.User{ID: 7, Username: "alice"}, nil
		},
	}

	oversized := strings.Repeat("a", maxWorkflowFileBytes+1)

	repoHost := &mockWorkflowSyncRepoHost{
		listFilesAtChangeFn: func(_ context.Context, _, _, _, _ string) ([]repohost.ChangeFile, error) {
			return []repohost.ChangeFile{
				{Path: ".smithers/workflows/huge.tsx"},
			}, nil
		},
		getFileAtChangeFn: func(_ context.Context, _, _, _, path string) (repohost.FileContent, error) {
			return repohost.FileContent{
				Path:    path,
				Content: oversized,
			}, nil
		},
	}

	parser := &mockWorkflowSyncParser{
		parseFn: func(_ context.Context, filePath string, _ []byte) (*WorkflowConfig, error) {
			t.Fatalf("parser should not be invoked for oversized file %q", filePath)
			return nil, nil
		},
	}

	svc := NewWorkflowSyncService(queries, repoHost, parser)
	result, err := svc.LoadDefinitionsFromCommit(context.Background(), 42, "abc123")
	require.NoError(t, err)

	assert.Empty(t, parser.calls)
	assert.Empty(t, result.Definitions)
	require.Len(t, result.FileErrors, 1)
	assert.Equal(t, ".smithers/workflows/huge.tsx", result.FileErrors[0].Path)
	assert.Contains(t, result.FileErrors[0].Error, "workflow file too large")
}

func (m *mockWorkflowSyncRepoHost) GetBookmark(ctx context.Context, owner, repo, name string) (repohost.Bookmark, error) {
	if m.getBookmarkFn != nil {
		return m.getBookmarkFn(ctx, owner, repo, name)
	}
	return repohost.Bookmark{}, &repohost.StatusError{StatusCode: 404, Code: "bookmark_not_found"}
}

func TestWorkflowSyncBookmarkLookupErrors(t *testing.T) {
	for _, tc := range []struct {
		name, want string
		bookmark   repohost.Bookmark
		err        error
	}{
		{name: "absent", want: "not found", err: &repohost.StatusError{StatusCode: 404, Code: "bookmark_not_found"}},
		{name: "empty target", want: "no target commit", bookmark: repohost.Bookmark{Name: "main"}},
		{name: "missing repository", want: "repository storage absent", err: &repohost.StatusError{StatusCode: 404, Message: "repository storage absent"}},
		{name: "canceled", want: "context canceled", err: context.Canceled},
	} {
		t.Run(tc.name, func(t *testing.T) {
			q := &mockWorkflowSyncQuerier{getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
				return db.Repository{Name: "demo", UserID: pgtype.Int8{Int64: 7, Valid: true}}, nil
			}, getUserByIDFn: func(context.Context, int64) (db.User, error) { return db.User{Username: "alice"}, nil }}
			calls := 0
			h := &mockWorkflowSyncRepoHost{getBookmarkFn: func(context.Context, string, string, string) (repohost.Bookmark, error) {
				calls++
				return tc.bookmark, tc.err
			}}
			_, err := NewWorkflowSyncService(q, h, nil).ResolveBookmarkCommit(t.Context(), 42, "main")
			require.ErrorContains(t, err, tc.want)
			require.Equal(t, 1, calls)
			require.Empty(t, h.listBookmarkCursors)
		})
	}
}

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

func TestWorkflowSyncDefaultHeadDeletedWorkflowCannotRearm(t *testing.T) {
	for _, source := range []string{"older-main-push", "non-main-ref"} {
		t.Run(source, func(t *testing.T) {
			ctx := context.Background()
			const workflowPath = ".smithers/workflows/ci.tsx"
			active := true
			queries := &mockWorkflowSyncQuerier{
				getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
					return db.Repository{ID: 42, Name: "demo", DefaultBookmark: "main", UserID: pgtype.Int8{Int64: 7, Valid: true}}, nil
				},
				getUserByIDFn: func(context.Context, int64) (db.User, error) { return db.User{Username: "alice"}, nil },
				listWorkflowDefinitionsByRepoFn: func(context.Context, db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
					return []db.WorkflowDefinition{{ID: 1, RepositoryID: 42, Path: workflowPath, IsActive: active}}, nil
				},
				upsertWorkflowDefinitionFn: func(context.Context, db.UpsertWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
					active = true
					return db.WorkflowDefinition{ID: 1, RepositoryID: 42, Path: workflowPath, IsActive: true}, nil
				},
				deactivateWorkflowDefinitionByPathFn: func(context.Context, db.DeactivateWorkflowDefinitionByPathParams) error { active = false; return nil },
			}
			host := &mockWorkflowSyncRepoHost{
				getBookmarkFn: func(context.Context, string, string, string) (repohost.Bookmark, error) {
					return repohost.Bookmark{Name: "main", TargetCommitID: "deletion-head"}, nil
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
				return &WorkflowConfig{On: WorkflowOnConfig{Push: &PushTrigger{}}}, nil
			}}
			svc := NewWorkflowSyncService(queries, host, parser)
			require.NoError(t, svc.SyncWorkflowsFromCommit(ctx, 42, "deletion-head"))
			require.False(t, active)
			require.NoError(t, svc.SyncWorkflowsFromCommit(ctx, 42, source))
			assert.False(t, active, "a stale or side-branch snapshot re-armed a deleted workflow")
			assert.Empty(t, queries.upsertCalls)
			assert.Empty(t, parser.calls, "skip stale snapshots before parsing")
			// Direct persistence must also reject a historical, read-only load.
			loaded, err := svc.LoadDefinitionsFromCommit(ctx, 42, source)
			require.NoError(t, err)
			require.Len(t, loaded.Definitions, 1)
			require.NoError(t, svc.PersistDefinitions(ctx, 42, loaded))
			assert.False(t, active)
			assert.Empty(t, queries.upsertCalls)
		})
	}
}

func TestWorkflowPushDefaultHeadAdmission(t *testing.T) {
	for _, mode := range []string{"broadcast", "loaded", "targeted"} {
		for _, tc := range []struct {
			name           string
			commit         string
			active, exists bool
			wantRuns       int
		}{
			{"older push after deletion", strings.Repeat("a", 40), true, true, 0},
			{"ref deletion without commit", "", true, true, 0},
			{"inactive definition at head", strings.Repeat("b", 40), false, true, 0},
			{"deleted file at head", strings.Repeat("b", 40), true, false, 0},
			{"invalid file at head", strings.Repeat("b", 40), true, true, 0},
			{"active file at head", strings.Repeat("b", 40), true, true, 1},
		} {
			t.Run(mode+"/"+tc.name, func(t *testing.T) {
				ctx := context.Background()
				def := makeWorkflowDef(1, 42, "ci", tc.active, `{"on":{"push":{}},"jobs":{"stale":{}}}`)
				q := &mockWorkflowRunQuerier{
					listDefsFn: func(context.Context, db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
						return []db.WorkflowDefinition{def}, nil
					},
					getDefFn: func(context.Context, db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) { return def, nil },
					ensureDefRefFn: func(context.Context, db.EnsureWorkflowDefinitionReferenceParams) (db.WorkflowDefinition, error) {
						return def, nil
					},
				}
				loaded := WorkflowLoadResult{}
				if tc.exists {
					loaded = workflowLoadResultForPath(def.Path, `{"on":{"push":{}},"jobs":{"from-commit":{}}}`)
				}
				if tc.name == "invalid file at head" {
					loaded.FileErrors = []WorkflowLoadFileError{{Path: def.Path, Error: "unreadable", PreserveExisting: true}}
				}
				loader := &recordingWorkflowDefinitionCommitLoader{result: loaded}
				resolver := &recordingWorkflowBookmarkCommitResolver{commit: strings.Repeat("b", 40)}
				svc := NewWorkflowRunService(q, WithWorkflowRunDefinitionCommitLoader(loader), WithWorkflowRunBookmarkCommitResolver(resolver))
				input := DispatchForEventInput{RepositoryID: 42, Event: TriggerEvent{Type: "push", Ref: "refs/heads/main", CommitSHA: tc.commit}}
				// A dotted descriptor normalizes to the same push event; it must
				// cross the same head/activity/file checks as the webhook form.
				if mode == "loaded" {
					input.Event.Type = "push.updated"
				}
				if mode == "loaded" {
					input.UseLoadedDefinitions = true
					input.LoadedDefinitions = []LoadedWorkflowDefinition{{Name: "ci", Path: def.Path, Config: json.RawMessage(`{"on":{"push":{}},"jobs":{"stale":{}}}`)}}
				}
				if mode == "targeted" {
					input.WorkflowDefinitionID = &def.ID
				}
				runs, err := svc.DispatchForEvent(ctx, input)
				require.NoError(t, err)
				assert.Len(t, runs, tc.wantRuns)
				assert.Len(t, q.createRunCalls, tc.wantRuns)
				if tc.wantRuns == 1 {
					require.Len(t, q.createStepCalls, 1)
					assert.Equal(t, "from-commit", q.createStepCalls[0].Name)
				}
			})
		}
	}
}

func TestWorkflowSyncRejectsUnboundSnapshots(t *testing.T) {
	for _, result := range []WorkflowLoadResult{{}, {repositoryID: 43, commitSHA: "head"}, {repositoryID: 42}} {
		q := &mockWorkflowSyncQuerier{}
		err := NewWorkflowSyncService(q, nil, nil).PersistDefinitions(context.Background(), 42, result)
		require.ErrorContains(t, err, "provenance")
		assert.Empty(t, q.upsertCalls)
		assert.Empty(t, q.deactivateCalls)
	}
}

func TestWorkflowSyncHeadMovesDuringDiscovery(t *testing.T) {
	head := "old-head"
	q := &mockWorkflowSyncQuerier{
		getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{ID: 42, Name: "demo", DefaultBookmark: "trunk", UserID: pgtype.Int8{Int64: 7, Valid: true}}, nil
		},
		getUserByIDFn: func(context.Context, int64) (db.User, error) { return db.User{Username: "alice"}, nil },
	}
	host := &mockWorkflowSyncRepoHost{
		getBookmarkFn: func(_ context.Context, _, _, bookmark string) (repohost.Bookmark, error) {
			require.Equal(t, "trunk", bookmark)
			return repohost.Bookmark{TargetCommitID: head}, nil
		},
		listFilesAtChangeFn: func(context.Context, string, string, string, string) ([]repohost.ChangeFile, error) {
			return []repohost.ChangeFile{{Path: ".smithers/workflows/ci.tsx"}}, nil
		},
		getFileAtChangeFn: func(context.Context, string, string, string, string) (repohost.FileContent, error) {
			return repohost.FileContent{Path: ".smithers/workflows/ci.tsx", Content: "ci"}, nil
		},
	}
	parser := &mockWorkflowSyncParser{parseFn: func(context.Context, string, []byte) (*WorkflowConfig, error) {
		head = "deletion-head"
		return &WorkflowConfig{On: WorkflowOnConfig{Push: &PushTrigger{}}}, nil
	}}
	require.NoError(t, NewWorkflowSyncService(q, host, parser).SyncWorkflowsFromCommit(context.Background(), 42, "old-head"))
	assert.Empty(t, q.upsertCalls)
	assert.Empty(t, q.disableWorkflowTriggerCalls)
	assert.Empty(t, q.deactivateCalls)
}

func TestWorkflowPushFailsClosedWithoutVerifiedHeadAndFiles(t *testing.T) {
	for _, tc := range []struct {
		name     string
		resolver *recordingWorkflowBookmarkCommitResolver
		loader   *recordingWorkflowDefinitionCommitLoader
	}{
		{"missing resolver", nil, &recordingWorkflowDefinitionCommitLoader{}},
		{"head read failure", &recordingWorkflowBookmarkCommitResolver{err: errors.New("offline")}, &recordingWorkflowDefinitionCommitLoader{}},
		{"empty head", &recordingWorkflowBookmarkCommitResolver{}, &recordingWorkflowDefinitionCommitLoader{}},
		{"missing loader", &recordingWorkflowBookmarkCommitResolver{commit: "head"}, nil},
		{"file list failure", &recordingWorkflowBookmarkCommitResolver{commit: "head"}, &recordingWorkflowDefinitionCommitLoader{err: errors.New("offline")}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			q := &mockWorkflowRunQuerier{listDefsFn: func(context.Context, db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
				return []db.WorkflowDefinition{makeWorkflowDef(1, 42, "ci", true, `{"on":{"push":{}},"jobs":{"build":{}}}`)}, nil
			}}
			var opts []WorkflowRunServiceOption
			if tc.resolver != nil {
				opts = append(opts, WithWorkflowRunBookmarkCommitResolver(tc.resolver))
			}
			if tc.loader != nil {
				opts = append(opts, WithWorkflowRunDefinitionCommitLoader(tc.loader))
			}
			runs, err := NewWorkflowRunService(q, opts...).DispatchForEvent(context.Background(), DispatchForEventInput{
				RepositoryID: 42, Event: TriggerEvent{Type: "push", Ref: "main", CommitSHA: "head"},
			})
			require.Error(t, err)
			assert.Empty(t, runs)
			assert.Empty(t, q.createRunCalls)
		})
	}
}

func TestWorkflowPushHeadMovesWhileLoadingFiles(t *testing.T) {
	q := &mockWorkflowRunQuerier{listDefsFn: func(context.Context, db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
		return []db.WorkflowDefinition{makeWorkflowDef(1, 42, "ci", true, `{"on":{"push":{}},"jobs":{"build":{}}}`)}, nil
	}}
	resolver := &recordingWorkflowBookmarkCommitResolver{commit: "head"}
	loader := workflowPushFixtureLoader(func(context.Context, int64, string) (WorkflowLoadResult, error) {
		resolver.commit = "deletion-head"
		return workflowLoadResultForPath(".smithers/workflows/ci.tsx", `{"on":{"push":{}},"jobs":{"build":{}}}`), nil
	})
	runs, err := NewWorkflowRunService(q, WithWorkflowRunBookmarkCommitResolver(resolver), WithWorkflowRunDefinitionCommitLoader(loader)).DispatchForEvent(context.Background(), DispatchForEventInput{
		RepositoryID: 42, Event: TriggerEvent{Type: "push", Ref: "main", CommitSHA: "head"},
	})
	require.NoError(t, err)
	assert.Empty(t, runs)
	assert.Empty(t, q.createRunCalls)
}

// Resolve different heads per ref so a default-head lookup cannot accidentally
// pass a branch freshness test when the fixture returns one constant revision.
type workflowPushRefResolver func(context.Context, int64, string) (string, error)

func (resolve workflowPushRefResolver) ResolveBookmarkCommit(ctx context.Context, repoID int64, bookmark string) (string, error) {
	return resolve(ctx, repoID, bookmark)
}

func TestWorkflowPushFeatureRefAdmission(t *testing.T) {
	for _, mode := range []string{"broadcast", "loaded", "targeted"} {
		for _, tc := range []struct {
			name           string
			commit         string
			active, exists bool
			wantRuns       int
		}{
			{"current feature head", "feature-head", true, true, 1},
			{"stale feature push still at main head", "main-head", true, true, 0},
			{"feature ref deletion", "", true, true, 0},
			{"inactive main definition", "feature-head", false, true, 0},
			{"file absent in feature tree", "feature-head", true, false, 0},
		} {
			t.Run(mode+"/"+tc.name, func(t *testing.T) {
				def := makeWorkflowDef(1, 42, "ci", tc.active, `{"on":{"push":{"branches":["main"]}},"jobs":{"from-main":{}}}`)
				q := &mockWorkflowRunQuerier{
					listDefsFn: func(context.Context, db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
						return []db.WorkflowDefinition{def}, nil
					},
					getDefFn: func(context.Context, db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error) { return def, nil },
				}
				loaded := WorkflowLoadResult{}
				if tc.exists {
					loaded = workflowLoadResultForPath(def.Path, `{"on":{"push":{"branches":["feature/*"]}},"jobs":{"from-feature":{}}}`)
				}
				loader := &recordingWorkflowDefinitionCommitLoader{result: loaded}
				var bookmarks []string
				resolver := workflowPushRefResolver(func(_ context.Context, repoID int64, bookmark string) (string, error) {
					assert.Equal(t, int64(42), repoID)
					bookmarks = append(bookmarks, bookmark)
					if bookmark == "feature/x" {
						return "feature-head", nil
					}
					return "main-head", nil
				})
				input := DispatchForEventInput{RepositoryID: 42, Event: TriggerEvent{Type: "push", Ref: "refs/heads/feature/x", CommitSHA: tc.commit}}
				if mode == "loaded" {
					input.UseLoadedDefinitions = true
					input.LoadedDefinitions = loaded.Definitions
				}
				if mode == "targeted" {
					input.WorkflowDefinitionID = &def.ID
				}
				runs, err := NewWorkflowRunService(q, WithWorkflowRunBookmarkCommitResolver(resolver), WithWorkflowRunDefinitionCommitLoader(loader)).DispatchForEvent(context.Background(), input)
				require.NoError(t, err)
				assert.Len(t, runs, tc.wantRuns)
				assert.Len(t, q.createRunCalls, tc.wantRuns)
				for _, bookmark := range bookmarks {
					assert.Equal(t, "feature/x", bookmark)
				}
				if tc.wantRuns == 1 {
					require.Len(t, q.createStepCalls, 1)
					assert.Equal(t, "from-feature", q.createStepCalls[0].Name)
					assert.Equal(t, "refs/heads/feature/x", q.createRunCalls[0].TriggerRef)
				}
				if tc.commit == "" || tc.commit == "main-head" {
					assert.Empty(t, loader.calls)
				}
			})
		}
	}
}

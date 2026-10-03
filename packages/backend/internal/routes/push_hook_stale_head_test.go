package routes

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// Use the real sync and dispatch services: a route-only mock would hide the
// freshness checks that caused the production canary to stop syncing.
func TestPushHookWorkflowResolverStillAtOldHead(t *testing.T) {
	for _, tc := range []struct {
		name, ref, head           string
		wantDefinitions, wantRuns int
	}{
		{"default resolver lags", "refs/heads/main", "old", 1, 1},
		{"default current head", "refs/heads/main", "new", 1, 1},
		{"LateDelivery descendant head", "refs/heads/main", "later", 0, 0},
		{"default unrelated head", "refs/heads/main", "unrelated", 0, 0},
		{"FeatureRef resolver lags", "refs/heads/feature", "old", 1, 1},
		{"FeatureRef LateDelivery", "refs/heads/feature", "later", 1, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			q := &pushHeadQueries{}
			host := &pushHeadHost{old: strings.Repeat("a", 40), new: strings.Repeat("b", 40), head: tc.head}
			if strings.Contains(tc.ref, "feature") {
				q.defs = []db.WorkflowDefinition{{ID: 1, RepositoryID: 101, Name: "existing", Path: ".smithers/workflows/smoke.ts", IsActive: true}}
			}
			syncer := services.NewWorkflowSyncService(q, host, pushHeadParser{})
			loaded, err := syncer.LoadDefinitionsFromCommit(t.Context(), 101, host.new)
			require.NoError(t, err)
			require.Len(t, loaded.Definitions, 1)
			runner := services.NewWorkflowRunService(q, services.WithWorkflowRunDefinitionCommitLoader(syncer), services.WithWorkflowRunBookmarkCommitResolver(syncer))
			h := &InternalPushHookHandler{RepoResolver: &mockPushHookRepoResolver{}, WorkflowSync: syncer, WorkflowRun: runner}
			require.NoError(t, h.handleWorkflowsForPush(t.Context(), 101, PushHookEventRequest{Ref: tc.ref, CommitSHA: host.new, PusherCredential: "person"}))
			require.Len(t, q.defs, tc.wantDefinitions, "default push must persist while jj still reports its ancestor")
			require.Equal(t, tc.wantRuns, q.runs, "fresh pushes must dispatch, late pushes must not")
			if strings.Contains(tc.ref, "feature") {
				require.Equal(t, "existing", q.defs[0].Name, "feature push must not replace repository definitions")
			}
		})
	}
}

type pushHeadQueries struct {
	services.WorkflowSyncQuerier
	services.WorkflowRunQuerier
	defs []db.WorkflowDefinition
	runs int
}

func (*pushHeadQueries) GetRepoByID(context.Context, int64) (db.Repository, error) {
	return db.Repository{ID: 101, Name: "demo", DefaultBookmark: "main", UserID: pgtype.Int8{Int64: 7, Valid: true}}, nil
}
func (*pushHeadQueries) GetUserByID(context.Context, int64) (db.User, error) {
	return db.User{Username: "alice"}, nil
}
func (q *pushHeadQueries) ListWorkflowDefinitionsByRepo(context.Context, db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error) {
	return q.defs, nil
}
func (q *pushHeadQueries) UpsertWorkflowDefinition(_ context.Context, p db.UpsertWorkflowDefinitionParams) (db.WorkflowDefinition, error) {
	d := db.WorkflowDefinition{ID: 1, RepositoryID: p.RepositoryID, Name: p.Name, Path: p.Path, Config: p.Config, IsActive: true}
	q.defs = []db.WorkflowDefinition{d}
	return d, nil
}
func (*pushHeadQueries) DisableWorkflowTriggersByRepositoryPath(context.Context, db.DisableWorkflowTriggersByRepositoryPathParams) error {
	return nil
}
func (*pushHeadQueries) DeleteWorkflowScheduleSpecsByDefinition(context.Context, int64) error {
	return nil
}
func (*pushHeadQueries) CreateWorkflowTrigger(context.Context, db.CreateWorkflowTriggerParams) (db.WorkflowTrigger, error) {
	return db.WorkflowTrigger{}, nil
}
func (q *pushHeadQueries) CreateWorkflowRun(_ context.Context, p db.CreateWorkflowRunParams) (db.WorkflowRun, error) {
	q.runs++
	return db.WorkflowRun{ID: int64(q.runs), TriggerCommitSha: p.TriggerCommitSha}, nil
}
func (*pushHeadQueries) CreateWorkflowStep(context.Context, db.CreateWorkflowStepParams) (db.WorkflowStep, error) {
	return db.WorkflowStep{ID: 1}, nil
}
func (*pushHeadQueries) CreateWorkflowTask(context.Context, db.CreateWorkflowTaskParams) (db.WorkflowTask, error) {
	return db.WorkflowTask{ID: 1}, nil
}
func (q *pushHeadQueries) EnsureWorkflowDefinitionReference(context.Context, db.EnsureWorkflowDefinitionReferenceParams) (db.WorkflowDefinition, error) {
	return q.defs[0], nil
}

type pushHeadHost struct{ old, new, head string }

func (h *pushHeadHost) GetBookmark(context.Context, string, string, string) (repohost.Bookmark, error) {
	head := h.head
	if head == "old" {
		head = h.old
	}
	if head == "new" {
		head = h.new
	}
	return repohost.Bookmark{TargetCommitID: head}, nil
}
func (*pushHeadHost) ListBookmarks(context.Context, string, string, string, int) ([]repohost.Bookmark, string, error) {
	panic("named lookup required")
}
func (h *pushHeadHost) IsAncestor(_ context.Context, _, _, ancestor, descendant string) (bool, error) {
	return ancestor == h.old && descendant == h.new, nil
}
func (*pushHeadHost) ListFilesAtChange(context.Context, string, string, string, string) ([]repohost.ChangeFile, error) {
	return []repohost.ChangeFile{{Path: ".smithers/workflows/smoke.ts"}}, nil
}
func (*pushHeadHost) GetFileAtChange(context.Context, string, string, string, string) (repohost.FileContent, error) {
	return repohost.FileContent{Path: ".smithers/workflows/smoke.ts", Content: "smoke"}, nil
}

type pushHeadParser struct{}

func (pushHeadParser) Parse(context.Context, string, []byte) (*services.WorkflowConfig, error) {
	var cfg services.WorkflowConfig
	err := json.Unmarshal([]byte(`{"on":{"push":{}},"jobs":{"smoke":{}}}`), &cfg)
	return &cfg, err
}

func (*pushHeadQueries) GetOrgByID(context.Context, int64) (db.Organization, error) {
	return db.Organization{}, nil
}

package compose

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// A workflow cache archive saved by a run of the default bookmark is what
// every later run restores, so only runs a person or the server started save.
// A run credential is the agent of a run nobody has reviewed: through the
// assembled router it can start no workflow run on invoke or either dispatch
// route, whatever trigger it names, and replays none by rerun or resume. A person's invoke records "invoke" (never
// the "schedule" the body claims) and saves nothing; a person's dispatch
// records workflow_dispatch and saves.
func TestRunCredentialCannotStartCacheSavingWorkflowRunsPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "trig-owner", LowerUsername: "trig-owner", DisplayName: "Trigger owner"})
	require.NoError(t, err)
	repoID := ciTestRepo(t, pool, owner.ID, "app")
	defID := ciTestDefinition(t, q, repoID)

	token := func(name, scopes string, systemIssued bool) string {
		plaintext := "smithers_" + hex.EncodeToString([]byte(name + "-token-padding-bytes"))[:40]
		sum := sha256.Sum256([]byte(plaintext))
		hash := hex.EncodeToString(sum[:])
		_, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{
			UserID: owner.ID, Name: name, TokenHash: hash, TokenLastEight: hash[len(hash)-8:],
			SystemIssued: systemIssued, Scopes: scopes,
			ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true},
		})
		require.NoError(t, err)
		return plaintext
	}
	runToken := token("sandbox-run", string(middleware.ScopeWriteRepository)+","+middleware.RepositoryRestrictionScope(repoID)+","+middleware.AgentSessionRestrictionScope("session-1"), true)
	personToken := token("personal", string(middleware.ScopeWriteRepository), false)

	store, err := blob.NewFilesystemStore(blob.FilesystemConfig{Root: t.TempDir(), PublicBaseURL: "http://blob.test"})
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })
	cache := services.NewWorkflowCacheService(q, store, services.WorkflowCacheConfig{})
	jobStore, err := jobs.NewStore(pool)
	require.NoError(t, err)
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: jobStore, Resolver: flowruntime.ResolverFunc(
		func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
			return nil, errors.New("no Flow host in this test")
		})})
	require.NoError(t, err)
	invokedFlows := services.NewInvokedFlowService(pool, services.NewRepositoryJobService(q, nil, pool), nil)
	invokedFlows.SetFlowDispatcher(dispatcher)
	invokedFlows.SetFlowSourceReader(invokeTestSources{})
	router := buildWorkflowTriggerRouter(q, pool, &routes.WorkflowHandler{
		Service: services.NewWorkflowAPIService(q, services.NewWorkflowRunService(q), services.WithWorkflowAPIFlowInvoker(invokedFlows)),
	})
	serve := func(bearer, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/repos/trig-owner/app"+path, bytes.NewBufferString(body))
		req.Header.Set("Authorization", "Bearer "+bearer)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}
	runCount := func() int {
		var n int
		require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM workflow_runs WHERE repository_id = $1`, repoID).Scan(&n))
		return n
	}
	saves := func(runID int64) error {
		run, err := q.GetWorkflowRun(ctx, db.GetWorkflowRunParams{ID: runID, RepositoryID: repoID})
		require.NoError(t, err)
		_, err = cache.BeginSave(ctx, run, "deps", "v1", 16)
		return err
	}

	for _, attempt := range []struct{ name, path, body string }{
		{"invoke as schedule", "/invoke", `{"flow":"ci","trigger":"schedule"}`},
		{"invoke as manual", "/invoke", `{"flow":"ci","trigger":"manual"}`},
		{"invoke", "/invoke", `{"flow":"ci"}`},
		{"dispatch by id", fmt.Sprintf("/workflows/%d/dispatches", defID), `{"ref":"main"}`},
		{"dispatch by name", "/workflows/CI/dispatch", `{"ref":"main"}`},
	} {
		rec := serve(runToken, attempt.path, attempt.body)
		assert.Equal(t, http.StatusForbidden, rec.Code, "%s with a run credential: %s", attempt.name, rec.Body.String())
		assert.Contains(t, rec.Body.String(), "a run credential cannot use this endpoint", attempt.name)
		assert.Zero(t, runCount(), "%s with a run credential created a run", attempt.name)
	}

	// A person's invoke cannot claim the scheduler either.
	rec := serve(personToken, "/invoke", `{"flow":"ci","trigger":"schedule"}`)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var invoked struct {
		RunID int64 `json:"run_id"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &invoked))
	run, err := q.GetWorkflowRun(ctx, db.GetWorkflowRunParams{ID: invoked.RunID, RepositoryID: repoID})
	require.NoError(t, err)
	assert.Equal(t, "invoke", run.TriggerEvent)
	assert.Equal(t, services.WorkflowRunPlaneFlow, run.ExecutionPlane, "an invoked flow runs on the Flow runtime, not the sandbox scheduler")
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, saves(invoked.RunID), &apiErr)
	assert.Equal(t, http.StatusForbidden, apiErr.Status, "an invoked run restores caches and saves none")

	// A person's dispatch of the default bookmark is a maintainer's request.
	rec = serve(personToken, fmt.Sprintf("/workflows/%d/dispatches", defID), `{"ref":"main"}`)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var dispatched struct {
		Runs []struct {
			WorkflowRunID int64 `json:"workflow_run_id"`
		} `json:"runs"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &dispatched))
	require.Len(t, dispatched.Runs, 1)
	run, err = q.GetWorkflowRun(ctx, db.GetWorkflowRunParams{ID: dispatched.Runs[0].WorkflowRunID, RepositoryID: repoID})
	require.NoError(t, err)
	assert.Equal(t, "workflow_dispatch", run.TriggerEvent)
	assert.NoError(t, saves(run.ID), "a person's dispatch saves")

	// Nor can a run credential replay a person's run.
	before := runCount()
	for _, path := range []string{"/runs/%d/rerun", "/workflows/runs/%d/rerun", "/actions/runs/%d/rerun", "/runs/%d/resume", "/workflows/runs/%d/resume"} {
		rec := serve(runToken, fmt.Sprintf(path, run.ID), `{}`)
		assert.Equal(t, http.StatusForbidden, rec.Code, "%s with a run credential: %s", path, rec.Body.String())
		assert.Contains(t, rec.Body.String(), "a run credential cannot use this endpoint", path)
	}
	assert.Equal(t, before, runCount(), "a run credential replayed a run")
}

func buildWorkflowTriggerRouter(q *db.Queries, pool *pgxpool.Pool, workflow *routes.WorkflowHandler) http.Handler {
	return buildRouter(
		testConfigAllFlagsOn(), q, pool,
		&routes.RepoHandler{},
		nil, // mirrorSyncHandler
		&routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{},
		nil, // deployKeyHandler
		&routes.LabelHandler{}, &routes.OrgHandler{}, &routes.LandingHandler{},
		nil, // changesetHandler
		nil, // buildCacheHandler
		nil, // stackHandler
		&routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{},
		nil, // wikiService
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil,                     // notificationHandler
		nil,                     // pairSessionHandler
		nil, nil, nil, nil, nil, // admin user/org/repo/github-app/audit
		nil, nil, nil, nil, nil, nil, nil, nil, // webhook, secret, provider, variable, billing, protected, status, lfs
		nil, // jjVCSHandler
		&routes.AgentInternalHandler{},
		nil, nil, nil, nil, nil, // agent sessions/stream, approvals, branch lock, push hook
		workflow,
		nil, nil, // workflow cache, artifacts
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
	)
}

// invokeTestSources is a repo host whose main holds flows/ci/flow.ts.
type invokeTestSources struct{}

func (invokeTestSources) ListBookmarks(context.Context, string, string, string, int) ([]repohost.Bookmark, string, error) {
	return []repohost.Bookmark{{Name: "main", TargetCommitID: strings.Repeat("c", 40)}}, "", nil
}

func (invokeTestSources) GetFileAtChange(_ context.Context, _, _, _, path string) (repohost.FileContent, error) {
	if path != "flows/ci/flow.ts" {
		return repohost.FileContent{}, &repohost.StatusError{StatusCode: 404}
	}
	return repohost.FileContent{Path: path}, nil
}

func (h invokeTestSources) GetBookmark(ctx context.Context, owner, repo, name string) (repohost.Bookmark, error) {
	items, _, err := h.ListBookmarks(ctx, owner, repo, "", 100)
	if err != nil {
		return repohost.Bookmark{}, err
	}
	for _, bookmark := range items {
		if bookmark.Name == name {
			return bookmark, nil
		}
	}
	return repohost.Bookmark{}, &repohost.StatusError{StatusCode: 404, Code: "bookmark_not_found"}
}

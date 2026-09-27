package compose

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

const browserBoxID = "11111111-1111-4111-8111-111111111111"

type browserReadDependencies struct {
	workspace db.Workspace
	err       error
	lookups   []db.GetWorkspaceForUserRepoParams
	canWrite  bool
}

func (d *browserReadDependencies) GetRepoView(context.Context, *db.User, string, string) (services.RepoView, error) {
	return services.RepoView{Repository: db.Repository{ID: 23}, CanWrite: d.canWrite}, nil
}
func (d *browserReadDependencies) GetWorkspaceForUserRepo(_ context.Context, params db.GetWorkspaceForUserRepoParams) (db.Workspace, error) {
	d.lookups = append(d.lookups, params)
	return d.workspace, d.err
}

func browserFlowCall(api browserFlowAPI, body string, provision bool) (*httptest.ResponseRecorder, bool, string) {
	request := httptest.NewRequest("POST", "/api/workflow/rpc", strings.NewReader(body))
	request = request.WithContext(context.WithValue(request.Context(), middleware.UserContextKey, &db.User{ID: 17}))
	writer := httptest.NewRecorder()
	_, target, ok := api.prepare(writer, request, provision)
	return writer, ok, target.WorkspaceID
}

func TestBrowserFlowRunsOnlyOnTheNamedRunningBox(t *testing.T) {
	for _, procedure := range []string{"List", "Plan", "Run", "Projection.Snapshot"} {
		for _, state := range []string{"missing", "suspended", "running"} {
			t.Run(procedure+"/"+state, func(t *testing.T) {
				deps := &browserReadDependencies{canWrite: true, workspace: db.Workspace{ID: browserBoxID, Status: state}}
				if state == "missing" {
					deps.err = pgx.ErrNoRows
				}
				writer, ok, workspaceID := browserFlowCall(browserFlowAPI{repos: deps, queries: deps},
					`{"repo":"owner/repo","workspaceId":"`+browserBoxID+`","procedure":"`+procedure+`","payload":{}}`, false)
				require.Equal(t, state == "running", ok)
				require.Equal(t, []db.GetWorkspaceForUserRepoParams{{ID: browserBoxID, RepositoryID: 23, UserID: 17}}, deps.lookups)
				if ok {
					require.Equal(t, browserBoxID, workspaceID)
				} else {
					require.Equal(t, 404, writer.Code)
				}
			})
		}
	}
}

// A call that names no box is refused before any lookup: there is no
// repository-level flow host (#2194).
func TestBrowserFlowWithoutABoxIsRefused(t *testing.T) {
	for _, provision := range []bool{false, true} {
		deps := &browserReadDependencies{canWrite: true, workspace: db.Workspace{ID: browserBoxID, Status: "running"}}
		writer, ok, _ := browserFlowCall(browserFlowAPI{repos: deps, queries: deps},
			`{"repo":"owner/repo","procedure":"Run","payload":{}}`, provision)
		require.False(t, ok)
		require.Equal(t, 400, writer.Code)
		require.Empty(t, deps.lookups)
		require.Contains(t, writer.Body.String(), "a box (workspaceId)")
	}
}

func TestBrowserFlowRefusesAReaderBeforeReadingTheBox(t *testing.T) {
	deps := &browserReadDependencies{canWrite: false}
	writer, ok, _ := browserFlowCall(browserFlowAPI{repos: deps, queries: deps}, `{"repo":"owner/repo","workspaceId":"`+browserBoxID+`","procedure":"List"}`, false)
	require.False(t, ok)
	require.Equal(t, 404, writer.Code)
	require.Empty(t, deps.lookups)
}

func TestBrowserFlowUnknownProcedureIsRefused(t *testing.T) {
	deps := &browserReadDependencies{canWrite: true}
	api := browserFlowAPI{repos: deps, queries: deps}
	request := httptest.NewRequest("POST", "/api/workflow/rpc", strings.NewReader(`{"repo":"owner/repo","workspaceId":"`+browserBoxID+`","procedure":"Unknown"}`))
	request = request.WithContext(context.WithValue(request.Context(), middleware.UserContextKey, &db.User{ID: 17}))
	writer := httptest.NewRecorder()
	api.rpc(writer, request)
	require.Equal(t, 400, writer.Code)
	require.Empty(t, deps.lookups)
}

func (d *browserReadDependencies) GetRepoByOwnerAndLowerName(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	return db.Repository{ID: 23}, nil
}

func TestBrowserFlowTargetIsTheBoxCodingHost(t *testing.T) {
	deps := &browserReadDependencies{canWrite: true, workspace: db.Workspace{ID: browserBoxID, Status: "running"}}
	_, ok, workspaceID := browserFlowCall(browserFlowAPI{repos: deps, queries: deps},
		`{"repo":"owner/repo","workspaceId":"`+browserBoxID+`","procedure":"List","payload":{}}`, false)
	require.True(t, ok)
	authority, err := browserFlowTarget{queries: deps}.ResolveFlowHostTarget(context.Background(), flowruntime.Target{
		TenantID: "repository:23", PrincipalID: "user:17", WorkspaceID: workspaceID,
		BindingKind: "browser-flow", BindingID: "owner/repo",
	})
	require.NoError(t, err)
	require.Equal(t, flowhost.CatalogCoding, authority.CatalogKey)
	require.Equal(t, browserBoxID, authority.WorkspaceID)
	deps.workspace.Status = "suspended"
	_, err = browserFlowTarget{queries: deps}.ResolveFlowHostTarget(context.Background(), flowruntime.Target{
		TenantID: "repository:23", PrincipalID: "user:17", WorkspaceID: workspaceID,
		BindingKind: "browser-flow", BindingID: "owner/repo",
	})
	require.Error(t, err)
}

// #2206: a running box built with a subscription token is not entered.
func TestBrowserFlowRefusesRebuildRequiredBox(t *testing.T) {
	body := `{"repo":"owner/repo","workspaceId":"` + browserBoxID + `","procedure":"List","payload":{}}`
	deps := &browserReadDependencies{canWrite: true, workspace: db.Workspace{ID: browserBoxID, Status: "running", RebuildRequiredAt: pgtype.Timestamptz{Valid: true}}}
	api := browserFlowAPI{repos: deps, queries: deps}
	writer, ok, _ := browserFlowCall(api, body, false)
	require.False(t, ok)
	require.Equal(t, 409, writer.Code)

	// A deployment that allows subscription tokens enters it.
	api.subscriptionTokens = true
	_, ok, _ = browserFlowCall(api, body, false)
	require.True(t, ok)
}

type startingDispatcher struct {
	ready   bool
	err     error
	targets []flowruntime.Target
}

func (d *startingDispatcher) CallRPC(context.Context, flowruntime.Target, string, json.RawMessage) (json.RawMessage, error) {
	return nil, errors.New("provision never relays a procedure")
}

func (d *startingDispatcher) StartHost(_ context.Context, target flowruntime.Target) (bool, error) {
	d.targets = append(d.targets, target)
	return d.ready, d.err
}

// Provision starts the box's coding host and answers "provisioning" until it
// is live, so the flows list works before the box's first run (#2198).
func TestBrowserFlowProvisionStartsTheBoxHost(t *testing.T) {
	deps := &browserReadDependencies{canWrite: true, workspace: db.Workspace{ID: browserBoxID, Status: "running"}}
	provision := func(dispatcher *startingDispatcher) *httptest.ResponseRecorder {
		request := httptest.NewRequest("POST", "/api/workflow/provision", strings.NewReader(`{"repo":"owner/repo","workspaceId":"`+browserBoxID+`"}`))
		request = request.WithContext(context.WithValue(request.Context(), middleware.UserContextKey, &db.User{ID: 17}))
		writer := httptest.NewRecorder()
		(&browserFlowAPI{repos: deps, queries: deps, dispatcher: dispatcher}).provision(writer, request)
		return writer
	}
	starting := &startingDispatcher{}
	writer := provision(starting)
	require.Equal(t, 200, writer.Code)
	require.JSONEq(t, `{"status":"provisioning"}`, writer.Body.String())
	require.Equal(t, []flowruntime.Target{{TenantID: "repository:23", PrincipalID: "user:17", WorkspaceID: browserBoxID,
		BindingKind: "browser-flow", BindingID: "owner/repo"}}, starting.targets)

	writer = provision(&startingDispatcher{ready: true})
	require.Equal(t, 200, writer.Code)
	require.JSONEq(t, `{"status":"ready","workspaceId":"`+browserBoxID+`","gatewayId":"`+browserBoxID+`"}`, writer.Body.String())

	writer = provision(&startingDispatcher{err: testFlowFailure("runtime_start_failed")})
	require.Equal(t, 503, writer.Code)
	require.Contains(t, writer.Body.String(), `"code":"runtime_start_failed"`)

	// The plan limit that refused the start reaches the app as itself.
	limit := pkgerrors.New(pkgerrors.CodePlanLimitExceeded, "Your Free plan allows 1 running sandbox.")
	writer = provision(&startingDispatcher{err: fmt.Errorf("flow host: runtime_start_failed: %w", limit)})
	require.Equal(t, 402, writer.Code)
	require.Contains(t, writer.Body.String(), "plan_limit_exceeded")
}

type testFlowFailure string

func (failure testFlowFailure) Error() string              { return string(failure) }
func (failure testFlowFailure) FlowRuntimeCode() string    { return string(failure) }
func (failure testFlowFailure) FlowRuntimeRetryable() bool { return true }

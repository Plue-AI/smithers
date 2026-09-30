package compose

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/background"
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

func browserFlowCall(api *browserFlowAPI, body string, provision bool) (*httptest.ResponseRecorder, bool, string) {
	request := httptest.NewRequest("POST", "/api/workflow/rpc", strings.NewReader(body))
	request = request.WithContext(context.WithValue(request.Context(), middleware.UserContextKey, &db.User{ID: 17}))
	writer := httptest.NewRecorder()
	_, target, _, ok := api.prepare(writer, request, provision)
	return writer, ok, target.WorkspaceID
}

func TestBrowserFlowRunsOnlyOnTheNamedBox(t *testing.T) {
	for _, procedure := range []string{"List", "Plan", "Run", "Projection.Snapshot"} {
		for _, state := range []string{"missing", "failed", "suspended", "running"} {
			t.Run(procedure+"/"+state, func(t *testing.T) {
				deps := &browserReadDependencies{canWrite: true, workspace: db.Workspace{ID: browserBoxID, Status: state}}
				if state == "missing" {
					deps.err = pgx.ErrNoRows
				}
				writer, ok, workspaceID := browserFlowCall(&browserFlowAPI{repos: deps, queries: deps},
					`{"repo":"owner/repo","workspaceId":"`+browserBoxID+`","procedure":"`+procedure+`","payload":{}}`, false)
				require.Equal(t, state == "running" || state == "suspended", ok)
				require.Equal(t, []db.GetWorkspaceForUserRepoParams{{ID: browserBoxID, RepositoryID: 23, UserID: 17}}, deps.lookups)
				switch state {
				case "missing":
					require.Equal(t, 404, writer.Code)
				case "failed":
					require.Equal(t, 409, writer.Code)
					require.Contains(t, writer.Body.String(), `"code":"workspace_gone"`)
				default:
					require.Equal(t, browserBoxID, workspaceID)
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
		writer, ok, _ := browserFlowCall(&browserFlowAPI{repos: deps, queries: deps},
			`{"repo":"owner/repo","procedure":"Run","payload":{}}`, provision)
		require.False(t, ok)
		require.Equal(t, 400, writer.Code)
		require.Empty(t, deps.lookups)
		require.Contains(t, writer.Body.String(), "a box (workspaceId)")
	}
}

func TestBrowserFlowRefusesAReaderBeforeReadingTheBox(t *testing.T) {
	deps := &browserReadDependencies{canWrite: false}
	writer, ok, _ := browserFlowCall(&browserFlowAPI{repos: deps, queries: deps}, `{"repo":"owner/repo","workspaceId":"`+browserBoxID+`","procedure":"List"}`, false)
	require.False(t, ok)
	require.Equal(t, 404, writer.Code)
	require.Empty(t, deps.lookups)
}

func TestBrowserFlowUnknownProcedureIsRefused(t *testing.T) {
	deps := &browserReadDependencies{canWrite: true}
	api := &browserFlowAPI{repos: deps, queries: deps}
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
	_, ok, workspaceID := browserFlowCall(&browserFlowAPI{repos: deps, queries: deps},
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

// #2206: a running box built with a subscription token is not entered, even
// on a deployment that allows ChatGPT tokens: it marks a box only for a
// Claude one (#2777).
func TestBrowserFlowRefusesRebuildRequiredBox(t *testing.T) {
	body := `{"repo":"owner/repo","workspaceId":"` + browserBoxID + `","procedure":"List","payload":{}}`
	deps := &browserReadDependencies{canWrite: true, workspace: db.Workspace{ID: browserBoxID, Status: "running", RebuildRequiredAt: pgtype.Timestamptz{Valid: true}}}
	api := &browserFlowAPI{repos: deps, queries: deps}
	writer, ok, _ := browserFlowCall(api, body, false)
	require.False(t, ok)
	require.Equal(t, 409, writer.Code)
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

	// A box whose stale helper could not be refreshed answers that typed
	// reason, not a host outage (#3111).
	stale := &pkgerrors.APIError{Status: 409, Code: pkgerrors.CodeCodingHostUnavailable, Message: "workspace helper could not be refreshed; retry"}
	writer = provision(&startingDispatcher{err: fmt.Errorf("flow host: runtime_start_failed: %w", stale)})
	require.Equal(t, 409, writer.Code)
	require.Contains(t, writer.Body.String(), `"coding_host_unavailable"`)
	require.Contains(t, writer.Body.String(), "workspace helper could not be refreshed; retry")
}

type testFlowFailure string

func (failure testFlowFailure) Error() string              { return string(failure) }
func (failure testFlowFailure) FlowRuntimeCode() string    { return string(failure) }
func (failure testFlowFailure) FlowRuntimeRetryable() bool { return true }

type resumingBoxes struct {
	resumed chan string
	err     error
}

func (b *resumingBoxes) ResumeWorkspace(_ context.Context, id string, _, _ int64) (services.WorkspaceResponse, error) {
	b.resumed <- id
	return services.WorkspaceResponse{}, b.err
}

// A sleeping box wakes in the background: provision and a snapshot answer
// "provisioning" at once, any other procedure is refused as starting, and a
// resume that failed is answered to the next poll (#2198).
func TestBrowserFlowWakesASleepingBox(t *testing.T) {
	deps := &browserReadDependencies{canWrite: true, workspace: db.Workspace{ID: browserBoxID, Status: "suspended", RepositoryID: 23, UserID: 17}}
	boxes := &resumingBoxes{resumed: make(chan string, 4), err: pkgerrors.New(pkgerrors.CodePlanLimitExceeded, "Your Free plan allows 1 running sandbox.")}
	dispatcher := &startingDispatcher{}
	api := &browserFlowAPI{repos: deps, queries: deps, dispatcher: dispatcher, boxes: boxes,
		resumes: background.Jobs[string]{FailureTTL: time.Minute}}
	call := func(path, body string) *httptest.ResponseRecorder {
		request := httptest.NewRequest("POST", path, strings.NewReader(body))
		request = request.WithContext(context.WithValue(request.Context(), middleware.UserContextKey, &db.User{ID: 17}))
		writer := httptest.NewRecorder()
		if path == "/api/workflow/provision" {
			api.provision(writer, request)
		} else {
			api.rpc(writer, request)
		}
		return writer
	}
	box := `"repo":"owner/repo","workspaceId":"` + browserBoxID + `"`
	writer := call("/api/workflow/provision", `{`+box+`}`)
	require.JSONEq(t, `{"status":"provisioning"}`, writer.Body.String())
	require.Equal(t, browserBoxID, <-boxes.resumed)
	require.Eventually(t, func() bool { return !api.resumes.Running(browserBoxID) }, time.Second, time.Millisecond)
	writer = call("/api/workflow/provision", `{`+box+`}`)
	require.Equal(t, 402, writer.Code, "the plan limit that refused the resume")

	boxes.err = nil
	writer = call("/api/workflow/rpc", `{`+box+`,"procedure":"Projection.Snapshot","payload":{}}`)
	require.JSONEq(t, `{"status":"provisioning"}`, writer.Body.String())
	<-boxes.resumed
	writer = call("/api/workflow/rpc", `{`+box+`,"procedure":"Plan","payload":{}}`)
	require.Equal(t, 409, writer.Code)
	require.Contains(t, writer.Body.String(), `"code":"workspace_starting"`)
	require.Empty(t, dispatcher.targets, "a sleeping box's host is not started until it runs")

	// A snapshot of a running box whose host is not running starts it.
	deps.workspace.Status = "running"
	api.dispatcher = &hostlessDispatcher{startingDispatcher: dispatcher}
	writer = call("/api/workflow/rpc", `{`+box+`,"procedure":"Projection.Snapshot","payload":{}}`)
	require.JSONEq(t, `{"status":"provisioning"}`, writer.Body.String())
	require.Len(t, dispatcher.targets, 1)
	writer = call("/api/workflow/rpc", `{`+box+`,"procedure":"List","payload":{"_tag":"flows"}}`)
	require.JSONEq(t, `{"status":"provisioning"}`, writer.Body.String(), "the flows list of a box whose host is down starts it")
	require.Len(t, dispatcher.targets, 2)
}

type hostlessDispatcher struct{ *startingDispatcher }

func (d *hostlessDispatcher) CallRPC(context.Context, flowruntime.Target, string, json.RawMessage) (json.RawMessage, error) {
	return nil, testFlowFailure("runtime_host_not_running")
}

// A box its owner stopped is resumed only by provision; a read of it says so.
// A resume that fails for another reason is typed.
func TestBrowserFlowStoppedBoxWakesOnlyOnProvision(t *testing.T) {
	deps := &browserReadDependencies{canWrite: true, workspace: db.Workspace{ID: browserBoxID, Status: "stopped", RepositoryID: 23, UserID: 17}}
	boxes := &resumingBoxes{resumed: make(chan string, 4), err: errors.New("vm unavailable")}
	api := &browserFlowAPI{repos: deps, queries: deps, dispatcher: &startingDispatcher{}, boxes: boxes,
		resumes: background.Jobs[string]{FailureTTL: time.Minute}}
	call := func(provision bool, body string) *httptest.ResponseRecorder {
		request := httptest.NewRequest("POST", "/api/workflow/rpc", strings.NewReader(body))
		request = request.WithContext(context.WithValue(request.Context(), middleware.UserContextKey, &db.User{ID: 17}))
		writer := httptest.NewRecorder()
		if provision {
			api.provision(writer, request)
		} else {
			api.rpc(writer, request)
		}
		return writer
	}
	box := `"repo":"owner/repo","workspaceId":"` + browserBoxID + `"`
	writer := call(false, `{`+box+`,"procedure":"Projection.Snapshot","payload":{}}`)
	require.Equal(t, 409, writer.Code)
	require.Contains(t, writer.Body.String(), `"code":"workspace_stopped"`)
	require.Empty(t, boxes.resumed)

	require.JSONEq(t, `{"status":"provisioning"}`, call(true, `{`+box+`}`).Body.String())
	<-boxes.resumed
	require.Eventually(t, func() bool { return !api.resumes.Running(browserBoxID) }, time.Second, time.Millisecond)
	writer = call(true, `{`+box+`}`)
	require.Equal(t, 503, writer.Code)
	require.Contains(t, writer.Body.String(), `"code":"workspace_resume_failed"`)
}

// The API budget covers what a person does on a box, not a run's progress polls.
func TestBrowserFlowBudgetsAllButProgressReads(t *testing.T) {
	deps := &browserReadDependencies{canWrite: true, workspace: db.Workspace{ID: browserBoxID, Status: "running"}}
	limited := []string{}
	api := &browserFlowAPI{repos: deps, queries: deps, dispatcher: &hostlessDispatcher{startingDispatcher: &startingDispatcher{}},
		limit: func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				limited = append(limited, "limited")
				next.ServeHTTP(w, r)
			})
		}}
	for _, procedure := range []string{"Projection.Snapshot", "List", "Plan", "Run"} {
		request := httptest.NewRequest("POST", "/api/workflow/rpc", strings.NewReader(`{"repo":"owner/repo","workspaceId":"`+browserBoxID+`","procedure":"`+procedure+`","payload":{}}`))
		request = request.WithContext(context.WithValue(request.Context(), middleware.UserContextKey, &db.User{ID: 17}))
		api.rpc(httptest.NewRecorder(), request)
	}
	require.Len(t, limited, 2)
}

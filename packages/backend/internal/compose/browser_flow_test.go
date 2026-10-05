package compose

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const browserBoxID = "11111111-1111-4111-8111-111111111111"

// browserReadDependencies is the box the routing and authorization tests
// relay to: repository 23, box browserBoxID. Which box a caller may name is
// tested on real PostgreSQL (browser_flow_read_test.go).
type browserReadDependencies struct {
	workspace db.Workspace
	lookups   []db.GetFlowWorkspaceForUserRepoParams
	canWrite  bool
}

func (d *browserReadDependencies) GetRepoView(context.Context, *db.User, string, string) (services.RepoView, error) {
	return services.RepoView{Repository: db.Repository{ID: 23}, CanWrite: d.canWrite}, nil
}

func (d *browserReadDependencies) GetFlowWorkspaceForUserRepo(_ context.Context, params db.GetFlowWorkspaceForUserRepoParams) (db.Workspace, error) {
	d.lookups = append(d.lookups, params)
	workspace := d.workspace
	if workspace.UserID == 0 {
		// The caller's own box unless the test names another owner.
		workspace.UserID = params.UserID
	}
	return workspace, nil
}

type browserFlowRelayCall struct {
	target    flowruntime.Target
	procedure string
	payload   json.RawMessage
}

type browserFlowRecordingDispatcher struct {
	calls []browserFlowRelayCall
}

func (d *browserFlowRecordingDispatcher) CallRPC(_ context.Context, target flowruntime.Target, procedure string, payload json.RawMessage) (json.RawMessage, error) {
	d.calls = append(d.calls, browserFlowRelayCall{target: target, procedure: procedure, payload: append(json.RawMessage(nil), payload...)})
	return json.RawMessage(`{"ok":true,"relayed":true}`), nil
}

// RefuseRelay is the production classification, which needs no host.
func (*browserFlowRecordingDispatcher) RefuseRelay(ctx context.Context, target flowruntime.Target, procedure string, payload json.RawMessage) error {
	return (&flowdispatch.Service{}).RefuseRelay(ctx, target, procedure, payload)
}

func (*browserFlowRecordingDispatcher) StartHost(context.Context, flowruntime.Target) (bool, error) {
	return true, nil
}

func TestRunCredentialCannotSteerOrCancelRuns(t *testing.T) {
	for _, procedure := range []string{"Cancel", "Signal", "Resume", "Steer", "Approval.Submit", "Run.Fork", "Run.Verify"} {
		t.Run(procedure, func(t *testing.T) {
			deps := &browserReadDependencies{canWrite: true, workspace: db.Workspace{ID: browserBoxID, Status: "running"}}
			dispatcher := &browserFlowRecordingDispatcher{}
			api := &browserFlowAPI{repos: deps, queries: deps, dispatcher: dispatcher}
			user := &db.User{ID: 17, UserType: "user"}
			payload := `{"runId":"run-42","marker":"` + procedure + `"}`
			body := `{"repo":"owner/repo","workspaceId":"` + browserBoxID + `","procedure":"` + procedure + `","payload":` + payload + `}`
			call := func(systemIssued bool) *httptest.ResponseRecorder {
				request := httptest.NewRequest(http.MethodPost, "/api/workflow/rpc", strings.NewReader(body))
				request = request.WithContext(middleware.ContextWithAuthInfo(request.Context(), &middleware.AuthInfo{
					User: user, IsTokenAuth: true, TokenSystemIssued: systemIssued,
				}))
				writer := httptest.NewRecorder()
				api.rpc(writer, request)
				return writer
			}

			run := call(true)
			assert.Equal(t, http.StatusForbidden, run.Code, run.Body.String())
			assert.Empty(t, dispatcher.calls, "a run credential reached the box flow host")

			person := call(false)
			require.Equal(t, http.StatusOK, person.Code, person.Body.String())
			require.JSONEq(t, `{"ok":true,"relayed":true}`, person.Body.String())
			require.Equal(t, []browserFlowRelayCall{{
				target: flowruntime.Target{
					TenantID: "repository:23", PrincipalID: "user:17", WorkspaceID: browserBoxID,
					BindingKind: "browser-flow", BindingID: "owner/repo",
				},
				procedure: procedure,
				payload:   json.RawMessage(payload),
			}}, dispatcher.calls)
		})
	}
}

// Fable round 2, N1: the browser relay refuses planning the todo composition
// before the box wakes or the host is reached; it runs only from a filed
// TODO's pinned stack launch.
func TestBrowserFlowRelayRefusesTheTodoComposition(t *testing.T) {
	for name, call := range map[string]struct {
		procedure, payload, code string
		status                   int
	}{
		"todo":                                 {"Plan", `{"flowId":"todo","input":{}}`, "todo_requires_stack_admission", http.StatusForbidden},
		"flows/todo/flow.ts":                   {"Plan", `{"flowId":"flows/todo/flow.ts","input":{}}`, "todo_requires_stack_admission", http.StatusForbidden},
		"./flows/todo/flow.ts":                 {"Plan", `{"flowId":"./flows/todo/flow.ts","input":{}}`, "todo_requires_stack_admission", http.StatusForbidden},
		"todo beside a lower-case key":         {"Plan", `{"flowId":"todo","flowid":"coding/dispatch","input":{}}`, "todo_requires_stack_admission", http.StatusForbidden},
		"duplicate key":                        {"Plan", `{"flowId":"coding/dispatch","flowId":"todo","input":{}}`, "Invalid workflow request.", http.StatusBadRequest},
		"run of a plan the relay did not save": {"Run", `{"_tag":"Plan","planId":"stack-parked-todo","digest":"d","envelope":{},"idempotencyKey":"k"}`, "plan_unknown", http.StatusConflict},
		"run without a run id":                 {"Resume", `{"reason":"again"}`, "Invalid workflow request.", http.StatusBadRequest},
	} {
		t.Run(name, func(t *testing.T) {
			deps := &browserReadDependencies{canWrite: true, workspace: db.Workspace{ID: browserBoxID, Status: "suspended", RepositoryID: 23, UserID: 17}}
			boxes := &resumingBoxes{resumed: make(chan string, 1)}
			dispatcher := &browserFlowRecordingDispatcher{}
			api := &browserFlowAPI{repos: deps, queries: deps, dispatcher: dispatcher, boxes: boxes}
			body := `{"repo":"owner/repo","workspaceId":"` + browserBoxID + `","procedure":"` + call.procedure + `","payload":` + call.payload + `}`
			request := httptest.NewRequest(http.MethodPost, "/api/workflow/rpc", strings.NewReader(body))
			request = request.WithContext(middleware.ContextWithAuthInfo(request.Context(), &middleware.AuthInfo{User: &db.User{ID: 17, UserType: "user"}}))
			writer := httptest.NewRecorder()
			api.rpc(writer, request)
			require.Equal(t, call.status, writer.Code, writer.Body.String())
			require.Contains(t, writer.Body.String(), call.code)
			require.Empty(t, dispatcher.calls, "the host was never reached")
			require.Empty(t, boxes.resumed, "the box was never woken")
		})
	}
}

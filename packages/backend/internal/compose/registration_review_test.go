package compose

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/stretchr/testify/require"
)

func registrationRequest(api *browserFlowAPI, user *db.User, run bool, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", "/api/workflow/rpc", strings.NewReader(body))
	auth := &middleware.AuthInfo{User: user, IsTokenAuth: run, TokenSystemIssued: run, RawScopes: "all", Scopes: middleware.ParseTokenScopes("all")}
	r = r.WithContext(middleware.ContextWithAuthInfo(r.Context(), auth))
	w := httptest.NewRecorder()
	api.rpc(w, r)
	return w
}

type reviewDispatcher struct{ calls int }

func (d *reviewDispatcher) CallRPC(context.Context, flowruntime.Target, string, json.RawMessage) (json.RawMessage, error) {
	d.calls++
	return json.RawMessage(`{"ok":true,"payload":{}}`), nil
}
func (d *reviewDispatcher) StartHost(context.Context, flowruntime.Target) (bool, error) {
	d.calls++
	return true, nil
}

func TestRegistrationReviewRequiresAdminPerson(t *testing.T) {
	for _, procedure := range []string{"Registration.Reviews", "Approval.Submit"} {
		for _, tc := range []struct {
			name   string
			user   *db.User
			run    bool
			status int
		}{
			{"anonymous", nil, false, 401},
			{"member", &db.User{ID: 2}, false, 403},
			{"admin run", &db.User{ID: 1, IsAdmin: true}, true, 403},
		} {
			t.Run(procedure+"/"+tc.name, func(t *testing.T) {
				dispatcher := &reviewDispatcher{}
				api := &browserFlowAPI{dispatcher: dispatcher}
				w := registrationRequest(api, tc.user, tc.run, `{"procedure":"`+procedure+`","workspaceId":"`+browserBoxID+`","payload":{"target":{"requestId":"register-repository/review#1"}}}`)
				require.Equal(t, tc.status, w.Code, w.Body.String())
				require.Zero(t, dispatcher.calls)
			})
		}
	}
}

func TestRegistrationReviewCannotBypassAdminThroughOrdinaryRelay(t *testing.T) {
	for _, procedure := range []string{"Approval.Submit", "Signal"} {
		for _, name := range []string{"register-repository/review#1", "register-repository/decline-note#1"} {
			t.Run(procedure+name, func(t *testing.T) {
				deps := &browserReadDependencies{canWrite: true, workspace: db.Workspace{ID: browserBoxID, Status: "running"}}
				dispatcher := &reviewDispatcher{}
				api := &browserFlowAPI{repos: deps, queries: deps, dispatcher: dispatcher}
				payload := `{"target":{"_tag":"Node","runId":"run-1","requestId":"` + name + `"},"signal":{"name":"` + name + `","payload":"Approve"}}`
				w := registrationRequest(api, &db.User{ID: 17}, false, `{"repo":"owner/repo","workspaceId":"`+browserBoxID+`","procedure":"`+procedure+`","payload":`+payload+`}`)
				require.Equal(t, 403, w.Code, w.Body.String())
				require.Zero(t, dispatcher.calls)
			})
		}
	}
}

func TestRegistrationReviewIgnoresExtraneousJSONFields(t *testing.T) {
	for _, tc := range []struct{ procedure, payload string }{
		{"Approval.Submit", `{"target":{"requestId":"register-repository/review#1"},"Target":{"requestId":"other"}}`},
		{"Approval.Submit", `{"target":{"requestId":"register-repository/review#1","RequestID":"other"}}`},
		{"Approval.Submit", `{"target":{"requestId":"register-repository/review#1"},"signal":42}`},
		{"Signal", `{"signal":{"name":"register-repository/review"},"Signal":{"name":"other"}}`},
		{"Signal", `{"signal":{"name":"register-repository/decline-note","Name":"other"}}`},
		{"Signal", `{"signal":{"name":"register-repository/review"},"target":42}`},
	} {
		t.Run(tc.procedure+tc.payload, func(t *testing.T) {
			deps := &browserReadDependencies{canWrite: true, workspace: db.Workspace{ID: browserBoxID, Status: "running"}}
			dispatcher := &reviewDispatcher{}
			api := &browserFlowAPI{repos: deps, queries: deps, dispatcher: dispatcher}
			w := registrationRequest(api, &db.User{ID: 17}, false, `{"repo":"owner/repo","workspaceId":"`+browserBoxID+`","procedure":"`+tc.procedure+`","payload":`+tc.payload+`}`)
			require.Equal(t, 403, w.Code, w.Body.String())
			require.Zero(t, dispatcher.calls)
		})
	}
}

// Cross-account reads expose neither grants nor similarly named questions in
// other flows. The workspace's stored wait token must match its decision target.
type registrationProjectionDispatcher struct{ reviewDispatcher }

func (d *registrationProjectionDispatcher) CallRPC(_ context.Context, _ flowruntime.Target, _ string, payload json.RawMessage) (json.RawMessage, error) {
	if strings.Contains(string(payload), "workspace-runs") {
		return json.RawMessage(`{"ok":true,"payload":{"rows":[{"runId":"registration","flowId":"register-repository"},{"runId":"other","flowId":"other-flow"}]}}`), nil
	}
	row := func(run, name, token, digest string) map[string]any {
		return map[string]any{
			"runId": run, "status": "pending", "request": map[string]any{"name": name, "token": token},
			"payload": map[string]any{"target": map[string]any{"_tag": "Node", "runId": run, "requestId": name + "#1", "digest": digest}},
		}
	}
	return json.Marshal(map[string]any{"ok": true, "payload": map[string]any{"rows": []any{
		row("registration", registrationReview, "token", "token"),
		row("other", registrationReview, "token", "token"),
		row("registration", "other-question", "token", "token"),
		row("registration", registrationReview, "token", "forged"),
		row("registration", registrationReview, "", ""),
	}}})
}
func TestRegistrationReviewFiltersCrossAccountProjection(t *testing.T) {
	api := &browserFlowAPI{dispatcher: &registrationProjectionDispatcher{}}
	rows, err := api.registrationRows(context.Background(), flowruntime.Target{})
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Contains(t, string(rows[0]), `"runId":"registration"`)
}

package compose

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/stretchr/testify/require"
)

// A run credential and an agent account may read a box's flows, but every
// procedure that starts, steers, stops or answers a run needs a person (#2286).
func TestBrowserFlowRejectsRunCredentialForControlProcedures(t *testing.T) {
	credentials := map[string]*middleware.AuthInfo{
		"run credential":  {User: &db.User{ID: 17, UserType: "user"}, IsTokenAuth: true, TokenSystemIssued: true},
		"bot account":     {User: &db.User{ID: 17, UserType: "bot"}, IsTokenAuth: true},
		"service account": {User: &db.User{ID: 17, UserType: "service"}, IsTokenAuth: true},
		"person":          {User: &db.User{ID: 17, UserType: "user"}, IsTokenAuth: true},
	}
	for _, tc := range []struct {
		procedure string
		decision  bool
	}{
		{"Approval.Submit", true}, {"Signal", true}, {"Cancel", true}, {"Resume", true},
		{"Steer", true}, {"Plan", true}, {"Run", true},
		{"List", false}, {"Projection.Snapshot", false},
	} {
		for name, auth := range credentials {
			t.Run(tc.procedure+"/"+name, func(t *testing.T) {
				deps := &browserReadDependencies{canWrite: true, workspace: db.Workspace{ID: browserBoxID, Status: "running"}}
				dispatcher := &browserFlowRecordingDispatcher{}
				api := &browserFlowAPI{repos: deps, queries: deps, dispatcher: dispatcher}
				// Each payload is one the relay classifies exactly (RefuseRelay).
				payload := `{"runId":"run-42"}`
				switch tc.procedure {
				case "Plan":
					payload = `{"flowId":"coding/dispatch","input":{}}`
				case "Run":
					payload = `{"_tag":"Resume","runId":"run-42","idempotencyKey":"k"}`
				case "Approval.Submit":
					payload = `{"target":{"_tag":"Node","runId":"run-42","requestId":"r","digest":"d","envelope":{}},"scope":"once","decision":"approve"}`
				}
				body := `{"repo":"owner/repo","workspaceId":"` + browserBoxID + `","procedure":"` + tc.procedure + `","payload":` + payload + `}`
				request := httptest.NewRequest(http.MethodPost, "/api/workflow/rpc", strings.NewReader(body))
				request = request.WithContext(middleware.ContextWithAuthInfo(request.Context(), auth))
				writer := httptest.NewRecorder()
				api.rpc(writer, request)

				if tc.decision && name != "person" {
					require.Equal(t, http.StatusForbidden, writer.Code, writer.Body.String())
					require.Empty(t, dispatcher.calls, "a non-person reached the box flow host")
					return
				}
				require.Equal(t, http.StatusOK, writer.Code, writer.Body.String())
				require.Len(t, dispatcher.calls, 1)
				require.Equal(t, "user:17", dispatcher.calls[0].target.PrincipalID)
			})
		}
	}
}

// Restore the old exact-key classifier, but every retired wait now refuses
// before a box lookup, wake, admission, signal or approval relay.
func TestBrowserFlowRetiredRegistration(t *testing.T) {
	for _, tc := range []struct {
		procedure, payload string
		retired            bool
	}{
		{"Registration.Report", `{}`, true},
		{"Registration.Reviews", `{}`, true},
		{"Approval.Submit", `{"target":{"requestId":"register-repository/review"}}`, true},
		{"Approval.Submit", `{"target":{"requestId":"register-repository/decline-note#42"}}`, true},
		{"Signal", `{"signal":{"name":"register-repository/review#42"}}`, true},
		{"Signal", `{"signal":{"name":"register-repository/decline-note"}}`, true},
		{"Signal", `{"signal":{"name":"register-repository/review"},"Signal":{"name":"kept"}}`, true},
		{"Approval.Submit", `{"target":{"requestId":"register-repository/review"},"Target":{"requestId":"kept"}}`, true},
		{"Signal", `{"signal":{"name":"register-repository/review-extra"}}`, false},
		{"Approval.Submit", `{"target":{"requestId":"todo/review#42"}}`, false},
		{"Signal", `{"Signal":{"name":"register-repository/review"}}`, false},
		{"List", `{}`, false},
		{"Signal", `{"signal":null}`, false},
		{"Signal", `{"signal":{"name":7}}`, false},
		{"Signal", `[]`, false},
	} {
		t.Run(tc.procedure+tc.payload, func(t *testing.T) {
			deps := &browserReadDependencies{canWrite: true, workspace: db.Workspace{ID: browserBoxID, Status: "running"}}
			dispatcher := &browserFlowRecordingDispatcher{}
			api := &browserFlowAPI{repos: deps, queries: deps, dispatcher: dispatcher}
			body := `{"repo":"owner/repo","workspaceId":"` + browserBoxID + `","procedure":"` + tc.procedure + `","payload":` + tc.payload + `}`
			request := httptest.NewRequest(http.MethodPost, "/api/workflow/rpc", strings.NewReader(body))
			request = request.WithContext(middleware.ContextWithAuthInfo(request.Context(), &middleware.AuthInfo{User: &db.User{ID: 17, UserType: "user"}, IsTokenAuth: true}))
			writer := httptest.NewRecorder()
			api.rpc(writer, request)
			if tc.retired {
				require.Equal(t, 404, writer.Code)
				require.JSONEq(t, `{"code":"registration_retired","class":"user","message":"Registration is unavailable."}`, writer.Body.String())
				require.Empty(t, deps.lookups)
				require.Empty(t, dispatcher.calls)
			} else {
				require.Equal(t, 200, writer.Code, writer.Body.String())
				require.Len(t, dispatcher.calls, 1)
			}
		})
	}
}

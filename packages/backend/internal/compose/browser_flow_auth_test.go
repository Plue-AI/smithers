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
				body := `{"repo":"owner/repo","workspaceId":"` + browserBoxID + `","procedure":"` + tc.procedure + `","payload":{"runId":"run-42"}}`
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

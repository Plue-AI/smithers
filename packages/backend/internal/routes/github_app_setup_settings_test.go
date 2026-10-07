package routes

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/stretchr/testify/require"
)

// Unit tests stop at the selected handler's unavailable-provider response, so
// parsing is independent of a database or listener. The composed parallel test
// covers actual session authorization, persistence and capacity changes.
func TestInstallSettingsDecodeExistingFields(t *testing.T) {
	for _, tc := range []struct {
		name, body, message string
		status              int
	}{
		{"parallel", `{"parallel":2}`, "Install setup unavailable", 503},
		{"daily admissions", `{"todo_daily_admissions":12}`, "Install setup unavailable", 503},
		{"preapproval", `{"todo_preapprove_default":false}`, "Install setup unavailable", 503},
		{"obsidian", `{"wiki_sync.obsidian":{"path":"/notes"}}`, "Install setup unavailable", 503},
		{"bind", `{"bind":"127.0.0.1:4000"}`, "Install listener unavailable", 503},
		{"origins", `{"origins":["https://factory.example"]}`, "Install listener unavailable", 503},
		{"capacity", `{"capacity":2}`, "Install setup unavailable", 503},
		{"chatgpt", `{"chatgpt":false}`, "Install setup unavailable", 503},
		{"capacity null", `{"capacity":null}`, "capacity must be an integer", 400},
		{"parallel null", `{"parallel":null}`, "parallel must be an integer", 400},
		{"daily admissions null", `{"todo_daily_admissions":null}`, "todo_daily_admissions must be an integer", 400},
		{"preapproval null", `{"todo_preapprove_default":null}`, "todo_preapprove_default must be a boolean", 400},
		{"chatgpt null", `{"chatgpt":null}`, "chatgpt must be a boolean", 400},
		{"fractional parallel", `{"parallel":1.5}`, "parallel must be an integer", 400},
		{"overflow parallel", `{"parallel":1e50}`, "parallel must be an integer", 400},
		{"wrong daily type", `{"todo_daily_admissions":"3"}`, "todo_daily_admissions must be an integer", 400},
		{"wrong boolean", `{"todo_preapprove_default":"false"}`, "todo_preapprove_default must be a boolean", 400},
		{"unknown setting", `{"unknown":1}`, "unknown field", 400},
		{"unknown nested setting", `{"wiki_sync.obsidian":{"path":"/notes","unknown":true}}`, "unknown field", 400},
		{"empty", `{}`, "install setting required", 400},
		{"mixed preapproval", `{"todo_preapprove_default":true,"parallel":2}`, "Change one setting at a time", 400},
		{"mixed obsidian", `{"wiki_sync.obsidian":{"path":"/notes"},"parallel":2}`, "Obsidian must be set separately", 400},
		{"mixed address", `{"bind":"127.0.0.1:4000","parallel":2}`, "other settings and address must be set separately", 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h, _ := githubAppSetupTestHandler()
			owner := db.User{ID: 1, Username: "owner"}
			h.Owners = githubAppSetupTestOwner{user: owner}
			r := httptest.NewRequest(http.MethodPut, "http://localhost:4000/api/install", strings.NewReader(tc.body))
			r.RemoteAddr = "127.0.0.1:1234"
			r.Header.Set("Origin", "http://localhost:4000")
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("X-CSRF-Token", "csrf")
			r.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
			r = r.WithContext(middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{User: &owner, SessionHash: "owner-session"}))
			w := httptest.NewRecorder()
			h.SetSettings(w, r)
			require.Equal(t, tc.status, w.Code, w.Body.String())
			require.Contains(t, w.Body.String(), tc.message)
		})
	}
}

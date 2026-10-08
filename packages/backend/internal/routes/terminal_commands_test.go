package routes

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/coder/websocket"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/stretchr/testify/require"
)

func TestTerminalCommandBinding(t *testing.T) {
	for _, path := range []string{"/api/todos/2/answer", "/api/todos/T2/answer"} {
		require.True(t, terminalBindingPath("/api/todos/{n}/answer", path), path)
	}
	for _, path := range []string{"/api/todos//answer", "/api/todos/../answer", "/api/todos/./answer", "/api/todos/%2f/answer", "/api/todos/%5c/answer", "/api/todos/%252f/answer", "/api/todos/%zz/answer", "/api/todos/2/answer/extra", "/api/members/2/answer"} {
		require.False(t, terminalBindingPath("/api/todos/{n}/answer", path), path)
	}
}

func TestPersonTerminalCommandAuthorityAndResults(t *testing.T) {
	for _, cell := range []struct {
		name             string
		info             *middleware.AuthInfo
		cookie           bool
		configured       bool
		response         string
		status, expected int
	}{
		{"missing identity", nil, true, true, `{}`, 200, 403},
		{"delegated beside cookie", &middleware.AuthInfo{User: &db.User{UserType: "person"}, IsTokenAuth: true, RawScopes: "via:terminal", TokenSystemIssued: true}, true, true, `{}`, 200, 403},
		{"agent account", &middleware.AuthInfo{User: &db.User{UserType: "bot"}}, true, true, `{}`, 200, 403},
		{"no cookie", &middleware.AuthInfo{User: &db.User{UserType: "person"}}, false, true, `{}`, 200, 403},
		{"missing composition", &middleware.AuthInfo{User: &db.User{UserType: "person"}}, true, false, `{}`, 200, 503},
		{"no content", &middleware.AuthInfo{User: &db.User{UserType: "person"}}, true, true, "", 204, 204},
		{"non JSON", &middleware.AuthInfo{User: &db.User{UserType: "person"}}, true, true, "bad", 200, 502},
		{"oversized response", &middleware.AuthInfo{User: &db.User{UserType: "person"}}, true, true, strings.Repeat("x", (1<<20)+1), 200, 502},
		{"refusal", &middleware.AuthInfo{User: &db.User{UserType: "person"}}, true, true, `{"class":"permission","code":"permission"}`, 403, 403},
	} {
		t.Run(cell.name, func(t *testing.T) {
			calls := 0
			h := &WorkspaceTerminalHandler{}
			if cell.configured {
				h.CommandRouter = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls++
					cookie, err := r.Cookie("smithers_session")
					require.NoError(t, err)
					require.Equal(t, "person-cookie", cookie.Value)
					require.Equal(t, "", r.Header.Get("Authorization"))
					require.Equal(t, "terminal", r.Header.Get("Smithers-Via"))
					require.Nil(t, middleware.AuthInfoFromContext(r.Context()), "fresh loader must decide each command")
					w.Header().Set("Set-Cookie", "private-cookie")
					w.WriteHeader(cell.status)
					_, _ = w.Write([]byte(cell.response))
				})
			}
			source := httptest.NewRequest("GET", "http://install/api/terminal", nil)
			source = source.WithContext(middleware.ContextWithAuthInfo(source.Context(), cell.info))
			if cell.cookie {
				source.AddCookie(&http.Cookie{Name: "smithers_session", Value: "person-cookie"})
			}
			done := make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				defer close(done)
				ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
				require.NoError(t, err)
				defer ws.CloseNow()
				h.personTerminalCommand(r.Context(), ws, source, []byte(`{"type":"command","id":"1","command":"todo.new","method":"POST","path":"/api/todos","body":{"prompt":"Append"},"idempotencyKey":"1","token":"forged-person"}`))
			}))
			defer server.Close()
			ws, _, err := websocket.Dial(t.Context(), "ws"+strings.TrimPrefix(server.URL, "http"), nil)
			require.NoError(t, err)
			defer ws.CloseNow()
			_, raw, err := ws.Read(t.Context())
			require.NoError(t, err)
			var receipt terminalCommandResponse
			require.NoError(t, json.Unmarshal(raw, &receipt))
			require.Equal(t, cell.expected, receipt.Status)
			require.False(t, bytes.Contains(raw, []byte("person-cookie")))
			require.False(t, bytes.Contains(raw, []byte("private-cookie")))
			<-done
			if cell.expected == 403 && cell.name != "refusal" || !cell.configured {
				require.Zero(t, calls)
			} else {
				require.Equal(t, 1, calls)
			}
		})
	}
}

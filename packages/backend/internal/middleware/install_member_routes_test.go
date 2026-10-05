package middleware

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
)

// The member route table, by literal request: every TODO and Members route
// maps to its command; anything else is the owner's alone.
func TestInstallMemberCommandRoutes(t *testing.T) {
	for _, tc := range []struct{ method, path, command string }{
		{http.MethodGet, "/api/user", "self"},
		{http.MethodPost, "/api/auth/logout", "self"},
		{http.MethodGet, "/api/todos", "todo.read"},
		{http.MethodGet, "/api/todos/12", "todo.read"},
		{http.MethodPost, "/api/todos", "todo.new"},
		{http.MethodPost, "/api/todos/12/answer", "todo.answer"},
		{http.MethodPost, "/api/todos/12/merge", "merge"},
		{http.MethodGet, "/api/members", "members.list"},
		{http.MethodPost, "/api/members", "members.write"},
		{http.MethodPatch, "/api/members/alice", "members.write"},
		{http.MethodDelete, "/api/members/alice", "members.write"},
		{http.MethodGet, "/api/todos/T12", ""},
		{http.MethodPost, "/api/todos/12/answer/x", ""},
		{http.MethodPut, "/api/todos/12", ""},
		{http.MethodPut, "/api/install", ""},
		{http.MethodPost, "/api/install/setup/models", ""},
		{http.MethodPost, "/api/model/credential", ""},
		{http.MethodPost, "/api/user/tokens", ""},
		{http.MethodGet, "/api/members/alice", ""},
		{http.MethodPost, "/api/repos/acme/app/secrets", ""},
		{http.MethodGet, "/api/user/repos", ""},
	} {
		require.Equal(t, tc.command, InstallMemberCommand(tc.method, tc.path), "%s %s", tc.method, tc.path)
	}
}

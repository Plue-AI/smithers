package middleware

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
)

// The member route table, by literal request: the app's install reads, the
// app agent, and every TODO and Members route map to their command; anything
// else is the owner's alone.
func TestInstallMemberCommandRoutes(t *testing.T) {
	for _, tc := range []struct{ method, path, command string }{
		{http.MethodGet, "/api/user", "self"},
		{http.MethodPost, "/api/auth/logout", "self"},
		{http.MethodGet, "/api/install", "install.read"},
		{http.MethodGet, "/api/user/repos", "repo.read"},
		{http.MethodGet, "/api/repos/local-owner/demo/mythical", "repo.read"},
		{http.MethodGet, "/api/repos/local-owner/demo/mythical/events", "repo.read"},
		{http.MethodGet, "/api/repos/local-owner/demo/mythical/items/T3", "repo.read"},
		{http.MethodGet, "/api/github/sync", "sync.read"},
		{http.MethodPost, "/api/github/sync", "sync.retry"},
		{http.MethodGet, "/api/live", "live"},
		{http.MethodPost, "/api/agent/turn", "agent.turn"},
		{http.MethodPost, "/api/agent/turn/cancel", "agent.turn"},
		{http.MethodPost, "/api/agent/turn/replay", "agent.turn"},
		{http.MethodPost, "/api/agent/turn/retire", "agent.turn"},
		{http.MethodGet, "/api/agent/conversations", "agent.turn"},
		{http.MethodPost, "/api/agent/conversations/replay", "agent.turn"},
		{http.MethodGet, "/api/user/orgs", "self.read"},
		{http.MethodGet, "/api/user/workspaces", "self.read"},
		{http.MethodPost, "/api/telemetry/errors", "telemetry.report"},
		{http.MethodPost, "/api/todos/12", "todo.control"},
		{http.MethodGet, "/api/todos", "todo.read"},
		{http.MethodGet, "/api/todos/12", "todo.read"},
		{http.MethodPost, "/api/todos", "todo.new"},
		{http.MethodPost, "/api/todos/12/answer", "todo.answer"},
		{http.MethodPost, "/api/todos/12/merge", "merge"},
		{http.MethodGet, "/api/flows", "flows.read"},
		{http.MethodPost, "/api/flows", ""},
		{http.MethodGet, "/api/flows/todo", ""},
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
		{http.MethodPost, "/api/user/repos", ""},
		{http.MethodPost, "/api/repos/local-owner/demo/mythical/bootstrap", ""},
		{http.MethodPost, "/api/repos/local-owner/demo/mythical/items/x/merge", ""},
		{http.MethodPut, "/api/repos/local-owner/demo/mythical/lanes", ""},
		{http.MethodGet, "/api/repos/local-owner/demo/mythical/items/x/y", ""},
		{http.MethodGet, "/api/repos/local-owner/demo/contents/README.md", ""},
		{http.MethodGet, "/api/user/keys", ""},
		{http.MethodPost, "/api/user/workspaces", ""},
		{http.MethodPost, "/api/agent/turn/erase", ""},
		{http.MethodGet, "/api/install/scorecard", ""},
	} {
		require.Equal(t, tc.command, InstallMemberCommand(tc.method, tc.path), "%s %s", tc.method, tc.path)
	}
}

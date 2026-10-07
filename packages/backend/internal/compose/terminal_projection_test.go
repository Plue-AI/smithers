package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
	"testing"
	"time"
)

// Real persisted session rows and the composed live socket supply card metadata.
// The fixture presence host is not a root/guest acceptance receipt.
func TestTerminalMetadataThroughComposedLiveSocket(t *testing.T) {
	f := presenceInstall(t)
	q := db.New(f.pool)
	_, err := f.pool.Exec(t.Context(), `INSERT INTO collaborators(repository_id,user_id,permission,unix_login,unix_uid) VALUES($1,$2,'write','alice',20001)`, f.row.RepositoryID, f.user.ID)
	require.NoError(t, err)
	create := func(via string) db.WorkspaceSession {
		row, e := q.CreateWorkspaceSession(t.Context(), db.CreateWorkspaceSessionParams{WorkspaceID: f.row.ID, RepositoryID: f.row.RepositoryID, UserID: f.user.ID, Cols: 80, Rows: 24})
		require.NoError(t, e)
		_, e = q.UpdateWorkspaceSessionSSHConnectionInfo(t.Context(), db.UpdateWorkspaceSessionSSHConnectionInfoParams{ID: row.ID, SshConnectionInfo: []byte(fmt.Sprintf(`{"via":%q}`, via))})
		require.NoError(t, e)
		return row
	}
	own := create("terminal")
	_ = create("ssh")
	manager := routes.NewTerminalSessionManager(nil)
	defer manager.Close()
	require.NoError(t, manager.OpenOwned(t.Context(), own.ID, revocation.Principal{UserID: f.user.ID, RepositoryID: f.row.RepositoryID, WorkspaceID: f.row.ID}, func(context.Context) (workspaceapi.Terminal, error) {
		return &projectionTerminal{done: make(chan struct{})}, nil
	}))
	f.p.terminals = terminalProjection(f.pool, manager, nil)

	socket := f.dial(t)
	sendPresenceFrame(t, socket, fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s"}`, f.row.ID))
	frame := readPresenceFrame(t, socket)
	require.Equal(t, "snap", frame.T)
	var model struct {
		Terminals []struct {
			ID     string `json:"id"`
			Frozen bool   `json:"frozen"`
			Owner  struct {
				Login string `json:"login"`
			} `json:"owner"`
		} `json:"terminals"`
	}
	require.NoError(t, json.Unmarshal(frame.Data, &model))
	require.Len(t, model.Terminals, 1)
	require.Equal(t, own.ID, model.Terminals[0].ID)
	require.Equal(t, f.user.Username, model.Terminals[0].Owner.Login)
	require.True(t, model.Terminals[0].Frozen, "a persisted request is not a ready broker")
	_, err = f.pool.Exec(t.Context(), `UPDATE collaborators SET suspended_at=now() WHERE repository_id=$1 AND user_id=$2`, f.row.RepositoryID, f.user.ID)
	require.NoError(t, err)
	manager.RevokeMatching(revocation.Event{Kind: revocation.KindCollaboratorRemoved, UserID: f.user.ID, RepositoryID: f.row.RepositoryID})
	rows, err := f.p.terminals(t.Context(), f.row, nil)
	require.NoError(t, err)
	require.Empty(t, rows, "revoked members disappear from terminal metadata")
}

func TestTerminalAgentParticipantsThroughComposedLiveSocket(t *testing.T) {
	f := presenceInstall(t)
	ctx := t.Context()
	_, err := f.pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,unix_login,unix_uid) VALUES($1,$2,'write','alice',20001)`, f.row.RepositoryID, f.user.ID)
	require.NoError(t, err)
	q := db.New(f.pool)
	terminal, err := q.CreateWorkspaceSession(ctx, db.CreateWorkspaceSessionParams{WorkspaceID: f.row.ID, RepositoryID: f.row.RepositoryID, UserID: f.user.ID, Cols: 80, Rows: 24})
	require.NoError(t, err)
	f.p.terminals = terminalProjection(f.pool, nil, nil)
	_, slug, err := installRepository(ctx, q)
	require.NoError(t, err)
	announce := func(session string, where map[string]any) {
		_, err := f.p.call(ctx, f.row, slug, "Branch.Announce", map[string]any{
			"participantId": "run:coding-run", "sessionId": session, "displayName": "coding", "kind": "agent", "agentKind": "coding", "runId": "coding-run", "for_member": fmt.Sprintf("member:%d", f.user.ID), "where": where, "cursor": nil,
		})
		require.NoError(t, err)
	}
	// Trusted host announcements use the real participant flow. This proves
	// card publication, not a reference-host PTY or command execution receipt.
	announce("daemon:terminal", map[string]any{"kind": "terminal", "id": terminal.ID})
	announce("daemon:duplicate", map[string]any{"kind": "terminal", "id": terminal.ID})
	announce("daemon:foreign", map[string]any{"kind": "terminal", "id": "foreign"})
	time.Sleep(2 * time.Millisecond)
	announce("runtime:step", map[string]any{"kind": "step", "label": "Implement"})
	socket := f.dial(t)
	sendPresenceFrame(t, socket, fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s"}`, f.row.ID))
	var model struct {
		Presence []struct {
			Actor map[string]any `json:"actor"`
			Where map[string]any `json:"where"`
		} `json:"presence"`
		Terminals []struct {
			ID     string           `json:"id"`
			Owner  map[string]any   `json:"owner"`
			Agents []map[string]any `json:"agents"`
		} `json:"terminals"`
	}
	read := func() {
		frame := readPresenceFrame(t, socket)
		require.NoError(t, json.Unmarshal(frame.Data, &model))
	}
	read()
	require.Len(t, model.Terminals, 1)
	require.Len(t, model.Presence, 1)
	require.Equal(t, "step", model.Presence[0].Where["kind"])
	require.Equal(t, terminal.ID, model.Terminals[0].ID)
	require.Equal(t, "person", model.Terminals[0].Owner["kind"], "participants never acquire input ownership")
	require.Len(t, model.Terminals[0].Agents, 1, "duplicate sessions render one participant; foreign terminals are excluded")
	agent := model.Terminals[0].Agents[0]
	require.Contains(t, []string{"daemon:terminal", "daemon:duplicate"}, agent["session_id"])
	require.Equal(t, "runtime:step", model.Presence[0].Actor["session_id"], "terminal projection must not mutate Branch presence")
	delete(agent, "session_id")
	delete(model.Presence[0].Actor, "session_id")
	require.Equal(t, model.Presence[0].Actor, agent, "Branch and Terminal share the participant adapter")
	require.Equal(t, "coding-run", agent["run_id"])
	require.Equal(t, "coding", agent["agent"])
	require.NotEmpty(t, agent["avatar_url"])
	require.Equal(t, f.user.Username, agent["for_member"].(map[string]any)["login"])
	for _, session := range []string{"daemon:terminal", "daemon:duplicate"} {
		_, err := f.p.call(ctx, f.row, slug, "Branch.Leave", map[string]any{"participantId": "run:coding-run", "sessionId": session})
		require.NoError(t, err)
	}
	deadline := time.Now().Add(time.Second)
	for {
		read()
		if len(model.Terminals[0].Agents) == 0 {
			break
		}
		require.True(t, time.Now().Before(deadline), "process leave must remove terminal participants")
	}
	require.Len(t, model.Presence, 1, "other live sessions retain the run participant")
}

func TestTerminalAgentProjectionKeepsSessionsIsolated(t *testing.T) {
	actor := func(id string) map[string]any {
		return map[string]any{"kind": "agent", "id": id, "run_id": id, "session_id": "latest"}
	}
	entry := func(id string, locations ...string) any {
		sessions := []any{}
		for i, raw := range locations {
			sessions = append(sessions, map[string]any{"id": fmt.Sprintf("%s:%d", id, i), "where": json.RawMessage(raw)})
		}
		return map[string]any{"actor": actor(id), "sessions": sessions}
	}
	one := map[string]any{"id": "one", "title": "TODO one", "owner": "Agent"}
	two := map[string]any{"id": "two", "title": "TODO two", "owner": "Agent"}
	presence := []any{
		entry("run-one", "", `{"kind":"branch"}`, `{"kind":"terminal","id":""}`, `{"kind":"terminal","id":"one"}`),
		entry("run-two", `{"kind":"terminal","id":"two"}`),
	}
	require.NoError(t, projectTerminalAgents([]any{one, two}, presence))
	require.Equal(t, []any{map[string]any{"kind": "agent", "id": "run-one", "run_id": "run-one", "session_id": "run-one:3"}}, one["agents"])
	require.Equal(t, []any{map[string]any{"kind": "agent", "id": "run-two", "run_id": "run-two", "session_id": "run-two:0"}}, two["agents"])
	require.Equal(t, "TODO one", one["title"])
	require.Equal(t, "Agent", one["owner"])
	require.Error(t, projectTerminalAgents([]any{one, two}, []any{entry("malformed", "{")}))
	require.Len(t, one["agents"], 1, "malformed leases must fail before publishing a partial projection")
	require.NoError(t, projectTerminalAgents([]any{one, two}, nil))
	require.Equal(t, []any{}, one["agents"])
	require.Equal(t, []any{}, two["agents"])
}

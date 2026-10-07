package compose

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/stretchr/testify/require"
)

type presenceStream struct{}

func (presenceStream) Close() error { return nil }

func TestPresenceDaemonAndRunThroughInstall(t *testing.T) {
	f := presenceInstall(t)
	reader := f.dial(t)
	sendPresenceFrame(t, reader, fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s"}`, f.row.ID))
	require.Equal(t, "snap", readPresenceFrame(t, reader).T)
	browser := f.dial(t)
	sendPresenceFrame(t, browser, fmt.Sprintf(`{"t":"presence","id":2,"where":{"branch":%q,"path":"retry.ts","line":12}}`, f.row.ID))
	registry := new(machined.Registry)
	link, guest := presenceTestLink(t, registry, f.row.ID)
	connection := link.Connection
	raw, err := os.ReadFile("testdata/cocontracts/presence_snapshot.bin")
	require.NoError(t, err)
	frame, err := wire.Decode(raw)
	require.NoError(t, err)
	resolve := func(_ context.Context, branch string, session uint32) (presenceSessionBinding, error) {
		require.Equal(t, f.row.ID, branch)
		if session == 1 {
			return presenceSessionBinding{Member: f.user.ID, Name: "Alice", Kind: "person", Via: "ssh"}, nil
		}
		return presenceSessionBinding{Member: f.user.ID, Participant: "session:codex", Name: "Codex", Kind: "agent", AgentKind: "codex", Run: "codex-run", Via: "terminal", Terminal: "term-2"}, nil
	}
	require.ErrorIs(t, f.p.daemonSnapshot(t.Context(), connection, f.row.ID, frame, resolve), machined.ErrNotReady)
	require.NoError(t, connection.Reconciled())
	require.NoError(t, wire.Write(guest, frame))
	frame, err = link.ReceivePresence(t.Context(), f.row.ID)
	require.NoError(t, err)
	require.NoError(t, f.p.daemonSnapshot(t.Context(), connection, f.row.ID, frame, resolve))
	update := flowdispatch.ProjectionUpdate{State: jobs.StateRunning, Checkpoint: flowdispatch.RuntimeCheckpoint{
		Target: flowruntime.Target{TenantID: fmt.Sprintf("repository:%d", f.row.RepositoryID), PrincipalID: fmt.Sprintf("user:%d", f.user.ID), WorkspaceID: f.row.ID, BindingKind: "mythical-item"},
		RunID:  "coding-run", FlowID: "todo", Run: &flowruntime.Run{RunID: "coding-run", FlowID: "todo", Status: "running"},
	}}
	require.NoError(t, f.p.ProjectFlowRuntime(t.Context(), update))
	// One person across browser and SSH, plus two independent agents. Consume
	// subscriber frames: no direct helper projection supplies the oracle.
	deadline := time.Now().Add(time.Second)
	var data struct {
		Presence []struct {
			Actor    map[string]any `json:"actor"`
			Sessions []any          `json:"sessions"`
			Where    map[string]any `json:"where"`
		} `json:"presence"`
	}
	for {
		received := readPresenceFrame(t, reader)
		require.NoError(t, json.Unmarshal(received.Data, &data))
		complete := false
		if len(data.Presence) == 3 {
			for _, entry := range data.Presence {
				if entry.Actor["kind"] == "person" && len(entry.Sessions) == 2 {
					complete = true
				}
			}
		}
		if complete {
			break
		}
		require.True(t, time.Now().Before(deadline), "three participants must reach subscribers within 1 second")
	}
	require.Less(t, time.Now().Sub(deadline.Add(-time.Second)), time.Second)
	agents := map[string]bool{}
	for _, entry := range data.Presence {
		if entry.Actor["kind"] == "person" {
			require.Len(t, entry.Sessions, 2)
			foundSSH := false
			for _, session := range entry.Sessions {
				if session.(map[string]any)["via"] == "ssh" {
					foundSSH = true
				}
			}
			require.True(t, foundSSH)
		} else {
			agents[entry.Actor["agent"].(string)] = true
			require.Equal(t, "presence-owner", entry.Actor["for_member"].(map[string]any)["login"])
		}
	}
	require.Equal(t, map[string]bool{"coding": true, "codex": true}, agents)
	// Full snapshots omit ended sessions; remove both immediately without
	// affecting the browser lease or conflating the runtime agent.
	empty := wire.Frame{Kind: wire.Presence, Payload: wire.Union(1, wire.Field(1, []byte{0, 0}))}
	require.NoError(t, f.p.daemonSnapshot(t.Context(), connection, f.row.ID, empty, resolve))
	update.State = jobs.StateCompleted
	update.Checkpoint.Run.Status = "completed"
	require.NoError(t, f.p.ProjectFlowRuntime(t.Context(), update))
	require.Len(t, f.roster(t), 1)
	// Superseded readers cannot re-announce a departed broker session.
	require.NoError(t, registry.BindBoot(f.row.ID, "machine", [16]byte{2}, []byte("new-secret")))
	require.ErrorIs(t, f.p.daemonSnapshot(t.Context(), connection, f.row.ID, frame, resolve), machined.ErrUnauthorized)
	require.Len(t, f.roster(t), 1)
}

func TestPresenceDaemonSnapshotAtomicAuthorization(t *testing.T) {
	f := presenceInstall(t)
	registry := new(machined.Registry)
	require.NoError(t, registry.BindBoot(f.row.ID, "machine", [16]byte{1}, []byte("secret")))
	connection, err := registry.Admit([16]byte{1}, []byte("secret"), presenceStream{})
	require.NoError(t, err)
	defer connection.Close()
	require.NoError(t, connection.Reconciled())
	raw, err := os.ReadFile("testdata/cocontracts/presence_snapshot.bin")
	require.NoError(t, err)
	frame, err := wire.Decode(raw)
	require.NoError(t, err)
	err = f.p.daemonSnapshot(t.Context(), connection, f.row.ID, frame, func(_ context.Context, _ string, session uint32) (presenceSessionBinding, error) {
		if session == 2 {
			return presenceSessionBinding{}, errors.New("ended session")
		}
		return presenceSessionBinding{Member: f.user.ID, Name: "Alice", Kind: "person", Via: "ssh"}, nil
	})
	require.Error(t, err)
	require.Empty(t, f.roster(t))
	require.ErrorIs(t, f.p.daemonSnapshot(t.Context(), nil, f.row.ID, frame, nil), machined.ErrNotReady)
}

type presenceTurnHost func(context.Context, ports.ChatTurnGrant) error

func (h presenceTurnHost) RunChatTurn(ctx context.Context, grant ports.ChatTurnGrant) error {
	return h(ctx, grant)
}

func TestPresenceAppTurnLifetimeThroughInstall(t *testing.T) {
	f := presenceInstall(t)
	_, err := f.pool.Exec(t.Context(), `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, f.row.RepositoryID, f.user.ID)
	require.NoError(t, err)
	store, err := chat.NewStore(f.pool)
	require.NoError(t, err)
	scope := chat.Scope{RepositoryID: f.row.RepositoryID, UserID: f.user.ID, Owner: "presence-owner"}
	accepted, err := store.Admit(t.Context(), chat.AdmitInput{Scope: scope, RunID: "turn-run", Journal: chat.JournalRequest{Version: 1, LegID: "turn-leg", Token: strings.Repeat("a", 64)}, Request: json.RawMessage(fmt.Sprintf(`{"runId":"turn-run","conversationId":%q,"messages":[{"role":"user","content":"Check retry"}]}`, f.row.ID))})
	require.NoError(t, err)
	grant, err := store.Claim(t.Context(), scope, accepted.TurnID, time.Minute)
	require.NoError(t, err)
	reader := f.dial(t)
	sendPresenceFrame(t, reader, fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s"}`, f.row.ID))
	require.Equal(t, "snap", readPresenceFrame(t, reader).T)
	host := presenceChatHost{presence: f.p, pool: f.pool, ChatHost: presenceTurnHost(func(ctx context.Context, g ports.ChatTurnGrant) error {
		require.Equal(t, "turn-run", g.RunID)
		frame := readPresenceFrame(t, reader)
		require.Contains(t, string(frame.Data), `"agent":"smithers"`)
		require.Contains(t, string(frame.Data), `"run_id":"turn-run"`)
		return errors.New("host stopped")
	})}
	require.EqualError(t, host.RunChatTurn(t.Context(), grant), "host stopped")
	require.Empty(t, f.roster(t), "failure ends agent presence immediately")
}

func TestPresenceVisitAuditSharedWithSSH(t *testing.T) {
	f := presenceInstall(t)
	base := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	var seconds atomic.Int64
	f.p.visits.now = func() time.Time { return base.Add(time.Duration(seconds.Load()) * time.Second) }
	browser := f.dial(t)
	sendPresenceFrame(t, browser, fmt.Sprintf(`{"t":"presence","id":2,"where":{"branch":%q}}`, f.row.ID))
	require.Eventually(t, func() bool { return len(f.roster(t)) == 1 }, time.Second, 10*time.Millisecond)
	// The roster is published before the audit heartbeat is recorded.
	// Advance the fake clock only after the initial visit receipt exists.
	require.Eventually(t, func() bool {
		f.p.visits.mu.Lock()
		defer f.p.visits.mu.Unlock()
		for _, visit := range f.p.visits.visits {
			if visit.start.Equal(base) && len(visit.sessions) == 1 {
				return true
			}
		}
		return false
	}, time.Second, 10*time.Millisecond)
	registry := new(machined.Registry)
	require.NoError(t, registry.BindBoot(f.row.ID, "machine", [16]byte{1}, []byte("secret")))
	connection, err := registry.Admit([16]byte{1}, []byte("secret"), presenceStream{})
	require.NoError(t, err)
	defer connection.Close()
	require.NoError(t, connection.Reconciled())
	frame := wire.Frame{Kind: wire.Presence, Payload: wire.Union(1, wire.Field(1, append([]byte{0, 1}, wire.Struct(wire.Field(1, wire.U32(9)))...)))}
	resolve := func(context.Context, string, uint32) (presenceSessionBinding, error) {
		return presenceSessionBinding{Member: f.user.ID, Name: "Alice", Kind: "person", Via: "ssh"}, nil
	}
	for at := int64(10); at <= 120; at += 10 {
		seconds.Store(at)
		require.NoError(t, f.p.daemonSnapshot(t.Context(), connection, f.row.ID, frame, resolve))
	}
	sendPresenceFrame(t, browser, `{"t":"presence","id":2,"where":{"branch":""}}`)
	require.Eventually(t, func() bool { return len(f.roster(t)) == 1 }, time.Second, 10*time.Millisecond)
	empty := wire.Frame{Kind: wire.Presence, Payload: wire.Union(1, wire.Field(1, []byte{0, 0}))}
	require.NoError(t, f.p.daemonSnapshot(t.Context(), connection, f.row.ID, empty, resolve))
	var count int
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM audit_log WHERE event_type='presence'`).Scan(&count))
	require.Equal(t, 1, count)
	var metadata []byte
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT metadata FROM audit_log WHERE event_type='presence'`).Scan(&metadata))
	require.JSONEq(t, fmt.Sprintf(`{"branch":%q,"member":%d,"via":"app","vias":["app","ssh"],"start":"2026-10-06T12:00:00Z","end":"2026-10-06T12:02:00Z"}`, f.row.ID, f.user.ID), string(metadata))
}

func TestPresenceAgentSessionResolvesAdmittedBranch(t *testing.T) {
	f := presenceInstall(t)
	q := db.New(f.pool)
	_, err := q.CreateAgentSession(t.Context(), db.CreateAgentSessionParams{ID: "ad3e54f3-2d04-4059-a430-2b51c0731a3b", RepositoryID: f.row.RepositoryID, UserID: f.user.ID, Title: "Review retry", Status: "active", Metadata: []byte(`{}`)})
	require.NoError(t, err)
	var branch pgtype.UUID
	require.NoError(t, branch.Scan(f.row.ID))
	require.NoError(t, q.SetAgentSessionWorkspace(t.Context(), db.SetAgentSessionWorkspaceParams{ID: "ad3e54f3-2d04-4059-a430-2b51c0731a3b", WorkspaceID: branch}))
	reader := f.dial(t)
	sendPresenceFrame(t, reader, fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s"}`, f.row.ID))
	require.Equal(t, "snap", readPresenceFrame(t, reader).T)
	update := flowdispatch.ProjectionUpdate{State: jobs.StateRunning, Checkpoint: flowdispatch.RuntimeCheckpoint{
		Target: flowruntime.Target{TenantID: fmt.Sprintf("repository:%d", f.row.RepositoryID), PrincipalID: fmt.Sprintf("user:%d", f.user.ID), BindingKind: "agent-session", BindingID: "ad3e54f3-2d04-4059-a430-2b51c0731a3b"},
		RunID:  "review-run", FlowID: "review", Run: &flowruntime.Run{RunID: "review-run", FlowID: "review", Status: "running"},
	}}
	require.NoError(t, f.p.ProjectFlowRuntime(t.Context(), update))
	require.Contains(t, string(readPresenceFrame(t, reader).Data), `"agent":"reviewer"`)
	// A caller-provided branch cannot replace the admitted session's branch.
	update.Checkpoint.Target.WorkspaceID = "foreign"
	update.Checkpoint.RunID = "foreign-run"
	require.NoError(t, f.p.ProjectFlowRuntime(t.Context(), update))
	require.Len(t, f.roster(t), 1)
	update.Checkpoint.Target.WorkspaceID = ""
	update.Checkpoint.RunID = "review-run"
	_, err = f.pool.Exec(t.Context(), `UPDATE agent_sessions SET status='completed' WHERE id=$1`, update.Checkpoint.Target.BindingID)
	require.NoError(t, err)
	// A stale running observation cannot retain a finished participant.
	require.NoError(t, f.p.ProjectFlowRuntime(t.Context(), update))
	require.Empty(t, f.roster(t))
	update.State = jobs.StateCompleted
	require.NoError(t, f.p.ProjectFlowRuntime(t.Context(), update))
	require.Empty(t, f.roster(t))
}

// The guest is the only fake here; host authentication, snapshot transport,
// bridge, PostgreSQL authorization and the install live route are production.
func presenceTestLink(t *testing.T, registry *machined.Registry, branch string) (*machined.Link, net.Conn) {
	t.Helper()
	authority, err := registry.MintBoot(branch, "machine")
	require.NoError(t, err)
	host, guest := net.Pipe()
	t.Cleanup(func() { host.Close(); guest.Close() })
	done := make(chan error, 1)
	go func() {
		nonce := make([]byte, 32)
		err := wire.Write(guest, wire.Frame{Kind: wire.Hello, Payload: wire.Union(1, wire.Field(1, wire.U32(0x534d4d44)), wire.Field(2, wire.U16(2)), wire.Field(3, authority.ID[:]), wire.Field(4, nonce))})
		if err != nil {
			done <- err
			return
		}
		proof, err := wire.Read(guest)
		if err != nil {
			done <- err
			return
		}
		fields, err := wire.Fields("proof", proof.Payload[1:])
		if err != nil {
			done <- err
			return
		}
		if !wire.VerifyHostMAC(authority.Secret[:], authority.ID[:], nonce, fields[2]) {
			done <- wire.AuthFailed
			return
		}
		err = wire.Write(guest, wire.Frame{Kind: wire.Hello, Payload: wire.Union(3, wire.Field(1, wire.Bytes([]byte(authority.Credential))), wire.Field(2, make([]byte, 16)), wire.Field(3, wire.U64(1)), wire.Field(4, wire.U16(0)))})
		if err != nil {
			done <- err
			return
		}
		_, err = wire.Read(guest)
		done <- err
	}()
	link, err := registry.Connect(t.Context(), branch, host)
	require.NoError(t, err)
	require.NoError(t, <-done)
	t.Cleanup(func() { link.Close() })
	return link, guest
}

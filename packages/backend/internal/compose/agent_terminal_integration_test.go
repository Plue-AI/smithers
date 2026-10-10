package compose

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/stretchr/testify/require"
)

// hostSpawnReceipts stands in for the composed install's durable receipts:
// sessions the host opened have one; a local agent command never does.
type hostSpawnReceipts struct {
	mu     sync.Mutex
	opened map[uint32]machined.SessionUser
}

func (h *hostSpawnReceipts) Record(_ context.Context, _ string, _ [16]byte, id uint32, user machined.SessionUser, _ string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.opened[id] = user
	return nil
}
func (h *hostSpawnReceipts) Lookup(_ context.Context, _ string, _ [16]byte, id uint32) (machined.SessionUser, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if user, ok := h.opened[id]; ok {
		return user, nil
	}
	return machined.SessionUser{}, machined.ErrNotReady
}
func (h *hostSpawnReceipts) Attribution(context.Context, string, [16]byte, uint32) (json.RawMessage, error) {
	return nil, machined.ErrNotReady
}

// guestFrames reads what the host sends the guest, so the synchronous test
// pipe never blocks the watcher's credit.
func guestFrames(t *testing.T, guest net.Conn) <-chan wire.Frame {
	t.Helper()
	frames := make(chan wire.Frame, 64)
	go func() {
		defer close(frames)
		for {
			f, err := wire.Read(guest)
			if err != nil {
				return
			}
			frames <- f
		}
	}()
	return frames
}

func nextGuestFrame(t *testing.T, frames <-chan wire.Frame) wire.Frame {
	t.Helper()
	select {
	case f, ok := <-frames:
		require.True(t, ok)
		return f
	case <-time.After(5 * time.Second):
		t.Fatal("host sent the guest nothing")
		return wire.Frame{}
	}
}

func answerGuest(t *testing.T, guest net.Conn, request wire.Frame, method wire.Method, fields ...[]byte) {
	t.Helper()
	id, got, _, err := request.Request()
	require.NoError(t, err)
	require.Equal(t, byte(method), got)
	require.NoError(t, wire.Write(guest, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(byte(method), fields...)))}))
}

// T-TRM-05 through the composed presence consumer, the shared terminal
// manager and the Branch card's live socket. The guest end of the daemon link
// is scripted; the broker's pause/attach contract is crates/smithers-machined
// tests/session_dispatch.rs.
func TestAgentCommandsReachTheBranchTerminalCardThroughPresence(t *testing.T) {
	f := presenceInstall(t)
	manager := routes.NewTerminalSessionManager(nil)
	defer manager.Close()
	f.p.terminalManager = manager
	f.p.terminals = terminalProjection(f.pool, manager, nil)
	var run string
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT id::text FROM flow_runtime_host_bindings WHERE workspace_id=$1 AND catalog_key='coding'`, f.row.ID).Scan(&run))
	registry := new(machined.Registry)
	registry.BindSessionIdentities(&hostSpawnReceipts{opened: map[uint32]machined.SessionUser{}})
	link, guest := presenceTestLink(t, registry, f.row.ID)
	require.NoError(t, link.Reconciled())
	frames := guestFrames(t, guest)
	// The coding host: session 1, registered as the branch's coding run.
	host := machined.NewSessions(link.Connection, f.row.ID, registry.Sessions(f.row.ID)).WithActor([]byte("actor-reference1"), run).WithPresenceVia("agent:" + run)
	opened := make(chan error, 1)
	go func() {
		_, err := host.OpenSession(t.Context(), machined.SessionUser{Login: "agent", UID: 19999}, machined.SessionExec, []string{"node"}, nil)
		opened <- err
	}()
	answerGuest(t, guest, nextGuestFrame(t, frames), wire.OpenSession, wire.Field(1, wire.U32(1)))
	require.NoError(t, <-opened)

	reader := f.dial(t)
	sendPresenceFrame(t, reader, fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s"}`, f.row.ID))
	readPresenceFrame(t, reader)
	stop := f.p.consumeDaemons(t.Context(), registry)
	defer stop()
	snapshot := func(ids ...uint32) {
		locations := wire.U16(uint16(len(ids)))
		for _, id := range ids {
			locations = append(locations, wire.Struct(wire.Field(1, wire.U32(id)))...)
		}
		require.NoError(t, wire.Write(guest, wire.Frame{Kind: wire.Presence, Payload: wire.Union(1, wire.Field(1, locations))}))
	}
	// The daemon lists the paused command; the host attaches its watcher.
	snapshot(1, 7)
	attach := nextGuestFrame(t, frames)
	_, method, args, err := attach.Request()
	require.NoError(t, err)
	require.Equal(t, byte(wire.AttachSession), method)
	fields, err := wire.Fields("args15", args)
	require.NoError(t, err)
	require.Equal(t, uint32(7), binary.BigEndian.Uint32(fields[1]))
	answerGuest(t, guest, attach, wire.AttachSession, wire.Field(1, wire.U64(0)))

	type cardTerminal struct {
		ID, Title string
		Owner     struct {
			ID, Kind, Name string
			RunID          string                 `json:"run_id"`
			ForMember      struct{ Login string } `json:"for_member"`
		}
	}
	var model struct{ Terminals []cardTerminal }
	deadline := time.Now().Add(5 * time.Second)
	for len(model.Terminals) == 0 {
		require.True(t, time.Now().Before(deadline), "agent terminal missing from the Branch card")
		frame := readPresenceFrame(t, reader)
		if len(frame.Data) > 0 {
			require.NoError(t, json.Unmarshal(frame.Data, &model))
		}
	}
	require.Len(t, model.Terminals, 1)
	terminal := model.Terminals[0]
	require.Equal(t, "agent-"+run, terminal.ID)
	require.Equal(t, "Retry webhooks", terminal.Title, "titled after the branch's TODO")
	require.Equal(t, "agent", terminal.Owner.Kind)
	require.Equal(t, "Agent", terminal.Owner.Name)
	require.Equal(t, run, terminal.Owner.RunID)
	require.Equal(t, f.user.Username, terminal.Owner.ForMember.Login)

	// The command's bytes reach the shared manager, which returns their credit.
	output := []byte("$ pnpm test\r\nAGENT_TERMINAL_FIRST\r\n")
	require.NoError(t, wire.Write(guest, wire.Frame{Kind: wire.Sessions, Stream: 7, Payload: append([]byte{1, 1}, output...)}))
	credit := nextGuestFrame(t, frames)
	require.Equal(t, wire.Sessions, credit.Kind)
	require.Equal(t, uint32(7), credit.Stream)
	require.Equal(t, append([]byte{6}, wire.U32(uint32(len(output)))...), credit.Payload, "a watcher returns credit only")
	for _, payload := range [][]byte{{2, 1}, {5, 0, 0, 0, 0, 7}, {7}} {
		require.NoError(t, wire.Write(guest, wire.Frame{Kind: wire.Sessions, Stream: 7, Payload: payload}))
	}
	require.Eventually(t, func() bool { return !link.HasSession(7) }, 3*time.Second, 10*time.Millisecond)

	// The run's next command joins the same terminal: one card row per run.
	snapshot(1, 9)
	attach = nextGuestFrame(t, frames)
	answerGuest(t, guest, attach, wire.AttachSession, wire.Field(1, wire.U64(0)))
	require.Eventually(t, func() bool { return link.HasSession(9) }, 3*time.Second, 10*time.Millisecond)
	facts := manager.BranchTerminals(f.row.RepositoryID, f.row.ID)
	require.Len(t, facts, 1)
	require.Equal(t, run, facts[0].RunID)
	require.Zero(t, facts[0].Owner, "nobody owns the agent's terminal input")
	require.Equal(t, f.user.ID, facts[0].ForMember)

	// A session the host opened itself is never taken for an agent command.
	snapshot(1, 9)
	select {
	case unexpected := <-frames:
		t.Fatalf("host sent %v for a known session", unexpected)
	case <-time.After(300 * time.Millisecond):
	}
	require.NoError(t, link.RequireReady(f.row.ID))
}

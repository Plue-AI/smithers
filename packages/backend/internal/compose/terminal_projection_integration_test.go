package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// Only the not-yet-composed broker is replaced. PostgreSQL, auth, live routing,
// manager lifecycle and the TypeScript presence host are production providers.
type projectionTerminal struct {
	done chan struct{}
	once sync.Once
}

func (p *projectionTerminal) Read([]byte) (int, error)                     { <-p.done; return 0, io.EOF }
func (p *projectionTerminal) Write(b []byte) (int, error)                  { return len(b), nil }
func (p *projectionTerminal) Close() error                                 { p.once.Do(func() { close(p.done) }); return nil }
func (p *projectionTerminal) Resize(context.Context, uint16, uint16) error { return nil }

func TestTerminalBranchProjectionLifecycleHTTP(t *testing.T) {
	f := presenceInstall(t)
	manager := routes.NewTerminalSessionManager(nil)
	defer manager.Close()
	f.p.terminalManager = manager
	f.p.terminals = terminalProjection(f.pool, manager, nil)
	terminal := &projectionTerminal{done: make(chan struct{})}
	require.NoError(t, manager.OpenOwned(t.Context(), "term-ben", revocation.Principal{UserID: f.user.ID, RepositoryID: f.row.RepositoryID, WorkspaceID: f.row.ID}, func(context.Context) (workspaceapi.Terminal, error) { return terminal, nil }))
	require.True(t, manager.HasBranchTerminal(f.row.RepositoryID, f.row.ID))
	require.False(t, manager.HasBranchTerminal(f.row.RepositoryID+1, f.row.ID))
	state, err := f.p.rebasePresence(t.Context(), f.row.RepositoryID, f.row.ID)
	require.NoError(t, err)
	require.Equal(t, services.RebasePresencePeople, state)
	conn := f.dial(t)
	sendPresenceFrame(t, conn, fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s"}`, f.row.ID))
	var model struct {
		Terminals []struct {
			ID, Title string
			Owner     struct{ Login string }
			Watchers  []any
		}
	}
	// Subscription acknowledges before delivering the snapshot.
	for i := 0; i < 3; i++ {
		frame := readPresenceFrame(t, conn)
		// The live frame's data carries the complete card.
		if len(frame.Data) > 0 {
			require.NoError(t, json.Unmarshal(frame.Data, &model))
			break
		}
	}
	require.Len(t, model.Terminals, 1)
	require.Equal(t, "term-ben", model.Terminals[0].ID)
	require.Equal(t, f.user.Username, model.Terminals[0].Owner.Login)
	manager.Destroy("term-ben")
	require.Eventually(t, func() bool { return !manager.HasBranchTerminal(f.row.RepositoryID, f.row.ID) }, time.Second, time.Millisecond)
	require.Empty(t, manager.BranchTerminals(f.row.RepositoryID, f.row.ID))
	frame := readPresenceFrame(t, conn)
	require.NoError(t, json.Unmarshal(frame.Data, &model))
	require.Empty(t, model.Terminals)
}

// The composed live socket projects the registered run owner rather than
// looking up the participant id as a member. The broker transport fixture is
// not evidence of uid/cgroup confinement or command execution.
func TestAgentTerminalOwnerThroughComposedLiveSocket(t *testing.T) {
	f := presenceInstall(t)
	manager := routes.NewTerminalSessionManager(nil)
	defer manager.Close()
	f.p.terminalManager = manager
	f.p.terminals = terminalProjection(f.pool, manager, nil)
	terminal := &projectionTerminal{done: make(chan struct{})}
	require.NoError(t, manager.OpenAgent(t.Context(), "agent-term", "coding-run", "Fix build", revocation.Principal{UserID: f.user.ID, RepositoryID: f.row.RepositoryID, WorkspaceID: f.row.ID}, func(context.Context) (workspaceapi.Terminal, error) { return terminal, nil }))
	conn := f.dial(t)
	sendPresenceFrame(t, conn, fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s"}`, f.row.ID))
	var model struct {
		Terminals []struct {
			ID, Title string
			Owner     struct {
				ID, Kind, Name string
				RunID          string                 `json:"run_id"`
				SessionID      string                 `json:"session_id"`
				ForMember      struct{ Login string } `json:"for_member"`
			}
		}
	}
	for i := 0; i < 3; i++ {
		frame := readPresenceFrame(t, conn)
		if len(frame.Data) > 0 {
			require.NoError(t, json.Unmarshal(frame.Data, &model))
			break
		}
	}
	require.Len(t, model.Terminals, 1)
	entry := model.Terminals[0]
	require.Equal(t, "agent-term", entry.ID)
	require.Equal(t, "Fix build", entry.Title)
	require.Equal(t, "agent:coding-run", entry.Owner.ID)
	require.Equal(t, "agent", entry.Owner.Kind)
	require.Equal(t, "Agent", entry.Owner.Name)
	require.Equal(t, "coding-run", entry.Owner.RunID)
	require.Equal(t, "agent-term", entry.Owner.SessionID)
	require.Equal(t, f.user.Username, entry.Owner.ForMember.Login)
	manager.Destroy("agent-term")
	require.Eventually(t, func() bool { return !manager.HasBranchTerminal(f.row.RepositoryID, f.row.ID) }, time.Second, time.Millisecond)
}

type commandProjectionTerminal struct {
	projectionTerminal
	command atomic.Pointer[string]
}

func (p *commandProjectionTerminal) ForegroundCommand() string {
	if command := p.command.Load(); command != nil {
		return *command
	}
	return ""
}

func TestForegroundTerminalCommandThroughComposedLiveSocket(t *testing.T) {
	f := presenceInstall(t)
	manager := routes.NewTerminalSessionManager(nil)
	defer manager.Close()
	f.p.terminalManager = manager
	f.p.terminals = terminalProjection(f.pool, manager, nil)
	terminal := &commandProjectionTerminal{projectionTerminal: projectionTerminal{done: make(chan struct{})}}
	require.NoError(t, manager.OpenOwned(t.Context(), "term-ben", revocation.Principal{UserID: f.user.ID, RepositoryID: f.row.RepositoryID, WorkspaceID: f.row.ID}, func(context.Context) (workspaceapi.Terminal, error) {
		return &receiptedOwnerTerminal{Terminal: terminal, closed: func() {}}, nil
	}))
	conn := f.dial(t)
	sendPresenceFrame(t, conn, fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s"}`, f.row.ID))
	read := func() map[string]any {
		for {
			frame := readPresenceFrame(t, conn)
			if len(frame.Data) == 0 {
				continue
			}
			var model struct{ Terminals []map[string]any }
			require.NoError(t, json.Unmarshal(frame.Data, &model))
			require.Len(t, model.Terminals, 1)
			require.Equal(t, "term-ben", model.Terminals[0]["id"])
			return model.Terminals[0]
		}
	}
	require.NotContains(t, read(), "command", "an unknown command stays absent")
	sleep := "sleep"
	terminal.command.Store(&sleep)
	require.Equal(t, "sleep", read()["command"])
	cat := "cat"
	terminal.command.Store(&cat)
	require.Equal(t, "cat", read()["command"])
	terminal.command.Store(nil)
	require.NotContains(t, read(), "command", "the live card clears completed foreground commands")
}

package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sync"
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
	f.p.terminals = manager
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

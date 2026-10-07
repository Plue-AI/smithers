package routes

import (
	"context"
	"errors"
	"io"
	"sync"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

type ownedTerminalFixture struct {
	done chan struct{}
	once sync.Once
}

func (p *ownedTerminalFixture) Read([]byte) (int, error)                     { <-p.done; return 0, io.EOF }
func (p *ownedTerminalFixture) Write(b []byte) (int, error)                  { return len(b), nil }
func (p *ownedTerminalFixture) Close() error                                 { p.once.Do(func() { close(p.done) }); return nil }
func (p *ownedTerminalFixture) Resize(context.Context, uint16, uint16) error { return nil }

func TestOwnedTerminalStartupRevocationAndProjection(t *testing.T) {
	manager := NewTerminalSessionManager(nil)
	defer manager.Close()
	p := revocation.Principal{UserID: 7, RepositoryID: 3, WorkspaceID: "branch"}
	entered, release := make(chan struct{}), make(chan struct{})
	terminal := &ownedTerminalFixture{done: make(chan struct{})}
	result := make(chan error, 1)
	go func() {
		result <- manager.OpenOwned(t.Context(), "terminal", p, func(context.Context) (workspaceapi.Terminal, error) { close(entered); <-release; return terminal, nil })
	}()
	<-entered
	require.True(t, manager.HasBranchTerminal(3, "branch"))
	require.Empty(t, manager.BranchTerminals(3, "branch"))
	manager.RevokeMatching(revocation.Event{Kind: revocation.KindCollaboratorRemoved, RepositoryID: 3, UserID: 7})
	close(release)
	require.Error(t, <-result)
	<-terminal.done
	require.False(t, manager.HasBranchTerminal(3, "branch"))
	require.Empty(t, manager.BranchTerminals(3, "branch"))
}

func TestOwnedTerminalFailureReleasesHold(t *testing.T) {
	manager := NewTerminalSessionManager(nil)
	defer manager.Close()
	require.Error(t, manager.OpenOwned(t.Context(), "terminal", revocation.Principal{UserID: 7, RepositoryID: 3, WorkspaceID: "branch"}, func(context.Context) (workspaceapi.Terminal, error) { return nil, errors.New("broker unavailable") }))
	require.False(t, manager.HasBranchTerminal(3, "branch"))
	require.Empty(t, manager.BranchTerminals(3, "branch"))
}

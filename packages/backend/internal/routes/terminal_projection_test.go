package routes

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

type ownedTerminalFixture struct {
	closeWait <-chan struct{}
	closeErr  error
	done      chan struct{}
	once      sync.Once
}

func (p *ownedTerminalFixture) Read([]byte) (int, error)    { <-p.done; return 0, io.EOF }
func (p *ownedTerminalFixture) Write(b []byte) (int, error) { return len(b), nil }
func (p *ownedTerminalFixture) Close() error {
	if p.closeWait != nil {
		<-p.closeWait
	}
	p.once.Do(func() { close(p.done) })
	return p.closeErr
}
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

func TestOwnedTerminalHoldsUntilCloseReceipt(t *testing.T) {
	for _, failure := range []bool{false, true} {
		t.Run(fmt.Sprint(failure), func(t *testing.T) {
			manager := NewTerminalSessionManager(nil)
			defer manager.Close()
			released := make(chan struct{})
			terminal := &ownedTerminalFixture{done: make(chan struct{}), closeWait: released}
			if failure {
				terminal.closeErr = errors.New("lost broker receipt")
			}
			require.NoError(t, manager.OpenOwned(t.Context(), "terminal", revocation.Principal{UserID: 7, RepositoryID: 3, WorkspaceID: "branch"}, func(context.Context) (workspaceapi.Terminal, error) { return terminal, nil }))
			manager.Destroy("terminal")
			require.Empty(t, manager.BranchTerminals(3, "branch"))
			require.True(t, manager.HasBranchTerminal(3, "branch"))
			close(released)
			<-terminal.done
			if failure {
				require.True(t, manager.HasBranchTerminal(3, "branch"))
			} else {
				require.Eventually(t, func() bool { return !manager.HasBranchTerminal(3, "branch") }, time.Second, time.Millisecond)
			}
		})
	}
}

func TestAgentTerminalUsesSharedManagerWithoutSponsorInput(t *testing.T) {
	manager := NewTerminalSessionManager(nil)
	defer manager.Close()
	principal := revocation.Principal{UserID: 7, RepositoryID: 3, WorkspaceID: "branch"}
	terminal := &ownedTerminalFixture{done: make(chan struct{})}
	calls := 0
	open := func(context.Context) (workspaceapi.Terminal, error) { calls++; return terminal, nil }
	for _, run := range []string{"", "bad\x00run"} {
		require.Error(t, manager.OpenAgent(t.Context(), "agent-terminal", run, "Fix build", principal, open))
	}
	require.Zero(t, calls)
	require.NoError(t, manager.OpenAgent(t.Context(), "agent-terminal", "run-1", "Fix build", principal, open))
	facts := manager.BranchTerminals(3, "branch")
	require.Len(t, facts, 1)
	require.Zero(t, facts[0].Owner)
	require.Equal(t, int64(7), facts[0].ForMember)
	require.Equal(t, "run-1", facts[0].RunID)
	require.Equal(t, "Fix build", facts[0].Title)
	session, err := manager.getExisting("agent-terminal")
	require.NoError(t, err)
	session.idleExpire(session.idleGen)
	require.False(t, session.isDead(), "run lifetime does not depend on a browser watcher")
	// Even the sponsoring member's authenticated attachment is a watcher.
	sink := &terminalSink{principal: principal}
	session.mu.Lock()
	session.sinks[sink] = struct{}{}
	session.mu.Unlock()
	require.False(t, session.ownsInput(nil))
	require.Equal(t, []int64{7}, manager.BranchTerminals(3, "branch")[0].Watchers)
	require.Zero(t, manager.Presence("agent-terminal").Owner)
	require.Equal(t, []int64{7}, manager.Presence("agent-terminal").Watchers)
	session.mu.Lock()
	delete(session.sinks, sink)
	session.mu.Unlock()
	manager.RevokeMatching(revocation.Event{Kind: revocation.KindCollaboratorRemoved, UserID: 7, RepositoryID: 3})
	require.Empty(t, manager.BranchTerminals(3, "branch"))
	<-terminal.done
}

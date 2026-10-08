package routes

import (
	"context"
	"errors"
	"sort"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// TerminalFact is a snapshot of the existing manager, never a second session store.
type TerminalFact struct {
	ID         string
	Branch     string
	Owner      int64
	RunID      string
	Title      string
	ForMember  int64
	Repository int64
	Watchers   []int64
}

func (m *TerminalSessionManager) BranchTerminals(repository int64, branch string) []TerminalFact {
	facts := []TerminalFact{}
	if m == nil {
		return facts
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, session := range m.sessions {
		session.mu.Lock()
		p := session.principal
		if !session.dead && p.RepositoryID == repository && p.WorkspaceID == branch && p.UserID > 0 {
			fact := TerminalFact{ID: session.id, Branch: branch, Owner: p.UserID, Repository: repository, Watchers: []int64{}}
			if session.agentRun != "" {
				fact.Owner = 0
				fact.RunID = session.agentRun
				fact.Title = session.agentTitle
				fact.ForMember = p.UserID
			}
			seen := map[int64]bool{}
			for sink := range session.sinks {
				id := sink.principal.UserID
				if id > 0 && id != fact.Owner && !seen[id] {
					fact.Watchers = append(fact.Watchers, id)
					seen[id] = true
				}
			}
			sort.Slice(fact.Watchers, func(i, j int) bool { return fact.Watchers[i] < fact.Watchers[j] })
			facts = append(facts, fact)
		}
		session.mu.Unlock()
	}
	sort.Slice(facts, func(i, j int) bool { return facts[i].ID < facts[j].ID })
	return facts
}

// HasBranchTerminal includes startup: an admitted open must hold the machine
// even before its PTY produces output or a browser attaches.
func (m *TerminalSessionManager) HasBranchTerminal(repository int64, branch string) bool {
	if m == nil {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for pending := range m.starting {
		if (repository == 0 || pending.principal.RepositoryID == repository) && pending.principal.WorkspaceID == branch {
			return true
		}
	}
	for _, session := range m.sessions {
		session.mu.Lock()
		held := (!session.dead || session.ownerSession) && (repository == 0 || session.principal.RepositoryID == repository) && session.principal.WorkspaceID == branch
		session.mu.Unlock()
		if held {
			return true
		}
	}
	return false
}

// OpenOwned registers an already authorized owner session without a database
// workspace_sessions row. The opener must use the authenticated daemon broker.
// Pending opens participate in revocation and the safe-idle hold.
func (m *TerminalSessionManager) OpenOwned(ctx context.Context, id string, principal revocation.Principal, open func(context.Context) (workspaceapi.Terminal, error)) error {
	return m.openRegistered(ctx, id, principal, "", "", open)
}

// OpenAgent attaches a host-admitted run terminal to the existing ring and fanout.
// The sponsor is retained for revocation only; no browser attachment owns input.
func (m *TerminalSessionManager) OpenAgent(ctx context.Context, id, run, title string, sponsor revocation.Principal, open func(context.Context) (workspaceapi.Terminal, error)) error {
	if run == "" || len(run) > 4096 || strings.ContainsRune(run, 0) || title == "" || len(title) > 4096 || strings.ContainsRune(title, 0) {
		return errors.New("invalid agent terminal")
	}
	return m.openRegistered(ctx, id, sponsor, run, title, open)
}

func (m *TerminalSessionManager) openRegistered(ctx context.Context, id string, principal revocation.Principal, run, title string, open func(context.Context) (workspaceapi.Terminal, error)) error {
	if principal.UserID <= 0 || principal.RepositoryID <= 0 || principal.WorkspaceID == "" || id == "" || open == nil {
		return errors.New("invalid terminal owner")
	}
	ctx, cancel := context.WithCancelCause(ctx)
	pending := &terminalStartup{cancel: cancel, principal: principal, sessionID: id}
	m.mu.Lock()
	if m.starting == nil {
		m.starting = make(map[*terminalStartup]struct{})
	}
	m.starting[pending] = struct{}{}
	m.mu.Unlock()
	defer func() { cancel(context.Canceled); m.mu.Lock(); delete(m.starting, pending); m.mu.Unlock() }()
	terminal, err := open(ctx)
	if err != nil {
		return err
	}
	client, backend, err := newRuntimeTerminalBackend(terminal, func() {})
	if err != nil {
		return err
	}
	stdin, err := backend.StdinPipe()
	if err != nil {
		_ = client.Close()
		return err
	}
	stdout, err := backend.StdoutPipe()
	if err != nil {
		_ = client.Close()
		return err
	}
	stderr, err := backend.StderrPipe()
	if err != nil {
		_ = client.Close()
		return err
	}
	var session *terminalSession
	session = newTerminalSession(id, client, backend, stdin, stdout, stderr, m.ringBufferBytes, m.idleTimeout, 0, func() { m.removeSession(id, session) })
	session.ownerSession = true
	session.agentRun = run
	session.agentTitle = title
	session.setPrincipal(principal)
	m.mu.Lock()
	if ctx.Err() != nil || m.sessions[id] != nil {
		m.mu.Unlock()
		_ = client.Close()
		if ctx.Err() != nil {
			return context.Cause(ctx)
		}
		return errors.New("terminal already exists")
	}
	m.sessions[id] = session
	m.mu.Unlock()
	wait := make(chan error, 1)
	go func() { wait <- backend.Wait() }()
	session.startWithWait(wait)
	return nil
}

// OwnsSubject includes admission in progress so the host can mint the delegated
// credential before the shell starts. No caller-supplied identity is trusted.
func (m *TerminalSessionManager) OwnsSubject(member, repository int64, branch, id string) bool {
	if m == nil {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	matches := func(p revocation.Principal) bool {
		return p.UserID == member && p.RepositoryID == repository && p.WorkspaceID == branch
	}
	for pending := range m.starting {
		if pending.sessionID == id && matches(pending.principal) {
			return true
		}
	}
	if session := m.sessions[id]; session != nil {
		session.mu.Lock()
		defer session.mu.Unlock()
		return !session.dead && matches(session.principal)
	}
	return false
}

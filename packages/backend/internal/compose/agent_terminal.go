package compose

import (
	"context"
	"encoding/hex"
	"errors"
	"log/slog"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// agentTerminals shows the coding agent's commands in the Terminal card
// (T-TRM-05, spec §8.11.2a). Each bash call is a local agent PTY on the
// branch machine; the daemon lists it in presence while the broker holds it
// paused, and this attaches the host's read-only watcher, which starts it.
// One coding run's commands share one terminal on the shared manager: owner
// "Agent", sponsored by the run's member, titled after the branch's TODO.
type agentTerminals struct {
	mu      sync.Mutex
	runs    map[string]*machined.AgentTerminal
	refused map[string]time.Time
	now     func() time.Time
}

// agentTerminalRetry spaces attempts at a session the broker refused to let
// the host watch (for example one that started unwatched).
const agentTerminalRetry = 5 * time.Second

// codingRun is the branch's one coding host binding: the run that registers
// local agent sessions on its machine, its member and its TODO title.
type codingRun struct {
	run, title, sandbox string
	member, repository  int64
}

func loadCodingRun(ctx context.Context, pool *pgxpool.Pool, branch string) (codingRun, error) {
	var run codingRun
	err := pool.QueryRow(ctx, `SELECT h.id::text, h.user_id, w.repository_id, w.vm_id,
	  COALESCE((SELECT COALESCE(NULLIF(btrim(i.title),''), NULLIF(btrim(i.issue_title),''))
	    FROM mythical_lanes l JOIN mythical_items i ON i.id = l.item_id
	    WHERE l.workspace_id = w.id::text AND l.retired_at IS NULL LIMIT 1), '')
	FROM flow_runtime_host_bindings h JOIN workspaces w ON w.id = h.workspace_id
	WHERE h.workspace_id = $1::uuid AND h.catalog_key = 'coding' AND h.state IN ('starting','running')
	  AND w.deleted_at IS NULL`, branch).Scan(&run.run, &run.member, &run.repository, &run.sandbox, &run.title)
	if run.title == "" {
		run.title = "Agent"
	}
	return run, err
}

// observe attaches every unknown local agent session in one presence snapshot.
// A refusal never blocks presence: the snapshot is still applied afterwards.
func (p *branchPresence) observeAgentTerminals(ctx context.Context, link *machined.Link, branch string, frame wire.Frame) {
	if p == nil || p.terminalManager == nil || p.members == nil || p.members.Pool == nil || link == nil {
		return
	}
	locations, err := frame.PresenceSnapshot()
	if err != nil {
		return
	}
	var run *codingRun
	for _, location := range locations {
		if location.Participant != ([16]byte{}) || link.HasSession(location.Session) {
			continue
		}
		boot := link.BootID()
		key := hex.EncodeToString(boot[:]) + ":" + strconv.FormatUint(uint64(location.Session), 10)
		if !p.agents.admit(key) {
			continue
		}
		if run == nil {
			loaded, err := loadCodingRun(ctx, p.members.Pool, branch)
			if err != nil {
				if !errors.Is(err, pgx.ErrNoRows) {
					slog.Warn("agent terminal run lookup failed", "branch", branch, "error", err)
				}
				p.agents.refuse(key)
				return
			}
			run = &loaded
		}
		if err := p.agents.watch(ctx, p.terminalManager, link, branch, location.Session, *run); err != nil {
			p.agents.refuse(key)
			slog.Debug("agent terminal not watched", "branch", branch, "session", location.Session, "error", err)
		}
	}
}

func (a *agentTerminals) clock() time.Time {
	if a.now != nil {
		return a.now()
	}
	return time.Now()
}

func (a *agentTerminals) admit(key string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	at, ok := a.refused[key]
	return !ok || a.clock().Sub(at) >= agentTerminalRetry
}

func (a *agentTerminals) refuse(key string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.refused == nil {
		a.refused = map[string]time.Time{}
	}
	now := a.clock()
	for k, at := range a.refused {
		if now.Sub(at) >= time.Minute {
			delete(a.refused, k)
		}
	}
	a.refused[key] = now
}

// watch attaches one command and adds it to its run's terminal, opening that
// terminal on the shared manager for the run's first command.
func (a *agentTerminals) watch(ctx context.Context, manager *routes.TerminalSessionManager, link *machined.Link, branch string, session uint32, run codingRun) error {
	stream, err := link.ObserveAgentTerminal(ctx, branch, session, run.run)
	if err != nil {
		return err
	}
	a.mu.Lock()
	if a.runs == nil {
		a.runs = map[string]*machined.AgentTerminal{}
	}
	terminal := a.runs[run.run]
	if terminal != nil && terminal.Append(stream) {
		a.mu.Unlock()
		return nil
	}
	terminal = machined.NewAgentTerminal(func() bool {
		select {
		case <-link.Done():
			return false
		default:
		}
		_, err := link.RunPresence(branch, run.run)
		return err == nil
	})
	terminal.Append(stream)
	a.runs[run.run] = terminal
	a.mu.Unlock()
	go func() {
		<-terminal.Done()
		a.mu.Lock()
		if a.runs[run.run] == terminal {
			delete(a.runs, run.run)
		}
		a.mu.Unlock()
	}()
	sponsor := revocation.Principal{UserID: run.member, RepositoryID: run.repository, WorkspaceID: branch, SandboxID: run.sandbox}
	err = manager.OpenAgent(ctx, "agent-"+run.run, run.run, run.title, sponsor, func(context.Context) (workspaceapi.Terminal, error) {
		return terminal, nil
	})
	if err != nil {
		_ = terminal.Close()
		return err
	}
	return nil
}

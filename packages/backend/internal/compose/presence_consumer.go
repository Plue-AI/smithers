package compose

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

func (p *branchPresence) sessionResolver(link *machined.Link) presenceSessionResolver {
	return func(ctx context.Context, branch string, id uint32) (presenceSessionBinding, error) {
		user, run, via, err := link.SessionPresence(branch, id)
		if err != nil {
			return presenceSessionBinding{}, err
		}
		// A File card's language server is not a participant: it neither
		// announces the member nor holds the machine awake (spec §9.1.2).
		if via == "lsp" {
			return presenceSessionBinding{Skip: true}, nil
		}
		if user.Login == "agent" {
			if run == "" {
				return presenceSessionBinding{}, machined.ErrUnauthorized
			}
			// The native coding host's own session (microsandbox native_host:
			// run = host binding, via "agent:<binding>") is not a participant.
			// Its runs announce the coding agent through the runtime projection
			// while they run, so a parked or finished run leaves the branch
			// safe-idle. Refusing it left every factory machine's census
			// unknown and its machine never released (#3776).
			if via == "agent:"+run {
				return presenceSessionBinding{Skip: true}, nil
			}
			return p.agentSessionBinding(ctx, branch, run, via)
		}
		row, err := p.queries.GetWorkspace(ctx, branch)
		if err != nil {
			return presenceSessionBinding{}, err
		}
		member, err := p.queries.PresenceSessionMember(ctx, row.RepositoryID, user.Login, user.UID)
		if err != nil {
			return presenceSessionBinding{}, err
		}
		name := member.DisplayName
		if name == "" {
			name = member.Username
		}
		if via == "" {
			via = "cli"
		}
		return presenceSessionBinding{Member: member.ID, Name: name, Kind: "person", Via: via}, nil
	}
}

// Start one consumer per admitted boot. The registry and existing TS roster
// remain the sole authorities; this map tracks workers, never participants.
func (p *branchPresence) consumeDaemons(ctx context.Context, registry *machined.Registry) func() {
	if p == nil || registry == nil {
		return func() {}
	}
	// The daemon consumer is the last presence source composed and the only
	// writer of daemon snapshots, so it binds the PresenceOn census. Without it
	// sourcesReady stays nil and PresenceOn stays unknown.
	p.sourcesReady = p.sourceCensus(liveRevocation(), registry)
	ctx, cancel := context.WithCancel(ctx)
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		workers := map[*machined.Link]context.CancelFunc{}
		defer func() {
			for _, stop := range workers {
				stop()
			}
		}()
		ticker := time.NewTicker(250 * time.Millisecond)
		defer ticker.Stop()
		for {
			current := map[*machined.Link]bool{}
			for _, branch := range registry.ConnectedBranches() {
				link, err := registry.Current(branch)
				if err != nil || link.RequireReady(branch) != nil {
					continue
				}
				current[link] = true
				if workers[link] != nil {
					continue
				}
				child, stop := context.WithCancel(ctx)
				workers[link] = stop
				wg.Add(1)
				go func() { defer wg.Done(); p.consumeDaemon(child, link, branch) }()
			}
			for link, stop := range workers {
				if !current[link] {
					stop()
					delete(workers, link)
				}
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	return func() { cancel(); wg.Wait() }
}

func (p *branchPresence) consumeDaemon(ctx context.Context, link *machined.Link, branch string) {
	scope, err := link.PresenceScope(branch)
	if err != nil {
		return
	}
	defer p.leaveDaemon(context.WithoutCancel(ctx), branch, "daemon:"+scope+":")
	defer p.daemons.clear(branch, link)
	for {
		frame, err := link.ReceivePresence(ctx, branch)
		if err != nil {
			return
		}
		// Only a fully applied snapshot lets the census count this link; a refused
		// one leaves its sessions unknown until the next complete snapshot.
		if err = p.daemonSnapshot(ctx, link.Connection, branch, frame, p.sessionResolver(link)); err != nil {
			p.daemons.clear(branch, link)
			if !errors.Is(err, context.Canceled) {
				slog.Warn("daemon presence refused", "branch", branch, "error", err)
			}
			continue
		}
		p.daemons.mark(branch, link, p.clock())
	}
}

// A clean close removes only this boot's leases; silent transport loss is still
// governed by the existing 30-second lease. A replacement cannot leave its rows.
func (p *branchPresence) leaveDaemon(ctx context.Context, branch, prefix string) {
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	row, err := p.queries.GetWorkspace(ctx, branch)
	if err != nil {
		return
	}
	_, slug, err := installRepository(ctx, p.queries)
	if err != nil {
		return
	}
	raw, err := p.call(ctx, row, slug, "Branch.Roster", map[string]any{})
	if err != nil {
		return
	}
	var leases []leaseParticipant
	if json.Unmarshal(raw, &leases) != nil {
		return
	}
	for _, lease := range leases {
		if !strings.HasPrefix(lease.SessionID, prefix) {
			continue
		}
		if _, err := p.call(ctx, row, slug, "Branch.Leave", map[string]any{"participantId": lease.ParticipantID, "sessionId": lease.SessionID}); err != nil {
			return
		}
		if member, err := strconv.ParseInt(strings.TrimPrefix(lease.ParticipantID, "member:"), 10, 64); err == nil {
			p.visits.leave(branch, member, lease.SessionID)
		}
	}
}

func (p *branchPresence) agentSessionBinding(ctx context.Context, branch, run, via string) (presenceSessionBinding, error) {
	binding := presenceSessionBinding{Participant: "run:" + run, Name: "Agent", Kind: "agent", AgentKind: "external", Run: run, Via: via}
	raw, state, err := p.queries.PresenceRunCheckpoint(ctx, branch, run)
	if errors.Is(err, pgx.ErrNoRows) {
		return binding, nil
	}
	if err != nil {
		return presenceSessionBinding{}, err
	}
	var checkpoint flowdispatch.RuntimeCheckpoint
	if json.Unmarshal(raw, &checkpoint) != nil || checkpoint.Version != 1 || checkpoint.RunID != run || checkpoint.Target.WorkspaceID != branch || checkpoint.Run == nil || checkpoint.Run.RunID != run {
		return presenceSessionBinding{}, machined.ErrUnauthorized
	}
	if jobs.State(state).Terminal() || checkpoint.Run.Status != "running" {
		return presenceSessionBinding{Skip: true}, nil
	}
	if checkpoint.Target.BindingKind != "agent-session" && checkpoint.Target.BindingKind != "mythical-item" {
		return presenceSessionBinding{}, machined.ErrUnauthorized
	}
	member, err := strconv.ParseInt(strings.TrimPrefix(checkpoint.Target.PrincipalID, "user:"), 10, 64)
	if err != nil || !strings.HasPrefix(checkpoint.Target.PrincipalID, "user:") || member <= 0 {
		return presenceSessionBinding{}, machined.ErrUnauthorized
	}
	binding.Member = member
	binding.AgentKind = "coding"
	if strings.Contains(strings.ToLower(checkpoint.FlowID), "review") {
		binding.AgentKind = "reviewer"
	}
	binding.Name = binding.AgentKind
	if checkpoint.Target.BindingKind == "agent-session" {
		session, err := p.queries.GetAgentSession(ctx, checkpoint.Target.BindingID)
		if errors.Is(err, pgx.ErrNoRows) {
			return presenceSessionBinding{Skip: true}, nil
		}
		if err != nil {
			return presenceSessionBinding{}, err
		}
		if services.UUIDString(session.WorkspaceID) != branch {
			return presenceSessionBinding{}, machined.ErrUnauthorized
		}
		if session.UserID != member || session.Status != "active" || session.DeletedAt.Valid {
			return presenceSessionBinding{Skip: true}, nil
		}
	}
	return binding, nil
}

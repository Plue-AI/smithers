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

	"github.com/smithersai/smithers/packages/backend/internal/machined"
)

func (p *branchPresence) sessionResolver(link *machined.Link) presenceSessionResolver {
	return func(ctx context.Context, branch string, id uint32) (presenceSessionBinding, error) {
		user, run, via, err := link.SessionPresence(branch, id)
		if err != nil {
			return presenceSessionBinding{}, err
		}
		if user.Login == "agent" {
			if run == "" {
				return presenceSessionBinding{}, machined.ErrUnauthorized
			}
			return presenceSessionBinding{Participant: "run:" + run, Name: "Agent", Kind: "agent", AgentKind: "external", Run: run, Via: via}, nil
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
	for {
		frame, err := link.ReceivePresence(ctx, branch)
		if err != nil {
			return
		}
		if err = p.daemonSnapshot(ctx, link.Connection, branch, frame, p.sessionResolver(link)); err != nil && !errors.Is(err, context.Canceled) {
			slog.Warn("daemon presence refused", "branch", branch, "error", err)
		}
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

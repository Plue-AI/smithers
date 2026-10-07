package compose

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
)

// This binding is minted by the host session authorizer when opening a broker
// session. The daemon snapshot supplies only the session number and last path.
// Missing registry/session attribution leaves the operation unavailable.
type presenceSessionBinding struct {
	Member                                                 int64
	Participant, Name, Kind, AgentKind, Run, Via, Terminal string
}
type presenceSessionResolver func(context.Context, string, uint32) (presenceSessionBinding, error)

func (p *branchPresence) daemonSnapshot(ctx context.Context, connection *machined.Connection, branch string, frame wire.Frame, resolve presenceSessionResolver) error {
	if p == nil || p.dispatcher == nil || p.queries == nil || p.branches == nil || connection == nil || resolve == nil {
		return machined.ErrNotReady
	}
	if err := connection.RequireReady(branch); err != nil {
		return err
	}
	locations, err := frame.PresenceSnapshot()
	if err != nil {
		return err
	}
	row, err := p.queries.GetWorkspace(ctx, branch)
	if err != nil {
		return err
	}
	_, slug, err := installRepository(ctx, p.queries)
	if err != nil {
		return err
	}
	// Resolve the entire snapshot before mutating any leases. A foreign or ended
	// session must not partially announce an otherwise valid snapshot.
	bindings := make([]presenceSessionBinding, len(locations))
	for i, location := range locations {
		binding, err := resolve(ctx, branch, location.Session)
		if err != nil {
			return err
		}
		if !validPresenceBinding(binding) {
			return machined.ErrUnauthorized
		}
		if binding.Member > 0 {
			if _, err := p.branches.PresenceBranch(ctx, branch, row.RepositoryID, binding.Member); err != nil {
				return err
			}
		}
		if binding.Kind == "person" {
			binding.Participant = "member:" + strconv.FormatInt(binding.Member, 10)
		}
		if binding.Participant == "" {
			return machined.ErrUnauthorized
		}
		if location.Path != "" && !presencePath(location.Path) {
			return errors.New("invalid presence path")
		}
		bindings[i] = binding
	}
	scope, err := connection.PresenceScope(branch)
	if err != nil {
		return err
	}
	prefix := "daemon:" + scope + ":"
	keep := map[string]bool{}
	for i, location := range locations {
		binding := bindings[i]
		session := prefix + strconv.FormatUint(uint64(location.Session), 10)
		keep[session] = true
		if err := connection.RequireReady(branch); err != nil {
			return err
		}
		where := map[string]any{"kind": "branch"}
		if binding.Terminal != "" {
			where = map[string]any{"kind": "terminal", "id": binding.Terminal}
		}
		if location.Path != "" {
			where = map[string]any{"kind": "file", "path": location.Path}
		}
		fields := map[string]any{"participantId": binding.Participant, "sessionId": session, "displayName": binding.Name, "kind": binding.Kind, "where": where, "cursor": nil}
		if binding.Via != "" {
			fields["via"] = binding.Via
		}
		if binding.Kind == "agent" {
			fields["agentKind"] = binding.AgentKind
			if binding.Member > 0 {
				fields["for_member"] = "member:" + strconv.FormatInt(binding.Member, 10)
			}
			if binding.Run != "" {
				fields["runId"] = binding.Run
			}
		}
		if _, err := p.call(ctx, row, slug, "Branch.Announce", fields); err != nil {
			return err
		}
		if err := connection.RequireReady(branch); err != nil {
			// A replacement boot may race the bridge call. Remove only this boot's
			// session; never leave an old announcement after the newer snapshot.
			_, _ = p.call(ctx, row, slug, "Branch.Leave", map[string]any{"participantId": binding.Participant, "sessionId": session})
			return err
		}
		if binding.Kind == "person" {
			p.visits.heartbeatVia(branch, binding.Member, binding.Name, session, binding.Via)
		}
	}
	raw, err := p.call(ctx, row, slug, "Branch.Roster", map[string]any{})
	if err != nil {
		return err
	}
	var leases []leaseParticipant
	if err := json.Unmarshal(raw, &leases); err != nil {
		return err
	}
	for _, lease := range leases {
		if !strings.HasPrefix(lease.SessionID, "daemon:") || keep[lease.SessionID] {
			continue
		}
		if err := connection.RequireReady(branch); err != nil {
			return err
		}
		if _, err := p.call(ctx, row, slug, "Branch.Leave", map[string]any{"participantId": lease.ParticipantID, "sessionId": lease.SessionID}); err != nil {
			return err
		}
		member, _ := strconv.ParseInt(strings.TrimPrefix(lease.ParticipantID, "member:"), 10, 64)
		if member > 0 {
			p.visits.leave(branch, member, lease.SessionID)
		}
	}
	return nil
}

func presencePath(path string) bool {
	if len(path) > 4096 || strings.HasPrefix(path, "/") || strings.Contains(path, "\\") {
		return false
	}
	for _, part := range strings.Split(path, "/") {
		if part == "" || part == ".." {
			return false
		}
	}
	return true
}

func validPresenceBinding(binding presenceSessionBinding) bool {
	if binding.Member < 0 || binding.Name == "" || len(binding.Name) > 4096 {
		return false
	}
	switch binding.Via {
	case "", "ssh", "terminal", "cli":
	default:
		return false
	}
	if binding.Kind == "person" {
		return binding.Member > 0
	}
	if binding.Kind != "agent" || binding.Participant == "" || strings.HasPrefix(binding.Participant, "member:") {
		return false
	}
	switch binding.AgentKind {
	case "smithers", "coding", "reviewer", "claude-code", "codex", "external":
		return true
	default:
		return false
	}
}

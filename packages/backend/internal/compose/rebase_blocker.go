package compose

import (
	"context"
	"fmt"
	"strconv"

	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// The native refusal supplies a counter; its authenticated connection supplies
// the boot. A counter reused on a replacement boot never labels another person.
func (p *branchPresence) rebaseBlockerReader(registry *machined.Registry) services.RebaseBlockerReader {
	return func(ctx context.Context, branch, boot string, session uint32) (map[string]any, error) {
		if p == nil || p.queries == nil || registry == nil || session == 0 {
			return nil, machined.ErrNotReady
		}
		link, err := registry.Current(branch)
		if err != nil {
			return nil, err
		}
		scope, err := link.PresenceScope(branch)
		if err != nil || scope != boot {
			return nil, machined.ErrNotReady
		}
		binding, err := p.sessionResolver(link)(ctx, branch, session)
		if err != nil || binding.Skip || (binding.Kind != "person" && binding.Kind != "agent") {
			return nil, machined.ErrNotReady
		}
		permission, err := p.queries.InstallationMemberPermission(ctx, binding.Member)
		if err != nil || (permission != "admin" && permission != "write") {
			return nil, machined.ErrUnauthorized
		}
		member, err := p.queries.GetUserByID(ctx, binding.Member)
		if err != nil {
			return nil, err
		}
		color := 0
		if p.members != nil {
			roster, err := p.members.SharedRoster(ctx)
			if err != nil {
				return nil, err
			}
			for _, person := range roster.Members {
				if person.Login == member.Username {
					color = person.ColorIndex
				}
			}
		}
		// Revalidate the link after database reads. Terminal's existing fallback
		// renders the real session as Terminal without inventing a display name.
		current, err := registry.Current(branch)
		if err != nil || current != link || link.RequireReady(branch) != nil {
			return nil, machined.ErrNotReady
		}
		if _, _, _, err := link.SessionPresence(branch, session); err != nil {
			return nil, err
		}
		terminal := binding.Terminal
		if terminal == "" {
			terminal = fmt.Sprintf("daemon:%s:%s", scope, strconv.FormatUint(uint64(session), 10))
		}
		actor := branchPersonActor(member, color)
		if binding.Kind == "agent" {
			actor = branchAgentActor(binding.Participant, leaseParticipant{AgentKind: binding.AgentKind, DisplayName: binding.Name, RunID: binding.Run}, &member, color)
		}
		return map[string]any{"actor": actor, "terminal": terminal}, nil
	}
}

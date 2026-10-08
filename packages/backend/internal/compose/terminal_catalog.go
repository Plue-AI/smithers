package compose

import (
	"context"

	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// These are the named S2 dependencies, not a stage switch or a client hint.
// OpenOwnerTerminal separately checks the persisted private Unix allocation,
// microVM-only member writer and dropped-uid supervisor before issuing tokens.
func terminalCatalogContracts(terminal *routes.WorkspaceTerminalHandler, presence *branchPresence, registry *machined.Registry, confirmations *services.ApprovalsService) func(context.Context, int64, int64, string, string) bool {
	return func(ctx context.Context, member, repository int64, branch, session string) bool {
		if ctx.Err() != nil || terminal == nil || !terminal.OwnerOnly || terminal.OwnerTerminals == nil || presence == nil || presence.terminalManager == nil || presence.terminals == nil || presence.dispatcher == nil || presence.hosts == nil || registry == nil || confirmations == nil || !confirmations.TerminalCatalogAvailable() {
			return false
		}
		if !presence.terminalManager.OwnsSubject(member, repository, branch, session) {
			return false
		}
		return terminal.OwnerTerminals.Ready(ctx, revocation.Principal{UserID: member, RepositoryID: repository, WorkspaceID: branch}) == nil
	}
}

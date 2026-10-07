package compose

import (
	"context"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// installLanguageServers starts the File card's language server as the
// requesting member's daemon exec session (spec §9.1.2). It shares the owner
// terminal's branch.join authority and broker admission, never wakes a
// sleeping branch, and presence ignores its sessions.
type installLanguageServers struct {
	terminals *installOwnerTerminals
}

func newInstallLanguageServers(queries *db.Queries, branches *services.WorkspaceService, registry *machined.Registry) *installLanguageServers {
	return &installLanguageServers{terminals: &installOwnerTerminals{queries: queries, branches: branches, registry: registry}}
}

func (p *installLanguageServers) Available() bool {
	return p != nil && p.terminals.branches.LanguageServerAvailable(p.terminals.registry)
}

func (p *installLanguageServers) Authorize(ctx context.Context, branch string, member int64) (revocation.Principal, error) {
	return p.terminals.Authorize(ctx, branch, member)
}

func (p *installLanguageServers) Ready(ctx context.Context, principal revocation.Principal) error {
	return p.terminals.branches.RequireAwakeBranch(ctx, p.terminals.registry, principal.WorkspaceID)
}

func (p *installLanguageServers) Open(ctx context.Context, principal revocation.Principal, language string) (routes.LSPProcess, error) {
	process, err := p.terminals.branches.OpenOwnerLanguageServer(ctx, p.terminals.registry, principal.WorkspaceID, principal.RepositoryID, principal.UserID, language)
	if err != nil {
		return nil, err
	}
	return process, nil
}

var _ routes.BranchLanguageServers = (*installLanguageServers)(nil)

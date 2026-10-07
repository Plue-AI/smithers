package compose

import (
	"context"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

type installOwnerTerminals struct {
	queries  *db.Queries
	branches *services.WorkspaceService
	registry *machined.Registry
}

func (p *installOwnerTerminals) Authorize(ctx context.Context, branch string, member int64) (revocation.Principal, error) {
	repo, err := services.InstallRepositoryID(ctx, p.queries)
	if err != nil {
		return revocation.Principal{}, err
	}
	row, err := p.branches.AuthorizeTerminalBranch(ctx, branch, repo, member)
	return revocation.Principal{UserID: member, RepositoryID: repo, WorkspaceID: row.ID, SandboxID: row.VmID}, err
}
func (p *installOwnerTerminals) Open(ctx context.Context, id string, principal revocation.Principal) (workspaceapi.Terminal, error) {
	return p.branches.OpenOwnerTerminal(ctx, p.registry, principal.WorkspaceID, id, principal.RepositoryID, principal.UserID)
}

func (p *installOwnerTerminals) Ready(ctx context.Context, principal revocation.Principal) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if p.registry == nil {
		return machined.ErrNotReady
	}
	link, err := p.registry.Current(principal.WorkspaceID)
	if err != nil {
		return err
	}
	return link.RequireReady(principal.WorkspaceID)
}

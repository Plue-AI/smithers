package compose

import (
	"context"
	"sync"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
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
	terminal, err := p.branches.OpenOwnerTerminal(ctx, p.registry, principal.WorkspaceID, id, principal.RepositoryID, principal.UserID)
	if err != nil {
		return nil, err
	}
	return &receiptedOwnerTerminal{Terminal: terminal, closed: func() { p.branches.OwnerTerminalClosed(principal.RepositoryID, principal.UserID, id) }}, nil
}

type receiptedOwnerTerminal struct {
	workspaceapi.Terminal
	once   sync.Once
	closed func()
}

func (t *receiptedOwnerTerminal) Close() error {
	err := t.Terminal.Close()
	t.once.Do(t.closed)
	return err
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

func (p *installOwnerTerminals) Available() bool {
	return p.branches.OwnerTerminalAvailable(p.registry)
}
func (p *installOwnerTerminals) Bind(manager *routes.TerminalSessionManager) {
	p.branches.BindOwnerTerminalOpen(func(ctx context.Context, id, branch string, repository, member int64) error {
		principal, err := p.Authorize(ctx, branch, member)
		if err != nil {
			return err
		}
		if principal.RepositoryID != repository {
			return machined.ErrNotReady
		}
		return manager.OpenOwned(ctx, id, principal, func(ctx context.Context) (workspaceapi.Terminal, error) { return p.Open(ctx, id, principal) })
	})
}

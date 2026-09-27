package services

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type flowHostCallbackQuerier interface {
	GetWorkspace(context.Context, string) (db.Workspace, error)
	HasWritableWorkspaceShares(context.Context, string) (bool, error)
	TouchWorkspaceActivity(context.Context, string) error
}

// FlowHostCallbacks authorizes the box's coding host when it calls the API
// back (repository-job registration, trials, comments, check receipts). The
// host names its binding in SMITHERS_GATEWAY_ID and presents its control
// credential as SMITHERS_API_KEY (#2198).
type FlowHostCallbacks struct {
	pool    *pgxpool.Pool
	queries flowHostCallbackQuerier
}

func NewFlowHostCallbacks(pool *pgxpool.Pool, queries flowHostCallbackQuerier) *FlowHostCallbacks {
	return &FlowHostCallbacks{pool: pool, queries: queries}
}

// AuthorizeRelay answers the live binding's owner, repository and box. The box
// must still be the owner's running, unshared workspace: its host holds a
// repository credential a write-share guest could read.
func (callbacks *FlowHostCallbacks) AuthorizeRelay(ctx context.Context, hostID, token string) (RepoGatewayRelayTarget, error) {
	binding, err := flowhost.VerifyHostCredential(ctx, callbacks.pool, hostID, token)
	if errors.Is(err, flowhost.ErrHostCredentialInvalid) {
		return RepoGatewayRelayTarget{}, pkgerrors.Unauthorized("invalid gateway credentials")
	}
	if err != nil {
		return RepoGatewayRelayTarget{}, pkgerrors.Internal("load flow host binding").WithCause(err)
	}
	workspace, err := callbacks.queries.GetWorkspace(ctx, binding.WorkspaceID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (workspace.DeletedAt.Valid || workspace.UserID != binding.UserID || workspace.RepositoryID != binding.RepositoryID)) {
		return RepoGatewayRelayTarget{}, pkgerrors.Unauthorized("invalid gateway credentials")
	}
	if err != nil {
		return RepoGatewayRelayTarget{}, pkgerrors.Internal("load flow host workspace").WithCause(err)
	}
	if workspace.Status != "running" {
		return RepoGatewayRelayTarget{}, pkgerrors.Conflict("repo gateway is not running")
	}
	shared, err := callbacks.queries.HasWritableWorkspaceShares(ctx, workspace.ID)
	if err != nil {
		return RepoGatewayRelayTarget{}, pkgerrors.Internal("check workspace sharing").WithCause(err)
	}
	if shared {
		return RepoGatewayRelayTarget{}, pkgerrors.Forbidden("coding gateways require a workspace without write shares until shared execution has actor-bound credentials")
	}
	_ = callbacks.queries.TouchWorkspaceActivity(ctx, workspace.ID)
	return RepoGatewayRelayTarget{GatewayID: binding.ID, UserID: binding.UserID, RepositoryID: binding.RepositoryID, WorkspaceID: workspace.ID, SandboxID: workspace.VmID}, nil
}

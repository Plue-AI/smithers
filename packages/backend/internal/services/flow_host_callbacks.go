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
	WorkspaceSoleWriter(context.Context, db.WorkspaceSoleWriterParams) (bool, error)
	TouchWorkspaceActivity(context.Context, string) error
}

// BoxHostTarget is what an authorized callback from a box's coding host acts
// for: the host's flowhost binding, its owner, repository and box.
type BoxHostTarget struct {
	HostID       string
	UserID       int64
	RepositoryID int64
	WorkspaceID  string
	SandboxID    string
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

// AuthorizeHostCallback answers the live binding's owner, repository and box. The box
// must still be the owner's running, unshared workspace: its host holds a
// repository credential a write-share guest could read.
func (callbacks *FlowHostCallbacks) AuthorizeHostCallback(ctx context.Context, hostID, token string) (BoxHostTarget, error) {
	binding, err := flowhost.VerifyHostCredential(ctx, callbacks.pool, hostID, token)
	if errors.Is(err, flowhost.ErrHostCredentialInvalid) {
		return BoxHostTarget{}, pkgerrors.Unauthorized("invalid coding host credentials")
	}
	if err != nil {
		return BoxHostTarget{}, pkgerrors.Internal("load flow host binding").WithCause(err)
	}
	workspace, err := callbacks.queries.GetWorkspace(ctx, binding.WorkspaceID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (workspace.DeletedAt.Valid || workspace.RepositoryID != binding.RepositoryID)) {
		return BoxHostTarget{}, pkgerrors.Unauthorized("invalid coding host credentials")
	}
	if err != nil {
		return BoxHostTarget{}, pkgerrors.Internal("load flow host workspace").WithCause(err)
	}
	// The box is the binding user's alone: their own with no write share, or a
	// branch machine shared with them only (WorkspaceSoleWriter).
	alone, err := callbacks.queries.WorkspaceSoleWriter(ctx, db.WorkspaceSoleWriterParams{WorkspaceID: workspace.ID, UserID: binding.UserID})
	if err != nil {
		return BoxHostTarget{}, pkgerrors.Internal("check workspace sharing").WithCause(err)
	}
	if !alone && workspace.UserID != binding.UserID {
		return BoxHostTarget{}, pkgerrors.Unauthorized("invalid coding host credentials")
	}
	if workspace.Status != "running" {
		return BoxHostTarget{}, pkgerrors.Conflict("the coding host's box is not running")
	}
	if !alone {
		return BoxHostTarget{}, pkgerrors.Forbidden("a coding host calls back only from a box without write shares until shared execution has actor-bound credentials")
	}
	_ = callbacks.queries.TouchWorkspaceActivity(ctx, workspace.ID)
	return BoxHostTarget{HostID: binding.ID, UserID: binding.UserID, RepositoryID: binding.RepositoryID, WorkspaceID: workspace.ID, SandboxID: workspace.VmID}, nil
}

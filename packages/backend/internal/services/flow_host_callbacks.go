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
	pool                *pgxpool.Pool
	queries             flowHostCallbackQuerier
	protectedBranchHost func(context.Context, string) error
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
	if workspace.Status != "running" {
		return BoxHostTarget{}, pkgerrors.Conflict("the coding host's box is not running")
	}
	if !alone {
		if callbacks.protectedBranchHost == nil {
			return BoxHostTarget{}, pkgerrors.Forbidden("coding host is private")
		}
		if err := callbacks.protectedBranchHost(ctx, workspace.ID); err != nil {
			return BoxHostTarget{}, pkgerrors.Unauthorized("invalid coding host credentials")
		}
		var protected bool
		err = callbacks.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM product_job_events e JOIN flow_runtime_host_bindings h ON h.id=$1 JOIN workspaces w ON w.id=h.workspace_id JOIN users machine ON machine.id=w.user_id JOIN collaborators c ON c.repository_id=w.repository_id AND c.user_id=h.user_id JOIN users u ON u.id=c.user_id WHERE e.principal_id='branch:'||w.id::text AND e.event_type='branch.session_opened' AND e.data->>'via'='agent:'||h.id::text AND (e.data->>'uid')::bigint=19999 AND (e.data->>'owner_generation')::bigint=h.owner_generation AND w.kind='vm' AND machine.lower_username='smithers-machines' AND machine.user_type='service' AND machine.prohibit_login AND c.permission IN ('write','admin') AND c.suspended_at IS NULL AND c.unix_uid>=20000 AND u.is_active AND u.deleted_at IS NULL AND NOT u.prohibit_login)`, binding.ID).Scan(&protected)
		if err != nil {
			return BoxHostTarget{}, pkgerrors.Internal("check native coding host").WithCause(err)
		}
		if !protected {
			return BoxHostTarget{}, pkgerrors.Unauthorized("invalid coding host credentials")
		}
	}
	_ = callbacks.queries.TouchWorkspaceActivity(ctx, workspace.ID)
	return BoxHostTarget{HostID: binding.ID, UserID: binding.UserID, RepositoryID: binding.RepositoryID, WorkspaceID: workspace.ID, SandboxID: workspace.VmID}, nil
}

func (c *FlowHostCallbacks) BindProtectedBranchHost(admit func(context.Context, string) error) {
	c.protectedBranchHost = admit
}

package compose

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// browserFlowTarget resolves the repository and workspace afresh on every RPC.
// Browser-supplied names and workspace IDs never become host authority alone.
type browserFlowTarget struct {
	// Install membership is rechecked after durable admission, before a host resolves.
	install *db.Queries
	queries interface {
		GetRepoByOwnerAndLowerName(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
		GetFlowWorkspaceForUserRepo(context.Context, db.GetFlowWorkspaceForUserRepoParams) (db.Workspace, error)
		GetMythicalLane(context.Context, string) (db.MythicalLane, error)
		GetMythicalItem(context.Context, pgtype.UUID) (db.MythicalItem, error)
	}
}

func (resolver browserFlowTarget) ResolveFlowHostTarget(ctx context.Context, target flowruntime.Target) (flowhost.Authority, error) {
	if (target.BindingKind != "browser-flow" && target.BindingKind != flowdispatch.DraftBindingKind) || target.WorkspaceID == "" {
		return flowhost.Authority{}, errors.New("browser Flow target is invalid")
	}
	owner, name, ok := strings.Cut(target.BindingID, "/")
	if !ok || owner == "" || name == "" || strings.Contains(name, "/") {
		return flowhost.Authority{}, errors.New("browser Flow repository is invalid")
	}
	repository, err := resolver.queries.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{Owner: owner, LowerName: name})
	if err != nil || target.TenantID != "repository:"+strconv.FormatInt(repository.ID, 10) {
		return flowhost.Authority{}, errors.New("browser Flow repository is unavailable")
	}
	userID, err := strconv.ParseInt(strings.TrimPrefix(target.PrincipalID, "user:"), 10, 64)
	if err != nil || userID <= 0 || target.PrincipalID != "user:"+strconv.FormatInt(userID, 10) {
		return flowhost.Authority{}, errors.New("browser Flow principal is invalid")
	}
	if resolver.install != nil {
		bound, err := resolver.install.InstallRepositoryID(ctx)
		if err != nil {
			return flowhost.Authority{}, err
		}
		role, err := services.InstallRoleOf(ctx, resolver.install, userID)
		if err != nil {
			return flowhost.Authority{}, err
		}
		if bound != repository.ID || role == "" {
			return flowhost.Authority{}, installFlowTargetRefusal{}
		}
	}
	// The relay's own box lookup: a TODO's lane resolves for the one person
	// it is shared with, as the host's lease checks again (flowhost/store.go).
	workspace, err := resolver.queries.GetFlowWorkspaceForUserRepo(ctx, db.GetFlowWorkspaceForUserRepoParams{
		ID: target.WorkspaceID, RepositoryID: repository.ID, UserID: userID,
	})
	if err != nil || workspace.ID != target.WorkspaceID || workspace.Status != "running" {
		return flowhost.Authority{}, errors.New("browser Flow workspace is unavailable")
	}
	authority := flowhost.Authority{
		Target: target, RepositoryID: repository.ID, UserID: userID, WorkspaceID: workspace.ID,
		// Like every other coding-host caller, name no repository: it is part
		// of the host's service identity, and the box's host is shared.
		CatalogKey: flowhost.CatalogCoding,
	}
	execution, err := services.ResolveTodoWorkspaceExecution(ctx, resolver.queries, repository.ID, workspace.ID)
	if err != nil {
		return flowhost.Authority{}, err
	}
	if target.BindingKind == flowdispatch.DraftBindingKind {
		if execution != nil || !strings.HasPrefix(workspace.TargetBookmark, "scratch/") {
			return flowhost.Authority{}, errors.New("draft Flow workspace is unavailable")
		}
		return authority, nil
	}
	if execution != nil {
		authority.ExecutionPin = &execution.Pin
		authority.SourceRevision = execution.Pin.SourceCommit
	}
	return authority, nil
}

type installFlowTargetRefusal struct{}

func (installFlowTargetRefusal) Error() string              { return "Flow authority is no longer available" }
func (installFlowTargetRefusal) FlowRuntimeCode() string    { return "permission" }
func (installFlowTargetRefusal) FlowRuntimeClass() string   { return "permission" }
func (installFlowTargetRefusal) FlowRuntimeRetryable() bool { return false }

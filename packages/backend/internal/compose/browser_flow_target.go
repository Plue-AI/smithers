package compose

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// browserFlowTarget resolves the repository and workspace afresh on every RPC.
// Browser-supplied names and workspace IDs never become host authority alone.
type browserFlowTarget struct {
	queries interface {
		GetRepoByOwnerAndLowerName(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
		GetWorkspaceForUserRepo(context.Context, db.GetWorkspaceForUserRepoParams) (db.Workspace, error)
	}
}

func (resolver browserFlowTarget) ResolveFlowHostTarget(ctx context.Context, target flowruntime.Target) (flowhost.Authority, error) {
	if target.BindingKind != "browser-flow" || target.WorkspaceID == "" {
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
	workspace, err := resolver.queries.GetWorkspaceForUserRepo(ctx, db.GetWorkspaceForUserRepoParams{
		ID: target.WorkspaceID, RepositoryID: repository.ID, UserID: userID,
	})
	if err != nil || workspace.ID != target.WorkspaceID || workspace.Status != "running" {
		return flowhost.Authority{}, errors.New("browser Flow workspace is unavailable")
	}
	return flowhost.Authority{
		Target: target, RepositoryID: repository.ID, UserID: userID, WorkspaceID: workspace.ID,
		CatalogKey: flowhost.CatalogCoding, Repository: target.BindingID,
	}, nil
}

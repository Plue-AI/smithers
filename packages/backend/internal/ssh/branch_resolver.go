package ssh

import (
	"context"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// InstallBranchResolver resolves only the installed repository's roster and
// canonical branch machines. Resolution never wakes a machine or mints a grant.
// The gateway repeats it for every channel, including direct-tcpip.
type InstallBranchResolver struct{ Database *pgxpool.Pool }

func (r *InstallBranchResolver) ResolveBranch(ctx context.Context, member int64, login string) (WorkspaceAccess, error) {
	if r == nil || r.Database == nil {
		return WorkspaceAccess{}, ErrWorkspaceUnavailable
	}
	if !validBranchLogin(login) || login == "main" {
		return WorkspaceAccess{}, ErrWorkspaceAccessDenied
	}
	q := db.New(r.Database)
	if err := identity.NewMemberBoundary(q).AuthorizeMember(identity.WithMemberRoute(ctx), member); err != nil {
		return WorkspaceAccess{}, ErrWorkspaceAccessDenied
	}
	repo, err := services.InstallRepositoryID(ctx, q)
	if err != nil {
		return WorkspaceAccess{}, ErrWorkspaceUnavailable
	}
	owner, err := q.GetBranchMachineOwner(ctx)
	if err != nil {
		return WorkspaceAccess{}, ErrWorkspaceUnavailable
	}
	// Detached reservations and suspended identities must never authorize SSH,
	// even when a stale workspace share survives. No guest account is client-selected.
	var user string
	var uid uint32
	err = r.Database.QueryRow(ctx, `SELECT c.unix_login,c.unix_uid FROM collaborators c
 JOIN users u ON u.id=c.user_id WHERE c.repository_id=$1 AND c.user_id=$2
 AND c.suspended_at IS NULL AND c.permission IN ('write','admin')
 AND u.is_active AND u.deleted_at IS NULL AND NOT u.prohibit_login`, repo, member).Scan(&user, &uid)
	if err != nil || !validMemberLogin(user) || uid < 20000 {
		return WorkspaceAccess{}, ErrWorkspaceAccessDenied
	}
	rows, err := r.Database.Query(ctx, `SELECT w.id,w.target_bookmark FROM workspaces w
 JOIN workspace_shares s ON s.workspace_id=w.id AND s.grantee_user_id=$2 AND s.level='write'
 WHERE w.repository_id=$1 AND w.user_id=$3 AND w.deleted_at IS NULL AND w.target_bookmark<>'main'
 AND (w.target_bookmark LIKE 'scratch/%' OR EXISTS
 (SELECT 1 FROM mythical_lanes l WHERE l.workspace_id=w.id::text AND l.repository_id=$1 AND l.retired_at IS NULL))`, repo, member, owner)
	if err != nil {
		return WorkspaceAccess{}, ErrWorkspaceUnavailable
	}
	defer rows.Close()
	names := []string{}
	ids := map[string]string{}
	for rows.Next() {
		var id, name string
		if err := rows.Scan(&id, &name); err != nil {
			return WorkspaceAccess{}, ErrWorkspaceUnavailable
		}
		// Multiple machines for a bookmark are not an arbitrary choice of identity.
		if prior, ok := ids[name]; ok && prior != id {
			return WorkspaceAccess{}, ErrWorkspaceUnavailable
		}
		ids[name] = id
		names = append(names, name)
	}
	if rows.Err() != nil {
		return WorkspaceAccess{}, ErrWorkspaceUnavailable
	}
	name, err := ResolveBranchName(login, names)
	if err != nil {
		return WorkspaceAccess{}, err
	}
	return WorkspaceAccess{SandboxID: ids[name], User: user, MemberID: member, UID: uid}, nil
}

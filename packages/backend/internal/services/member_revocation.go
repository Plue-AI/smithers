package services

import (
	"context"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

// memberMutation serializes roster changes and session minting (ClaimOwner
// takes the same row FOR SHARE) on the owner row, then decides the actor's
// standing again under that lock: a maintainer removed a moment ago changes
// nothing.
func (m *Members) memberMutation(ctx context.Context) (pgx.Tx, int64, error) {
	tx, err := m.Pool.Begin(ctx)
	if err != nil {
		return nil, 0, err
	}
	var owner int64
	err = tx.QueryRow(ctx, `SELECT user_id FROM self_host_owners FOR UPDATE`).Scan(&owner)
	if err == nil {
		var role InstallRole
		info := middleware.AuthInfoFromContext(ctx)
		if info != nil && info.User != nil {
			role, err = InstallRoleOf(ctx, db.New(tx), info.User.ID)
		}
		if err == nil && role.rank() < InstallMaintainer.rank() {
			err = memberError(http.StatusForbidden, "permission", "permission", "Only a maintainer can do this")
		}
	}
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, 0, err
	}
	return tx, owner, nil
}

// revokeMemberCredentials ends every credential user holds in tx: sessions,
// tokens, OAuth grants and workspace sessions are deleted, sign-in is barred,
// and one durable revocation event is written with the commit; live sockets
// and terminals close on its fanout (bus catch-up within 1 s).
func revokeMemberCredentials(ctx context.Context, tx pgx.Tx, repo, user, actor int64) error {
	for _, statement := range []string{
		`UPDATE users SET prohibit_login=true WHERE id=$1`,
		`DELETE FROM auth_sessions WHERE user_id=$1`,
		`DELETE FROM access_tokens WHERE user_id=$1`,
		`DELETE FROM oauth2_authorization_codes WHERE user_id=$1`,
		`DELETE FROM oauth2_refresh_tokens WHERE user_id=$1`,
		`DELETE FROM oauth2_access_tokens WHERE user_id=$1`,
		`DELETE FROM workspace_sessions WHERE user_id=$1`,
		`DELETE FROM workspace_shares WHERE grantee_user_id=$1 OR owner_user_id=$1`,
	} {
		if _, err := tx.Exec(ctx, statement, user); err != nil {
			return err
		}
	}
	q := db.New(tx)
	return revocation.NewTransactionalDBPublisher(q).Publish(ctx, revocation.Event{Kind: revocation.KindCollaboratorRemoved, UserID: user, RepositoryID: repo, ActorID: actor, SandboxIDs: workspaceVMIDs(ctx, q, repo, user), Reason: "member access revoked"})
}

// Remove takes login off the roster and revokes everything they hold in the
// same transaction. Removing someone not on the roster changes nothing.
func (m *Members) Remove(ctx context.Context, login string) error {
	decision, err := Authorize(ctx, db.New(m.Pool), "members.write")
	if err != nil {
		return err
	}
	if !ValidMemberLogin(login) {
		return memberError(http.StatusBadRequest, "user", "invalid_login", "Enter a GitHub username")
	}
	repo, err := m.repository(ctx)
	if err != nil {
		return err
	}
	tx, owner, err := m.memberMutation(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	id, userID, err := lockMemberRow(ctx, tx, repo.ID, login)
	if err != nil {
		if typed, ok := err.(*AccessError); ok && typed.Code == "not_found" {
			return nil
		}
		return err
	}
	if userID != nil && *userID == owner {
		return memberError(http.StatusForbidden, "permission", "owner_immutable", "Owner cannot be removed")
	}
	if userID != nil {
		if err = revokeMemberCredentials(ctx, tx, repo.ID, *userID, decision.UserID); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(ctx, `DELETE FROM collaborators WHERE id=$1`, id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

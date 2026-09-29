package services

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// The credential is minted by the public workspace service against a real
// product database. Pair membership and share changes use the pair service.
func TestDesktopSessionFollowsCreatorShareInProductDatabase(t *testing.T) {
	for _, change := range []string{"downgrade", "remove"} {
		t.Run(change, func(t *testing.T) {
			ctx := context.Background()
			fx := newPairFixture(t)
			owner := mkPairUser(t, fx.pool, "desktop-owner")
			editor := mkPairUser(t, fx.pool, "desktop-editor")
			source := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
			pairs := newPairService(fx, map[int64]bool{owner: true, editor: true}, false, nil)
			session, err := pairs.CreateSession(ctx, owner, fx.repoID, source)
			require.NoError(t, err)
			workspaceID := UUIDString(session.WorkspaceID)
			_, err = fx.pool.Exec(ctx, `UPDATE workspaces SET kind='desktop', status='running', vm_id='vm-desktop-share' WHERE id=$1::uuid`, workspaceID)
			require.NoError(t, err)
			link, err := pairs.MintLink(ctx, session.ID, owner, PairRoleEditor)
			require.NoError(t, err)
			_, err = pairs.ResolveByLink(ctx, link.Slug, editor)
			require.NoError(t, err)
			pairs.revocations = revocation.NewDBPublisher(db.New(fx.pool), nil)

			provider := &desktopSandbox{}
			provider.writeFileFn = func(context.Context, string, string, sandbox.WriteFileRequest) error { return nil }
			provider.execAwaitFn = func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
				code := int32(0)
				return sandbox.ExecResult{StatusCode: &code}, nil
			}
			workspaces := NewWorkspaceService(db.New(fx.pool), WithWorkspaceSandboxClient(provider))

			ownerSession, err := workspaces.CreateDesktopSession(ctx, workspaceID, fx.repoID, owner)
			require.NoError(t, err)
			ownerTarget, err := workspaces.AuthorizeDesktopRelay(ctx, workspaceID, ownerSession.Token)
			require.NoError(t, err)
			require.Equal(t, owner, ownerTarget.UserID, "owner credential belongs to owner")
			require.Equal(t, owner, ownerTarget.OwnerUserID)

			memberSession, err := workspaces.CreateDesktopSession(ctx, workspaceID, fx.repoID, editor)
			require.NoError(t, err)
			memberTarget, err := workspaces.AuthorizeDesktopRelay(ctx, workspaceID, memberSession.Token)
			require.NoError(t, err)
			assert.Equal(t, editor, memberTarget.UserID, "member credential must watch member revocation")
			require.Equal(t, owner, memberTarget.OwnerUserID)

			if change == "downgrade" {
				_, err = pairs.SetMemberRole(ctx, session.ID, owner, editor, PairRoleViewer)
			} else {
				err = pairs.RevokeMember(ctx, session.ID, owner, editor)
			}
			require.NoError(t, err)
			var events int
			require.NoError(t, fx.pool.QueryRow(ctx,
				`SELECT count(*) FROM revocation_events WHERE kind='workspace_share_removed' AND user_id=$1 AND workspace_id=$2`,
				editor, workspaceID).Scan(&events))
			require.Equal(t, 1, events, "membership change must persist exactly one revocation event")
			var sandboxIDs []string
			require.NoError(t, fx.pool.QueryRow(ctx,
				`SELECT sandbox_ids FROM revocation_events WHERE kind='workspace_share_removed' AND user_id=$1 AND workspace_id=$2`,
				editor, workspaceID).Scan(&sandboxIDs))
			require.Equal(t, []string{"vm-desktop-share"}, sandboxIDs, "downgrade and removal must revoke sandbox-scoped streams")
			_, err = workspaces.AuthorizeDesktopRelay(ctx, workspaceID, memberSession.Token)
			assert.Equal(t, 403, httpStatus(err), "existing member credential must lose desktop access")
			_, err = workspaces.CreateDesktopSession(ctx, workspaceID, fx.repoID, editor)
			require.Equal(t, 403, httpStatus(err), "fresh member request must lose desktop access")
		})
	}
}

func TestDesktopSessionCreatorDeletionInvalidatesCredential(t *testing.T) {
	ctx := context.Background()
	fx := newPairFixture(t)
	owner := mkPairUser(t, fx.pool, "desktop-erasure-owner")
	member := mkPairUser(t, fx.pool, "desktop-erasure-member")
	workspaceID := uuid.NewString()
	token, hash := generateDesktopSessionToken(member)
	_, err := fx.pool.Exec(ctx, `INSERT INTO workspaces(id, repository_id, user_id, kind, status, vm_id,
		desktop_session_token_hash, desktop_session_expires_at)
		VALUES($1::uuid,$2,$3,'desktop','running','vm-desktop-erasure',$4,$5)`,
		workspaceID, fx.repoID, owner, hash, time.Now().Add(time.Hour))
	require.NoError(t, err)
	_, err = fx.store.UpsertWorkspaceShare(ctx, db.UpsertWorkspaceShareParams{
		WorkspaceID: workspaceID, OwnerUserID: owner, GranteeUserID: member, Level: "write",
	})
	require.NoError(t, err)
	workspaces := NewWorkspaceService(db.New(fx.pool))
	target, err := workspaces.AuthorizeDesktopRelay(ctx, workspaceID, token)
	require.NoError(t, err)
	require.Equal(t, member, target.UserID)
	_, err = fx.pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, member)
	require.NoError(t, err)
	_, err = workspaces.AuthorizeDesktopRelay(ctx, workspaceID, token)
	require.Equal(t, 403, httpStatus(err), "credential with erased creator must fail closed")
}

package services

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/stretchr/testify/require"
)

func TestMembersRemoveDeletedWorkspaceSharesPostgres(t *testing.T) {
	testMemberDeletedWorkspaceShares(t, false)
}

func TestMemberPermissionRecheckDeletedWorkspaceSharesPostgres(t *testing.T) {
	testMemberDeletedWorkspaceShares(t, true)
}

func testMemberDeletedWorkspaceShares(t *testing.T, recheck bool) {
	t.Helper()
	f := newPermissionPollFixture(t, func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"user":{"id":77},"permission":"read"}`)
	}, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/user/99":
			fmt.Fprint(w, `{"id":99,"login":"later"}`)
		case "/repos/factory/app/collaborators/later/permission":
			fmt.Fprint(w, `{"user":{"id":99},"permission":"read"}`)
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
			w.WriteHeader(500)
		}
	})
	ctx, q := t.Context(), db.New(f.m.Pool)
	var ownerID int64
	require.NoError(t, f.m.Pool.QueryRow(ctx, `SELECT user_id FROM self_host_owners`).Scan(&ownerID))
	owner, err := q.GetUserByID(ctx, ownerID)
	require.NoError(t, err)
	var repoID int64
	require.NoError(t, f.m.Pool.QueryRow(ctx, `SELECT repository_id FROM collaborators WHERE id=$1`, f.memberID).Scan(&repoID))
	// Retain a VM ID on the tombstone to verify it is omitted from revocation.
	deleted, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repoID, UserID: ownerID, Name: "deleted", Kind: "container", Status: "running", TargetBookmark: "main"})
	require.NoError(t, err)
	_, err = f.m.Pool.Exec(ctx, `UPDATE workspaces SET vm_id='deleted-vm' WHERE id=$1`, deleted.ID)
	require.NoError(t, err)
	_, err = q.SoftDeleteWorkspace(ctx, deleted.ID)
	require.NoError(t, err)
	live, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repoID, UserID: ownerID, Name: "live", Kind: "container", Status: "running", TargetBookmark: "main"})
	require.NoError(t, err)
	_, err = f.m.Pool.Exec(ctx, `UPDATE workspaces SET vm_id='live-vm' WHERE id=$1`, live.ID)
	require.NoError(t, err)
	for _, workspace := range []string{deleted.ID, live.ID} {
		_, err = q.UpsertWorkspaceShare(ctx, db.UpsertWorkspaceShareParams{WorkspaceID: workspace, OwnerUserID: ownerID, GranteeUserID: f.userID, Level: "write"})
		require.NoError(t, err)
	}
	later, err := q.CreateUser(ctx, db.CreateUserParams{Username: "later", LowerUsername: "later"})
	require.NoError(t, err)
	_, err = f.m.Pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,github_id,github_login,permission) VALUES($1,$2,99,'later','write')`, repoID, later.ID)
	require.NoError(t, err)
	if recheck {
		require.NoError(t, f.m.Recheck(ctx))
		f.assertRoster(t, true, 0)
		var suspended bool
		require.NoError(t, f.m.Pool.QueryRow(ctx, `SELECT suspended_at IS NOT NULL FROM collaborators WHERE user_id=$1`, later.ID).Scan(&suspended))
		require.True(t, suspended, "the later member must also be processed")
	} else {
		// Roster effects fence on the owner's live, verified session (6c9a598847).
		asOwner := registerTestInstallCredential(t, f.m.Pool, middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &owner, SessionHash: "owner-session"}), repoID)
		require.NoError(t, f.m.Remove(asOwner, "writer"))
		require.Zero(t, fetchedCount(t, f.m.Pool, `SELECT count(*) FROM collaborators WHERE github_id=77`))
	}
	var count int
	require.NoError(t, f.m.Pool.QueryRow(ctx, `SELECT count(*) FROM workspace_shares WHERE grantee_user_id=$1 OR owner_user_id=$1`, f.userID).Scan(&count))
	require.Zero(t, count)
	for _, workspace := range []string{deleted.ID, live.ID} {
		var sandboxIDs []string
		require.NoError(t, f.m.Pool.QueryRow(ctx, `SELECT sandbox_ids FROM revocation_events WHERE kind='workspace_share_removed' AND workspace_id=$1 AND user_id=$2`, workspace, f.userID).Scan(&sandboxIDs))
		if workspace == deleted.ID {
			require.Empty(t, sandboxIDs, "a deleted workspace revocation must omit its VM")
		} else {
			require.Equal(t, []string{"live-vm"}, sandboxIDs)
		}
	}
	require.NoError(t, f.m.Pool.QueryRow(ctx, `SELECT count(*) FROM revocation_events WHERE kind='collaborator_removed' AND user_id=$1`, f.userID).Scan(&count))
	require.Equal(t, 1, count)
}

package compose

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// A member's machine start holds one transaction for the whole start
// (services.commitWorkspaceMutation) and reads the roster on it. The start
// then records the machine's vm_id and status through the pool, because the
// daemon's registry resolves that binding from another connection. The
// roster's lock on the workspace row must therefore admit that write: a real
// install's first machine start waited 15 minutes on its own transaction
// (2026-10-08) while the roster share-locked the row.
func TestProvisioningRosterAdmitsTheStartsOwnStatusWrite(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	user, err := q.CreateUser(ctx, db.CreateUserParams{Username: "roster-owner", LowerUsername: "roster-owner", DisplayName: "Alice"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, user.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: user.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	row, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: user.ID, Name: "roster", TargetBookmark: "mythical", Kind: "vm", Status: "starting"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,unix_login,unix_uid) VALUES($1,$2,'admin','alice',20001)`, repo.ID, user.ID)
	require.NoError(t, err)

	// The held mutation transaction, passed down as the admission transaction.
	held, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = held.Rollback(context.WithoutCancel(ctx)) }()
	roster := machineRoster{pool: pool}
	require.NoError(t, roster.withProvisioningRoster(machined.WithSessionAdmissionTransaction(ctx, row.ID, held), row.ID, func(_ context.Context, members []microsandbox.MemberIdentity) error {
		require.Equal(t, []microsandbox.MemberIdentity{{Login: "alice", UID: 20001, Active: true}}, members)
		return nil
	}))

	// The start's own write, on another connection, while the roster is held.
	write, stop := context.WithTimeout(ctx, 2*time.Second)
	updated, err := q.UpdateWorkspaceExecutionInfo(write, db.UpdateWorkspaceExecutionInfoParams{ID: row.ID, VmID: "machine", Status: "starting"})
	stop()
	require.NoError(t, err, "the machine start's status write waited on its own roster lock")
	require.Equal(t, "machine", updated.VmID)
	running, stop := context.WithTimeout(ctx, 2*time.Second)
	updated, err = q.UpdateWorkspaceExecutionInfo(running, db.UpdateWorkspaceExecutionInfoParams{ID: row.ID, VmID: "machine", Status: "running"})
	stop()
	require.NoError(t, err)
	require.Equal(t, "running", updated.Status)

	// The roster is still frozen: membership, the linked user and the
	// workspace's identity cannot change until the start commits.
	waits := func(name, sql string, args ...any) {
		t.Helper()
		wait, stop := context.WithTimeout(ctx, 500*time.Millisecond)
		defer stop()
		_, err := pool.Exec(wait, sql, args...)
		require.Error(t, err, name)
		require.ErrorIs(t, wait.Err(), context.DeadlineExceeded, "%s: %v", name, err)
	}
	waits("suspending the member", `UPDATE collaborators SET suspended_at=now() WHERE repository_id=$1 AND user_id=$2`, repo.ID, user.ID)
	waits("demoting the member", `UPDATE collaborators SET permission='read' WHERE repository_id=$1 AND user_id=$2`, repo.ID, user.ID)
	waits("removing the member", `DELETE FROM collaborators WHERE repository_id=$1 AND user_id=$2`, repo.ID, user.ID)
	waits("refusing the member's login", `UPDATE users SET prohibit_login=true WHERE id=$1`, user.ID)
	waits("deleting the workspace", `DELETE FROM workspaces WHERE id=$1`, row.ID)
	waits("changing the workspace's identity", `UPDATE workspaces SET id=gen_random_uuid() WHERE id=$1`, row.ID)

	require.NoError(t, held.Commit(ctx))
	_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=now() WHERE repository_id=$1 AND user_id=$2`, repo.ID, user.ID)
	require.NoError(t, err)
	require.NoError(t, roster.withProvisioningRoster(ctx, row.ID, func(_ context.Context, members []microsandbox.MemberIdentity) error {
		require.Empty(t, members)
		return nil
	}))
}

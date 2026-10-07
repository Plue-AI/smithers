package compose

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/stretchr/testify/require"
)

func TestMemberActorAdmissionCommitsBeforeLaunchAndRechecksAuthority(t *testing.T) {
	f := presenceInstall(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	_, err := f.pool.Exec(ctx, `UPDATE workspaces SET vm_id='machine' WHERE id=$1`, f.row.ID)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,unix_login,unix_uid)
 VALUES($1,$2,'admin','maya',20001) ON CONFLICT(repository_id,user_id) WHERE user_id IS NOT NULL DO UPDATE SET unix_login='maya',unix_uid=20001`, f.row.RepositoryID, f.user.ID)
	require.NoError(t, err)
	cfg := f.pool.Config()
	cfg.MaxConns = 1
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	require.NoError(t, err)
	defer pool.Close()
	roster := machineRoster{pool: pool}
	member := microsandbox.MemberIdentity{Login: "maya", UID: 20001, Active: true}
	reference, err := roster.commitMemberActor(ctx, f.row.ID, "machine", member)
	require.NoError(t, err)
	require.Len(t, reference, 16)
	// This second transaction can see the reference before the caller has made
	// any launch. It also proves admission released the one available connection.
	read := func() {
		tx, err := pool.Begin(ctx)
		require.NoError(t, err)
		actor, err := machined.ResolveActorInTx(ctx, tx, f.row.ID, "machine", reference)
		require.NoError(t, err)
		require.Equal(t, machined.ActorIdentity{Kind: "person", MemberID: f.user.ID, Via: "terminal"}, actor)
		require.NoError(t, tx.Rollback(ctx))
	}
	read()
	require.NoError(t, roster.withProvisioningRoster(ctx, f.row.ID, func(members []microsandbox.MemberIdentity) error {
		require.Contains(t, members, member)
		return nil
	}))
	for _, bad := range []microsandbox.MemberIdentity{
		{Login: "maya", UID: 20002, Active: true}, {Login: "other", UID: 20001, Active: true}, {Login: "maya", UID: 20001, Active: false},
	} {
		ref, err := roster.commitMemberActor(ctx, f.row.ID, "machine", bad)
		require.Error(t, err)
		require.Empty(t, ref)
	}
	ref, err := roster.commitMemberActor(ctx, f.row.ID, "replacement-machine", member)
	require.Error(t, err)
	require.Empty(t, ref)
	_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=now() WHERE repository_id=$1 AND user_id=$2`, f.row.RepositoryID, f.user.ID)
	require.NoError(t, err)
	ref, err = roster.commitMemberActor(ctx, f.row.ID, "machine", member)
	require.Error(t, err)
	require.Empty(t, ref)
	require.NoError(t, roster.withProvisioningRoster(ctx, f.row.ID, func(members []microsandbox.MemberIdentity) error {
		require.NotContains(t, members, member)
		return nil
	}))
	read() // revocation fences launches without rewriting earlier identity
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM machine_actor_references WHERE workspace_id=$1`, f.row.ID).Scan(&count))
	require.Equal(t, 1, count)
}

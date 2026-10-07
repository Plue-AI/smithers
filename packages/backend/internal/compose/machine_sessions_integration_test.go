package compose

import (
	"context"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/repository"
	"github.com/stretchr/testify/require"
	"testing"
	"time"
)

func TestInstallSessionBindingsSurviveLinkReplacement(t *testing.T) {
	f := presenceInstall(t)
	_, err := f.pool.Exec(t.Context(), `INSERT INTO collaborators(repository_id,user_id,permission,unix_login,unix_uid) VALUES($1,$2,'write','alice',20001)`, f.row.RepositoryID, f.user.ID)
	require.NoError(t, err)
	host := newMachineHost(f.pool, repository.NewRemoteClient(nil, "test"))
	boot := [16]byte{1}
	user := machined.SessionUser{Login: "alice", UID: 20001}
	_, err = host.Lookup(t.Context(), f.row.ID, boot, 2)
	require.ErrorIs(t, err, machined.ErrNotReady)
	require.NoError(t, host.Record(t.Context(), f.row.ID, boot, 2, user, "terminal"))
	// Reconstruct the composed host: the old network stream is absent.
	restored := newMachineHost(f.pool, repository.NewRemoteClient(nil, "test"))
	got, err := restored.Lookup(t.Context(), f.row.ID, boot, 2)
	require.NoError(t, err)
	require.Equal(t, user, got)
	_, err = restored.Lookup(t.Context(), f.row.ID, [16]byte{2}, 2)
	require.ErrorIs(t, err, machined.ErrNotReady)
	_, err = restored.Lookup(t.Context(), "11111111-1111-4111-8111-111111111111", boot, 2)
	require.ErrorIs(t, err, machined.ErrNotReady)
	_, err = restored.Lookup(t.Context(), f.row.ID, boot, 4)
	require.ErrorIs(t, err, machined.ErrNotReady)
	require.NoError(t, host.Record(t.Context(), f.row.ID, boot, 2, user, "terminal"))
	require.ErrorIs(t, host.Record(t.Context(), f.row.ID, boot, 2, machined.SessionUser{Login: "mallory", UID: 20002}, "terminal"), machined.ErrUnauthorized)
	require.ErrorIs(t, host.Record(t.Context(), f.row.ID, boot, 2, user, "ssh"), machined.ErrUnauthorized)
	actor, err := restored.Attribution(t.Context(), f.row.ID, boot, 2)
	require.NoError(t, err)
	require.Contains(t, string(actor), "member:")
	_, err = f.pool.Exec(t.Context(), `UPDATE collaborators SET suspended_at=now() WHERE repository_id=$1 AND user_id=$2`, f.row.RepositoryID, f.user.ID)
	require.NoError(t, err)
	replay, err := restored.Attribution(t.Context(), f.row.ID, boot, 2)
	require.NoError(t, err)
	require.Equal(t, string(actor), string(replay))
	require.ErrorIs(t, host.Record(t.Context(), f.row.ID, boot, 5, user, "terminal"), machined.ErrUnauthorized)
	var count int
	require.NoError(t, f.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE principal_id=$1 AND event_type='branch.session_opened'`, "branch:"+f.row.ID).Scan(&count))
	require.Equal(t, 1, count)
}

// This tests SQL authority ordering with a sentinel spawn; it does not launch
// a guest or qualify identity/cgroup isolation.
func TestNativeAgentAdmissionHoldsOwnerThroughSpawnSupplemental(t *testing.T) {
	f := presenceInstall(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	q := db.New(f.pool)
	machine, err := q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `UPDATE workspaces SET kind='vm',status='running',user_id=$2 WHERE id=$1`, f.row.ID, machine)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,unix_login,unix_uid) VALUES($1,$2,'write','alice',20001)`, f.row.RepositoryID, f.user.ID)
	require.NoError(t, err)
	var binding string
	require.NoError(t, f.pool.QueryRow(ctx, `UPDATE flow_runtime_host_bindings SET state='starting',user_id=$2 WHERE workspace_id=$1 AND catalog_key='coding' RETURNING id`, f.row.ID, f.user.ID).Scan(&binding))
	host := newMachineHost(f.pool, repository.NewRemoteClient(nil, "test"))
	boot := [16]byte{9}
	revoked := make(chan error, 1)
	require.NoError(t, host.admitAgent(ctx, f.row.ID, binding, func(spawnCtx context.Context) error {
		go func() {
			_, err := f.pool.Exec(ctx, `UPDATE collaborators SET suspended_at=now() WHERE repository_id=$1 AND user_id=$2`, f.row.RepositoryID, f.user.ID)
			revoked <- err
		}()
		select {
		case err := <-revoked:
			t.Fatalf("revocation crossed active spawn authorization: %v", err)
		case <-time.After(100 * time.Millisecond):
		}
		return host.Record(spawnCtx, f.row.ID, boot, 42, machined.SessionUser{Login: "agent", UID: 19999}, "agent:"+binding)
	}))
	select {
	case err := <-revoked:
		require.NoError(t, err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	calls := 0
	require.ErrorIs(t, host.admitAgent(ctx, f.row.ID, binding, func(spawnCtx context.Context) error { calls++; return nil }), machined.ErrUnauthorized)
	require.Zero(t, calls)
	actor, err := host.agentActor(ctx, f.row.ID, boot, binding)
	require.NoError(t, err)
	require.Contains(t, string(actor), `"kind": "agent"`)
	require.ErrorIs(t, host.Record(ctx, f.row.ID, boot, 43, machined.SessionUser{Login: "agent", UID: 19999}, "terminal"), machined.ErrUnauthorized)
}

func TestMemberAdmissionReceiptSharesRevocationFenceSupplemental(t *testing.T) {
	f := presenceInstall(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	_, err := f.pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,unix_login,unix_uid) VALUES($1,$2,'write','alice',20001)`, f.row.RepositoryID, f.user.ID)
	require.NoError(t, err)
	roster := machineRoster{pool: f.pool}
	host := newMachineHost(f.pool, repository.NewRemoteClient(nil, "test"))
	boot := [16]byte{7}
	revoked := make(chan error, 1)
	require.NoError(t, roster.withProvisioningRoster(ctx, f.row.ID, func(admissionCtx context.Context, members []microsandbox.MemberIdentity) error {
		require.Len(t, members, 1)
		go func() {
			_, err := f.pool.Exec(ctx, `UPDATE collaborators SET suspended_at=now() WHERE repository_id=$1 AND user_id=$2`, f.row.RepositoryID, f.user.ID)
			revoked <- err
		}()
		select {
		case err := <-revoked:
			t.Fatalf("revocation crossed admission: %v", err)
		case <-time.After(100 * time.Millisecond):
		}
		return host.Record(admissionCtx, f.row.ID, boot, 17, machined.SessionUser{Login: "alice", UID: 20001}, "ssh")
	}))
	select {
	case err := <-revoked:
		require.NoError(t, err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	actor, err := host.Attribution(ctx, f.row.ID, boot, 17)
	require.NoError(t, err)
	require.Contains(t, string(actor), "member:")
	require.NoError(t, roster.withProvisioningRoster(ctx, f.row.ID, func(_ context.Context, members []microsandbox.MemberIdentity) error {
		require.Empty(t, members)
		return nil
	}))
}

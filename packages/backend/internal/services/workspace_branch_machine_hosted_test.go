package services

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// A hosted branch's members are its repository's writers (#3751): the owner
// and write or admin collaborators, while they may sign in.
func TestHostedBranchMachineMembership(t *testing.T) {
	pool := newProductTestPool(t)
	owner, repo := setupTestUserAndRepo(t, pool)
	ctx := context.Background()
	var other int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES('hosted-other','hosted-other') RETURNING id`).Scan(&other))
	providers := HostedBranchMachineProviders(nil)
	check := func(actor int64, command string) (membership, authorize error) {
		tx, err := pool.Begin(ctx)
		require.NoError(t, err)
		defer func() { _ = tx.Rollback(ctx) }()
		return providers.Membership(ctx, tx, repo, actor), providers.Authorize(ctx, tx, command, repo, "main", actor)
	}
	requireAdmitted := func(actor int64, why string) {
		t.Helper()
		for _, command := range []string{"branch.join", "branches.read", "branch.read"} {
			membership, authorize := check(actor, command)
			require.NoError(t, membership, why)
			require.NoError(t, authorize, why+": "+command)
		}
	}
	requireRefused := func(actor int64) {
		t.Helper()
		membership, authorize := check(actor, "branch.join")
		requireBranchStatus(t, membership, 403)
		requireBranchStatus(t, authorize, 403)
	}

	requireAdmitted(owner, "the repository owner joins")
	requireRefused(other) // a stranger
	requireRefused(0)     // no account

	_, err := pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'read')`, repo, other)
	require.NoError(t, err)
	requireRefused(other) // a reader
	_, err = pool.Exec(ctx, `UPDATE collaborators SET permission='write' WHERE user_id=$1`, other)
	require.NoError(t, err)
	requireAdmitted(other, "a write collaborator joins")
	_, err = pool.Exec(ctx, `UPDATE collaborators SET permission='admin' WHERE user_id=$1`, other)
	require.NoError(t, err)
	requireAdmitted(other, "an admin collaborator joins")

	for _, change := range []string{`is_active=false`, `prohibit_login=true`, `deleted_at=NOW()`} {
		t.Run(change, func(t *testing.T) {
			tx, err := pool.Begin(ctx)
			require.NoError(t, err)
			defer func() { _ = tx.Rollback(ctx) }()
			_, err = tx.Exec(ctx, `UPDATE users SET `+change+` WHERE id=$1`, other)
			require.NoError(t, err)
			requireBranchStatus(t, providers.Membership(ctx, tx, repo, other), 403)
		})
	}

	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = tx.Rollback(ctx) }()
	requireBranchStatus(t, providers.Membership(ctx, tx, repo+1_000_000, owner), 403)
	for _, command := range []string{"", "branch.fork", "branch.delete", "Branch.Join"} {
		requireBranchStatus(t, providers.Authorize(ctx, tx, command, repo, "main", owner), 403)
	}
}

// Hosted providers share the install's runtime gates: a microVM whose guests
// run repository code as one non-root account.
func TestHostedBranchMachineRuntimeGates(t *testing.T) {
	ctx := context.Background()
	microVM := installRuntime{level: workspaceapi.IsolationSandboxed}
	require.NoError(t, HostedBranchMachineProviders(guestRuntime{installRuntime: microVM, login: "developer", uid: 1000}).SessionIdentity(ctx))
	requireBranchStatus(t, HostedBranchMachineProviders(microVM).SessionIdentity(ctx), 503)
	requireBranchStatus(t, HostedBranchMachineProviders(guestRuntime{installRuntime: microVM, login: "root", uid: 0}).SessionIdentity(ctx), 503)
	require.NoError(t, HostedBranchMachineProviders(microVM).MicroVM(ctx))
	requireBranchStatus(t, HostedBranchMachineProviders(installRuntime{level: workspaceapi.IsolationTrustedProcess}).MicroVM(ctx), 503)
}

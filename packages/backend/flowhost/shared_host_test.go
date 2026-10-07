package flowhost

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
	"testing"
)

// Real PostgreSQL admission and grant constraints with an explicit synthetic
// native readiness callback. This does not qualify guest identity separation.
func TestSharedNativeHostRequiresProtectedAdmission(t *testing.T) {
	pool := hostTestPool(t)
	authority, catalog := hostFixture(t, pool)
	q := db.New(pool)
	machine, err := q.GetBranchMachineOwner(t.Context())
	require.NoError(t, err)
	other, err := q.CreateUser(t.Context(), db.CreateUserParams{Username: "other", LowerUsername: "other"})
	require.NoError(t, err)
	_, err = pool.Exec(t.Context(), `UPDATE workspaces SET user_id=$2,kind='vm',status='running',vm_id='fixture' WHERE id=$1`, authority.WorkspaceID, machine)
	require.NoError(t, err)
	for i, user := range []int64{authority.UserID, other.ID} {
		_, err = pool.Exec(t.Context(), `INSERT INTO collaborators(repository_id,user_id,permission,unix_login,unix_uid) VALUES($1,$2,'write',$3,$4)`, authority.RepositoryID, user, []string{"alice", "ben"}[i], 20000+i)
		require.NoError(t, err)
		_, err = pool.Exec(t.Context(), `INSERT INTO workspace_shares(workspace_id,owner_user_id,grantee_user_id,level) VALUES($1,$2,$3,'write')`, authority.WorkspaceID, machine, user)
		require.NoError(t, err)
	}
	store, err := NewStore(pool, testCodec{})
	require.NoError(t, err)
	_, err = store.Acquire(t.Context(), authority, catalog)
	require.Error(t, err)
	calls := 0
	store.BindProtectedBranchHost(func(_ context.Context, id string) error {
		require.Equal(t, authority.WorkspaceID, id)
		calls++
		return nil
	})
	lease, err := store.Acquire(t.Context(), authority, catalog)
	require.NoError(t, err)
	binding := lease.Binding()
	require.NoError(t, lease.Close())
	require.Equal(t, 1, calls)
	// A process state marker alone cannot relax the share trigger.
	_, err = pool.Exec(t.Context(), `UPDATE flow_runtime_host_bindings SET state='running' WHERE id=$1`, binding.ID)
	require.NoError(t, err)
	_, err = pool.Exec(t.Context(), `UPDATE workspace_shares SET level='write' WHERE workspace_id=$1 AND grantee_user_id=$2`, authority.WorkspaceID, other.ID)
	require.Error(t, err)
	// Only the immutable host-produced agent spawn receipt for this generation
	// permits another current allocated member's grant.
	receipt, err := json.Marshal(map[string]any{"via": "agent:" + binding.ID, "uid": 19999, "owner_generation": binding.OwnerGeneration})
	require.NoError(t, err)
	factTx, err := pool.Begin(t.Context())
	require.NoError(t, err)
	_, err = jobs.RecordFactInTx(t.Context(), factTx, jobs.Scope{TenantID: fmt.Sprint(authority.RepositoryID), PrincipalID: "branch:" + authority.WorkspaceID}, uuid.NewString(), "branch.session_opened", "completed", receipt)
	require.NoError(t, err)
	require.NoError(t, factTx.Commit(t.Context()))
	_, err = pool.Exec(t.Context(), `UPDATE workspace_shares SET level='write' WHERE workspace_id=$1 AND grantee_user_id=$2`, authority.WorkspaceID, other.ID)
	require.NoError(t, err)
	for _, clause := range []string{"unix_uid=0", "suspended_at=now()", "permission='read'"} {
		tx, err := pool.Begin(t.Context())
		require.NoError(t, err)
		_, err = tx.Exec(t.Context(), `UPDATE collaborators SET `+clause+` WHERE repository_id=$1 AND user_id=$2`, authority.RepositoryID, other.ID)
		require.NoError(t, err)
		_, err = tx.Exec(t.Context(), `UPDATE workspace_shares SET level='write' WHERE workspace_id=$1 AND grantee_user_id=$2`, authority.WorkspaceID, other.ID)
		require.Error(t, err)
		require.NoError(t, tx.Rollback(t.Context()))
	}
	before := calls
	denied := authority
	denied.UserID = other.ID + 10000
	_, err = store.Acquire(t.Context(), denied, catalog)
	require.Error(t, err)
	require.Equal(t, before, calls, "unauthorized targets cannot start a native daemon")
}

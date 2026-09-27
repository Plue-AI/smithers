package services

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type callbackTestCodec struct{}

func (callbackTestCodec) EncryptString(value string) (string, error) { return "sealed:" + value, nil }
func (callbackTestCodec) DecryptString(value string) (string, error) {
	if !strings.HasPrefix(value, "sealed:") {
		return "", errors.New("not sealed")
	}
	return strings.TrimPrefix(value, "sealed:"), nil
}

// The box's coding host calls back with its flowhost binding and credential;
// only the owner's running, unshared box is accepted (#2198).
func TestFlowHostCallbacksAuthorizeTheBoxHost(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")
	var user, other, repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username,email,lower_email) VALUES($1,$1,$2,$2) RETURNING id`, "u"+suffix, suffix+"@example.invalid").Scan(&user))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username,email,lower_email) VALUES($1,$1,$2,$2) RETURNING id`, "o"+suffix, "o"+suffix+"@example.invalid").Scan(&other))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,$2,$2) RETURNING id`, user, "r"+suffix).Scan(&repo))
	var workspace string
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspaces(repository_id,user_id,status,vm_id) VALUES($1,$2,'running','vm-1') RETURNING id::text`, repo, user).Scan(&workspace))

	store, err := flowhost.NewStore(pool, callbackTestCodec{})
	require.NoError(t, err)
	lease, err := store.Acquire(ctx, flowhost.Authority{
		Target:       flowruntime.Target{TenantID: "repository:1", PrincipalID: "user:1", BindingKind: "browser-flow", BindingID: "o/r"},
		RepositoryID: repo, UserID: user, WorkspaceID: workspace, CatalogKey: flowhost.CatalogCoding, SourceRevision: strings.Repeat("a", 40),
	}, flowhost.Catalog{Key: flowhost.CatalogCoding, Family: flowhost.CatalogCoding, Executable: "/opt/smithers/coding", ArtifactDigest: strings.Repeat("b", 64), ServiceName: "coding"})
	require.NoError(t, err)
	_, err = lease.PrepareStart(ctx, false)
	require.NoError(t, err)
	require.NoError(t, lease.MarkRunning(ctx))
	id, credential := lease.Binding().ID, lease.Credential()
	require.NoError(t, lease.Close())

	callbacks := NewFlowHostCallbacks(pool, db.New(pool))
	target, err := callbacks.AuthorizeHostCallback(ctx, id, credential)
	require.NoError(t, err)
	require.Equal(t, BoxHostTarget{HostID: id, UserID: user, RepositoryID: repo, WorkspaceID: workspace, SandboxID: "vm-1"}, target)

	refusedAs := func(code pkgerrors.Code, id, credential string) {
		t.Helper()
		_, err := callbacks.AuthorizeHostCallback(ctx, id, credential)
		var api *pkgerrors.APIError
		require.ErrorAs(t, err, &api)
		require.Equal(t, code, api.Code)
	}
	refusedAs(pkgerrors.CodeUnauthorized, id, credential+"x")
	refusedAs(pkgerrors.CodeUnauthorized, uuid.NewString(), credential)

	// A share granted while the host was down (the host then starting on a
	// shared box) refuses its callbacks.
	_, err = pool.Exec(ctx, `UPDATE flow_runtime_host_bindings SET state='failed' WHERE id=$1`, id)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO workspace_shares(workspace_id, owner_user_id, grantee_user_id, level) VALUES($1,$2,$3,'write')`, workspace, user, other)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE flow_runtime_host_bindings SET state='running' WHERE id=$1`, id)
	require.NoError(t, err)
	refusedAs(pkgerrors.CodeForbidden, id, credential)
	_, err = pool.Exec(ctx, `DELETE FROM workspace_shares WHERE workspace_id=$1`, workspace)
	require.NoError(t, err)

	_, err = pool.Exec(ctx, `UPDATE workspaces SET status='suspended' WHERE id=$1`, workspace)
	require.NoError(t, err)
	refusedAs(pkgerrors.CodeConflict, id, credential)

	// While the box's host runs, the box is never shared for writing: its
	// guest would run as the owner beside the host's credentials (#2198).
	_, err = pool.Exec(ctx, `INSERT INTO workspace_shares(workspace_id, owner_user_id, grantee_user_id, level) VALUES($1,$2,$3,'write')`, workspace, user, other)
	require.True(t, workspaceGatewaySharingConflict(err), "%v", err)
	_, err = pool.Exec(ctx, `INSERT INTO workspace_shares(workspace_id, owner_user_id, grantee_user_id, level) VALUES($1,$2,$3,'read')`, workspace, user, other)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE workspace_shares SET level='write' WHERE workspace_id=$1`, workspace)
	require.True(t, workspaceGatewaySharingConflict(err), "%v", err)
	_, err = pool.Exec(ctx, `UPDATE flow_runtime_host_bindings SET state='failed' WHERE id=$1`, id)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE workspace_shares SET level='write' WHERE workspace_id=$1`, workspace)
	require.NoError(t, err)
}

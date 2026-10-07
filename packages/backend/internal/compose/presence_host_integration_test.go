package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func presenceHostBinding(t *testing.T, pool *pgxpool.Pool, row db.Workspace, user int64) (*flowhost.Store, flowhost.Catalog) {
	t.Helper()
	codec, err := newSecretCodec(config.WebhookConfig{SecretEncryptionKey: "presence-host-test"})
	require.NoError(t, err)
	store, err := flowhost.NewStore(pool, codec)
	require.NoError(t, err)
	catalog := flowhost.Catalog{Key: flowhost.CatalogCoding, Family: flowhost.CatalogCoding, Executable: "/opt/smithers/coding", ArtifactDigest: strings.Repeat("b", 64), ServiceName: "coding", SystemFlows: []string{"coding/plan"}}
	lease, err := store.Acquire(t.Context(), flowhost.Authority{
		Target:       flowruntime.Target{TenantID: fmt.Sprintf("repository:%d", row.RepositoryID), PrincipalID: fmt.Sprintf("user:%d", user), WorkspaceID: row.ID, BindingKind: "mythical-item", BindingID: "presence-test-item"},
		RepositoryID: row.RepositoryID, UserID: user, WorkspaceID: row.ID, CatalogKey: flowhost.CatalogCoding, SourceRevision: strings.Repeat("a", 40),
	}, catalog)
	require.NoError(t, err)
	_, err = lease.PrepareStart(t.Context(), false)
	require.NoError(t, err)
	require.NoError(t, lease.MarkRunning(t.Context(), "presence-test-host"))
	require.NoError(t, lease.Close())
	return store, catalog
}

// Real PostgreSQL, browser target authorization, durable host lease checks and
// authenticated TS presence RPC. No guest or new host launch is involved.
type authorizedPresenceDispatcher struct {
	presenceBridgeFixture
	queries       *db.Queries
	hosts         *flowhost.Store
	catalog       flowhost.Catalog
	reached       []flowruntime.Target
	beforeAcquire func()
}

func (d *authorizedPresenceDispatcher) CallRPC(ctx context.Context, target flowruntime.Target, procedure string, payload json.RawMessage) (json.RawMessage, error) {
	authority, err := (browserFlowTarget{queries: d.queries}).ResolveFlowHostTarget(ctx, target)
	if err != nil {
		return nil, err
	}
	if d.beforeAcquire != nil {
		d.beforeAcquire()
	}
	lease, err := d.hosts.AcquireExisting(ctx, authority, d.catalog)
	if err != nil {
		return nil, err
	}
	defer lease.Close()
	d.reached = append(d.reached, target)
	return d.Client.CallRPC(ctx, procedure, payload)
}

func TestPresenceUsesExistingHostPrincipal(t *testing.T) {
	b := newRelayBoxes(t)
	bridge := realPresenceBridge(t)
	for _, machineOwned := range []bool{false, true} {
		t.Run(fmt.Sprintf("machine-owned=%t", machineOwned), func(t *testing.T) {
			owner := b.owner
			if machineOwned {
				owner = b.machines
			}
			id := b.box(b.repo, owner, "running", b.owner)
			row, err := b.GetWorkspace(t.Context(), id)
			require.NoError(t, err)
			slug := b.login + "/repo"
			hosts, catalog := presenceHostBinding(t, b.pool, row, b.owner)
			dispatcher := &authorizedPresenceDispatcher{presenceBridgeFixture: presenceBridgeFixture{bridge}, queries: b.Queries, hosts: hosts, catalog: catalog}
			p := &branchPresence{hosts: hosts, dispatcher: dispatcher}
			call := func() error { _, err := p.call(t.Context(), row, slug, "Branch.Roster", map[string]any{}); return err }
			require.NoError(t, call())
			require.Equal(t, []flowruntime.Target{b.target(b.repo, b.owner, id)}, dispatcher.reached)
			if machineOwned {
				_, err := dispatcher.CallRPC(t.Context(), b.target(b.repo, row.UserID, id), "Branch.Roster", json.RawMessage(`{}`))
				require.Error(t, err, "the former machine-owner target conflicts with the host's person")
			}
			// The stored binding was created by a TODO, yet resolves as a browser read.
			// A stale host principal must still fail AcquireExisting's exact match.
			dispatcher.beforeAcquire = func() {
				b.exec(`UPDATE flow_runtime_host_bindings SET principal_id='user:stale' WHERE workspace_id=$1`, id)
			}
			require.Error(t, call())
			require.Len(t, dispatcher.reached, 1)
			dispatcher.beforeAcquire = nil
			b.exec(`UPDATE flow_runtime_host_bindings SET principal_id=$2 WHERE workspace_id=$1`, id, fmt.Sprintf("user:%d", b.owner))
			if machineOwned {
				b.exec(`DELETE FROM workspace_shares WHERE workspace_id=$1`, id)
				require.Error(t, call(), "revoked write access must not reach the host")
				// The share table also refuses new writers while a host is live.
				_, err := b.UpsertWorkspaceShare(t.Context(), db.UpsertWorkspaceShareParams{WorkspaceID: id, OwnerUserID: b.machines, GranteeUserID: b.owner, Level: "write"})
				require.Error(t, err)
				b.exec(`UPDATE flow_runtime_host_bindings SET state='failed' WHERE workspace_id=$1`, id)
				b.share(id, b.machines, b.owner, "write")
				b.share(id, b.machines, b.ben, "write")
				b.exec(`UPDATE flow_runtime_host_bindings SET state='running' WHERE workspace_id=$1`, id)
				require.Error(t, call(), "routing must not bypass the current shared-host credential boundary")
				b.exec(`DELETE FROM workspace_shares WHERE workspace_id=$1 AND grantee_user_id=$2`, id, b.ben)
			}
			for _, state := range []string{"pending", "starting", "failed", "retired"} {
				b.exec(`UPDATE flow_runtime_host_bindings SET state=$2 WHERE workspace_id=$1`, id, state)
				require.ErrorIs(t, call(), flowhost.ErrHostNotRunning)
			}
			b.exec(`UPDATE flow_runtime_host_bindings SET state='running', tenant_id='repository:foreign' WHERE workspace_id=$1`, id)
			require.ErrorIs(t, call(), flowhost.ErrHostIdentityConflict)
			b.exec(`UPDATE flow_runtime_host_bindings SET tenant_id=$2 WHERE workspace_id=$1`, id, fmt.Sprintf("repository:%d", b.repo.ID))
			foreign := row
			foreign.RepositoryID = b.other.ID
			_, err = p.call(t.Context(), foreign, slug, "Branch.Roster", map[string]any{})
			require.ErrorIs(t, err, flowhost.ErrHostNotRunning)
			_, err = p.call(t.Context(), row, b.login+"/other", "Branch.Roster", map[string]any{})
			require.Error(t, err)
			b.exec(`UPDATE workspaces SET status='suspended' WHERE id=$1`, id)
			require.Error(t, call(), "a stored running binding cannot wake a sleeping machine")
			b.exec(`UPDATE workspaces SET status='running' WHERE id=$1`, id)
			require.NoError(t, call(), "valid access recovers without replacing the host")
			require.Len(t, dispatcher.reached, 2)
			b.exec(`DELETE FROM flow_runtime_host_bindings WHERE workspace_id=$1`, id)
			require.ErrorIs(t, call(), flowhost.ErrHostNotRunning)
			p.hosts = nil
			require.ErrorIs(t, call(), flowhost.ErrHostNotRunning)
			var count int
			require.NoError(t, b.pool.QueryRow(t.Context(), `SELECT count(*) FROM flow_runtime_host_bindings WHERE workspace_id=$1`, id).Scan(&count))
			require.Zero(t, count, "presence never creates a binding")
		})
	}
}

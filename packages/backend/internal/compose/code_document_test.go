package compose

import (
	"context"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// The database, admission policy, registry and authenticated link are real.
// The peer only handshakes; these tests do not certify a guest filesystem.
func TestComposeCodeDocumentAuthority(t *testing.T) {
	configureNativeInstallFixture(t)
	pool := docDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "document-owner", LowerUsername: "document-owner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	machineOwner, err := q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	row, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: machineOwner, TargetBookmark: "scratch/owner/document", Kind: "container", Status: "running"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE workspaces SET vm_id='machine' WHERE id=$1`, row.ID)
	require.NoError(t, err)
	_, err = q.UpsertWorkspaceShare(ctx, db.UpsertWorkspaceShareParams{WorkspaceID: row.ID, OwnerUserID: machineOwner, GranteeUserID: owner.ID, Level: "write"})
	require.NoError(t, err)
	runtime := guestMicroVM{isolatedRuntime{isolation: workspace.IsolationSandboxed}}
	service := services.NewWorkspaceService(q, services.WithWorkspaceTransactions(pool), services.WithBranchMachineProviders(services.InstallBranchMachineProviders(ownerOnly{owner.ID}, runtime)))
	registry := new(machined.Registry)
	t.Cleanup(func() { require.NoError(t, registry.Close()) })
	require.Nil(t, composeCodeDocumentRelay(nil, registry))
	require.Nil(t, composeCodeDocumentRelay(service, nil))
	relay := composeCodeDocumentRelay(service, registry)
	require.NotNil(t, relay)
	topic := fmt.Sprintf("doc:code:%s:src/main.ts", row.ID)
	_, code := relay.Resolve(ctx, topic, repo.ID, owner.ID)
	require.Equal(t, live.Unsupported, code, "no connected daemon")
	link, _ := presenceTestLink(t, registry, row.ID)
	_, code = relay.Resolve(ctx, topic, repo.ID, owner.ID)
	require.Equal(t, live.Unsupported, code, "wake reconciliation required")
	require.NoError(t, link.Connection.Reconciled())
	source, code := relay.Resolve(ctx, topic, repo.ID, owner.ID)
	require.Empty(t, code)
	require.NotNil(t, source.Document)
	require.NoError(t, source.Document.Ready())
	require.Len(t, source.Document.Actor, 16)
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	actor, err := machined.ResolveActorInTx(ctx, tx, row.ID, "machine", source.Document.Actor)
	require.NoError(t, err)
	require.Equal(t, machined.ActorIdentity{Kind: "person", MemberID: owner.ID, Via: "web"}, actor)
	require.NoError(t, tx.Rollback(ctx))
	conn, rpc := relay.Connection(ctx, row.ID)
	require.Same(t, link.Connection, conn)
	require.NotNil(t, rpc)
	conn, rpc = relay.Connection(ctx, "not-connected")
	require.Nil(t, conn)
	require.Nil(t, rpc)
	for _, scope := range []struct{ repo, member int64 }{{repo.ID + 1000, owner.ID}, {repo.ID, machineOwner}, {repo.ID, owner.ID + 1000}} {
		_, code = relay.Resolve(ctx, topic, scope.repo, scope.member)
		require.Equal(t, live.Forbidden, code)
	}
	_, err = pool.Exec(ctx, `UPDATE workspace_shares SET level='read' WHERE workspace_id=$1`, row.ID)
	require.NoError(t, err)
	require.ErrorIs(t, source.Document.Ready(), machined.ErrUnauthorized)
	_, code = relay.Resolve(ctx, topic, repo.ID, owner.ID)
	require.Equal(t, live.Forbidden, code)
	_, err = pool.Exec(ctx, `UPDATE workspace_shares SET level='write' WHERE workspace_id=$1`, row.ID)
	require.NoError(t, err)
	require.NoError(t, source.Document.Ready())
	_, err = pool.Exec(ctx, `UPDATE workspaces SET vm_id='replacement' WHERE id=$1`, row.ID)
	require.NoError(t, err)
	require.ErrorIs(t, source.Document.Ready(), machined.ErrUnauthorized)
	_, code = relay.Resolve(ctx, topic, repo.ID, owner.ID)
	require.Equal(t, live.Unsupported, code, "old transport cannot consume the replacement's actor")
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	_, code = relay.Resolve(canceled, topic, repo.ID, owner.ID)
	require.Equal(t, live.Forbidden, code)
}

package db

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"
)

// Exercise the generated public query boundary against the migrated product
// database: nullable sizing must survive every full-workspace row scanner.
func TestSQLCWorkspaceSchemaRoundTrip(t *testing.T) {
	for _, tc := range []struct {
		name              string
		cpu, memory, disk pgtype.Int4
	}{
		{name: "operator defaults"},
		{name: "explicit resources", cpu: pgtype.Int4{Int32: 3, Valid: true}, memory: pgtype.Int4{Int32: 7168, Valid: true}, disk: pgtype.Int4{Int32: 24576, Valid: true}},
		{name: "partial resources", memory: pgtype.Int4{Int32: 4096, Valid: true}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			q, tx := newQueries(t)
			username, repository := uniqueTestUsername(t), uniqueTestRepoName(t)
			userID, repoID := mustCreateUserAndRepo(t, tx, username, repository)
			created, err := q.CreateWorkspace(ctx, CreateWorkspaceParams{
				RepositoryID: repoID, UserID: userID, Name: "schema-roundtrip", Status: "pending", Kind: "vm",
				SourceCommit: "0123456789abcdef0123456789abcdef01234567", TargetBookmark: "feature", EnvironmentRevision: "environment-revision",
				VcpuCount: tc.cpu, MemoryMb: tc.memory, DiskMb: tc.disk,
			})
			require.NoError(t, err)
			check := func(got Workspace) {
				t.Helper()
				require.Equal(t, created.ID, got.ID)
				require.Equal(t, repoID, got.RepositoryID)
				require.Equal(t, userID, got.UserID)
				require.Equal(t, "0123456789abcdef0123456789abcdef01234567", got.SourceCommit)
				require.Equal(t, "feature", got.TargetBookmark)
				require.Equal(t, "environment-revision", got.EnvironmentRevision)
				require.Equal(t, tc.cpu, got.VcpuCount)
				require.Equal(t, tc.memory, got.MemoryMb)
				require.Equal(t, tc.disk, got.DiskMb)
				require.False(t, got.ParentWorkspaceID.Valid)
				require.False(t, got.SourceSnapshotID.Valid)
				require.False(t, got.AgentSessionID.Valid)
				require.False(t, got.DeletedAt.Valid)
			}
			check(created)
			got, err := q.GetWorkspace(ctx, created.ID)
			require.NoError(t, err)
			check(got)
			updated, err := q.UpdateWorkspaceHead(ctx, UpdateWorkspaceHeadParams{
				ID: created.ID, HeadChangeID: "change", HeadCommitID: "commit", Ahead: 7, Behind: 2,
			})
			require.NoError(t, err)
			check(updated)
			require.Equal(t, "change", updated.HeadChangeID)
			require.Equal(t, "commit", updated.HeadCommitID)
			require.Equal(t, int32(7), updated.Ahead)
			require.Equal(t, int32(2), updated.Behind)
			reread, err := q.GetWorkspace(ctx, created.ID)
			require.NoError(t, err)
			require.Equal(t, updated, reread)
			parent, err := q.GetWorkspaceChildParentForUpdate(ctx, created.ID)
			require.NoError(t, err)
			require.Equal(t, updated, parent)
			rows, err := q.AdminListWorkspaces(ctx, AdminListWorkspacesParams{Owner: username, RowLimit: 10})
			require.NoError(t, err)
			require.Len(t, rows, 1)
			require.Equal(t, username, rows[0].Owner)
			require.Equal(t, username+"/"+repository, rows[0].Repository)
			require.Equal(t, updated, rows[0].Workspace)
		})
	}
}

func TestSQLCWorkspaceChildSchemaRoundTrip(t *testing.T) {
	ctx := context.Background()
	q, tx := newQueries(t)
	userID, repoID := mustCreateUserAndRepo(t, tx, uniqueTestUsername(t), uniqueTestRepoName(t))
	parent, err := q.CreateWorkspace(ctx, CreateWorkspaceParams{
		RepositoryID: repoID, UserID: userID, Name: "schema-parent", Status: "running", Kind: "vm",
		TargetBookmark: "feature", EnvironmentRevision: "parent-revision",
	})
	require.NoError(t, err)
	var parentID pgtype.UUID
	require.NoError(t, parentID.Scan(parent.ID))
	batch, err := q.CreateWorkspaceChildBatch(ctx, CreateWorkspaceChildBatchParams{
		ParentWorkspaceID: parentID, UserID: userID, Profile: "small", Requested: 2, ExpiresAt: time.Now().UTC().Add(time.Hour),
	})
	require.NoError(t, err)
	require.NoError(t, q.ReserveWorkspaceChildren(ctx, batch.ID))
	children, err := q.CreateWorkspaceChildRows(ctx, batch.ID)
	require.NoError(t, err)
	require.Len(t, children, 2)
	require.NotEqual(t, children[0].ID, children[1].ID)
	for _, child := range children {
		require.Equal(t, repoID, child.RepositoryID)
		require.Equal(t, userID, child.UserID)
		require.True(t, child.IsFork)
		require.Equal(t, parentID, child.ParentWorkspaceID)
		require.Equal(t, "feature", child.TargetBookmark)
		require.Equal(t, "vm", child.Kind)
		require.Equal(t, "parent-revision", child.EnvironmentRevision)
		require.Equal(t, "starting", child.Status)
		require.Equal(t, int32(0), child.IdleTimeoutSecs)
		require.False(t, child.VcpuCount.Valid)
		require.False(t, child.MemoryMb.Valid)
		require.False(t, child.DiskMb.Valid)
		require.False(t, child.SourceSnapshotID.Valid)
		reread, err := q.GetWorkspace(ctx, child.ID)
		require.NoError(t, err)
		require.Equal(t, child, reread)
	}
}

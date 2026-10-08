package services

import (
	"context"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestCleanupReopenRestoresOnlyRetainedItemLane(t *testing.T) {
	pool := newProductTestPool(t)
	_, repo := setupTestUserAndRepo(t, pool)
	q := db.New(pool)
	owner, err := q.GetBranchMachineOwner(t.Context())
	require.NoError(t, err)
	for _, name := range []string{"retained", "deleted", "different item", "different repository", "different workspace"} {
		t.Run(name, func(t *testing.T) {
			row, err := q.CreateWorkspace(t.Context(), db.CreateWorkspaceParams{RepositoryID: repo, UserID: owner, TargetBookmark: "smithers/reopen-" + name, Kind: "container", Status: "suspended"})
			require.NoError(t, err)
			item, _, err := q.InsertMythicalChatItem(t.Context(), db.MythicalItem{RepositoryID: repo, IssueTitle: name, WorkspaceID: row.ID})
			require.NoError(t, err)
			_, _, err = q.BindMythicalLane(t.Context(), db.MythicalLane{RepositoryID: repo, WorkspaceID: row.ID, ItemID: item.ID, Name: name})
			require.NoError(t, err)
			require.NoError(t, q.RetireMythicalLane(t.Context(), row.ID))
			if name == "deleted" {
				_, err = pool.Exec(t.Context(), `UPDATE workspaces SET deleted_at=now() WHERE id=$1`, row.ID)
				require.NoError(t, err)
			}
			if name == "different item" {
				other, _, err := q.InsertMythicalChatItem(t.Context(), db.MythicalItem{RepositoryID: repo, IssueTitle: "other"})
				require.NoError(t, err)
				item.ID = other.ID
			}
			if name == "different repository" {
				item.RepositoryID++
			}
			if name == "different workspace" {
				item.WorkspaceID = "00000000-0000-4000-8000-000000000000"
			}
			require.NoError(t, q.RestoreMythicalItemLane(t.Context(), item))
			lane, err := q.GetMythicalLane(t.Context(), row.ID)
			require.NoError(t, err)
			require.Equal(t, name != "retained", lane.RetiredAt.Valid)
			require.NoError(t, q.RestoreMythicalItemLane(t.Context(), item))
			again, err := q.GetMythicalLane(t.Context(), row.ID)
			require.NoError(t, err)
			require.Equal(t, lane.RetiredAt, again.RetiredAt, "repeated reopen is idempotent")
		})
	}
}

func TestCleanupRetiredLaneReadableWithoutWriterAdmission(t *testing.T) {
	pool := newProductTestPool(t)
	_, repo := setupTestUserAndRepo(t, pool)
	q := db.New(pool)
	owner, err := q.GetBranchMachineOwner(t.Context())
	require.NoError(t, err)
	row, err := q.CreateWorkspace(t.Context(), db.CreateWorkspaceParams{RepositoryID: repo, UserID: owner, TargetBookmark: "smithers/retained", Kind: "container", Status: "suspended"})
	require.NoError(t, err)
	item, _, err := q.InsertMythicalChatItem(t.Context(), db.MythicalItem{RepositoryID: repo, IssueTitle: "retained", WorkspaceID: row.ID})
	require.NoError(t, err)
	_, _, err = q.BindMythicalLane(t.Context(), db.MythicalLane{RepositoryID: repo, WorkspaceID: row.ID, ItemID: item.ID, Name: "retained"})
	require.NoError(t, err)
	require.NoError(t, q.RetireMythicalLane(t.Context(), row.ID))
	check := func(read bool) error {
		tx, err := pool.Begin(t.Context())
		require.NoError(t, err)
		defer tx.Rollback(t.Context())
		ctx := t.Context()
		if read {
			ctx = context.WithValue(ctx, retainedBranchReadKey{}, true)
		}
		return installLaneBinding(ctx, tx, repo, row.TargetBookmark, row.ID)
	}
	require.Error(t, check(false))
	require.Error(t, check(true), "retirement alone never authorizes history reads")
	_, err = pool.Exec(t.Context(), `UPDATE workspaces SET branch_archived_at=now(),disk_reclaimed_at=now() WHERE id=$1`, row.ID)
	require.NoError(t, err)
	require.NoError(t, check(true), "retained archived branch remains readable")
	require.Error(t, check(false), "read authorization must never admit a writer or wake")
	_, err = pool.Exec(t.Context(), `UPDATE workspaces SET deleted_at=now() WHERE id=$1`, row.ID)
	require.NoError(t, err)
	require.Error(t, check(true), "deleted workspace cannot borrow archived read authority")
}

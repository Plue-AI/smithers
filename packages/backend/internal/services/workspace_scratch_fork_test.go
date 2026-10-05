package services

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// scratchHeads advertises refs as repo-host's info/refs does.
type scratchHeads map[string]string

func (h scratchHeads) InfoRefsUploadPack(context.Context, string, string) ([]byte, error) {
	var out strings.Builder
	for ref, oid := range h {
		line := oid + " " + ref + "\n"
		fmt.Fprintf(&out, "%04x%s", len(line)+4, line)
	}
	out.WriteString("0000")
	return []byte(out.String()), nil
}

// A scratch fork (spec §8.5, T-MCH-08) is a workspace on the pushed-ref
// path: its revision is retained under the new workspace's source ref before
// the row exists, the row records forked_from, and the branch is published
// only once it does. A person outside the roster writes nothing, and the
// branch reads as kind scratch with forked_from and its branch ref's head.
func TestScratchForkRecordsForkedFromAndPublishesAfterTheRow(t *testing.T) {
	pool := newProductTestPool(t)
	owner, repo := setupTestUserAndRepo(t, pool)
	installBranchOwner(t, pool, owner)
	ctx := context.Background()
	q := db.New(pool)
	item, _, err := q.InsertMythicalChatItem(ctx, db.MythicalItem{RepositoryID: repo, IssueTitle: "retries"})
	require.NoError(t, err)
	parent, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: owner, Name: "lane", Kind: "container", Status: "running",
		TargetBookmark: MythicalBookmark, EnvironmentSource: defaultWorkspaceEnvironmentSource})
	require.NoError(t, err)
	h2, c1, s := strings.Repeat("2", 40), strings.Repeat("1", 40), strings.Repeat("5", 40)
	heads := scratchHeads{}
	svc := installLaneService(t, pool, owner)
	svc.branchHeads = heads
	var steps []string
	fork := func(actor int64, branch, commit string, retain error) (BranchMachineResponse, error) {
		return NewWorkspaceMythicalLanes(svc).ForkScratch(ctx, ScratchFork{RepositoryID: repo, Owner: "owner", Repo: "repo", ActorID: actor,
			Branch: branch, Commit: commit, Base: c1, Item: item.ID, Parent: parent.ID,
			Retain: func(_ context.Context, id string) error {
				var rows int
				require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE id = $1`, id).Scan(&rows))
				steps = append(steps, fmt.Sprintf("retain %d", rows))
				return retain
			},
			Publish: func(context.Context) error { steps = append(steps, "publish"); return nil }})
	}

	created, err := fork(owner, "scratch/owner/try-retry", h2, nil)
	require.NoError(t, err)
	require.NoError(t, svc.WaitForProvisioning(ctx))
	require.Equal(t, []string{"retain 0", "publish"}, steps, "the revision is retained before the row; the branch is published after it")
	require.Equal(t, "scratch/owner/try-retry", created.Name)
	require.Equal(t, "scratch", created.Kind)
	row, err := q.GetWorkspace(ctx, created.Machine.ID)
	require.NoError(t, err)
	require.Equal(t, "scratch/owner/try-retry", row.TargetBookmark)
	require.Equal(t, h2, row.SourceCommit)
	require.Equal(t, c1, row.ForkedFromBase)
	require.Equal(t, item.ID, row.ForkedFromItem)
	require.Equal(t, parent.ID, UUIDString(row.ParentWorkspaceID))
	require.True(t, row.IsFork)
	machines, err := q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	require.Equal(t, machines, row.UserID, "the machine service owns the scratch machine")
	sole, err := q.WorkspaceSoleWriter(ctx, db.WorkspaceSoleWriterParams{WorkspaceID: row.ID, UserID: owner})
	require.NoError(t, err)
	require.True(t, sole, "the person who forked is its writer")
	unchanged, err := q.GetWorkspace(ctx, parent.ID)
	require.NoError(t, err)
	require.Equal(t, parent.Status, unchanged.Status, "the fork never touches the item's machine")
	require.Equal(t, parent.ProvisioningGeneration, unchanged.ProvisioningGeneration)

	// The read: forked_from {item, T<n>, H2, C1}; the head is the source
	// commit until the branch ref exists, then wherever a push moved it.
	read, err := svc.GetBranch(ctx, "scratch/owner/try-retry", repo, owner)
	require.NoError(t, err)
	require.Equal(t, "scratch", read.Kind)
	require.Equal(t, h2, read.Head)
	require.Equal(t, &BranchForkedFrom{Kind: "item", Ref: fmt.Sprintf("T%d", item.Number.Int64), Commit: h2, Base: c1, Item: item.Number.Int64}, read.ForkedFrom)
	heads["refs/heads/scratch/owner/try-retry"] = s
	read, err = svc.GetBranch(ctx, "scratch/owner/try-retry", repo, owner)
	require.NoError(t, err)
	require.Equal(t, s, read.Head)

	// The same name from another revision is refused before any publish.
	steps = nil
	_, err = fork(owner, "scratch/owner/try-retry", strings.Repeat("3", 40), nil)
	requireBranchStatus(t, err, 409)
	require.Equal(t, []string{"retain 0"}, steps)

	// A failed retention writes no row and publishes nothing.
	steps = nil
	_, err = fork(owner, "scratch/owner/other", h2, errors.New("retain refused"))
	require.ErrorContains(t, err, "retain refused")
	require.Equal(t, []string{"retain 0"}, steps)
	var rows int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE target_bookmark = 'scratch/owner/other'`).Scan(&rows))
	require.Zero(t, rows)

	// A person outside the roster is refused before the revision is retained.
	var outsider int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES('outsider','outsider') RETURNING id`).Scan(&outsider))
	steps = nil
	_, err = fork(outsider, "scratch/outsider/try", h2, nil)
	require.ErrorIs(t, err, errBranchMachineAdmission)
	require.Empty(t, steps)

	// Only a scratch branch at a full revision is a fork.
	for _, bad := range []struct{ branch, commit string }{{"smithers/try", h2}, {"main", h2}, {"scratch/owner/short", "abc"}} {
		_, err = fork(owner, bad.branch, bad.commit, nil)
		requireBranchStatus(t, err, 500)
	}
}

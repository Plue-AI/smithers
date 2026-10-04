package services

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type refDeleterFunc func(context.Context, string, string, string) (repohost.DeletedWorkspaceRefs, error)

func (f refDeleterFunc) DeleteWorkspaceRefs(ctx context.Context, owner, repo, workspaceID string) (repohost.DeletedWorkspaceRefs, error) {
	return f(ctx, owner, repo, workspaceID)
}

// #1990: deleting a workspace deletes its repo-host refs before its row is
// tombstoned, so a failed ref delete leaves the delete retryable.
func TestDeleteWorkspaceDeletesItsRefsBeforeTombstoning(t *testing.T) {
	const workspaceID = "0f8fad5b-d9cb-469f-a165-70867728950e"
	for _, fail := range []bool{false, true} {
		var order []string
		q := &workspaceHeadTestQuerier{mockWorkspaceQuerier: &mockWorkspaceQuerier{
			getWorkspaceByRepoFn: func(_ context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
				return db.Workspace{ID: arg.ID, RepositoryID: arg.RepositoryID, UserID: 7, Status: "running"}, nil
			},
			softDeleteWorkspaceFn: func(_ context.Context, id string) (db.Workspace, error) {
				order = append(order, "tombstone "+id)
				return db.Workspace{ID: id, Status: "stopped"}, nil
			},
		}}
		svc := newWorkspaceServiceForTests(q, WithWorkspaceRefDeleter(refDeleterFunc(func(_ context.Context, owner, repo, id string) (repohost.DeletedWorkspaceRefs, error) {
			order = append(order, "refs "+owner+"/"+repo+" "+id)
			if fail {
				return repohost.DeletedWorkspaceRefs{}, errors.New("repo-host down")
			}
			return repohost.DeletedWorkspaceRefs{Refs: []string{repohost.BranchHeadRef(id)}}, nil
		})))
		err := svc.DeleteWorkspace(context.Background(), workspaceID, 200, 7)
		if fail {
			require.ErrorContains(t, err, "delete workspace refs")
			assert.Equal(t, []string{"refs acme/widgets " + workspaceID}, order)
			continue
		}
		require.NoError(t, err)
		assert.Equal(t, []string{"refs acme/widgets " + workspaceID, "tombstone " + workspaceID}, order)
	}
}

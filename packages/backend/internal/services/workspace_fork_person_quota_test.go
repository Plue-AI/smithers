package services

import (
	"context"
	"net/http"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

// forkPersonQuotaQuerier reports one user at the active workspace cap.
type forkPersonQuotaQuerier struct {
	*db.Queries
	full int64
}

func (q forkPersonQuotaQuerier) CountActiveWorkspacesByUser(ctx context.Context, userID int64) (int64, error) {
	if userID == q.full {
		return MaxActiveWorkspacesPerUser, nil
	}
	return q.Queries.CountActiveWorkspacesByUser(ctx, userID)
}

// A fork is the requesting person's sandbox. The machine service owns every
// branch machine (de86a86992) and the database cap exempts it (0108), so the
// fork quota counts the person, never the machine service that owns the source.
func TestForkQuotaCountsThePersonNotTheMachineService(t *testing.T) {
	ctx := context.Background()
	pool := newProductTestPool(t)
	person, repo := setupTestUserAndRepo(t, pool)
	q := db.New(pool)
	machines, err := q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	source, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: machines, Name: "source", TargetBookmark: "source", Kind: "container", Status: "running"})
	require.NoError(t, err)
	_, err = q.UpsertWorkspaceShare(ctx, db.UpsertWorkspaceShareParams{WorkspaceID: source.ID, OwnerUserID: machines, GranteeUserID: person, Level: "write"})
	require.NoError(t, err)
	for _, tc := range []struct {
		name string
		full int64
		want int
	}{
		{"machine service at the cap", machines, 0},
		{"person at the cap", person, http.StatusTooManyRequests},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc := newWorkspaceServiceForTests(forkPersonQuotaQuerier{Queries: q, full: tc.full},
				WithWorkspaceTransactions(pool), WithBranchMachineProviders(branchMachineTestProviders()))
			forked := false
			svc.revisionFork = func(context.Context, db.Workspace, ForkWorkspaceInput) (WorkspaceResponse, error) {
				forked = true
				return WorkspaceResponse{}, nil
			}
			_, err := svc.ForkWorkspace(ctx, ForkWorkspaceInput{RepositoryID: repo, UserID: person, WorkspaceID: source.ID})
			if tc.want == 0 {
				require.NoError(t, err)
				require.True(t, forked)
				return
			}
			require.Equal(t, tc.want, apiStatus(t, err))
			require.False(t, forked, "a refused fork never reaches the revision writer")
		})
	}
}

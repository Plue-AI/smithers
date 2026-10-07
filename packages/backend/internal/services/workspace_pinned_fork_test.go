package services

import (
	"context"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
	"strings"
	"testing"
)

// A new revision-backed fork must not inspect or resume the primary machine,
// including when the sandbox provider offers a warm disk-copy optimization.
func TestPinnedWorkspaceNeverForksPrimary(t *testing.T) {
	for _, bookmark := range []string{"scratch/ben/main", "scratch/ben/t2", "smithers/adopted"} {
		t.Run(bookmark, func(t *testing.T) {
			row := db.Workspace{ID: "pinned-child", RepositoryID: 1, UserID: 2, IsFork: true, TargetBookmark: bookmark, Kind: "container", SourceCommit: strings.Repeat("a", 40)}
			q := &mockWorkspaceQuerier{getActiveWorkspaceForUserRepoKindFn: func(context.Context, db.GetActiveWorkspaceForUserRepoKindParams) (db.Workspace, error) {
				t.Fatal("a retained revision must not inspect its primary machine")
				return db.Workspace{}, nil
			}}
			service := newWorkspaceServiceForTests(q)
			got, forked := service.tryForkDerivedFromPrimary(t.Context(), row, CreateWorkspaceSessionInput{RepositoryID: 1, UserID: 2, RepoOwner: "ben", RepoName: "demo", SourceBookmark: bookmark})
			require.False(t, forked)
			require.Equal(t, row, got)
		})
	}
}

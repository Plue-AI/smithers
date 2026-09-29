package services

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	"github.com/stretchr/testify/require"
)

// Only provisioning is paused at the injected runtime port: identity lookup,
// concurrent inserts, uniqueness, quotas, and the exported create boundary use
// a real migrated PostgreSQL database.
func TestCreateWorkspaceConcurrentNamedIdentity(t *testing.T) {
	pool := newProductTestPool(t)
	user, repo := setupTestUserAndRepo(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	release := make(chan struct{})
	svc := NewWorkspaceService(db.New(pool), WithWorkspaceGitBaseURL(testWorkspaceGitBaseURL), WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(ctx context.Context, _ sandbox.CreateRequest) (sandbox.CreateResult, error) {
			select {
			case <-release:
				return sandbox.CreateResult{}, errors.New("test provisioning released")
			case <-ctx.Done():
				return sandbox.CreateResult{}, ctx.Err()
			}
		},
	}))
	t.Cleanup(func() {
		close(release)
		waitCtx, waitCancel := context.WithTimeout(context.Background(), time.Minute)
		defer waitCancel()
		require.NoError(t, svc.WaitForProvisioning(waitCtx))
	})
	createMany := func(names []string, bookmark string) []WorkspaceResponse {
		t.Helper()
		results := make([]WorkspaceResponse, len(names))
		errs := make([]error, len(names))
		start := make(chan struct{})
		var wg sync.WaitGroup
		for i, name := range names {
			wg.Add(1)
			go func(i int, name string) {
				defer wg.Done()
				<-start
				results[i], errs[i] = svc.CreateWorkspaceAsync(ctx, CreateWorkspaceInput{
					RepositoryID: repo, UserID: user, RepoOwner: "owner", RepoName: "named",
					Name: name, SourceBookmark: bookmark,
				})
			}(i, name)
		}
		close(start)
		wg.Wait()
		for _, err := range errs {
			require.NoError(t, err)
		}
		return results
	}
	for _, bookmark := range []string{"main", "feature/one"} {
		names := make([]string, 20)
		for i := range names {
			names[i] = "shared"
		}
		rows := createMany(names, bookmark)
		for _, row := range rows {
			require.Equal(t, rows[0].ID, row.ID, "simultaneous same identity must reuse its pending row")
		}
		for i := range names {
			names[i] = fmt.Sprintf("issue-%d", i)
		}
		rows = createMany(names, bookmark)
		ids := make(map[string]bool)
		for _, row := range rows {
			require.False(t, ids[row.ID], "each name needs its own checkout")
			ids[row.ID] = true
		}
	}
	count, err := db.New(pool).CountActiveWorkspacesByUser(ctx, user)
	require.NoError(t, err)
	require.EqualValues(t, 42, count)
}

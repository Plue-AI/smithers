package services

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// On an install, a TODO merged in Smithers reaches the install's main only
// through the GitHub sync: GitHub's squash commit (a real commit on the
// fixture's main) is read by the sync, fast-forwarded into the install's
// main with the sync's authority, and folded by the stack. The TODO is
// Merged by GitHub's merge receipt and GitHub's main containing it. Real
// PostgreSQL, real git on both sides, githubfake as GitHub.
func TestInstallMainFollowsAMergeInSmithers(t *testing.T) {
	h := newMergeHarness(t)
	ctx := context.Background()
	q := db.New(h.pool)
	sync := NewGitHubMainPullService(q, h.host, h.connections, h.connections)
	sync.UseInstallPolicy()
	sync.SetMainMoved(h.service.MainMoved)
	follows := 0
	h.service.SetMainFollower(func(ctx context.Context, repositoryID int64) {
		follows++
		_, err := sync.Request(ctx, repositoryID)
		require.NoError(t, err)
	})

	// The sync enrolls the repository and finds both mains equal.
	_, err := sync.SyncHealth(ctx)
	var unavailable *GitHubSyncUnavailable
	require.ErrorAs(t, err, &unavailable, "nothing followed yet")
	sync.Sweep(ctx)
	require.NoError(t, sync.PollOnce(ctx))
	row, err := q.GetGithubMainPull(ctx, h.repoID)
	require.NoError(t, err)
	require.Equal(t, "synced", row.State, row.LastError)
	require.Equal(t, []string{h.main, h.main}, []string{row.GithubHead, row.SmithersHead})
	health, err := sync.SyncHealth(ctx)
	require.NoError(t, err)
	require.Equal(t, "fresh", health.State)

	n, head, pr := h.first("Add a greeting")
	require.NoError(t, h.press(h.ctx, n, head))
	h.pass()
	squash := h.githubRef("main")
	require.Equal(t, h.pull(pr).MergeCommitSHA, squash, "GitHub's main is the squash commit")
	require.Equal(t, h.main, h.git(h.github, "rev-parse", squash+"^"))
	require.Equal(t, h.git(h.github, "rev-parse", head+"^{tree}"), h.git(h.github, "rev-parse", squash+"^{tree}"))
	state, _ := h.mergeCard(n)
	require.Equal(t, "merged", state, "Merged by GitHub's receipt and its main containing the merge")
	require.Equal(t, 1, follows, "the merge asks the sync to read main at once")
	require.Equal(t, h.main, h.hostRef("refs/heads/main"), "only the sync writes the install's main")

	writes := len(h.host.metas)
	require.NoError(t, sync.PollOnce(ctx))
	require.Equal(t, squash, h.hostRef("refs/heads/main"))
	row, err = q.GetGithubMainPull(ctx, h.repoID)
	require.NoError(t, err)
	require.Equal(t, "synced", row.State, row.LastError)
	require.Equal(t, []string{squash, squash}, []string{row.GithubHead, row.SmithersHead})
	require.Len(t, h.host.metas, writes+1)
	assert.Equal(t, middleware.CredentialSync, h.host.metas[writes].PusherCredential)
	health, err = sync.SyncHealth(ctx)
	require.NoError(t, err)
	require.Equal(t, "fresh", health.State)
	require.Equal(t, row.LastSyncedAt.Time, *health.LastSuccessAt)

	// The stack folds the main the sync brought in; the TODO stays Merged.
	h.pass()
	stack, err := q.GetMythicalStack(ctx, h.repoID)
	require.NoError(t, err)
	require.Equal(t, squash, stack.LandedMain, stack.LastError)
	require.Equal(t, h.hostTree(squash), h.hostTree(h.hostRef(repohost.MythicalBookmarkRef)), "the stack's tree is main's")
	state, _ = h.mergeCard(n)
	require.Equal(t, "merged", state)

	// Duplicate Retry admissions converge on the current tip; they do not
	// replay a transfer or manufacture another main write.
	writes = len(h.host.metas)
	require.NoError(t, sync.RetrySync(ctx))
	require.NoError(t, sync.RetrySync(ctx))
	require.NoError(t, sync.PollOnce(ctx))
	require.Len(t, h.host.metas, writes)
	health, err = sync.SyncHealth(ctx)
	require.NoError(t, err)
	require.NotNil(t, health.LastSuccessAt)
	require.Less(t, time.Since(*health.LastSuccessAt), 30*time.Second)

	// A cancelled HTTP read/retry cannot acknowledge success or schedule work.
	before, err := q.GetGithubMainPull(ctx, h.repoID)
	require.NoError(t, err)
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	_, err = sync.SyncHealth(cancelled)
	require.ErrorIs(t, err, context.Canceled)
	require.ErrorIs(t, sync.RetrySync(cancelled), context.Canceled)
	after, err := q.GetGithubMainPull(ctx, h.repoID)
	require.NoError(t, err)
	require.Equal(t, before.RequestedGeneration, after.RequestedGeneration)
	require.Equal(t, before.LastSyncedAt, after.LastSyncedAt)

	// Without the request, the sync reads main again 30 s after its last read.
	due := func(age int) bool {
		t.Helper()
		h.exec(`UPDATE github_main_pulls SET last_checked_at = NOW() - make_interval(secs => $1) WHERE repository_id = $2`, age, h.repoID)
		sync.Sweep(ctx)
		row, err := q.GetGithubMainPull(ctx, h.repoID)
		require.NoError(t, err)
		return row.RequestedGeneration > row.SyncedGeneration
	}
	require.False(t, due(29), "read 29 s ago")
	require.True(t, due(31), "read 31 s ago")
}

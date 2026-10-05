package services

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/stretchr/testify/require"
)

func TestInstallFollowDarkBeforeAnyDependencies(t *testing.T) {
	for _, absent := range []string{"sync", "qualification", "storage"} {
		t.Run(absent, func(t *testing.T) {
			stack := NewMythicalService(nil, nil)
			var synced *GitHubSyncedRepoService
			if absent != "sync" {
				synced = NewGitHubSyncedRepoService(nil)
			}
			if absent == "qualification" {
				synced.install = &gitHubInstallSync{}
			}
			stack.UseInstallGitHubPolling(synced)
			step := &mythicalItemStep{s: stack, now: time.Now()}
			next, saved, err := step.advance(t.Context(), db.MythicalItem{State: "proposed", PRNumber: pgtype.Int8{Int64: 7, Valid: true}})
			require.Error(t, err)
			require.Nil(t, next)
			require.False(t, saved)
		})
	}
}

func TestInstallFollowCadenceAndRetryDeadline(t *testing.T) {
	stack := NewMythicalService(nil, nil)
	require.Equal(t, 5*time.Minute, stack.pullPollEvery())
	stack.UseInstallGitHubPolling(nil)
	require.Equal(t, 45*time.Second, stack.pullPollEvery())
	now := time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)
	at := now.Add(90 * time.Second)
	failure := pkgerrors.New(pkgerrors.CodeGitHubRateLimited, "paused")
	failure.RetryAt = &at
	require.Equal(t, at, mythicalStepFailedDue(failure, now))
	require.Equal(t, at.Add(time.Minute), mythicalStepFailedDue(failure, at), "expired deadline cannot busy-loop")
}

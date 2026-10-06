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

func TestRejectedPullFollowWindowDoesNotSlide(t *testing.T) {
	closed := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	item := db.MythicalItem{State: "rejected", PRState: "closed", PRNumber: pgtype.Int8{Int64: 7, Valid: true}, UpdatedAt: pgtype.Timestamptz{Time: closed, Valid: true}}
	checks := mythicalChecksOf(item)
	checks.GitHubClosedAt = &closed
	item.Checks = checks.encode()
	item.UpdatedAt.Time = closed.Add(6 * 24 * time.Hour)
	for _, tc := range []struct {
		name     string
		at       time.Time
		followed bool
	}{
		{"day six", closed.Add(6 * 24 * time.Hour), true},
		{"day seven inclusive", closed.Add(7 * 24 * time.Hour), true},
		{"after window", closed.Add(7*24*time.Hour + time.Nanosecond), false},
		{"before close", closed.Add(-time.Nanosecond), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, tc.followed, mythicalReopenFollowed(item, tc.at))
			due := mythicalDue(item, false, tc.at)
			require.Equal(t, !tc.followed, due.IsZero())
		})
	}
	// Smithers Drop's timestamp remains fixed even when closing the PR and
	// retiring the lane update the row days later.
	item = mythicalDropped(item, todoDrop{At: closed, By: "ben"})
	item.UpdatedAt.Time = closed.Add(6 * 24 * time.Hour)
	require.True(t, mythicalReopenFollowed(item, closed.Add(7*24*time.Hour)))
	require.False(t, mythicalReopenFollowed(item, closed.Add(7*24*time.Hour+time.Nanosecond)))
	item.State = "landed"
	require.False(t, mythicalReopenFollowed(item, closed))
	item.State = "rejected"
	item.PRNumber.Valid = false
	require.False(t, mythicalReopenFollowed(item, closed))
}

func TestLocalDropFollowWindowDoesNotSlide(t *testing.T) {
	closed := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	for _, legacy := range []bool{false, true} {
		item := mythicalDropped(db.MythicalItem{State: "proposed", PRState: "closed", PRNumber: pgtype.Int8{Int64: 7, Valid: true}}, todoDrop{At: closed})
		if legacy {
			checks := mythicalChecksOf(item)
			checks.GitHubClosedAt = nil
			item.Checks = checks.encode()
		}
		item.UpdatedAt = pgtype.Timestamptz{Time: closed.Add(6 * 24 * time.Hour), Valid: true}
		for _, tc := range []struct {
			age      time.Duration
			followed bool
		}{
			{-time.Nanosecond, false}, {6 * 24 * time.Hour, true}, {7 * 24 * time.Hour, true}, {7*24*time.Hour + time.Nanosecond, false},
		} {
			require.Equal(t, tc.followed, mythicalReopenFollowed(item, closed.Add(tc.age)), "legacy=%v age=%s", legacy, tc.age)
			decision := decideGitHubFact(mythicalGitHubFact{Kind: "reopened"}, mythicalGitHubFactItem{State: item.State, ClosedAt: mythicalGitHubClosedAt(item)}, closed.Add(tc.age))
			require.Equal(t, tc.followed, decision.Event == "in_review")
		}
		item.PRState = "open"
		require.True(t, mythicalReopenFollowed(item, closed.Add(time.Hour)), "settled close observed a later reopen")
		item.PendingOp = []byte(`{"kind":"close"}`)
		require.False(t, mythicalReopenFollowed(item, closed.Add(time.Hour)), "unsettled close takes precedence")
	}
	item := db.MythicalItem{State: "cancelled", PRState: "closed", PRNumber: pgtype.Int8{Int64: 7, Valid: true}, UpdatedAt: pgtype.Timestamptz{Time: closed, Valid: true}}
	require.False(t, mythicalReopenFollowed(item, closed), "unrelated cancellation is not a person's drop")
}

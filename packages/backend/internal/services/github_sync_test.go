package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

func TestGitHubSyncHealth(t *testing.T) {
	now := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	at := func(age time.Duration) *time.Time { v := now.Add(-age); return &v }
	future := now.Add(time.Minute)
	expired := now.Add(-time.Nanosecond)
	for _, tc := range []struct {
		name           string
		streams        []GitHubSyncStream
		state, cause   string
		success, retry *time.Time
	}{
		{"119", []GitHubSyncStream{{LastSuccessAt: at(119 * time.Second)}}, "fresh", "", at(119 * time.Second), nil},
		{"120", []GitHubSyncStream{{LastSuccessAt: at(120 * time.Second)}}, "fresh", "", at(120 * time.Second), nil},
		{"121", []GitHubSyncStream{{LastSuccessAt: at(121 * time.Second)}}, "stale", "", at(121 * time.Second), nil},
		{"oldest", []GitHubSyncStream{{LastSuccessAt: at(time.Second)}, {LastSuccessAt: at(121 * time.Second)}}, "stale", "", at(121 * time.Second), nil},
		{"permission", []GitHubSyncStream{{Cause: "permission"}}, "refused", "permission", nil, nil},
		{"not installed", []GitHubSyncStream{{Cause: "not_installed"}}, "refused", "not_installed", nil, nil},
		{"limited beats stale", []GitHubSyncStream{{LastSuccessAt: at(121 * time.Second), RetryAt: &future}}, "limited", "", at(121 * time.Second), &future},
		{"refusal beats limited", []GitHubSyncStream{{Cause: "permission", RetryAt: &future}}, "refused", "permission", nil, &future},
		{"expired pause", []GitHubSyncStream{{LastSuccessAt: at(time.Second), RetryAt: &expired}}, "fresh", "", at(time.Second), nil},
		{"network", []GitHubSyncStream{{LastSuccessAt: at(121 * time.Second), Cause: "network"}}, "stale", "", at(121 * time.Second), nil},
		{"no streams", nil, "stale", "", nil, nil},
		{"missing success", []GitHubSyncStream{{}, {LastSuccessAt: at(time.Second)}}, "stale", "", nil, nil},
		{"future clock", []GitHubSyncStream{{LastSuccessAt: &future}}, "fresh", "", &future, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			health := aggregateGitHubSyncHealth(tc.streams, now)
			require.Equal(t, tc.state, health.State)
			require.Equal(t, tc.cause, health.Cause)
			require.Equal(t, tc.success, health.LastSuccessAt)
			require.Equal(t, tc.retry, health.RetryAt)
		})
	}
	later := future.Add(time.Minute)
	streams := []GitHubSyncStream{{Cause: "permission", RetryAt: &future}, {Cause: "not_installed", RetryAt: &later}}
	expected := GitHubSyncHealth{State: "refused", Cause: "not_installed", RetryAt: &later}
	require.Equal(t, expected, aggregateGitHubSyncHealth(streams, now))
	streams[0], streams[1] = streams[1], streams[0]
	require.Equal(t, expected, aggregateGitHubSyncHealth(streams, now))
}

type syncStreamFixture struct {
	streams []GitHubSyncStream
	err     error
	retries int
}

func (f *syncStreamFixture) RequiredStreams(context.Context) ([]GitHubSyncStream, error) {
	return f.streams, f.err
}
func (f *syncStreamFixture) RetryStreams(context.Context) error { f.retries++; return f.err }

// The install's GitHub sync is the main pull: it follows with no
// declaration, its receipt is the sync's health, a failed read keeps the
// last success (so health turns stale only past 120 s), and Retry makes
// every followed main due at once.
func TestInstallGitHubSyncFollowsMainAndServesItsHealth(t *testing.T) {
	const pullNext = "3333333333333333333333333333333333333333"
	h := newPullHarness(t)
	h.service.UseInstallPolicy()
	ctx := t.Context()
	var unavailable *GitHubSyncUnavailable
	_, err := h.service.SyncHealth(ctx)
	require.ErrorAs(t, err, &unavailable, "no followed repository yet: no health")
	require.Equal(t, "github_sync_unavailable", unavailable.Code)

	require.NoError(t, h.service.RequestForGitHub(ctx, "smithersai", "smithers"))
	require.NoError(t, h.service.PollOnce(ctx))
	require.Equal(t, pullNew, h.host.bookmarkSnapshot("main"))
	synced := h.row(t)
	require.Equal(t, "synced", synced.State)
	require.Equal(t, 0, h.policyReads, "an install never reads a declaration")
	health, err := h.service.SyncHealth(ctx)
	require.NoError(t, err)
	require.Equal(t, "fresh", health.State)
	require.Equal(t, synced.LastSyncedAt.Time, *health.LastSuccessAt)

	// The network drops: Retry reads at once and fails; the last success stands.
	h.github = pullNext
	h.service.lsRemote = func(context.Context, string, string) (string, error) {
		return "", errors.New("git ls-remote failed: Could not resolve host: github.com")
	}
	require.NoError(t, h.service.RetrySync(ctx))
	require.NoError(t, h.service.PollOnce(ctx))
	failed := h.row(t)
	require.Equal(t, "failed", failed.State)
	require.Equal(t, synced.LastSyncedAt, failed.LastSyncedAt)
	require.Equal(t, pullNew, h.host.bookmarkSnapshot("main"))
	health, err = h.service.SyncHealth(ctx)
	require.NoError(t, err)
	require.Equal(t, "fresh", health.State, "within 120 s of the last success")
	h.service.now = func() time.Time { return synced.LastSyncedAt.Time.Add(121 * time.Second) }
	health, err = h.service.SyncHealth(ctx)
	require.NoError(t, err)
	require.Equal(t, "stale", health.State)
	require.Equal(t, synced.LastSyncedAt.Time, *health.LastSuccessAt)

	// The network is back: Retry overrides the failure's backoff.
	h.service.now = time.Now
	h.service.lsRemote = func(context.Context, string, string) (string, error) { return h.github, nil }
	require.True(t, h.row(t).NextAttemptAt.Time.After(time.Now()), "a failure backs off")
	require.NoError(t, h.service.RetrySync(ctx))
	require.NoError(t, h.service.PollOnce(ctx))
	require.Equal(t, pullNext, h.host.bookmarkSnapshot("main"))
	health, err = h.service.SyncHealth(ctx)
	require.NoError(t, err)
	require.Equal(t, "fresh", health.State)
	require.True(t, health.LastSuccessAt.After(synced.LastSyncedAt.Time))
	// Every write of the install's main presents the sync's authority.
	require.Len(t, h.host.meta, 2)
	for _, meta := range h.host.meta {
		require.Equal(t, middleware.CredentialSync, meta.PusherCredential)
	}
}

// The install reads main every 30 s, so a commit whose factory projection it
// reconciled is not read again; a failed reconciliation retries.
func TestInstallGitHubSyncReconcilesEachCommitOnce(t *testing.T) {
	h := newPullHarness(t)
	h.service.UseInstallPolicy()
	h.github = pullOld
	reads, fail := 0, true
	h.service.readFactory = func(context.Context, string, string, string, string) ([]byte, error) {
		reads++
		return []byte(`{"on":[]}`), nil
	}
	h.service.SetFactoryReconciler(func(context.Context, int64, string, FactoryProjection) error {
		if fail {
			return errors.New("registry unavailable")
		}
		return nil
	})
	poll := func() db.GithubMainPull {
		t.Helper()
		_, err := h.service.Request(t.Context(), 19)
		require.NoError(t, err)
		require.NoError(t, h.service.PollOnce(t.Context()))
		return h.row(t)
	}
	require.Equal(t, "failed", poll().FactoryState)
	fail = false
	require.Equal(t, "empty", poll().FactoryState, "a failure retries on the next read")
	require.Equal(t, "synced", poll().State)
	require.Equal(t, 2, reads, "a reconciled commit is not read again")
	h.github = pullNew
	require.Equal(t, "empty", poll().FactoryState)
	require.Equal(t, 3, reads, "a new commit is")
}

func TestGitHubSyncProviderErrorsAndAdmission(t *testing.T) {
	s := NewGitHubMainPullService(nil, nil, nil, nil)
	var unavailable *GitHubSyncUnavailable
	require.ErrorAs(t, s.RetrySync(t.Context()), &unavailable, "no receipts: no Retry")
	f := &syncStreamFixture{}
	s.syncStreams = f
	_, err := s.SyncHealth(t.Context())
	require.Error(t, err)
	f.err = errors.New("receipt read failed")
	_, err = s.SyncHealth(t.Context())
	require.ErrorIs(t, err, f.err)
	require.ErrorIs(t, s.RetrySync(t.Context()), f.err)
	require.Equal(t, 1, f.retries)
}

func TestGitHubSyncStaleTimerRecoversWithoutPolling(t *testing.T) {
	for _, restart := range []bool{false, true} {
		t.Run(map[bool]string{false: "boundary", true: "restart"}[restart], func(t *testing.T) {
			s := NewGitHubMainPullService(nil, nil, nil, nil)
			success := time.Now().Add(-120*time.Second + 200*time.Millisecond)
			s.syncStreams = &syncStreamFixture{streams: []GitHubSyncStream{{LastSuccessAt: &success}}}
			changes := make(chan struct{}, 1)
			frames := make(chan GitHubSyncHealth, 8)
			start := func() (context.CancelFunc, chan error) {
				ctx, cancel := context.WithCancel(t.Context())
				done := make(chan error, 1)
				go func() { done <- s.WatchSyncHealth(ctx, changes, func(h GitHubSyncHealth) { frames <- h }) }()
				return cancel, done
			}
			receive := func() GitHubSyncHealth {
				select {
				case frame := <-frames:
					return frame
				case <-time.After(time.Second):
					t.Fatal("missing frame")
					return GitHubSyncHealth{}
				}
			}
			cancel, done := start()
			require.Equal(t, "fresh", receive().State)
			if restart {
				cancel()
				require.ErrorIs(t, <-done, context.Canceled)
				cancel, done = start()
				require.Equal(t, "fresh", receive().State)
			}
			defer cancel()
			require.Equal(t, "stale", receive().State)
			changes <- struct{}{}
			close(changes)
			require.NoError(t, <-done)
			require.Empty(t, frames, "same receipt must not emit a second stale delta")
		})
	}
	s := NewGitHubMainPullService(nil, nil, nil, nil)
	require.Error(t, s.WatchSyncHealth(t.Context(), nil, func(GitHubSyncHealth) { t.Fatal("missing provider published") }))
}

func TestGitHubSyncPauseTimerRecoversWithoutPolling(t *testing.T) {
	for _, cause := range []string{"", "permission"} {
		t.Run(cause, func(t *testing.T) {
			s := NewGitHubMainPullService(nil, nil, nil, nil)
			success := time.Now().Add(-121 * time.Second)
			retry := time.Now().Add(40 * time.Millisecond)
			s.syncStreams = &syncStreamFixture{streams: []GitHubSyncStream{{LastSuccessAt: &success, RetryAt: &retry, Cause: cause}}}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			frames := make(chan GitHubSyncHealth, 4)
			done := make(chan error, 1)
			go func() { done <- s.WatchSyncHealth(ctx, nil, func(h GitHubSyncHealth) { frames <- h }) }()
			receive := func() GitHubSyncHealth {
				select {
				case frame := <-frames:
					return frame
				case <-time.After(time.Second):
					t.Fatal("pause expiry did not publish without polling")
					return GitHubSyncHealth{}
				}
			}
			initial := receive()
			require.Equal(t, &retry, initial.RetryAt)
			settled := receive()
			require.Nil(t, settled.RetryAt)
			if cause == "" {
				require.Equal(t, "limited", initial.State)
				require.Equal(t, "stale", settled.State)
			} else {
				require.Equal(t, "refused", initial.State)
				require.Equal(t, "refused", settled.State)
				require.Equal(t, cause, settled.Cause)
			}
			cancel()
			require.ErrorIs(t, <-done, context.Canceled)
			require.Empty(t, frames)
		})
	}
}

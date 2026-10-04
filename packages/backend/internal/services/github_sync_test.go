package services

import (
	"context"
	"errors"
	"github.com/stretchr/testify/require"
	"testing"
	"time"
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

func TestGitHubSyncMissingProvidersHaveZeroEffects(t *testing.T) {
	h := newPullHarness(t)
	h.service.UseInstallPolicy()
	require.Error(t, h.service.RequestForGitHub(t.Context(), "smithersai", "smithers"))
	_, err := h.service.Request(t.Context(), 19)
	require.Error(t, err)
	require.Error(t, h.service.PollOnce(t.Context()))
	h.service.Sweep(t.Context())
	h.service.Start(t.Context())
	require.Error(t, h.service.RetrySync(t.Context()))
	require.Error(t, h.service.ResetToGitHub(t.Context(), 19, pullOld, pullNew))
	_, err = h.service.SyncHealth(t.Context())
	require.Error(t, err)
	require.Equal(t, pullOld, h.host.bookmarkSnapshot("main"))
	require.Equal(t, 0, h.policyReads)
	var unavailable *GitHubSyncUnavailable
	require.ErrorAs(t, err, &unavailable)
	require.Equal(t, "infra", unavailable.Class)
	_, err = h.store.GetGithubMainPull(t.Context(), 19)
	require.Error(t, err, "no request was persisted")
}

func TestGitHubSyncProviderErrorsAndAdmission(t *testing.T) {
	s := NewGitHubMainPullService(nil, nil, nil, nil)
	f := &syncStreamFixture{}
	s.syncStreams = f
	_, err := s.SyncHealth(t.Context())
	require.Error(t, err)
	f.err = errors.New("receipt read failed")
	_, err = s.SyncHealth(t.Context())
	require.ErrorIs(t, err, f.err)
	require.ErrorIs(t, s.RetrySync(t.Context()), f.err)
	require.Equal(t, 1, f.retries)
	s.UseInstallPolicy()
	require.Error(t, s.RetrySync(t.Context()))
	require.Equal(t, 1, f.retries, "install cannot bypass missing authority")
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

package services

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

type wakeMainPullStore struct {
	*fakeMainPullStore
	idle chan struct{}
	fail int64
}

func (s *wakeMainPullStore) ClaimGithubMainPulls(ctx context.Context, limit int32, lease float64) ([]db.GithubMainPull, error) {
	rows, err := s.fakeMainPullStore.ClaimGithubMainPulls(ctx, limit, lease)
	if len(rows) == 0 {
		select {
		case s.idle <- struct{}{}:
		default:
		}
	}
	return rows, err
}

func (s *wakeMainPullStore) RequestGithubMainPull(ctx context.Context, id int64) (db.GithubMainPull, error) {
	if id == s.fail {
		return db.GithubMainPull{}, errors.New("request write failed")
	}
	return s.fakeMainPullStore.RequestGithubMainPull(ctx, id)
}

func TestInstallMainPullRequestWakesWorkerBeforePeriodicTick(t *testing.T) {
	for _, source := range []string{"direct", "github-hint"} {
		t.Run(source, func(t *testing.T) {
			h := newPullHarness(t)
			store := &wakeMainPullStore{fakeMainPullStore: h.store, idle: make(chan struct{}, 1)}
			h.service.store = store
			qualifyMainPullFixture(h.service)
			started := make(chan struct{}, 1)
			var reads atomic.Int32
			h.service.lsRemote = func(ctx context.Context, _ string, _ ...string) (map[string]string, error) {
				reads.Add(1)
				started <- struct{}{}
				<-ctx.Done()
				return nil, ctx.Err()
			}
			ctx, cancel := context.WithCancel(t.Context())
			done := make(chan struct{})
			go func() { defer close(done); h.service.Start(ctx) }()
			t.Cleanup(func() {
				cancel()
				select {
				case <-done:
				case <-time.After(5 * time.Second):
					t.Error("worker did not stop")
				}
			})
			select {
			case <-store.idle:
			case <-time.After(time.Second):
				t.Fatal("worker never became idle")
			}
			request := func() error {
				if source == "github-hint" {
					return h.service.RequestForGitHub(ctx, "smithersai", "smithers")
				}
				status, err := h.service.Request(ctx, 19)
				if err == nil {
					require.True(t, status.Pending)
					require.False(t, status.Fresh)
				}
				return err
			}
			require.NoError(t, request(), "request returns while the remote read remains unresolved")
			select {
			case <-started:
			case <-time.After(time.Second):
				t.Fatal("hint waited for the five-second periodic tick")
			}
			for range 20 {
				require.NoError(t, request())
			}
			require.EqualValues(t, 1, reads.Load(), "duplicate hints cannot start concurrent reads")
		})
	}
}

func TestInstallMainPullWakeFollowsDurableRequest(t *testing.T) {
	for _, tc := range []struct {
		name     string
		ids      []int64
		fail     int64
		wantWake bool
		wantErr  bool
	}{
		{"no-binding", nil, 0, false, false},
		{"failed-first", []int64{19}, 19, false, true},
		{"partial-success", []int64{19, 20}, 20, true, true},
		{"success", []int64{19}, 0, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newPullHarness(t)
			h.store.bySource["smithersai/smithers"] = tc.ids
			h.service.store = &wakeMainPullStore{fakeMainPullStore: h.store, fail: tc.fail}
			qualifyMainPullFixture(h.service)
			err := h.service.RequestForGitHub(t.Context(), "smithersai", "smithers")
			require.Equal(t, tc.wantErr, err != nil)
			select {
			case <-h.service.wake:
				require.True(t, tc.wantWake)
			default:
				require.False(t, tc.wantWake)
			}
		})
	}
	h := newPullHarness(t)
	h.service.store = &wakeMainPullStore{fakeMainPullStore: h.store, fail: 19}
	qualifyMainPullFixture(h.service)
	_, err := h.service.Request(t.Context(), 19)
	require.Error(t, err)
	select {
	case <-h.service.wake:
		t.Fatal("failed direct request woke worker")
	default:
	}
}

func TestHostedMainPullRequestRetainsPeriodicScheduling(t *testing.T) {
	h := newPullHarness(t)
	_, err := h.service.Request(t.Context(), 19)
	require.NoError(t, err)
	require.NoError(t, h.service.RequestForGitHub(t.Context(), "smithersai", "smithers"))
	select {
	case <-h.service.wake:
		t.Fatal("hosted scheduling changed")
	default:
	}
}

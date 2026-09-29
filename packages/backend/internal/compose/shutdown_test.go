package compose

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
)

func TestServerShutdownTimeoutParsesConfiguredDuration(t *testing.T) {
	timeout, err := serverShutdownTimeout(config.ServerConfig{ShutdownTimeout: "45s"})
	require.NoError(t, err)
	assert.Equal(t, 45*time.Second, timeout)
}

func TestShutdownAccountingForcedCancellation(t *testing.T) {
	for _, mode := range []string{"normal", "cancelled", "still_active"} {
		t.Run(mode, func(t *testing.T) {
			tracker := newInFlightRequestTracker()
			started := make(chan struct{})
			release := make(chan struct{})
			server := httptest.NewServer(tracker.Wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				close(started)
				if mode == "cancelled" {
					<-r.Context().Done()
					w.WriteHeader(http.StatusServiceUnavailable)
					return
				}
				<-release
				w.WriteHeader(http.StatusNoContent)
			})))
			defer server.Close()
			defer func() {
				select {
				case <-release:
				default:
					close(release)
				}
			}()
			status := make(chan int, 1)
			go func() {
				response, err := server.Client().Get(server.URL)
				if err != nil {
					status <- 0
					return
				}
				defer response.Body.Close()
				status <- response.StatusCode
			}()
			select {
			case <-started:
			case <-time.After(time.Second):
				t.Fatal("request did not start")
			}
			require.Equal(t, int64(1), tracker.BeginShutdown())
			if mode == "normal" {
				close(release)
			}
			budget := 20 * time.Millisecond
			if mode == "normal" {
				budget = time.Second
			}
			ctx, cancel := context.WithTimeout(context.Background(), budget)
			defer cancel()
			err := tracker.WaitForDrain(ctx)
			if mode == "normal" {
				require.NoError(t, err)
			} else {
				require.True(t, errors.Is(err, context.DeadlineExceeded), "drain error: %v", err)
			}
			if mode == "still_active" {
				assert.Equal(t, [3]int64{0, 1, 1}, snapshotCounts(tracker))
				close(release)
				// The request eventually returning must not change its classification.
			} else if mode == "cancelled" {
				assert.Equal(t, [3]int64{0, 1, 0}, snapshotCounts(tracker))
			}
			select {
			case code := <-status:
				want := http.StatusNoContent
				if mode == "cancelled" {
					want = http.StatusServiceUnavailable
				}
				assert.Equal(t, want, code)
			case <-time.After(time.Second):
				t.Fatal("HTTP response did not finish")
			}
			want := [3]int64{0, 1, 0}
			if mode == "normal" {
				want = [3]int64{1, 0, 0}
			}
			require.Eventually(t, func() bool { return snapshotCounts(tracker) == want }, time.Second, time.Millisecond)
		})
	}
}

func snapshotCounts(tracker *inFlightRequestTracker) [3]int64 {
	drained, killed, active := tracker.Snapshot()
	return [3]int64{drained, killed, active}
}

func TestServerShutdownTimeoutRejectsInvalidDuration(t *testing.T) {
	_, err := serverShutdownTimeout(config.ServerConfig{ShutdownTimeout: "0s"})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "server.shutdown_timeout must be > 0")

	_, err = serverShutdownTimeout(config.ServerConfig{ShutdownTimeout: "soon"})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "server.shutdown_timeout is invalid")
}

func TestLFSVerifyTimeoutReservesWriteHeadroom(t *testing.T) {
	t.Parallel()

	assert.Equal(t, 595*time.Second, lfsVerifyTimeout(&config.Config{
		Server: config.ServerConfig{WriteTimeoutSecs: 600},
	}))
	assert.Equal(t, 25*time.Second, lfsVerifyTimeout(&config.Config{
		Server: config.ServerConfig{WriteTimeoutSecs: 30},
	}))
	assert.Equal(t, 500*time.Millisecond, lfsVerifyTimeout(&config.Config{
		Server: config.ServerConfig{WriteTimeoutSecs: 1},
	}))
	assert.Equal(t, defaultLFSVerifyJSONTimeout, lfsVerifyTimeout(&config.Config{}))
}

func TestInFlightRequestTrackerShutdownStats(t *testing.T) {
	tracker := newInFlightRequestTracker()
	started := make(chan struct{})
	release := make(chan struct{})
	done := make(chan struct{})

	handler := tracker.Wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-release
		w.WriteHeader(http.StatusNoContent)
	}))

	go func() {
		defer close(done)
		handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/slow", nil))
	}()

	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("request did not start")
	}

	inFlight := tracker.BeginShutdown()
	assert.Equal(t, int64(1), inFlight)

	drained, killed, activeRemaining := tracker.Snapshot()
	assert.Equal(t, int64(0), drained)
	assert.Equal(t, int64(1), killed)
	assert.Equal(t, int64(1), activeRemaining)

	close(release)

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("request did not finish")
	}

	drained, killed, activeRemaining = tracker.Snapshot()
	assert.Equal(t, int64(1), drained)
	assert.Equal(t, int64(0), killed)
	assert.Equal(t, int64(0), activeRemaining)
}

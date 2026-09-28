package chat

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"testing"
	"testing/synctest"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/require"
)

type chatRuntimeUnitHost func(context.Context, ProducerGrant) error

func (f chatRuntimeUnitHost) RunChatTurn(ctx context.Context, grant ProducerGrant) error {
	return f(ctx, grant)
}

func (f chatRuntimeUnitHost) RunTurn(ctx context.Context, grant ProducerGrant) error {
	return f(ctx, grant)
}

func TestChatRuntimeUnitRejectsInvalidCompositionBeforeDatabaseAccess(t *testing.T) {
	host := chatRuntimeUnitHost(func(context.Context, ProducerGrant) error {
		t.Fatal("invalid composition dispatched a host")
		return nil
	})
	runtime, err := NewRuntime(nil, nil, "https://callback.invalid", RuntimeOptions{})
	require.Nil(t, runtime)
	require.EqualError(t, err, "chat runtime requires a model host")
	for _, callback := range []string{"", "/relative", "ftp://callback.invalid", "https://", "https://user:private@callback.invalid", "https://callback.invalid?secret=private", "https://callback.invalid#private", "https://callback.invalid:bad", "https://callback.invalid/%XX"} {
		runtime, err := NewRuntime(nil, host, callback, RuntimeOptions{})
		require.Nil(t, runtime)
		require.EqualError(t, err, "chat producer callback URL is invalid", "callback details must not enter error text")
	}
	for _, options := range []RuntimeOptions{
		{QueueSize: -1}, {Concurrency: -1}, {Lease: -time.Nanosecond},
		{QueueSize: -1, Concurrency: -1, Lease: -time.Nanosecond},
	} {
		runtime, err := NewRuntime(nil, host, "https://callback.invalid", options)
		require.Nil(t, runtime)
		require.EqualError(t, err, "chat runtime options are invalid")
	}
	runtime, err = NewRuntime(nil, host, "https://callback.invalid", RuntimeOptions{})
	require.Nil(t, runtime)
	require.EqualError(t, err, "chat store requires a PostgreSQL pool")
	for _, runtime := range []*Runtime{nil, {}} {
		require.EqualError(t, runtime.Run(t.Context()), "chat runtime is not configured")
	}
}

func TestChatRuntimeUnitOptionsComposeIndependentlyWithoutLaunchingWork(t *testing.T) {
	pool, attempts := chatListenerUnitPool(t)
	defer pool.Close()
	host := chatRuntimeUnitHost(func(context.Context, ProducerGrant) error {
		t.Fatal("construction launched model work")
		return nil
	})
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	for _, queue := range []int{0, 1} {
		for _, concurrency := range []int{0, 3} {
			for _, lease := range []time.Duration{0, time.Nanosecond} {
				for _, explicitLogger := range []bool{false, true} {
					options := RuntimeOptions{QueueSize: queue, Concurrency: concurrency, Lease: lease}
					wantedLogger := slog.Default()
					if explicitLogger {
						options.Logger, wantedLogger = logger, logger
					}
					runtime, err := NewRuntime(pool, host, " https://callback.invalid/prefix/ ", options)
					require.NoError(t, err)
					wantedQueue, wantedConcurrency, wantedLease := queue, concurrency, lease
					if queue == 0 {
						wantedQueue = 256
					}
					if concurrency == 0 {
						wantedConcurrency = 4
					}
					if lease == 0 {
						wantedLease = 2 * time.Minute
					}
					require.Equal(t, wantedQueue, cap(runtime.dispatcher.queue))
					require.Equal(t, wantedConcurrency, runtime.concurrency)
					require.Equal(t, wantedLease, runtime.dispatcher.lease)
					require.Same(t, wantedLogger, runtime.dispatcher.logger)
					require.Same(t, wantedLogger, runtime.Handler.logger)
					require.Same(t, runtime.store, runtime.Handler.Store)
					require.Same(t, runtime.dispatcher, runtime.Handler.Dispatcher)
					require.Equal(t, "https://callback.invalid/prefix/", runtime.dispatcher.host.(PortHost).ProducerBaseURL)
					registry := prometheus.NewRegistry()
					for _, collector := range runtime.Collectors() {
						require.NoError(t, registry.Register(collector))
					}
					_, err = registry.Gather()
					require.NoError(t, err, "every runtime owns independent valid metrics")
				}
			}
		}
	}
	require.Zero(t, attempts.Load(), "composition must not acquire a database connection")
}

func TestChatRuntimeUnitCancelledRunJoinsBackgroundWorkers(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		pool, _ := chatListenerUnitPool(t)
		defer pool.Close()
		host := chatRuntimeUnitHost(func(context.Context, ProducerGrant) error {
			t.Error("cancelled empty runtime launched a host")
			return nil
		})
		runtime, err := NewRuntime(pool, host, "http://callback.invalid", RuntimeOptions{Concurrency: 3})
		require.NoError(t, err)
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		start := time.Now()
		require.NoError(t, runtime.Run(ctx))
		require.Zero(t, time.Since(start), "shutdown must not wait for recovery or renewal timers")
		// synctest also refuses a leaked listener, recovery watcher, or worker.
	})
}

func TestChatRuntimeUnitPortHostForwardsGrantContextAndExactFailure(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	grant := chatHostUnitGrant()
	grant.ProducerBaseURL = "https://untrusted.invalid"
	failure := errors.New("host stopped before provider start")
	calls := 0
	host := PortHost{ProducerBaseURL: "https://authorized.invalid/callback", Host: chatRuntimeUnitHost(func(gotContext context.Context, got ProducerGrant) error {
		calls++
		require.Equal(t, ctx, gotContext)
		require.ErrorIs(t, gotContext.Err(), context.Canceled)
		want := grant
		want.ProducerBaseURL = "https://authorized.invalid/callback"
		require.Equal(t, want, got)
		return failure
	})}
	require.Same(t, failure, host.RunTurn(ctx, grant))
	require.Equal(t, 1, calls)
	require.Equal(t, "https://untrusted.invalid", grant.ProducerBaseURL, "caller grant is not rewritten")
}

func TestChatDispatcherUnitAdmissionAndQueueSaturation(t *testing.T) {
	pool, attempts := chatListenerUnitPool(t)
	defer pool.Close()
	store, err := NewStore(pool)
	require.NoError(t, err)
	host := chatRuntimeUnitHost(func(context.Context, ProducerGrant) error {
		t.Fatal("admission launched host work synchronously")
		return nil
	})
	for _, row := range []struct {
		store *Store
		host  Host
		queue int
		lease time.Duration
	}{
		{nil, host, 1, time.Second}, {store, nil, 1, time.Second},
		{store, host, 0, time.Second}, {store, host, -1, time.Second},
		{store, host, 1, 0}, {store, host, 1, -time.Nanosecond},
	} {
		dispatcher, err := NewDispatcher(row.store, row.host, row.queue, row.lease)
		require.Nil(t, dispatcher)
		require.EqualError(t, err, "invalid chat dispatcher configuration")
	}
	dispatcher, err := NewDispatcher(store, host, 2, time.Second)
	require.NoError(t, err)
	for _, concurrency := range []int{0, -1} {
		require.EqualError(t, dispatcher.Run(t.Context(), concurrency), "chat dispatcher concurrency must be positive")
	}
	first := Candidate{Scope: Scope{UserID: 1, Owner: "first"}, TurnID: "first"}
	second := Candidate{Scope: Scope{UserID: 2, Owner: "second"}, TurnID: "second"}
	third := Candidate{Scope: Scope{UserID: 3, Owner: "third"}, TurnID: "third"}
	require.Zero(t, testutil.ToFloat64(dispatcher.metrics.queued))
	require.True(t, dispatcher.Enqueue(first))
	require.True(t, dispatcher.Enqueue(second))
	require.Equal(t, float64(2), testutil.ToFloat64(dispatcher.metrics.queued))
	require.False(t, dispatcher.Enqueue(third), "saturated queue must return immediately and retain admitted work")
	require.Equal(t, first, <-dispatcher.queue)
	require.Equal(t, float64(1), testutil.ToFloat64(dispatcher.metrics.queued))
	require.True(t, dispatcher.Enqueue(third), "draining a slot admits later work")
	require.Equal(t, second, <-dispatcher.queue)
	require.Equal(t, third, <-dispatcher.queue)
	require.Zero(t, testutil.ToFloat64(dispatcher.metrics.queued))
	require.Zero(t, attempts.Load(), "enqueue and local saturation never wait for SQL")
}

func TestChatDispatcherUnitCancelTargetsOnlyTheRunningTurn(t *testing.T) {
	first, cancelFirst := context.WithCancel(context.Background())
	defer cancelFirst()
	second, cancelSecond := context.WithCancel(context.Background())
	defer cancelSecond()
	dispatcher := &Dispatcher{running: map[string]runningTurn{
		"first": {generation: 1, cancel: cancelFirst}, "second": {generation: 2, cancel: cancelSecond},
	}}
	dispatcher.CancelRunning("missing")
	require.NoError(t, first.Err())
	require.NoError(t, second.Err())
	dispatcher.CancelRunning("first")
	dispatcher.CancelRunning("first")
	require.ErrorIs(t, first.Err(), context.Canceled)
	require.NoError(t, second.Err())
	dispatcher.CancelRunning("second")
	require.ErrorIs(t, second.Err(), context.Canceled)
}

func TestChatRuntimeUnitMetricErrorLabelsPreserveWrappedKinds(t *testing.T) {
	for _, row := range []struct {
		err  error
		code string
	}{
		{ErrCorrupt, "corrupt"}, {ErrProducerFenced, "producer_fenced"}, {ErrProducerBusy, "producer_busy"},
		{ErrTerminal, "terminal"}, {ErrRetired, "retired"}, {ErrUncertain, "uncertain"},
		{ErrNotFound, "not_found"}, {ErrForbidden, "forbidden"}, {ErrLimit, "limit"},
		{ErrCursorConflict, "cursor"}, {ErrInvalidRequest, "invalid"}, {ErrInvalidFrame, "invalid"},
		{errors.New("private storage path and request identity"), "storage"},
	} {
		require.Equal(t, row.code, errorCode(row.err))
		require.Equal(t, row.code, errorCode(fmt.Errorf("operation: %w", row.err)))
	}
	require.Equal(t, "ok", errorCode(nil))
	// A corrupt journal takes priority over a transient lease conflict.
	for _, joined := range []error{errors.Join(ErrCorrupt, ErrProducerBusy), errors.Join(ErrProducerBusy, ErrCorrupt)} {
		require.Equal(t, "corrupt", errorCode(joined))
	}
}

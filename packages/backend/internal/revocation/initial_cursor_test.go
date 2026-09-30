package revocation

import (
	"context"
	"encoding/json"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

func TestDelayedNotificationFromSkippedHistoryDoesNotDisableEnabledUser(t *testing.T) {
	log := newFakeLog()
	disabled, err := log.InsertRevocationEvent(context.Background(), Event{Kind: KindUserDisabled, UserID: 7}.ToParams())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := log.InsertRevocationEvent(context.Background(), Event{Kind: KindUserEnabled, UserID: 7}.ToParams()); err != nil {
		t.Fatal(err)
	}
	bus, cancel := startBus(t, log)
	defer cancel()
	if bus.Cursor() != 2 || bus.IsUserDisabled(7) {
		t.Fatalf("startup must skip history: cursor=%d disabled=%v", bus.Cursor(), bus.IsUserDisabled(7))
	}
	watchCtx, stopWatch := context.WithCancel(context.Background())
	defer stopWatch()
	watch := bus.Watch(watchCtx, Principal{UserID: 7})
	oldPayload, err := json.Marshal(FromRow(disabled))
	if err != nil {
		t.Fatal(err)
	}
	bus.deliverPayload(context.Background(), string(oldPayload))
	if bus.IsUserDisabled(7) {
		t.Fatal("late skipped suspension disabled a re-enabled user")
	}
	select {
	case event := <-watch:
		t.Fatalf("late skipped suspension closed a new watch: %+v", event)
	default:
	}

	// The boundary must not discard notifications for events committed later.
	newRow, err := log.InsertRevocationEvent(context.Background(), Event{Kind: KindUserDisabled, UserID: 7}.ToParams())
	if err != nil {
		t.Fatal(err)
	}
	newPayload, err := json.Marshal(FromRow(newRow))
	if err != nil {
		t.Fatal(err)
	}
	bus.deliverPayload(context.Background(), string(newPayload))
	if event := waitFor(t, watch, time.Second); event.ID != newRow.ID || !bus.IsUserDisabled(7) {
		t.Fatalf("new suspension was lost after startup: %+v", event)
	}
}

type gatedInitialLog struct {
	*fakeLog
	entered   chan struct{}
	release   chan struct{}
	failFirst bool
	attempts  atomic.Int32
}

func newGatedInitialLog() *gatedInitialLog {
	return &gatedInitialLog{
		fakeLog: newFakeLog(),
		entered: make(chan struct{}, 4),
		release: make(chan struct{}),
	}
}

func (l *gatedInitialLog) LatestRevocationEventID(ctx context.Context) (int64, error) {
	attempt := l.attempts.Add(1)
	select {
	case l.entered <- struct{}{}:
	default:
	}
	if l.failFirst && attempt == 1 {
		return 0, errors.New("initial read failed")
	}
	select {
	case <-l.release:
		return l.fakeLog.LatestRevocationEventID(ctx)
	case <-ctx.Done():
		return 0, ctx.Err()
	}
}

func releaseInitialRead(l *gatedInitialLog) {
	select {
	case <-l.release:
	default:
		close(l.release)
	}
}

func awaitInitialRead(t *testing.T, l *gatedInitialLog) {
	t.Helper()
	select {
	case <-l.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("initial cursor read never began")
	}
}

func requireStartPending(t *testing.T, started <-chan error) {
	t.Helper()
	select {
	case err := <-started:
		t.Fatalf("Start returned before initial cursor read finished: %v", err)
	case <-time.After(30 * time.Millisecond):
	}
}

func awaitStart(t *testing.T, started <-chan error) error {
	t.Helper()
	select {
	case err := <-started:
		return err
	case <-time.After(3 * time.Second):
		t.Fatal("Start did not finish")
		return nil
	}
}

func TestStartWaitsForInitialCursorAndDeliversLaterDeletion(t *testing.T) {
	log := newGatedInitialLog()
	t.Cleanup(func() { releaseInitialRead(log) })
	if _, err := log.InsertRevocationEvent(context.Background(), Event{Kind: KindTokenRevoked, TokenHash: "old"}.ToParams()); err != nil {
		t.Fatal(err)
	}
	bus := newBus(log)
	bus.PollInterval = 10 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	started := make(chan error, 1)
	go func() { started <- bus.Start(ctx) }()
	awaitInitialRead(t, log)
	requireStartPending(t, started)
	releaseInitialRead(log)
	if err := awaitStart(t, started); err != nil {
		t.Fatal(err)
	}
	if !bus.Positioned() || bus.Cursor() != 1 {
		t.Fatalf("Start returned before initial cursor was positioned: positioned=%v cursor=%d", bus.Positioned(), bus.Cursor())
	}
	if bus.IsTokenRevoked("old") {
		t.Fatal("history before Start was replayed")
	}
	watch := bus.Watch(ctx, Principal{TokenHash: "deleted"})
	if _, err := log.InsertRevocationEvent(context.Background(), Event{Kind: KindTokenRevoked, TokenHash: "deleted"}.ToParams()); err != nil {
		t.Fatal(err)
	}
	event := waitFor(t, watch, 2*time.Second)
	if event.ID != 2 || event.TokenHash != "deleted" || !bus.IsTokenRevoked("deleted") {
		t.Fatalf("deletion after Start not delivered: %+v", event)
	}
}

func TestConcurrentStartCallsWaitForSameInitialCursor(t *testing.T) {
	log := newGatedInitialLog()
	t.Cleanup(func() { releaseInitialRead(log) })
	bus := newBus(log)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	first := make(chan error, 1)
	second := make(chan error, 1)
	go func() { first <- bus.Start(ctx) }()
	awaitInitialRead(t, log)
	go func() { second <- bus.Start(ctx) }()
	requireStartPending(t, first)
	requireStartPending(t, second)
	releaseInitialRead(log)
	if err := awaitStart(t, first); err != nil {
		t.Fatal(err)
	}
	if err := awaitStart(t, second); err != nil {
		t.Fatal(err)
	}
	if !bus.Positioned() || log.attempts.Load() != 1 {
		t.Fatalf("concurrent Start: positioned=%v initial reads=%d", bus.Positioned(), log.attempts.Load())
	}
}

func TestCanceledConcurrentStartDoesNotStopOwner(t *testing.T) {
	log := newGatedInitialLog()
	t.Cleanup(func() { releaseInitialRead(log) })
	bus := newBus(log)
	ownerCtx, stopOwner := context.WithCancel(context.Background())
	defer stopOwner()
	owner := make(chan error, 1)
	go func() { owner <- bus.Start(ownerCtx) }()
	awaitInitialRead(t, log)

	waiterCtx, stopWaiter := context.WithCancel(context.Background())
	defer stopWaiter()
	waiter := make(chan error, 1)
	go func() { waiter <- bus.Start(waiterCtx) }()
	requireStartPending(t, waiter)
	stopWaiter()
	if err := awaitStart(t, waiter); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled concurrent Start = %v, want context canceled", err)
	}
	requireStartPending(t, owner)
	releaseInitialRead(log)
	if err := awaitStart(t, owner); err != nil {
		t.Fatalf("owner Start after waiter cancellation: %v", err)
	}
	if !bus.Positioned() || log.attempts.Load() != 1 {
		t.Fatalf("waiter cancellation affected owner: positioned=%v initial reads=%d", bus.Positioned(), log.attempts.Load())
	}
}

func TestStartRetriesInitialReadBeforeReturning(t *testing.T) {
	log := newGatedInitialLog()
	t.Cleanup(func() { releaseInitialRead(log) })
	log.failFirst = true
	bus := newBus(log)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	started := make(chan error, 1)
	go func() { started <- bus.Start(ctx) }()
	awaitInitialRead(t, log)
	requireStartPending(t, started)
	awaitInitialRead(t, log)
	requireStartPending(t, started)
	releaseInitialRead(log)
	if err := awaitStart(t, started); err != nil {
		t.Fatal(err)
	}
	if !bus.Positioned() || log.attempts.Load() != 2 {
		t.Fatalf("retry: positioned=%v attempts=%d", bus.Positioned(), log.attempts.Load())
	}
}

func TestStartCancellationDuringInitialReadAndBackoff(t *testing.T) {
	for _, failFirst := range []bool{false, true} {
		name := "read"
		if failFirst {
			name = "backoff"
		}
		t.Run(name, func(t *testing.T) {
			log := newGatedInitialLog()
			t.Cleanup(func() { releaseInitialRead(log) })
			log.failFirst = failFirst
			bus := newBus(log)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			started := make(chan error, 1)
			go func() { started <- bus.Start(ctx) }()
			awaitInitialRead(t, log)
			if failFirst {
				deadline := time.Now().Add(time.Second)
				for testutil.ToFloat64(bus.metrics.catchUpErrors) == 0 && time.Now().Before(deadline) {
					time.Sleep(time.Millisecond)
				}
				if testutil.ToFloat64(bus.metrics.catchUpErrors) == 0 {
					t.Fatal("initial read failure was not observed")
				}
			}
			cancel()
			if err := awaitStart(t, started); !errors.Is(err, context.Canceled) {
				t.Fatalf("Start after cancellation = %v, want context canceled", err)
			}
			if bus.Positioned() {
				t.Fatal("canceled initial read positioned the cursor")
			}
			select {
			case <-bus.Done():
			case <-time.After(time.Second):
				t.Fatal("listener did not stop after canceled initial read")
			}
			if err := bus.Start(context.Background()); !errors.Is(err, context.Canceled) {
				t.Fatalf("repeat Start after canceled startup = %v, want original cancellation", err)
			}
			if got := log.attempts.Load(); got != 1 {
				t.Fatalf("repeat Start reopened initial read: %d attempts", got)
			}
		})
	}
}

func TestStartWithoutListerAndPreStartDelivery(t *testing.T) {
	bus := newBus(nil)
	bus.Deliver(Event{ID: 7, Kind: KindTokenRevoked, TokenHash: "local"})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := bus.Start(ctx); err != nil {
		t.Fatal(err)
	}
	if bus.Positioned() || !bus.IsTokenRevoked("local") {
		t.Fatalf("nil lister changed pre-Start delivery: positioned=%v revoked=%v", bus.Positioned(), bus.IsTokenRevoked("local"))
	}
	cancel()
	select {
	case <-bus.Done():
	case <-time.After(time.Second):
		t.Fatal("nil-lister bus did not stop")
	}
}

// Keep the Lister shape checked here; the gate delegates durable scans to fakeLog.
var _ Lister = (*gatedInitialLog)(nil)

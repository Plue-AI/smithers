package cleanup

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestPeriodicTriggerCoalescesWithoutWaitingForSweep(t *testing.T) {
	p := NewPeriodic("trigger-test", time.Hour, time.Hour)
	ft := &fakeTicker{ch: make(chan time.Time)}
	p.runner.newTicker = func(time.Duration) ticker { return ft }
	started := make(chan int32, 8)
	release := make(chan struct{})
	var calls atomic.Int32
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p.Trigger() // A request made before startup is retained.
	p.Start(ctx, func(context.Context) error {
		n := calls.Add(1)
		started <- n
		if n == 1 {
			select {
			case <-release:
			case <-ctx.Done():
			}
		}
		return nil
	})
	t.Cleanup(func() { cancel(); p.Stop() })
	next := func(want int32) {
		t.Helper()
		select {
		case got := <-started:
			require.Equal(t, want, got)
		case <-time.After(5 * time.Second):
			t.Fatal("worker did not run")
		}
	}
	next(1)
	done := make(chan struct{})
	go func() {
		for range 100 {
			p.Trigger()
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Trigger waited for a running sweep")
	}
	close(release)
	next(2)
	// The unbuffered tick fences completion of the coalesced request. There
	// cannot be another pending hint after this tick is accepted.
	select {
	case ft.ch <- time.Now():
	case <-time.After(time.Second):
		t.Fatal("ticker stopped")
	}
	next(3)
	p.Stop()
	require.EqualValues(t, 3, calls.Load())
	for range 100 {
		p.Trigger()
	}
	require.EqualValues(t, 3, calls.Load(), "stopped workers stay stopped")
}

func TestPeriodicTriggerHonorsContextCancellation(t *testing.T) {
	p := NewPeriodic("trigger-cancel-test", time.Hour, time.Hour)
	started := make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	p.Start(ctx, func(ctx context.Context) error { close(started); <-ctx.Done(); return ctx.Err() })
	p.Trigger()
	select {
	case <-started:
	case <-time.After(time.Second):
		cancel()
		t.Fatal("worker did not run")
	}
	cancel()
	done := make(chan struct{})
	go func() { p.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("worker ignored cancellation")
	}
	p.Stop()
}

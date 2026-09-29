package revocation_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

func TestBusStartRefusesRestartAfterListenerStops(t *testing.T) {
	bus := revocation.NewBus(nil, nil)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if err := bus.Start(ctx); err != nil {
		t.Fatalf("initial Start: %v", err)
	}
	if err := bus.Start(context.Background()); err != nil {
		t.Fatalf("Start while listener runs: %v", err)
	}
	cancel()
	select {
	case <-bus.Done():
	case <-time.After(time.Second):
		t.Fatal("listener did not stop")
	}
	if err := bus.Start(context.Background()); !errors.Is(err, revocation.ErrBusStopped) {
		t.Fatalf("Start after listener stopped = %v, want revocation bus stopped", err)
	}
}

package revocation

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

func TestPostgresListenerIgnoresDelayedNotificationFromSkippedHistory(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	queries := db.New(pool)
	publisher := NewDBPublisher(queries, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, kind := range []Kind{KindUserDisabled, KindUserEnabled} {
		if err := publisher.Publish(ctx, Event{Kind: kind, UserID: 7}); err != nil {
			t.Fatal(err)
		}
	}
	rows, err := queries.ListRevocationEventsAfter(ctx, db.ListRevocationEventsAfterParams{AfterID: 0, LimitCount: 10})
	if err != nil || len(rows) != 2 {
		t.Fatalf("historical rows: count=%d error=%v", len(rows), err)
	}
	bus := NewBus(pool, queries)
	bus.PollInterval = 20 * time.Millisecond
	if err := bus.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cancel()
		select {
		case <-bus.Done():
		case <-time.After(2 * time.Second):
			t.Error("listener did not stop")
		}
	})
	deadline := time.Now().Add(2 * time.Second)
	for !bus.connectedNow() && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !bus.connectedNow() || bus.Cursor() != rows[1].ID {
		t.Fatalf("listener not ready at history boundary: connected=%v cursor=%d", bus.connectedNow(), bus.Cursor())
	}
	watch := bus.Watch(ctx, Principal{UserID: 7})
	if bus.IsUserDisabled(7) {
		t.Fatal("startup replayed the historical suspension")
	}

	oldPayload, err := json.Marshal(FromRow(rows[0]))
	if err != nil {
		t.Fatal(err)
	}
	if err := queries.NotifyRevocation(ctx, string(oldPayload)); err != nil {
		t.Fatal(err)
	}
	// This marker is not in the log, so its callback proves the listener has
	// consumed the delayed notification before the assertions below.
	marker := Event{ID: rows[1].ID + 100, Kind: KindUserEnabled, UserID: 99}
	markerPayload, err := json.Marshal(marker)
	if err != nil {
		t.Fatal(err)
	}
	markerSeen := make(chan struct{}, 1)
	unsubscribe := bus.Subscribe(func(event Event) {
		if event.ID == marker.ID {
			markerSeen <- struct{}{}
		}
	})
	defer unsubscribe()
	if err := queries.NotifyRevocation(ctx, string(markerPayload)); err != nil {
		t.Fatal(err)
	}
	select {
	case <-markerSeen:
	case <-ctx.Done():
		t.Fatal("listener did not process the notification marker")
	}
	if bus.IsUserDisabled(7) {
		t.Fatal("delayed historical notification re-disabled the user")
	}
	select {
	case event := <-watch:
		t.Fatalf("historical notification revoked a new watch: %+v", event)
	default:
	}

	if err := publisher.Publish(ctx, Event{Kind: KindUserDisabled, UserID: 7}); err != nil {
		t.Fatal(err)
	}
	if event := waitFor(t, watch, 2*time.Second); event.ID != rows[1].ID+1 || !bus.IsUserDisabled(7) {
		t.Fatalf("post-start publication was lost: %+v", event)
	}
}

func TestPostgresStartupBoundaryPreservesInFlightPublication(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if err := NewTransactionalDBPublisher(db.New(tx)).Publish(ctx, Event{Kind: KindUserDisabled, UserID: 7}); err != nil {
		t.Fatal(err)
	}

	// A second writer cannot allocate a later ID and commit ahead of the
	// still-open transaction. Startup may therefore safely use MAX(id) as its
	// immutable skipped-history boundary.
	secondDone := make(chan error, 1)
	go func() {
		secondDone <- NewDBPublisher(db.New(pool), nil).Publish(ctx, Event{Kind: KindUserDisabled, UserID: 8})
	}()
	select {
	case err := <-secondDone:
		t.Fatalf("second publication passed the open first transaction: %v", err)
	case <-time.After(100 * time.Millisecond):
	}

	bus := NewBus(pool, db.New(pool))
	bus.PollInterval = 20 * time.Millisecond
	if err := bus.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cancel()
		select {
		case <-bus.Done():
		case <-time.After(2 * time.Second):
			t.Error("listener did not stop")
		}
	})
	if bus.Cursor() != 0 {
		t.Fatalf("uncommitted publication advanced startup cursor to %d", bus.Cursor())
	}
	firstWatch := bus.Watch(ctx, Principal{UserID: 7})
	secondWatch := bus.Watch(ctx, Principal{UserID: 8})
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-secondDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("second publication did not proceed after the first committed")
	}
	if event := waitFor(t, firstWatch, 2*time.Second); event.ID != 1 {
		t.Fatalf("in-flight first publication was lost: %+v", event)
	}
	if event := waitFor(t, secondWatch, 2*time.Second); event.ID != 2 {
		t.Fatalf("later publication was lost: %+v", event)
	}
}

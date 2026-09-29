package revocation

import (
	"context"
	"sync"
	"testing"
	"time"
)

func waitForWatchAdmissionSubscribers(t *testing.T, bus *Bus, want int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		bus.mu.Lock()
		got := len(bus.subs)
		bus.mu.Unlock()
		if got == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("watch subscribers = %d, want %d", got, want)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestBusWatchAdmissionCachedRevocations(t *testing.T) {
	for _, tc := range []struct {
		name      string
		cached    Event
		principal Principal
		want      Event
	}{
		{"revoked token", Event{ID: 1, Kind: KindTokenRevoked, TokenHash: "token-a"}, Principal{UserID: 7, TokenHash: "token-a"}, Event{Kind: KindTokenRevoked, TokenHash: "token-a"}},
		{"narrowed token scopes", Event{ID: 1, Kind: KindTokenScopesNarrowed, TokenHash: "token-a"}, Principal{UserID: 7, TokenHash: "token-a"}, Event{Kind: KindTokenRevoked, TokenHash: "token-a"}},
		{"disabled user", Event{ID: 1, Kind: KindUserDisabled, UserID: 7}, Principal{UserID: 7, TokenHash: "token-a"}, Event{Kind: KindUserDisabled, UserID: 7}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			bus := newBus(nil)
			bus.Deliver(tc.cached)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			watch := bus.Watch(ctx, tc.principal)
			select {
			case got := <-watch:
				if got.Kind != tc.want.Kind || got.TokenHash != tc.want.TokenHash || got.UserID != tc.want.UserID || got.ID != 0 {
					t.Fatalf("cached admission event = %+v, want %+v", got, tc.want)
				}
			default:
				t.Fatal("Watch returned without the retained revocation")
			}
			waitForWatchAdmissionSubscribers(t, bus, 0)
			bus.Deliver(Event{ID: 2, Kind: KindUserDisabled, UserID: tc.principal.UserID})
			select {
			case got := <-watch:
				t.Fatalf("terminal watcher received a second event: %+v", got)
			default:
			}
		})
	}
}

func TestBusWatchAdmissionUnrelatedCacheAndReenabledUser(t *testing.T) {
	bus := newBus(nil)
	bus.Deliver(Event{ID: 1, Kind: KindTokenRevoked, TokenHash: "other-token"})
	bus.Deliver(Event{ID: 2, Kind: KindUserDisabled, UserID: 8})
	bus.Deliver(Event{ID: 3, Kind: KindUserDisabled, UserID: 7})
	bus.Deliver(Event{ID: 4, Kind: KindUserEnabled, UserID: 7})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	watch := bus.Watch(ctx, Principal{UserID: 7, TokenHash: "token-a"})
	select {
	case got := <-watch:
		t.Fatalf("unrelated or cleared cached revocation reached watcher: %+v", got)
	default:
	}
	bus.Deliver(Event{ID: 5, Kind: KindTokenRevoked, TokenHash: "other-token-2"})
	bus.Deliver(Event{ID: 6, Kind: KindUserDisabled, UserID: 8})
	select {
	case got := <-watch:
		t.Fatalf("unrelated live revocation reached watcher: %+v", got)
	default:
	}
	bus.Deliver(Event{ID: 7, Kind: KindUserDisabled, UserID: 7})
	select {
	case got := <-watch:
		if got.ID != 7 || got.Kind != KindUserDisabled || got.UserID != 7 {
			t.Fatalf("new suspension event = %+v", got)
		}
	default:
		t.Fatal("new suspension did not reach watcher")
	}
	waitForWatchAdmissionSubscribers(t, bus, 0)
}

func TestBusWatchAdmissionCancellationAndNilBus(t *testing.T) {
	var nilBus *Bus
	watch := nilBus.Watch(context.Background(), Principal{UserID: 7, TokenHash: "token-a"})
	select {
	case got := <-watch:
		t.Fatalf("nil bus yielded %+v", got)
	default:
	}

	bus := newBus(nil)
	ctx, cancel := context.WithCancel(context.Background())
	watch = bus.Watch(ctx, Principal{UserID: 7, TokenHash: "token-a"})
	waitForWatchAdmissionSubscribers(t, bus, 1)
	cancel()
	waitForWatchAdmissionSubscribers(t, bus, 0)
	bus.Deliver(Event{ID: 1, Kind: KindTokenRevoked, TokenHash: "token-a"})
	bus.Deliver(Event{ID: 2, Kind: KindUserDisabled, UserID: 7})
	select {
	case got := <-watch:
		t.Fatalf("cancelled watcher received later revocation: %+v", got)
	default:
	}
}

func TestBusWatchAdmissionConcurrentCachedAndLiveDelivery(t *testing.T) {
	for i := 0; i < 50; i++ {
		bus := newBus(nil)
		bus.Deliver(Event{ID: 1, Kind: KindTokenRevoked, TokenHash: "token-a"})
		ctx, cancel := context.WithCancel(context.Background())
		start := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			bus.Deliver(Event{ID: 2, Kind: KindUserDisabled, UserID: 7})
		}()
		close(start)
		watch := bus.Watch(ctx, Principal{UserID: 7, TokenHash: "token-a"})
		wg.Wait()
		select {
		case got := <-watch:
			if !got.Affects(Principal{UserID: 7, TokenHash: "token-a"}) {
				t.Fatalf("iteration %d: unrelated terminal event %+v", i, got)
			}
		default:
			t.Fatalf("iteration %d: cached and live revocations both missed", i)
		}
		waitForWatchAdmissionSubscribers(t, bus, 0)
		select {
		case got := <-watch:
			t.Fatalf("iteration %d: duplicate terminal event %+v", i, got)
		default:
		}
		cancel()
	}
}

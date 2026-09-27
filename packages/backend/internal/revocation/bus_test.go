package revocation

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// fakeLog is the durable event log plus the NOTIFY wire, shared by a fake
// publisher and any number of bus connections.
type fakeLog struct {
	mu     sync.Mutex
	rows   []db.RevocationEvent
	notify chan string
}

func newFakeLog() *fakeLog { return &fakeLog{notify: make(chan string, 64)} }

func (l *fakeLog) InsertRevocationEvent(_ context.Context, arg db.InsertRevocationEventParams) (db.RevocationEvent, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	row := db.RevocationEvent{
		ID:             int64(len(l.rows) + 1),
		Kind:           arg.Kind,
		UserID:         arg.UserID,
		TokenID:        arg.TokenID,
		TokenHash:      arg.TokenHash,
		RepositoryID:   arg.RepositoryID,
		OrganizationID: arg.OrganizationID,
		WorkspaceID:    arg.WorkspaceID,
		SessionID:      arg.SessionID,
		GatewayID:      arg.GatewayID,
		SandboxIds:     arg.SandboxIds,
		Reason:         arg.Reason,
		ActorID:        arg.ActorID,
		CreatedAt:      time.Now(),
	}
	l.rows = append(l.rows, row)
	return row, nil
}

func (l *fakeLog) NotifyRevocation(_ context.Context, payload string) error {
	l.notify <- payload
	return nil
}

func (l *fakeLog) ListRevocationEventsAfter(_ context.Context, arg db.ListRevocationEventsAfterParams) ([]db.RevocationEvent, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []db.RevocationEvent
	for _, row := range l.rows {
		if row.ID > arg.AfterID {
			out = append(out, row)
		}
		if len(out) >= int(arg.LimitCount) {
			break
		}
	}
	return out, nil
}

func (l *fakeLog) LatestRevocationEventID(context.Context) (int64, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return int64(len(l.rows)), nil
}

type fakeConn struct {
	log      *fakeLog
	listened []string
}

func (c *fakeConn) Exec(_ context.Context, sql string) error {
	c.listened = append(c.listened, sql)
	return nil
}

func (c *fakeConn) WaitForNotification(ctx context.Context) (*pgconn.Notification, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case payload := <-c.log.notify:
		return &pgconn.Notification{Channel: Channel, Payload: payload}, nil
	}
}

func (c *fakeConn) Release() {}

func startBus(t *testing.T, log *fakeLog) (*Bus, context.CancelFunc) {
	t.Helper()
	bus := newBus(log)
	bus.PollInterval = 50 * time.Millisecond
	bus.acquire = func(context.Context) (notifier, error) { return &fakeConn{log: log}, nil }
	ctx, cancel := context.WithCancel(context.Background())
	if err := bus.Start(ctx); err != nil {
		t.Fatalf("start: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for !bus.Positioned() && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if !bus.Positioned() {
		t.Fatal("bus never positioned its cursor")
	}
	return bus, cancel
}

func waitFor(t *testing.T, ch <-chan Event, bound time.Duration) Event {
	t.Helper()
	select {
	case ev := <-ch:
		return ev
	case <-time.After(bound):
		t.Fatalf("no event within %s", bound)
		return Event{}
	}
}

func TestBus_NotifyReachesWatcherWithinBound(t *testing.T) {
	log := newFakeLog()
	bus, cancel := startBus(t, log)
	defer cancel()
	publisher := NewDBPublisher(log, nil)

	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	watch := bus.Watch(ctx, Principal{UserID: 7, TokenHash: "abc"})
	other := bus.Watch(ctx, Principal{UserID: 8, TokenHash: "zzz"})

	started := time.Now()
	if err := publisher.Publish(context.Background(), Event{Kind: KindTokenRevoked, UserID: 7, TokenID: 1, TokenHash: "abc", Reason: "deleted"}); err != nil {
		t.Fatalf("publish: %v", err)
	}
	ev := waitFor(t, watch, 2*time.Second)
	if ev.Kind != KindTokenRevoked || ev.ID != 1 || ev.Reason != "deleted" {
		t.Fatalf("unexpected event %+v", ev)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("delivery took %s", elapsed)
	}
	select {
	case ev := <-other:
		t.Fatalf("unrelated principal received %+v", ev)
	case <-time.After(100 * time.Millisecond):
	}
	if !bus.IsTokenRevoked("abc") {
		t.Fatal("token not marked revoked")
	}
	if bus.IsTokenRevoked("zzz") {
		t.Fatal("unrelated token marked revoked")
	}
}

func TestBus_CatchUpDeliversEventsWhoseNotifyWasLost(t *testing.T) {
	log := newFakeLog()
	bus, cancel := startBus(t, log)
	defer cancel()

	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	watch := bus.Watch(ctx, Principal{UserID: 42})

	// Insert directly, no NOTIFY: only the poll can find it.
	if _, err := log.InsertRevocationEvent(context.Background(), Event{Kind: KindUserDisabled, UserID: 42}.ToParams()); err != nil {
		t.Fatal(err)
	}
	ev := waitFor(t, watch, 2*time.Second)
	if ev.Kind != KindUserDisabled || ev.UserID != 42 {
		t.Fatalf("unexpected event %+v", ev)
	}
	if !bus.IsUserDisabled(42) {
		t.Fatal("user not marked disabled")
	}
	if bus.Cursor() != 1 {
		t.Fatalf("cursor = %d, want 1", bus.Cursor())
	}
}

func TestBus_StartSkipsHistoryAndDedupes(t *testing.T) {
	log := newFakeLog()
	if _, err := log.InsertRevocationEvent(context.Background(), Event{Kind: KindUserDisabled, UserID: 1}.ToParams()); err != nil {
		t.Fatal(err)
	}
	bus, cancel := startBus(t, log)
	defer cancel()
	if bus.IsUserDisabled(1) {
		t.Fatal("history before start must not be replayed")
	}
	var count int
	var mu sync.Mutex
	bus.Subscribe(func(Event) { mu.Lock(); count++; mu.Unlock() })
	row, _ := log.InsertRevocationEvent(context.Background(), Event{Kind: KindUserDisabled, UserID: 2}.ToParams())
	payload, _ := json.Marshal(FromRow(row))
	// The same event arrives by NOTIFY and by poll; it must dispatch once.
	log.notify <- string(payload)
	log.notify <- string(payload)
	time.Sleep(300 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if count != 1 {
		t.Fatalf("dispatched %d times, want 1", count)
	}
}

func TestBus_LocalPublishAppliesBeforeRoundTrip(t *testing.T) {
	log := newFakeLog()
	bus := newBus(log) // never started: no listener, no poll
	publisher := NewDBPublisher(log, bus)
	if err := publisher.Publish(context.Background(), Event{Kind: KindTokenRevoked, TokenHash: "h1"}); err != nil {
		t.Fatal(err)
	}
	if !bus.IsTokenRevoked("h1") {
		t.Fatal("local apply did not mark the token")
	}
}

func TestBus_WatchUnsubscribesOnContextDone(t *testing.T) {
	bus := newBus(nil)
	ctx, cancel := context.WithCancel(context.Background())
	_ = bus.Watch(ctx, Principal{UserID: 1})
	bus.mu.Lock()
	n := len(bus.subs)
	bus.mu.Unlock()
	if n != 1 {
		t.Fatalf("subs = %d, want 1", n)
	}
	cancel()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		bus.mu.Lock()
		n = len(bus.subs)
		bus.mu.Unlock()
		if n == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("subscription leaked after cancel: %d", n)
}

func TestBus_NilIsSafe(t *testing.T) {
	var bus *Bus
	if bus.IsTokenRevoked("x") || bus.IsUserDisabled(1) {
		t.Fatal("nil bus reported a revocation")
	}
	ch := bus.Watch(context.Background(), Principal{UserID: 1})
	select {
	case <-ch:
		t.Fatal("nil bus yielded")
	default:
	}
	if err := bus.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestEvent_Affects(t *testing.T) {
	cases := []struct {
		name      string
		event     Event
		principal Principal
		want      bool
	}{
		{"token hash match", Event{Kind: KindTokenRevoked, TokenHash: "h"}, Principal{TokenHash: "h"}, true},
		{"token hash mismatch", Event{Kind: KindTokenRevoked, TokenHash: "h"}, Principal{TokenHash: "g"}, false},
		{"token empty never matches", Event{Kind: KindTokenRevoked}, Principal{TokenHash: ""}, false},
		{"user disabled", Event{Kind: KindUserDisabled, UserID: 3}, Principal{UserID: 3}, true},
		{"user disabled other", Event{Kind: KindUserDisabled, UserID: 3}, Principal{UserID: 4}, false},
		{"collaborator by repo+user", Event{Kind: KindCollaboratorRemoved, UserID: 3, RepositoryID: 9}, Principal{UserID: 3, RepositoryID: 9}, true},
		{"collaborator wrong repo", Event{Kind: KindCollaboratorRemoved, UserID: 3, RepositoryID: 9}, Principal{UserID: 3, RepositoryID: 10}, false},
		{"collaborator by sandbox", Event{Kind: KindCollaboratorRemoved, UserID: 3, RepositoryID: 9, SandboxIDs: []string{"vm1"}}, Principal{SandboxID: "vm1"}, true},
		{"share by workspace+user", Event{Kind: KindWorkspaceShareRemoved, UserID: 3, WorkspaceID: "w"}, Principal{UserID: 3, WorkspaceID: "w"}, true},
		{"share other user keeps access", Event{Kind: KindWorkspaceShareRemoved, UserID: 3, WorkspaceID: "w"}, Principal{UserID: 4, WorkspaceID: "w"}, false},
		{"session cancelled", Event{Kind: KindAgentSessionCancelled, SessionID: "s"}, Principal{SessionID: "s"}, true},
		{"session by sandbox", Event{Kind: KindAgentSessionCancelled, SessionID: "s", SandboxIDs: []string{"vm"}}, Principal{SandboxID: "vm"}, true},
		{"org member", Event{Kind: KindOrgMemberRemoved, UserID: 3, OrganizationID: 5}, Principal{UserID: 3, OrganizationID: 5}, true},
		{"ssh key fingerprint match", Event{Kind: KindSSHKeyRevoked, UserID: 3, KeyFingerprint: "SHA256:f"}, Principal{UserID: 3, KeyFingerprint: "SHA256:f"}, true},
		{"ssh key same user other key keeps access", Event{Kind: KindSSHKeyRevoked, UserID: 3, KeyFingerprint: "SHA256:f"}, Principal{UserID: 3, KeyFingerprint: "SHA256:g"}, false},
		{"ssh key empty never matches", Event{Kind: KindSSHKeyRevoked, UserID: 3}, Principal{UserID: 3}, false},
		{"unknown kind", Event{Kind: "nope", UserID: 3}, Principal{UserID: 3}, false},
	}
	for _, tc := range cases {
		if got := tc.event.Affects(tc.principal); got != tc.want {
			t.Errorf("%s: Affects = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestEvent_RowRoundTrip(t *testing.T) {
	in := Event{Kind: KindWorkspaceShareRemoved, UserID: 1, RepositoryID: 2, WorkspaceID: "w", KeyFingerprint: "SHA256:k", SandboxIDs: []string{"a", "b"}, Reason: "r", ActorID: 9}
	params := in.ToParams()
	row := db.RevocationEvent{ID: 5, Kind: params.Kind, UserID: params.UserID, RepositoryID: params.RepositoryID, WorkspaceID: params.WorkspaceID, KeyFingerprint: params.KeyFingerprint, SandboxIds: params.SandboxIds, Reason: params.Reason, ActorID: params.ActorID}
	out := FromRow(row)
	if out.ID != 5 || out.Kind != in.Kind || out.UserID != 1 || out.RepositoryID != 2 || out.WorkspaceID != "w" || out.KeyFingerprint != "SHA256:k" || len(out.SandboxIDs) != 2 || out.Reason != "r" || out.ActorID != 9 || out.TokenID != 0 {
		t.Fatalf("round trip lost data: %+v", out)
	}
	if (Event{}).ToParams().SandboxIds == nil {
		t.Fatal("nil sandbox ids must encode as an empty array")
	}
}

package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus/testutil"
)

// streamingHost commits one delta per tick for longer than the claim lease,
// then finishes. It models a healthy long turn with tool loops.
type streamingHost struct {
	store *Store
	ticks int
	every time.Duration
}

func (h streamingHost) RunTurn(ctx context.Context, grant ProducerGrant) error {
	if err := h.store.MarkProviderStarted(ctx, grant); err != nil {
		return err
	}
	cursor := grant.Cursor
	for index := range h.ticks {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(h.every):
		}
		result, err := h.store.Commit(ctx, CommitInput{TurnID: grant.TurnID, Generation: grant.Generation, Token: grant.Token,
			Expected: cursor, Frames: []json.RawMessage{frame(grant.RunID, strings.Repeat("x", index%3+1))}})
		if err != nil {
			return err
		}
		cursor = result.Cursor
	}
	_, err := h.store.Commit(ctx, CommitInput{TurnID: grant.TurnID, Generation: grant.Generation, Token: grant.Token,
		Expected: cursor, Frames: []json.RawMessage{done(grant.RunID, "stop")}})
	return err
}

func runDispatcherUntilTerminal(t *testing.T, store *Store, dispatcher *Dispatcher, scope Scope, turnID string) State {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	finished := make(chan error, 1)
	go func() { finished <- dispatcher.Run(ctx, 1) }()
	defer func() {
		cancel()
		<-finished
	}()
	if !dispatcher.Enqueue(Candidate{Scope: scope, TurnID: turnID}) {
		t.Fatal("enqueue refused")
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		state, terminal, err := store.GetState(context.Background(), scope, turnID)
		if err != nil {
			t.Fatal(err)
		}
		if terminal {
			return state
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("turn did not reach a terminal state")
	return ""
}

func TestDispatcherRenewsLeaseWhileHealthyHostOutlivesIt(t *testing.T) {
	store := needStore(t)
	scope, runID, journal := testScope(), "long-"+uuid.NewString(), testJournal()
	accepted := admit(t, store, scope, runID, journal)
	// The host keeps committing for four lease lengths. A one-second lease
	// leaves scheduling room on the shared integration host; the former 200ms
	// fixture could expire under compiler load before a healthy renewal ran.
	dispatcher, err := NewDispatcher(store, streamingHost{store: store, ticks: 16, every: 250 * time.Millisecond}, 1, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if state := runDispatcherUntilTerminal(t, store, dispatcher, scope, accepted.TurnID); state != StateCompleted {
		t.Fatalf("long healthy turn ended %s, want completed", state)
	}
	page, err := store.Replay(context.Background(), ReplayInput{Scope: scope, RunID: runID, Journal: journal, Limit: 16})
	if err != nil || len(page.Batches) != 16 || !page.More {
		t.Fatalf("long turn journal: batches=%d more=%v err=%v", len(page.Batches), page.More, err)
	}
}

type failingHost struct{ err error }

func (h failingHost) RunTurn(context.Context, ProducerGrant) error { return h.err }

func TestDispatcherRecordsHostFailureCause(t *testing.T) {
	store := needStore(t)
	scope, runID, journal := testScope(), "fail-"+uuid.NewString(), testJournal()
	accepted := admit(t, store, scope, runID, journal)
	dispatcher, err := NewDispatcher(store, failingHost{err: errors.New("launch owner model host: sandbox quota")}, 1, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	fastRetries(dispatcher)
	var logs bytes.Buffer
	dispatcher.logger = slog.New(slog.NewJSONHandler(&logs, nil))
	if state := runDispatcherUntilTerminal(t, store, dispatcher, scope, accepted.TurnID); state != StateFailed {
		t.Fatalf("failed host ended %s", state)
	}
	// Recovery also runs other tests' leftover turns, so count this turn's
	// records rather than the process-wide counters.
	var record map[string]any
	attempts := 0
	for line := range strings.Lines(logs.String()) {
		var candidate map[string]any
		if json.Unmarshal([]byte(line), &candidate) == nil && candidate["turn_id"] == accepted.TurnID && candidate["code"] == "host_failed" {
			record = candidate
			attempts++
		}
	}
	if record == nil || record["msg"] != "chat turn failed" || !strings.Contains(record["error"].(string), "sandbox quota") || record["generation"] != float64(maxProducerAttempts) {
		t.Fatalf("host failure was not logged with its cause: %s", logs.String())
	}
	if attempts != maxProducerAttempts {
		t.Fatalf("host ran %d times, want %d", attempts, maxProducerAttempts)
	}
	if got := testutil.ToFloat64(dispatcher.metrics.failures.WithLabelValues("host_failed")); got < maxProducerAttempts {
		t.Fatalf("host_failed counter = %v", got)
	}
}

// fastRetries makes recovery rerun a turn at once, so attempt bounds are
// tested without waiting out the production backoff.
func fastRetries(dispatcher *Dispatcher) {
	dispatcher.backoff = func(int64) time.Duration { return 0 }
	dispatcher.scan = 20 * time.Millisecond
}

// flakyHost refuses its first calls for one turn the way a restarting model
// host does, before any provider starts, then streams a healthy turn.
type flakyHost struct {
	turnID   string
	calls    atomic.Int32
	refusals int32
	healthy  streamingHost
}

func (h *flakyHost) RunTurn(ctx context.Context, grant ProducerGrant) error {
	if grant.TurnID != h.turnID {
		return errors.New("not this test's turn")
	}
	if h.calls.Add(1) <= h.refusals {
		return errors.New("run chat model host: dial tcp 10.0.0.7:8080: connect: connection refused")
	}
	return h.healthy.RunTurn(ctx, grant)
}

func TestDispatcherRerunsTurnWhenHostFailsBeforeProvider(t *testing.T) {
	store := needStore(t)
	scope, runID, journal := testScope(), "flaky-"+uuid.NewString(), testJournal()
	accepted := admit(t, store, scope, runID, journal)
	host := &flakyHost{turnID: accepted.TurnID, refusals: 2, healthy: streamingHost{store: store, ticks: 1, every: time.Millisecond}}
	dispatcher, err := NewDispatcher(store, host, 1, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	fastRetries(dispatcher)
	if state := runDispatcherUntilTerminal(t, store, dispatcher, scope, accepted.TurnID); state != StateCompleted {
		t.Fatalf("turn admitted during a host restart ended %s, want completed", state)
	}
	if got := host.calls.Load(); got != 3 {
		t.Fatalf("host ran the turn %d times, want 3", got)
	}
}

func TestRetryProducerSealsStartedProviderUncertain(t *testing.T) {
	store := needStore(t)
	scope, runID, journal := testScope(), "retry-started-"+uuid.NewString(), testJournal()
	accepted := admit(t, store, scope, runID, journal)
	grant, err := store.Claim(context.Background(), scope, accepted.TurnID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.MarkProviderStarted(context.Background(), grant); err != nil {
		t.Fatal(err)
	}
	retrying, err := store.RetryProducer(context.Background(), grant, "host_failed", 0)
	if err != nil || retrying {
		t.Fatalf("retry after provider start: retrying=%v err=%v", retrying, err)
	}
	if state, terminal, _ := store.GetState(context.Background(), scope, accepted.TurnID); state != StateUncertain || !terminal {
		t.Fatalf("state = %s terminal=%v, want uncertain", state, terminal)
	}
}

// A turn whose journal no longer verifies fails Claim every time. It must
// leave the oldest-first recovery scan instead of starving newer turns.
func TestDispatcherQuarantinesUnclaimableTurn(t *testing.T) {
	store, clock := clockedStore(needStore(t))
	scope := testScope()
	poison := admit(t, store, scope, "poison-"+uuid.NewString(), testJournal())
	if _, err := store.pool.Exec(context.Background(), `UPDATE chat_turns SET head_hash=repeat('0',64) WHERE id=$1`, poison.TurnID); err != nil {
		t.Fatal(err)
	}
	dispatcher, err := NewDispatcher(store, failingHost{err: errors.New("unused")}, 1, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	dispatcher.logger = slog.New(slog.DiscardHandler)
	dispatcher.runOne(context.Background(), Candidate{Scope: scope, TurnID: poison.TurnID})
	if recoveryHas(t, store, poison.TurnID) {
		t.Fatal("an unclaimable turn stayed in the recovery scan")
	}
	if got := testutil.ToFloat64(dispatcher.metrics.failures.WithLabelValues("quarantined_corrupt")); got != 1 {
		t.Fatalf("quarantine counter = %v", got)
	}
	later := admit(t, store, scope, "later-"+uuid.NewString(), testJournal())
	if !recoveryHas(t, store, later.TurnID) {
		t.Fatal("a newer turn is not recoverable")
	}
	clock.advance(quarantineDelay + time.Second)
	if !recoveryHas(t, store, poison.TurnID) {
		t.Fatal("quarantine never ends, so a repaired turn is never retried")
	}
}

// blockingHost holds one turn until its context ends and reports that.
type blockingHost struct {
	turnID  string
	entered chan struct{}
	stopped chan struct{}
}

func (h blockingHost) RunTurn(ctx context.Context, grant ProducerGrant) error {
	if grant.TurnID != h.turnID {
		return errors.New("not this test's turn")
	}
	close(h.entered)
	<-ctx.Done()
	close(h.stopped)
	return ctx.Err()
}

// A cancel served by another replica must stop the host on the replica that
// runs the turn, well before the lease renewal would notice.
func TestCancelOnAnotherReplicaStopsTheRunningHost(t *testing.T) {
	store := needStore(t)
	scope, runID, journal := testScope(), "xcancel-"+uuid.NewString(), testJournal()
	accepted := admit(t, store, scope, runID, journal)
	host := blockingHost{turnID: accepted.TurnID, entered: make(chan struct{}), stopped: make(chan struct{})}
	owner, err := NewDispatcher(store, host, 2, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	owner.scan = 20 * time.Millisecond
	other, err := NewDispatcher(store, failingHost{err: errors.New("unused")}, 1, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	finished := make(chan error, 1)
	go func() { finished <- owner.Run(ctx, 1) }()
	defer func() {
		cancel()
		<-finished
	}()
	owner.Enqueue(Candidate{Scope: scope, TurnID: accepted.TurnID})
	select {
	case <-host.entered:
	case <-time.After(dbWait):
		t.Fatal("host did not start")
	}
	server := httptest.NewServer(authenticatedRoutes(&Handler{Store: store, Dispatcher: other}, scope.UserID, scope.Owner))
	defer server.Close()
	body, _ := json.Marshal(cancelRequest{RunID: runID})
	response := postJSON(t, server.Client(), server.URL+CancelPath, body)
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("cancel status %d", response.StatusCode)
	}
	select {
	case <-host.stopped:
	case <-time.After(dbWait):
		t.Fatal("the owning replica kept its host running after a cancel elsewhere")
	}
}

func TestCommitWakesTurnWatchers(t *testing.T) {
	store := needStore(t)
	scope, runID, journal := testScope(), "wake-"+uuid.NewString(), testJournal()
	accepted := admit(t, store, scope, runID, journal)
	grant, err := store.Claim(context.Background(), scope, accepted.TurnID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	changed, stop := store.watch(accepted.TurnID)
	defer stop()
	if _, err = store.Commit(context.Background(), CommitInput{TurnID: accepted.TurnID, Generation: grant.Generation, Token: grant.Token,
		Expected: grant.Cursor, Frames: []json.RawMessage{frame(runID, "wake")}}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-changed:
	case <-time.After(dbWait):
		t.Fatal("commit did not wake its watcher")
	}
	changed, stop2 := store.watch(accepted.TurnID)
	defer stop2()
	if _, err = store.Cancel(context.Background(), scope, runID); err != nil {
		t.Fatal(err)
	}
	select {
	case <-changed:
	case <-time.After(dbWait):
		t.Fatal("terminal append did not wake its watcher")
	}
}

func TestCommitOnOneReplicaWakesAStreamOnAnother(t *testing.T) {
	shared := needStore(t)
	writer := &Store{pool: shared.pool, now: time.Now}
	reader := &Store{pool: shared.pool, now: time.Now}
	scope, runID, journal := testScope(), "replica-"+uuid.NewString(), testJournal()
	accepted := admit(t, writer, scope, runID, journal)
	grant, err := writer.Claim(context.Background(), scope, accepted.TurnID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	listening := make(chan error, 1)
	go func() { listening <- reader.Listen(ctx, nil) }()
	defer func() {
		cancel()
		<-listening
	}()
	changed, stop := reader.watch(accepted.TurnID)
	defer stop()
	// LISTEN takes effect asynchronously; commit until the other replica hears.
	cursor := grant.Cursor
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		result, commitErr := writer.Commit(context.Background(), CommitInput{TurnID: accepted.TurnID, Generation: grant.Generation, Token: grant.Token,
			Expected: cursor, Frames: []json.RawMessage{frame(runID, "replica")}})
		if commitErr != nil {
			t.Fatal(commitErr)
		}
		cursor = result.Cursor
		select {
		case <-changed:
			return
		case <-time.After(100 * time.Millisecond):
		}
	}
	t.Fatal("a commit on one replica never woke the other replica's stream")
}

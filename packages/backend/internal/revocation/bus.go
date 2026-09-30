package revocation

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

const (
	defaultPollInterval = 5 * time.Second
	defaultRetention    = 24 * time.Hour
	catchUpBatch        = 500
	reconnectBackoff    = time.Second
)

// ErrBusStopped means a single-use bus cannot start again after its listener exits.
var ErrBusStopped = errors.New("revocation bus stopped")

// Lister reads the durable event log (matched by *db.Queries).
type Lister interface {
	ListRevocationEventsAfter(ctx context.Context, arg db.ListRevocationEventsAfterParams) ([]db.RevocationEvent, error)
	LatestRevocationEventID(ctx context.Context) (int64, error)
}

// Checker is the cheap per-request view the auth middleware consults.
type Checker interface {
	IsTokenRevoked(tokenHash string) bool
	IsUserDisabled(userID int64) bool
	IsBrowserSessionRevoked(sessionHash string) bool
}

// Revoked reports the retained credential or account revocation that denies
// principal, if any. Long-lived handlers call it after Watch registers, so a
// completed revocation cannot hide in delayed fan-out.
func Revoked(checker Checker, principal Principal) (Event, bool) {
	if checker == nil {
		return Event{}, false
	}
	if principal.TokenHash != "" && checker.IsTokenRevoked(principal.TokenHash) {
		return Event{Kind: KindTokenRevoked, TokenHash: principal.TokenHash}, true
	}
	if principal.BrowserSessionHash != "" && checker.IsBrowserSessionRevoked(principal.BrowserSessionHash) {
		return Event{Kind: KindBrowserSessionRevoked, TokenHash: principal.BrowserSessionHash}, true
	}
	if principal.UserID != 0 && checker.IsUserDisabled(principal.UserID) {
		return Event{Kind: KindUserDisabled, UserID: principal.UserID}, true
	}
	return Event{}, false
}

// Watcher hands a long-lived handler a channel that yields the first event
// revoking its principal. Watch must register before checking retained token
// and account revocations, including revocations completed before the call.
// Resource authorization must be validated by the caller after registration.
type Watcher interface {
	Watch(ctx context.Context, principal Principal) <-chan Event
}

// notifier is the connection surface the bus needs; a pgx pool connection in
// production, a fake in tests.
type notifier interface {
	Exec(ctx context.Context, sql string) error
	WaitForNotification(ctx context.Context) (*pgconn.Notification, error)
	Release()
}

type poolNotifier struct{ conn *pgxpool.Conn }

func (p *poolNotifier) Exec(ctx context.Context, sql string) error {
	_, err := p.conn.Exec(ctx, sql)
	return err
}

func (p *poolNotifier) WaitForNotification(ctx context.Context) (*pgconn.Notification, error) {
	return p.conn.Conn().WaitForNotification(ctx)
}

func (p *poolNotifier) Release() { p.conn.Release() }

// Bus listens for revocations, keeps a bounded recent view for per-request
// checks, and fans events out to subscribers.
type Bus struct {
	acquire func(ctx context.Context) (notifier, error)
	lister  Lister

	// PollInterval bounds how long a lost NOTIFY can go unnoticed; every tick
	// re-reads the log after the cursor. Zero means 5s.
	PollInterval time.Duration
	// Retention bounds the in-memory recently-revoked sets. Zero means 24h.
	Retention time.Duration

	mu              sync.Mutex
	cursor          int64
	initialCursor   int64 // Durable history skipped at Start; never lowered by polling.
	seen            map[int64]time.Time
	revokedTokens   map[string]time.Time
	revokedSessions map[string]time.Time
	disabledUsers   map[int64]time.Time
	userEvents      map[int64]int64
	subs            map[int]func(Event)
	nextSub         int
	started         bool
	positioned      bool
	connected       bool
	ready           chan struct{}
	startErr        error // Written before ready closes; immutable afterwards.
	done            chan struct{}

	metrics busMetrics
}

// NewBus builds a bus over the pool for LISTEN and the lister for catch-up.
func NewBus(pool *pgxpool.Pool, lister Lister) *Bus {
	b := newBus(lister)
	if pool != nil {
		b.acquire = func(ctx context.Context) (notifier, error) {
			conn, err := pool.Acquire(ctx)
			if err != nil {
				return nil, err
			}
			return &poolNotifier{conn: conn}, nil
		}
	}
	return b
}

func newBus(lister Lister) *Bus {
	return &Bus{
		lister:          lister,
		seen:            make(map[int64]time.Time),
		revokedTokens:   make(map[string]time.Time),
		revokedSessions: make(map[string]time.Time),
		disabledUsers:   make(map[int64]time.Time),
		userEvents:      make(map[int64]int64),
		subs:            make(map[int]func(Event)),
		ready:           make(chan struct{}),
		done:            make(chan struct{}),
		metrics:         newBusMetrics(),
	}
}

// Start waits for the initial cursor read and begins listening. Callers must
// wait for success before admitting live consumers. Concurrent calls wait for
// the same initialization; the first call's context owns the listener lifetime.
// Once the listener stops, later calls return ErrBusStopped. A failed initial
// read retains its original startup error instead.
// Events older than the cursor are never replayed: a pod that restarts has no
// live connections from before its restart to terminate, and the auth path
// re-reads the database on every request anyway.
func (b *Bus) Start(ctx context.Context) error {
	if b == nil {
		return nil
	}
	b.mu.Lock()
	if !b.started {
		b.started = true
		go b.run(ctx)
	}
	b.mu.Unlock()
	select {
	case <-b.done:
		return b.startResult()
	default:
	}
	select {
	case <-b.ready:
		return b.startResult()
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (b *Bus) startResult() error {
	if b.startErr != nil {
		return b.startErr
	}
	select {
	case <-b.done:
		return ErrBusStopped
	default:
		return nil
	}
}

// positionCursor reads the newest stored event ID so history is never
// replayed. It retries until the database answers or ctx ends, because a
// process that cannot read the log yet must not start fanning out from zero:
// that would replay old suspensions of users who were since unsuspended.
func (b *Bus) positionCursor(ctx context.Context) bool {
	if b.lister == nil {
		return true
	}
	for {
		latest, err := b.lister.LatestRevocationEventID(ctx)
		if err == nil {
			b.mu.Lock()
			if latest > b.cursor {
				b.cursor = latest
			}
			b.initialCursor = latest
			b.positioned = true
			b.mu.Unlock()
			return true
		}
		if ctx.Err() != nil {
			return false
		}
		b.metrics.catchUpErrors.Inc()
		slog.Warn("revocation bus: cannot read the event log yet; retrying", "error", err)
		if !sleepCtx(ctx, reconnectBackoff) {
			return false
		}
	}
}

// Done is closed when the listen loop exits.
func (b *Bus) Done() <-chan struct{} { return b.done }

// Positioned reports whether the cursor has been read from the log, which is
// when durable events start being applied. Start waits for this boundary before
// callers may admit live consumers. A bus without a lister stays unpositioned.
func (b *Bus) Positioned() bool {
	if b == nil {
		return false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.positioned
}

func (b *Bus) pollInterval() time.Duration {
	if b.PollInterval > 0 {
		return b.PollInterval
	}
	return defaultPollInterval
}

func (b *Bus) retention() time.Duration {
	if b.Retention > 0 {
		return b.Retention
	}
	return defaultRetention
}

func (b *Bus) run(ctx context.Context) {
	defer close(b.done)
	if !b.positionCursor(ctx) {
		b.startErr = ctx.Err()
		close(b.ready)
		return
	}
	close(b.ready)
	for {
		if ctx.Err() != nil {
			return
		}
		if b.acquire == nil {
			// No connection source: poll the log only.
			b.catchUp(ctx)
			select {
			case <-ctx.Done():
				return
			case <-time.After(b.pollInterval()):
			}
			continue
		}
		conn, err := b.acquire(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			b.metrics.reconnects.Inc()
			slog.Warn("revocation bus: acquire connection failed", "error", err)
			if !sleepCtx(ctx, reconnectBackoff) {
				return
			}
			continue
		}
		b.serve(ctx, conn)
		b.setConnected(false)
		conn.Release()
		if ctx.Err() == nil {
			b.metrics.reconnects.Inc()
		}
		if !sleepCtx(ctx, reconnectBackoff) {
			return
		}
	}
}

func (b *Bus) serve(ctx context.Context, conn notifier) {
	if err := conn.Exec(ctx, "LISTEN "+Channel); err != nil {
		slog.Warn("revocation bus: LISTEN failed", "error", err)
		return
	}
	b.setConnected(true)
	// Anything published between the cursor read and LISTEN is picked up here.
	b.catchUp(ctx)
	for {
		waitCtx, cancel := context.WithTimeout(ctx, b.pollInterval())
		notification, err := conn.WaitForNotification(waitCtx)
		cancel()
		switch {
		case err == nil:
			b.deliverPayload(ctx, notification.Payload)
		case errors.Is(err, context.DeadlineExceeded):
			b.catchUp(ctx)
		case ctx.Err() != nil:
			return
		default:
			slog.Warn("revocation bus: connection lost; reconnecting", "error", err)
			return
		}
	}
}

func (b *Bus) deliverPayload(ctx context.Context, payload string) {
	var event Event
	if err := json.Unmarshal([]byte(payload), &event); err != nil || event.ID == 0 {
		// A malformed or foreign payload: the log is the source of truth.
		b.catchUp(ctx)
		return
	}
	// Notifications are hints, never durable scan progress. A later event may
	// arrive before an earlier notification (or after it was lost).
	b.catchUp(ctx)
	b.mu.Lock()
	skippedHistory := b.positioned && event.ID <= b.initialCursor
	b.mu.Unlock()
	if skippedHistory {
		return
	}
	b.apply(event)
}

// catchUp reads every stored event after the cursor.
func (b *Bus) catchUp(ctx context.Context) {
	if b.lister == nil {
		return
	}
	for {
		b.mu.Lock()
		after := b.cursor
		b.mu.Unlock()
		rows, err := b.lister.ListRevocationEventsAfter(ctx, db.ListRevocationEventsAfterParams{AfterID: after, LimitCount: catchUpBatch})
		if err != nil {
			if ctx.Err() == nil {
				b.metrics.catchUpErrors.Inc()
				slog.Warn("revocation bus: catch-up read failed", "after", after, "error", err)
			}
			return
		}
		for _, row := range rows {
			b.apply(FromRow(row))
			b.mu.Lock()
			if row.ID > b.cursor {
				b.cursor = row.ID
			}
			b.mu.Unlock()
		}
		if len(rows) < catchUpBatch {
			return
		}
	}
}

// apply records the event once and fans it out. It is idempotent per event ID.
func (b *Bus) apply(event Event) {
	now := time.Now()
	b.mu.Lock()
	if event.ID != 0 {
		if _, dup := b.seen[event.ID]; dup {
			b.mu.Unlock()
			return
		}
		b.seen[event.ID] = now
	}
	b.metrics.eventsApplied.WithLabelValues(string(event.Kind)).Inc()
	switch event.Kind {
	case KindTokenRevoked, KindTokenScopesNarrowed:
		if event.TokenHash != "" {
			b.revokedTokens[event.TokenHash] = now
		}
	case KindBrowserSessionRevoked:
		if event.TokenHash != "" {
			b.revokedSessions[event.TokenHash] = now
		}
	case KindUserDisabled, KindUserEnabled:
		if event.ID != 0 && event.ID < b.userEvents[event.UserID] {
			b.mu.Unlock()
			return // A delayed suspension must not close a newly authorized stream.
		}
		if event.UserID != 0 && (event.ID == 0 || event.ID >= b.userEvents[event.UserID]) {
			b.userEvents[event.UserID] = event.ID
			if event.Kind == KindUserDisabled {
				b.disabledUsers[event.UserID] = now
			} else {
				delete(b.disabledUsers, event.UserID)
			}
		}
	}
	b.pruneLocked(now)
	subs := make([]func(Event), 0, len(b.subs))
	for _, fn := range b.subs {
		subs = append(subs, fn)
	}
	b.mu.Unlock()
	for _, fn := range subs {
		b.dispatch(fn, event)
	}
}

func (b *Bus) dispatch(fn func(Event), event Event) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("revocation subscriber panicked", "kind", event.Kind, "id", event.ID, "panic", r)
		}
	}()
	fn(event)
}

func (b *Bus) pruneLocked(now time.Time) {
	cutoff := now.Add(-b.retention())
	for id, at := range b.seen {
		if at.Before(cutoff) {
			delete(b.seen, id)
		}
	}
	for userID, eventID := range b.userEvents {
		if _, retained := b.seen[eventID]; !retained {
			delete(b.userEvents, userID)
		}
	}
	for hash, at := range b.revokedTokens {
		if at.Before(cutoff) {
			delete(b.revokedTokens, hash)
		}
	}
	for hash, at := range b.revokedSessions {
		if at.Before(cutoff) {
			delete(b.revokedSessions, hash)
		}
	}
	for id, at := range b.disabledUsers {
		if at.Before(cutoff) {
			delete(b.disabledUsers, id)
		}
	}
}

// Deliver applies an event that arrived by some path other than the listener,
// for example the publisher in the same process. Safe before Start.
func (b *Bus) Deliver(event Event) {
	if b == nil {
		return
	}
	b.apply(event)
}

// Subscribe registers fn for every event. fn runs on the bus goroutine and
// must return quickly; hand slow work to another goroutine. The returned func
// unsubscribes.
func (b *Bus) Subscribe(fn func(Event)) func() {
	if b == nil || fn == nil {
		return func() {}
	}
	b.mu.Lock()
	id := b.nextSub
	b.nextSub++
	b.subs[id] = fn
	b.mu.Unlock()
	return func() {
		b.mu.Lock()
		delete(b.subs, id)
		b.mu.Unlock()
	}
}

// Watch returns a channel that yields the first event revoking principal. The
// subscription ends when ctx is done. Registration precedes checking retained
// credential revocations, so a completed revocation cannot fall into the gap
// between authentication and watching. A nil bus never yields.
func (b *Bus) Watch(ctx context.Context, principal Principal) <-chan Event {
	ch := make(chan Event, 1)
	if b == nil {
		return ch
	}
	var once sync.Once
	done := make(chan struct{})
	deliver := func(event Event) {
		if !event.Affects(principal) {
			return
		}
		once.Do(func() {
			ch <- event
			// The first hit is the terminal one; stop listening on behalf of
			// this watcher.
			close(done)
		})
	}
	unsubscribe := b.Subscribe(deliver)
	if event, revoked := Revoked(b, principal); revoked {
		deliver(event)
	}
	go func() {
		select {
		case <-ctx.Done():
		case <-done:
		}
		unsubscribe()
	}()
	return ch
}

// IsTokenRevoked reports whether a token with this hash was revoked recently.
func (b *Bus) IsTokenRevoked(tokenHash string) bool {
	if b == nil || tokenHash == "" {
		return false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	at, ok := b.revokedTokens[tokenHash]
	return ok && time.Since(at) <= b.retention()
}

// IsBrowserSessionRevoked reports whether the browser session with this key
// digest ended recently.
func (b *Bus) IsBrowserSessionRevoked(sessionHash string) bool {
	if b == nil || sessionHash == "" {
		return false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	at, ok := b.revokedSessions[sessionHash]
	return ok && time.Since(at) <= b.retention()
}

// IsUserDisabled reports whether the user was disabled recently.
func (b *Bus) IsUserDisabled(userID int64) bool {
	if b == nil || userID == 0 {
		return false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	at, ok := b.disabledUsers[userID]
	return ok && time.Since(at) <= b.retention()
}

// Cursor returns the highest event ID read from the durable log.
func (b *Bus) Cursor() int64 {
	if b == nil {
		return 0
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.cursor
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(d):
		return true
	}
}

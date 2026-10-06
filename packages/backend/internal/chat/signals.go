package chat

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

// turnChangedChannel carries a turn id whenever a batch commits, so a stream
// on any replica wakes without polling the journal.
const turnChangedChannel = "smithers_chat_turn_changed"

// turnSignals wakes the open streams of one process. The zero value is ready.
type turnSignals struct {
	mu       sync.Mutex
	watchers map[string]map[chan struct{}]struct{}
}

func (s *turnSignals) watch(turnID string) (<-chan struct{}, func()) {
	changed := make(chan struct{}, 1)
	s.mu.Lock()
	if s.watchers == nil {
		s.watchers = map[string]map[chan struct{}]struct{}{}
	}
	if s.watchers[turnID] == nil {
		s.watchers[turnID] = map[chan struct{}]struct{}{}
	}
	s.watchers[turnID][changed] = struct{}{}
	s.mu.Unlock()
	return changed, func() {
		s.mu.Lock()
		delete(s.watchers[turnID], changed)
		if len(s.watchers[turnID]) == 0 {
			delete(s.watchers, turnID)
		}
		s.mu.Unlock()
	}
}

func (s *turnSignals) notify(turnID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for changed := range s.watchers[turnID] {
		select {
		case changed <- struct{}{}:
		default:
		}
	}
}

// watch returns a channel that receives after the turn's journal changes.
func (s *Store) watch(turnID string) (<-chan struct{}, func()) { return s.signals.watch(turnID) }

// notifyTx publishes a turn change to other replicas when tx commits.
func notifyTx(ctx context.Context, tx pgx.Tx, turnID string) error {
	_, err := tx.Exec(ctx, `SELECT pg_notify($1,$2),
 pg_notify('view_' || repository_id::text || '_' || user_id::text,'{"type":"queue"}')
 FROM chat_turns WHERE id=$2`, turnChangedChannel, turnID)
	return err
}

// Listen relays commits made by other replicas to this process's streams. It
// holds one pool connection and reconnects until ctx ends. Streams also poll
// slowly, so a lost notification delays delivery and never loses it.
func (s *Store) Listen(ctx context.Context, report func(error)) error {
	for {
		err := s.listenOnce(ctx)
		if ctx.Err() != nil {
			return nil
		}
		if report != nil {
			report(err)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(time.Second):
		}
	}
}

func (s *Store) listenOnce(ctx context.Context) error {
	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return err
	}
	// A LISTEN session must not return to the pool.
	listener := conn.Hijack()
	defer func() { _ = listener.Close(context.WithoutCancel(ctx)) }()
	if _, err = listener.Exec(ctx, `LISTEN `+turnChangedChannel); err != nil {
		return err
	}
	for {
		notification, err := listener.WaitForNotification(ctx)
		if err != nil {
			return err
		}
		if notification == nil {
			return errors.New("chat listener received an empty notification")
		}
		s.signals.notify(notification.Payload)
	}
}

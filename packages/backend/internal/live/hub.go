package live

import (
	"bytes"
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/sse"
)

// Source is one shared topic's snapshot builder (spec §7.2): every
// subscriber of a topic reads the same committed facts, so one Build serves
// them all at one cursor.
type Source struct {
	// Key names the topic's stream. Subscribers with one key share its
	// cursor and its snapshots byte for byte.
	Key string
	// Hints are the broker channels whose notifications mean the facts may
	// have changed (the stack's mythical_<repo>).
	Hints []string
	// Every rebuilds without a hint, for facts no notification covers (a
	// run's steps, a machine's state).
	Every time.Duration
	// Build reads the snapshot from committed facts.
	Build func(context.Context) (json.RawMessage, error)
}

// Hints are the notifications a hub listens on: events arrive on the
// channel until stop; a closed channel means the listen was lost.
type Hints interface {
	Listen(ctx context.Context, channels []string) (events <-chan sse.Event, stop func(), err error)
}

// BrokerHints listens on sse.Broker, the install's one LISTEN connection.
type BrokerHints struct{ Broker *sse.Broker }

func (b BrokerHints) Listen(ctx context.Context, channels []string) (<-chan sse.Event, func(), error) {
	// The hub's streams share user 0's broker streams, one per topic.
	sub, err := b.Broker.SubscribeMulti(ctx, channels, 0)
	if err != nil {
		return nil, nil, err
	}
	return sub.Events(), func() { b.Broker.Unsubscribe(sub) }, nil
}

// Hub keeps one stream per shared topic: it builds the topic's snapshot
// once per hint or tick and sends it, at the stream's next cursor, to every
// subscriber when its bytes changed. It is the snapshot-only adapter over
// sse.Broker (spec §7.1).
type Hub struct {
	hints Hints
	now   func() time.Time
	ctx   context.Context

	mu      sync.Mutex
	streams map[string]*stream
	// last is each key's last cursor, so a topic whose stream restarts in
	// this process never reuses one. lastMu is taken last, under any other.
	lastMu sync.Mutex
	last   map[string]int64
}

// NewHub serves topics until ctx ends; hints may be nil (ticks only).
func NewHub(ctx context.Context, hints Hints) *Hub {
	return &Hub{hints: hints, now: time.Now, ctx: ctx, streams: map[string]*stream{}, last: map[string]int64{}}
}

// delivery is one subscriber's view of a stream: a snapshot at cursor, or
// failed when the stream has never built one.
type delivery func(cursor int64, data json.RawMessage, failed bool)

type stream struct {
	hub    *Hub
	source Source
	cancel context.CancelFunc

	mu      sync.Mutex
	members map[*delivery]struct{}
	cursor  int64
	data    json.RawMessage
	failed  bool
}

// Join adds deliver to source's stream, starting it if it is new, and
// answers how to leave it. A stream that already holds a snapshot delivers
// it at once.
func (h *Hub) Join(source Source, deliver func(cursor int64, data json.RawMessage, failed bool)) (leave func()) {
	d := delivery(deliver)
	h.mu.Lock()
	s := h.streams[source.Key]
	if s == nil {
		ctx, cancel := context.WithCancel(h.ctx)
		s = &stream{hub: h, source: source, cancel: cancel, members: map[*delivery]struct{}{}}
		h.streams[source.Key] = s
		go s.run(ctx)
	}
	s.mu.Lock()
	s.members[&d] = struct{}{}
	if s.data != nil {
		deliver(s.cursor, s.data, false)
	} else if s.failed {
		deliver(0, nil, true)
	}
	s.mu.Unlock()
	h.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			h.mu.Lock()
			defer h.mu.Unlock()
			s.mu.Lock()
			delete(s.members, &d)
			empty := len(s.members) == 0
			s.mu.Unlock()
			if empty && h.streams[source.Key] == s {
				delete(h.streams, source.Key)
				s.cancel()
				s.mu.Lock()
				cursor := s.cursor
				s.mu.Unlock()
				h.lastMu.Lock()
				h.last[source.Key] = max(h.last[source.Key], cursor)
				h.lastMu.Unlock()
			}
		})
	}
}

// Streams is the number of topics the hub serves now.
func (h *Hub) Streams() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.streams)
}

func (s *stream) run(ctx context.Context) {
	every := s.source.Every
	if every <= 0 {
		every = time.Second
	}
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	var stop func()
	var events <-chan sse.Event
	listen := func() {
		if s.hub.hints == nil || len(s.source.Hints) == 0 || stop != nil {
			return
		}
		// A refused or lost listen leaves the ticks; the next tick listens
		// again.
		if hinted, unlisten, err := s.hub.hints.Listen(ctx, s.source.Hints); err == nil {
			events, stop = hinted, unlisten
		}
	}
	defer func() {
		if stop != nil {
			stop()
		}
	}()
	listen()
	s.refresh(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case _, ok := <-events:
			if !ok {
				stop()
				events, stop = nil, nil
				continue
			}
			// One rebuild answers every hint already waiting.
			for drained := false; !drained; {
				select {
				case _, ok = <-events:
					if !ok {
						stop()
						events, stop = nil, nil
						drained = true
					}
				default:
					drained = true
				}
			}
			s.refresh(ctx)
		case <-ticker.C:
			listen()
			s.refresh(ctx)
		}
	}
}

// refresh builds the snapshot and sends it when its bytes changed. A build
// that fails keeps the last snapshot; a stream that never built one tells
// its subscribers so, once.
func (s *stream) refresh(ctx context.Context) {
	data, err := s.source.Build(ctx)
	if ctx.Err() != nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err != nil || !json.Valid(data) {
		if s.data == nil && !s.failed {
			s.failed = true
			for d := range s.members {
				(*d)(0, nil, true)
			}
		}
		return
	}
	if s.data != nil && bytes.Equal(s.data, data) {
		return
	}
	if s.cursor == 0 {
		s.hub.lastMu.Lock()
		s.cursor = max(s.hub.now().UnixMilli(), s.hub.last[s.source.Key]+1)
		s.hub.lastMu.Unlock()
	} else {
		s.cursor++
	}
	s.data, s.failed = data, false
	for d := range s.members {
		(*d)(s.cursor, data, false)
	}
}

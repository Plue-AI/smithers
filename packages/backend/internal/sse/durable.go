package sse

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

// DurablePage is an ordered page of persisted events. Cursor is the last row
// scanned, including rows hidden by authorization. More means another page may
// exist. IDs are increasing within this stream, never necessarily contiguous.
type DurablePage struct {
	Events []Event
	Cursor int64
	More   bool
}

// DurableStream reads the database as authority; broker events only wake it.
// Construct one instance per request. Head must use the writer's ordering
// barrier. An absent/invalid/zero Last-Event-ID starts at Head (live-only).
// A positive cursor resumes strictly after that ID. Load must not skip rows on
// errors and must return a complete, ordered page before anything is emitted.
type DurableStream struct {
	Head func(context.Context) (int64, error)
	Load func(context.Context, int64, int) (DurablePage, error)
	// Validate, when set, runs once for a positive Last-Event-ID before the
	// response starts. It returns pkgerrors.UnknownCursor when the cursor is
	// not one this stream issued, so a resume never silently skips events.
	Validate func(context.Context, int64) error
	// Ephemeral preserves explicitly non-durable control events without IDs.
	Ephemeral    func(Event) (Event, bool)
	PollInterval time.Duration
	cursor       int64
	initialized  bool
	check        func() error
}

const durablePageSize = 1000

// OnConnect performs initial catch-up. Failures are explicit and retry on the
// next wake or repair poll, without advancing past the failed page.
func (s *DurableStream) OnConnect(w http.ResponseWriter, r *http.Request, f http.Flusher) {
	if err := s.catchUp(w, r, f); err != nil && r.Context().Err() == nil {
		slog.WarnContext(r.Context(), "durable SSE catch-up failed", "after_id", s.cursor, "error", err)
		_, _ = fmt.Fprint(w, FormatEvent(Event{Type: "stream.error", Data: `{"code":"replay_unavailable","retryable":true}`}))
		f.Flush()
	}
}

func (s *DurableStream) initialize(r *http.Request) error {
	if !s.initialized {
		cursor, err := strconv.ParseInt(strings.TrimSpace(r.Header.Get("Last-Event-ID")), 10, 64)
		if err == nil && cursor > 0 && s.Validate != nil {
			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			defer cancel()
			if err := s.Validate(ctx, cursor); err != nil {
				return err
			}
		}
		if err != nil || cursor <= 0 {
			// A nil Head supports one-shot replay callbacks with no fresh subscription.
			if s.Head == nil {
				return nil
			}
			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			defer cancel()
			cursor, err = s.Head(ctx)
			if err != nil {
				return err
			}
		}
		if cursor < 0 {
			return errors.New("negative durable stream head")
		}
		s.cursor, s.initialized = cursor, true
	}
	return nil
}

func (s *DurableStream) catchUp(w http.ResponseWriter, r *http.Request, f http.Flusher) error {
	if err := s.initialize(r); err != nil {
		return err
	}
	if !s.initialized {
		return nil
	}
	for {
		if err := s.checkContext(r.Context()); err != nil {
			return err
		}
		page, err := s.Load(r.Context(), s.cursor, durablePageSize)
		if err != nil {
			return err
		}
		// Validate the whole page before emitting it. A broken adapter must not
		// silently advance a cursor or loop forever on an empty filtered page.
		previous := s.cursor
		for _, event := range page.Events {
			id, err := strconv.ParseInt(event.ID, 10, 64)
			if err != nil || id <= previous || id > page.Cursor {
				return errors.New("invalid durable event order")
			}
			previous = id
		}
		if page.Cursor < s.cursor || (page.More && page.Cursor == s.cursor) {
			return errors.New("durable page did not advance")
		}
		for _, event := range page.Events {
			if err := s.checkContext(r.Context()); err != nil {
				return err
			}
			if _, err := fmt.Fprint(w, FormatEvent(event)); err != nil {
				return err
			}
			f.Flush()
			s.cursor, _ = strconv.ParseInt(event.ID, 10, 64)
		}
		// Invisible rows move only the server's scan cursor. They never disclose an
		// event or an ID on the wire; reconnect may harmlessly scan them again.
		s.cursor = page.Cursor
		if !page.More {
			return nil
		}
	}
}

func (s *DurableStream) checkContext(ctx context.Context) error {
	if s.check != nil {
		if err := s.check(); err != nil {
			return err
		}
	}
	return ctx.Err()
}

func serveDurableBroker(w http.ResponseWriter, r *http.Request, f http.Flusher, cfg BrokerStreamConfig, hints <-chan Event, revoked <-chan revocation.Event, keepAlive time.Duration) {
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	r = r.WithContext(ctx)
	revokedResult := make(chan revocation.Event, 1)
	if revoked != nil {
		go func() {
			select {
			case ev, ok := <-revoked:
				if ok {
					revokedResult <- ev
					cancel()
				}
			case <-ctx.Done():
			}
		}()
	}
	sendRevoked := func() bool {
		select {
		case ev := <-revokedResult:
			cancel()
			data, _ := json.Marshal(ev)
			_, _ = fmt.Fprint(w, FormatEvent(Event{Type: RevokedEventType, Data: string(data)}))
			f.Flush()
			return true
		default:
			return false
		}
	}
	cfg.Durable.check = func() error {
		if sendRevoked() {
			return context.Canceled
		}
		return ctx.Err()
	}
	if cfg.OnConnect != nil {
		cfg.OnConnect(w, r, f)
	} else {
		cfg.Durable.OnConnect(w, r, f)
	}
	poll := cfg.Durable.PollInterval
	if poll <= 0 {
		poll = 5 * time.Second
	}
	repair := time.NewTicker(poll)
	defer repair.Stop()
	heartbeat := time.NewTicker(keepAlive)
	defer heartbeat.Stop()
	for {
		if sendRevoked() || ctx.Err() != nil {
			return
		}
		select {
		case <-ctx.Done():
			sendRevoked()
			return
		case hint, ok := <-hints:
			if !ok {
				return
			}
			cfg.Durable.OnConnect(w, r, f)
			if sendRevoked() || ctx.Err() != nil {
				return
			}
			if cfg.Durable.Ephemeral != nil {
				if event, ok := cfg.Durable.Ephemeral(hint); ok {
					event.ID = ""
					if _, err := fmt.Fprint(w, FormatEvent(event)); err != nil {
						return
					}
					f.Flush()
				}
			}
		case <-repair.C:
			cfg.Durable.OnConnect(w, r, f)
		case <-heartbeat.C:
			if _, err := fmt.Fprint(w, ": keep-alive\n\n"); err != nil {
				return
			}
			f.Flush()
		}
	}
}

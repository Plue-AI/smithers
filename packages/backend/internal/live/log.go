package live

import (
	"context"
	"encoding/json"
	"time"

	"github.com/coder/websocket"
)

// LogSource reads the existing durable product stream on the shared live
// socket. Nil cursor requests the last 200 entries; a supplied cursor reads
// strictly after it. A page larger than the replay window returns Gap.
type LogSource struct {
	Page func(context.Context, *int64) (LogPage, error)
}
type LogPage struct {
	Cursor int64
	Data   json.RawMessage
	Gap    bool
}

func (h *Hub) serveLog(ctx context.Context, source Source, out *outbox, id uint32, after *int64, refuse func(uint32, string)) *subscription {
	ctx, stop := context.WithCancel(ctx)
	sub := &subscription{leave: stop}
	h.logs.Add(1)
	go func() {
		defer h.logs.Add(-1)
		defer stop()
		var wake <-chan struct{}
		// The install's shared LISTEN broker is still the only hint transport.
		var hintStop func()
		if h.hints != nil && len(source.Hints) > 0 {
			events, closeHints, err := h.hints.Listen(ctx, source.Hints)
			if err == nil {
				hintStop = closeHints
				// One bounded notification channel avoids polling the broker and
				// still repairs a lost LISTEN connection on the regular tick.
				signal := make(chan struct{}, 1)
				go func() {
					for {
						select {
						case <-ctx.Done():
							return
						case _, ok := <-events:
							if !ok {
								return
							}
							select {
							case signal <- struct{}{}:
							default:
							}
						}
					}
				}()
				wake = signal
			}
		}
		if hintStop != nil {
			defer hintStop()
		}
		interval := source.Every
		if interval <= 0 {
			interval = time.Second
		}
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		cursor := after
		first := true
		for {
			page, err := source.Log.Page(ctx, cursor)
			if ctx.Err() != nil {
				return
			}
			if err != nil {
				sub.close()
				refuse(id, Unsupported)
				return
			}
			if page.Gap || page.Cursor < 0 || cursor != nil && page.Cursor < *cursor {
				sub.gap(out, id)
				return
			}
			if first || cursor == nil || page.Cursor > *cursor {
				kind := "delta"
				if first && after == nil {
					kind = "snap"
				}
				if !json.Valid(page.Data) {
					sub.close()
					refuse(id, Unsupported)
					return
				}
				sub.mu.Lock()
				if sub.closed || sub.gapped {
					sub.mu.Unlock()
					return
				}
				ok := out.pushChecked(encode(frame{T: kind, ID: id, Cursor: &page.Cursor, Data: page.Data}), false, websocket.MessageText, func() bool { sub.mu.Lock(); defer sub.mu.Unlock(); return !sub.closed && !sub.gapped })
				sub.mu.Unlock()
				if !ok {
					sub.gap(out, id)
					return
				}
			}
			current := page.Cursor
			cursor = &current
			first = false
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			case <-wake:
			}
		}
	}()
	return sub
}

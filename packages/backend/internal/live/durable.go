package live

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strconv"
	"time"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
)

// serveDurable adapts source replay directly; broker notifications are hints,
// never events. It adds no event, cursor, retention or projection store.
func (h *Hub) serveDurable(ctx context.Context, source Source, resume *int64, send func(frame) bool) {
	var events <-chan sse.Event
	var stop func()
	listen := func() {
		if h.hints == nil || len(source.Hints) == 0 || stop != nil {
			return
		}
		if hints, release, err := h.hints.Listen(ctx, source.Hints); err == nil {
			events, stop = hints, release
		}
	}
	defer func() {
		if stop != nil {
			stop()
		}
	}()
	listen()
	cursor := int64(0)
	var lastSnapshot json.RawMessage
	lastRefresh := time.Now()
	snapshot := func() bool {
		unavailable := false
		for {
			head, data, err := source.Snapshot(ctx)
			if err == nil && head >= 0 && json.Valid(data) {
				cursor = head
				if source.RefreshSnapshot != nil {
					lastSnapshot = append(lastSnapshot[:0], source.RefreshSnapshot(data)...)
				}
				return send(frame{T: "snap", Cursor: &head, Data: data})
			}
			if !unavailable {
				if !send(frame{T: "err", Code: Unsupported}) {
					return false
				}
				unavailable = true
			}
			// Registered sources may fail temporarily. Keep the subscription
			// alive and retry, as the snapshot-only adapter already does.
			timer := time.NewTimer(250 * time.Millisecond)
			select {
			case <-ctx.Done():
				timer.Stop()
				return false
			case <-timer.C:
			}
		}
	}

	if resume != nil {
		cursor = *resume
		// Validate the entire first replay before exposing any row: expired
		// cursors must receive a fresh snapshot, never a partial replay.
		if source.Durable.Validate != nil {
			for {
				err := source.Durable.Validate(ctx, cursor)
				if err == nil {
					break
				}
				if pkgerrors.IsUnknownCursor(err) {
					if !snapshot() {
						return
					}
					break
				}
				slog.WarnContext(ctx, "live cursor validation failed; retrying", "after", cursor, "error", err)
				timer := time.NewTimer(250 * time.Millisecond)
				select {
				case <-ctx.Done():
					timer.Stop()
					return
				case <-timer.C:
				}
			}
		}
	} else if !snapshot() {
		return
	}
	stopped := errors.New("delivery stopped")
	catchUp := func() bool {
		err := source.Durable.Replay(ctx, cursor, func(event sse.Event) error {
			seq, err := strconv.ParseInt(event.ID, 10, 64)
			if err != nil {
				return err
			}
			if !json.Valid([]byte(event.Data)) {
				return errors.New("invalid source payload")
			}
			if !send(frame{T: "delta", Cursor: &seq, Data: json.RawMessage(event.Data)}) {
				return stopped
			}
			if source.RefreshDelta != nil {
				lastSnapshot = source.RefreshDelta(lastSnapshot, json.RawMessage(event.Data))
			}
			cursor = seq
			return nil
		})
		if errors.Is(err, stopped) || ctx.Err() != nil {
			return false
		}
		if pkgerrors.IsUnknownCursor(err) {
			return snapshot()
		}
		if err != nil {
			slog.WarnContext(ctx, "live replay failed; retrying", "after", cursor, "error", err)
		}
		return true
	}
	if !catchUp() {
		return
	}
	interval := source.Every
	if interval <= 0 {
		interval = 250 * time.Millisecond
	}
	poll := time.NewTicker(interval)
	defer poll.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case _, ok := <-events:
			if !ok {
				stop()
				stop = nil
				events = nil
				continue
			}
			if !catchUp() {
				return
			}
		case <-poll.C:
			listen()
			if !catchUp() {
				return
			}
			if source.RefreshSnapshot != nil && time.Since(lastRefresh) >= source.RefreshEvery {
				lastRefresh = time.Now()
				head, data, err := source.Snapshot(ctx)
				if err == nil && head == cursor && json.Valid(data) && !bytes.Equal(source.RefreshSnapshot(data), lastSnapshot) {
					if source.RefreshSnapshot != nil {
						lastSnapshot = append(lastSnapshot[:0], source.RefreshSnapshot(data)...)
					}
					if !send(frame{T: "snap", Cursor: &head, Data: data}) {
						return
					}
				}
			}
		}
	}
}

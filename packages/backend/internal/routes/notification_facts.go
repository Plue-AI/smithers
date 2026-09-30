package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
)

func notificationFactCursor(raw string) (int64, error) {
	if strings.TrimSpace(raw) == "" {
		return 0, nil
	}
	cursor, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil || cursor < 0 {
		return 0, pkgerrors.BadRequest("invalid notification journal cursor")
	}
	return cursor, nil
}

// ListNotificationFacts handles GET /api/notifications/events?after=0&limit=1000.
// This is a separate versioned lifecycle API, leaving the legacy creation
// stream's notification envelope and public ID contract unchanged.
func (h *NotificationHandler) ListNotificationFacts(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	after, err := notificationFactCursor(r.URL.Query().Get("after"))
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	limit := 1000
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 1000 {
			pkgerrors.WriteError(w, pkgerrors.BadRequest("notification fact limit must be between 1 and 1000"))
			return
		}
		limit = parsed
	}
	page, err := h.Service.ListNotificationFacts(r.Context(), user.ID, after, limit)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, page)
}

// NotificationFactsStream handles GET /api/notifications/events/stream.
// Unlike the legacy creation feed, a new lifecycle subscription replays from
// the explicit baseline. This also makes an empty journal's zero cursor safe.
func (h *NotificationHandler) NotificationFactsStream(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	raw := r.Header.Get("Last-Event-ID")
	if raw == "" {
		raw = r.URL.Query().Get("after")
	}
	after, err := notificationFactCursor(raw)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	req := r.Clone(r.Context())
	req.Header.Set("Last-Event-ID", strconv.FormatInt(after, 10))
	stream := &sse.DurableStream{
		Head: func(context.Context) (int64, error) { return 0, nil },
		Validate: func(ctx context.Context, cursor int64) error {
			_, err := h.Service.ListNotificationFacts(ctx, user.ID, cursor, 1)
			return err
		},
		Load: func(ctx context.Context, cursor int64, limit int) (sse.DurablePage, error) {
			page, err := h.Service.ListNotificationFacts(ctx, user.ID, cursor, limit)
			if err != nil {
				return sse.DurablePage{}, err
			}
			result := sse.DurablePage{Cursor: page.Cursor, More: page.HasMore}
			if page.VisibilityFiltered && after > 0 {
				// No notification ID/body is disclosed. A resumed projection may retain
				// a now-hidden old image, so it must clear and rebuild from after=0.
				data, _ := json.Marshal(map[string]any{"schema_version": 1, "stream_id": page.StreamID, "reason": "visibility_filtered", "rebuild_from": 0})
				result.Events = []sse.Event{{ID: strconv.FormatInt(page.Cursor, 10), Type: "notification.reset", Data: string(data)}}
				return result, nil
			}
			for _, fact := range page.Events {
				data, err := json.Marshal(fact)
				if err != nil {
					return sse.DurablePage{}, err
				}
				result.Events = append(result.Events, sse.Event{ID: strconv.FormatInt(fact.Sequence, 10), Type: "notification.fact", Data: string(data)})
			}
			// A filtered suffix must still be resumable without exposing its records.
			if page.Cursor > cursor && (len(page.Events) == 0 || page.Events[len(page.Events)-1].Sequence < page.Cursor) {
				data, _ := json.Marshal(map[string]any{"schema_version": 1, "stream_id": page.StreamID, "cursor": page.Cursor})
				result.Events = append(result.Events, sse.Event{ID: strconv.FormatInt(page.Cursor, 10), Type: "notification.cursor", Data: string(data)})
			}
			return result, nil
		},
	}
	cfg := sse.BrokerStreamConfig{Broker: h.Broker, Channel: fmt.Sprintf("notification_facts_%d", user.ID), UserID: user.ID, Durable: stream, OnConnect: stream.OnConnect}
	attachRevocation(&cfg, req, revocation.Principal{})
	if h.Metrics != nil && h.Metrics.SSEActiveConnections != nil {
		cfg.ActiveConnections = h.Metrics.SSEActiveConnections
	}
	serveNotificationBrokerSSE(w, req, cfg)
}

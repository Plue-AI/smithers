package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
)

// NotificationRouteService is the minimal interface required by NotificationHandler.
type NotificationRouteService interface {
	ListNotificationFacts(context.Context, int64, int64, int) (services.NotificationFactPage, error)
	GetNotificationStreamHead(context.Context, int64) (int64, error)
	ListNotificationStreamPage(context.Context, int64, int64, int) (services.NotificationStreamPage, error)
	ListNotifications(ctx context.Context, userID int64, beforeID int64, limit int) ([]services.NotificationResponse, string, int64, error)
	ListNotificationsAfterID(ctx context.Context, userID, afterID int64, limit int) ([]services.NotificationResponse, error)
	MarkRead(ctx context.Context, userID, notificationID int64) error
	MarkAllRead(ctx context.Context, userID int64) error
	GetPreferences(ctx context.Context, userID int64) (services.NotificationPreferencesResponse, error)
	UpdatePreferences(ctx context.Context, userID int64, notifyIssues, notifyLandings, notifyMentions bool) (services.NotificationPreferencesResponse, error)
}

// NotificationHandler handles REST and SSE notification endpoints.
type NotificationHandler struct {
	Service NotificationRouteService
	// Broker multiplexes all notification LISTEN/NOTIFY streams over one shared
	// database connection and enforces the per-user concurrent stream cap.
	// If nil, the SSE stream endpoint returns a 500.
	Broker *sse.Broker
	// Metrics is used to record observability data (e.g. active connections).
	Metrics *SmithersMetrics
}

// serveNotificationBrokerSSE is a package-level seam so route tests can stub the
// SSE serving without a live broker.
var serveNotificationBrokerSSE = sse.ServeBrokerSSE

// ListNotifications handles GET /api/notifications/list.
// Returns a paginated list of notifications for the authenticated user.
func (h *NotificationHandler) ListNotifications(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	beforeID, limit, err := parseKeysetPagination(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	items, nextCursor, total, svcErr := h.Service.ListNotifications(r.Context(), user.ID, beforeID, limit)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	setFullCursorPaginationHeaders(w, r, limit, total, nextCursor)
	pkgerrors.WriteJSON(w, http.StatusOK, items)
}

// MarkNotificationRead handles PATCH /api/notifications/{id}.
// Marks a single notification as read for the authenticated user.
func (h *NotificationHandler) MarkNotificationRead(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	notifIDStr := chi.URLParam(r, "id")
	notifID, convErr := strconv.ParseInt(notifIDStr, 10, 64)
	if convErr != nil || notifID <= 0 {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid notification id"))
		return
	}

	if svcErr := h.Service.MarkRead(r.Context(), user.ID, notifID); svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// MarkAllNotificationsRead handles PUT /api/notifications/mark-read.
// Marks all unread notifications as read for the authenticated user.
func (h *NotificationHandler) MarkAllNotificationsRead(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	if svcErr := h.Service.MarkAllRead(r.Context(), user.ID); svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// notificationPreferencesRequest is the request body for updating notification preferences.
type notificationPreferencesRequest struct {
	NotifyIssues   *bool `json:"notify_issues"`
	NotifyLandings *bool `json:"notify_landings"`
	NotifyMentions *bool `json:"notify_mentions"`
}

// GetNotificationPreferences handles GET /api/notifications/preferences.
// Returns the authenticated user's in-app notification preferences.
func (h *NotificationHandler) GetNotificationPreferences(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	prefs, svcErr := h.Service.GetPreferences(r.Context(), user.ID)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusOK, prefs)
}

// PutNotificationPreferences handles PUT /api/notifications/preferences.
// Upserts the authenticated user's in-app notification preferences.
// Fields not present in the request body are left at their current values
// (partial-update semantics via nullable booleans).
func (h *NotificationHandler) PutNotificationPreferences(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	var req notificationPreferencesRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	// Read current preferences so that omitted fields keep their value.
	current, svcErr := h.Service.GetPreferences(r.Context(), user.ID)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	notifyIssues := current.NotifyIssues
	if req.NotifyIssues != nil {
		notifyIssues = *req.NotifyIssues
	}
	notifyLandings := current.NotifyLandings
	if req.NotifyLandings != nil {
		notifyLandings = *req.NotifyLandings
	}
	notifyMentions := current.NotifyMentions
	if req.NotifyMentions != nil {
		notifyMentions = *req.NotifyMentions
	}

	updated, svcErr := h.Service.UpdatePreferences(r.Context(), user.ID, notifyIssues, notifyLandings, notifyMentions)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusOK, updated)
}

// NotificationStream handles GET /api/notifications (SSE endpoint).
// Streams real-time notification events to the authenticated client via
// PostgreSQL LISTEN/NOTIFY. This endpoint is exempt from the 30s timeout
// middleware — connections are long-lived.
//
// Events are sent as:
//
//	id: 789
//	event: notification
//	data: {"id":789,"type":"mention","repo":"owner/repo","title":"..."}
//
// A ": keep-alive" comment is sent every 15 seconds to prevent proxy timeouts.
//
// If the client sends a Last-Event-ID header (set automatically by browsers
// on SSE reconnection), the handler replays any notifications with IDs greater
// than the given value before entering the live LISTEN/NOTIFY loop.
func (h *NotificationHandler) NotificationStream(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	// Each user gets their own PostgreSQL NOTIFY channel named after their user ID.
	channel := fmt.Sprintf("user_notifications_%d", user.ID)

	stream := h.durableNotifications(user.ID)
	cfg := sse.BrokerStreamConfig{
		Durable:       stream,
		Broker:        h.Broker,
		Channel:       channel,
		UserID:        user.ID,
		EventType:     "notification",
		FormatEventID: extractNotificationID,
		OnConnect:     stream.OnConnect,
	}

	attachRevocation(&cfg, r, revocation.Principal{})
	if h.Metrics != nil && h.Metrics.SSEActiveConnections != nil {
		cfg.ActiveConnections = h.Metrics.SSEActiveConnections
	}

	serveNotificationBrokerSSE(w, r, cfg)
}

// replayNotifications returns an OnConnect callback that replays missed
// notifications when the client reconnects with a Last-Event-ID header.
func (h *NotificationHandler) replayNotifications(userID int64) func(http.ResponseWriter, *http.Request, http.Flusher) {
	stream := h.durableNotifications(userID)
	stream.Head = nil
	return stream.OnConnect
}

// extractNotificationID extracts the "id" field from a JSON notification payload.
// Returns the stringified ID, or "" if extraction fails.
func extractNotificationID(data string) string {
	var partial struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal([]byte(data), &partial); err != nil || partial.ID == 0 {
		return ""
	}
	return strconv.FormatInt(partial.ID, 10)
}

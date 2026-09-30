package routes

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// AuditLogQuerier defines the database operations needed by the admin
// audit handler.
//
// Ticket 0134 added ListAuditLogsFiltered so operators can narrow a
// broad "show me everything since T" query down to a single approval
// or a single event-type family without paging blindly.
type AuditLogQuerier interface {
	ListAuditLogs(ctx context.Context, arg db.ListAuditLogsParams) ([]db.AuditLog, error)
	ListAuditLogsFiltered(ctx context.Context, arg db.ListAuditLogsFilteredParams) ([]db.AuditLog, error)
}

// AdminAuditHandler handles GET /api/admin/audit-logs.
type AdminAuditHandler struct {
	Queries AuditLogQuerier
}

// ListAuditLogs handles GET /api/admin/audit-logs?since=2024-01-01&page=1&per_page=50.
//
// Optional filter params added by ticket 0134:
//
//	event_type  — exact match (e.g. "approval.approved")
//	target_type — exact match (e.g. "approval")
//	target_id   — matches audit_log.target_name (supports UUID ids such
//	              as approval UUIDs, since target_id is BIGINT-only)
//	actor_id    — exact BIGINT match
//
// All filters are optional. When none are supplied, the handler keeps
// behaving like the pre-0134 endpoint (sends empty strings / zero as
// "wildcard" sentinels to the filtered query).
func (h *AdminAuditHandler) ListAuditLogs(w http.ResponseWriter, r *http.Request) {
	sinceStr := strings.TrimSpace(r.URL.Query().Get("since"))
	if sinceStr == "" {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("since parameter is required"))
		return
	}

	since, err := time.Parse(time.RFC3339, sinceStr)
	if err != nil {
		// Fall back to date-only format.
		since, err = time.Parse("2006-01-02", sinceStr)
		if err != nil {
			pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid since format, expected RFC3339 or YYYY-MM-DD"))
			return
		}
	}

	cursor, limit, parseErr := parseOffsetPaginationWithLimits(r, 50, 100, "invalid limit value", false)
	if parseErr != nil {
		pkgerrors.WriteError(w, parseErr.(*pkgerrors.APIError))
		return
	}

	eventType := strings.TrimSpace(r.URL.Query().Get("event_type"))
	targetType := strings.TrimSpace(r.URL.Query().Get("target_type"))
	targetID := strings.TrimSpace(r.URL.Query().Get("target_id"))
	actorIDStr := strings.TrimSpace(r.URL.Query().Get("actor_id"))

	// Modest length caps: VARCHAR(64) for event_type/target_type in the
	// schema, VARCHAR(255) for target_name. Reject garbage early rather
	// than running an expensive filter that can't match anything.
	if len(eventType) > 64 {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("event_type too long"))
		return
	}
	if len(targetType) > 64 {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("target_type too long"))
		return
	}
	if len(targetID) > 255 {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("target_id too long"))
		return
	}

	var actorID int64
	if actorIDStr != "" {
		parsed, perr := strconv.ParseInt(actorIDStr, 10, 64)
		if perr != nil || parsed < 0 {
			pkgerrors.WriteError(w, pkgerrors.BadRequest("actor_id must be a non-negative integer"))
			return
		}
		actorID = parsed
	}

	offset := clampOffsetInt32(cursorToOffset(cursor))
	logs, err := h.Queries.ListAuditLogsFiltered(r.Context(), db.ListAuditLogsFilteredParams{
		Since:      since,
		EventType:  eventType,
		TargetType: targetType,
		TargetName: targetID,
		ActorID:    actorID,
		PageOffset: offset,
		PageLimit:  int32(limit),
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusOK, logs)
}

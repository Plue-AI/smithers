package services

import (
	"context"
	"encoding/json"
	"log/slog"
	"net"
	"net/netip"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// AuditQueries is the minimal subset of db.Queries needed by AuditService.
type AuditQueries interface {
	InsertAuditLog(ctx context.Context, arg db.InsertAuditLogParams) error
}

// AuditService records audit events for observability.
type AuditService struct {
	q AuditQueries
}

// AuditEvent describes a single auditable action.
type AuditEvent struct {
	EventType  string
	ActorID    *int64 // nullable for unauthenticated events like failed auth
	ActorName  string
	TargetType string
	TargetID   *int64
	TargetName string
	Action     string
	Metadata   map[string]any
	IPAddress  string
}

// AuditIP is the form audit_log.ip_address stores (VARCHAR(45)): the client
// IP of a socket address such as r.RemoteAddr, without its port or zone, and
// an IPv4-mapped address as plain IPv4. Anything that is not an IP is "".
// An IPv6 peer with its port, "[2601:646:...:afd6]:52345", is 46 characters
// and failed the insert before.
func AuditIP(address string) string {
	if host, _, err := net.SplitHostPort(address); err == nil {
		address = host
	}
	ip, err := netip.ParseAddr(address)
	if err != nil {
		return ""
	}
	return ip.WithZone("").Unmap().String()
}

// NewAuditService returns a new AuditService.
func NewAuditService(q AuditQueries) *AuditService {
	return &AuditService{q: q}
}

// Log records an audit event. Fire-and-forget — never blocks the caller.
func (s *AuditService) Log(ctx context.Context, event AuditEvent) {
	metadataJSON, err := json.Marshal(event.Metadata)
	if err != nil {
		slog.Warn("audit: failed to marshal metadata", "event_type", event.EventType, "error", err)
		metadataJSON = []byte("{}")
	}

	var actorID pgtype.Int8
	if event.ActorID != nil {
		actorID = pgtype.Int8{Int64: *event.ActorID, Valid: true}
	}

	var targetID pgtype.Int8
	if event.TargetID != nil {
		targetID = pgtype.Int8{Int64: *event.TargetID, Valid: true}
	}

	if err := s.q.InsertAuditLog(ctx, db.InsertAuditLogParams{
		EventType:  event.EventType,
		ActorID:    actorID,
		ActorName:  event.ActorName,
		TargetType: event.TargetType,
		TargetID:   targetID,
		TargetName: event.TargetName,
		Action:     event.Action,
		Metadata:   json.RawMessage(metadataJSON),
		IpAddress:  AuditIP(event.IPAddress),
	}); err != nil {
		slog.Warn("audit: failed to insert audit log",
			"event_type", event.EventType,
			"actor_name", event.ActorName,
			"action", event.Action,
			"error", err,
		)
	}
}

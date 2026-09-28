// Package services — approvals service (ticket 0110).
//
// Provides the smithers-side API for the human-in-the-loop approvals flow:
//
//   - Create(ctx, input): called by the guest-agent forwarder when the
//     agent runtime emits MethodEmitApprovalRequest. Resolves the session,
//     derives repository_id from it, and persists a pending approval.
//
//   - Decide(ctx, input): called by the HTTP route handler when the user
//     approves or rejects. Implements:
//
//   - idempotency (same decision on a decided row -> 200 OK, no-op),
//
//   - conflict detection (different decision on a decided row -> 409),
//
//   - expiry enforcement (expires_at < now() -> 410 Gone-shaped error),
//
//   - repo scoping (approval must belong to the caller's repo).
//
// Expiry is NOT enforced by a background sweeper in v1. The decide endpoint
// is the single place that compares expires_at against now(); the realtime
// shape delivers rows verbatim and the client filters its UI on expires_at.
package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	stdErrors "errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// MaxApprovalPayloadBytes caps the serialized size of the payload JSON the
// agent runtime can attach to an approval request. 256 KiB is the same cap
// the guest-agent handler enforces defensively; Smithers re-checks here so an
// attacker who bypasses the guest still can't spam unbounded payloads.
const MaxApprovalPayloadBytes = 256 * 1024

// Approval state constants. The DB schema CHECK constraint mirrors this set;
// code paths MUST use these instead of string literals.
const (
	ApprovalStatePending  = "pending"
	ApprovalStateApproved = "approved"
	ApprovalStateRejected = "rejected"
	ApprovalStateExpired  = "expired"
)

// Approval kind caps. Mirror the guest-agent handler caps.
const (
	maxApprovalKindBytes        = 64
	maxApprovalTitleBytes       = 512
	maxApprovalDescriptionBytes = 4096
)

// ApprovalsQuerier is the minimal DB surface the ApprovalsService needs.
// Lives alongside AgentQuerier so tests can stub narrowly.
type ApprovalsQuerier interface {
	GetAgentSession(ctx context.Context, id string) (db.AgentSession, error)
	CreateApproval(ctx context.Context, arg db.CreateApprovalParams) (db.Approval, error)
	GetApproval(ctx context.Context, id string) (db.Approval, error)
	ListApprovalsByRepo(ctx context.Context, arg db.ListApprovalsByRepoParams) ([]db.Approval, error)
	DecideApproval(ctx context.Context, arg db.DecideApprovalParams) (db.Approval, error)
	ExpireApproval(ctx context.Context, arg db.ExpireApprovalParams) (db.Approval, error)
}

// ApprovalsAuditor is the narrow interface ApprovalsService uses to emit
// audit events (ticket 0134). The concrete type is *AuditService but we
// keep this narrow so tests can assert the exact payload without pulling
// in a DB mock.
//
// Note: ApprovalsService calls Log synchronously in the same goroutine as
// the request; AuditService.Log is documented as "fire-and-forget — never
// blocks the caller" which in practice means "non-returning, errors are
// swallowed." That matches this ticket's needs: a missed audit row must
// never turn a successful approval decide into a 500, but operators must
// still see the approval happened.
type ApprovalsAuditor interface {
	Log(ctx context.Context, event AuditEvent)
}

// Audit event type constants for approval lifecycle (ticket 0134). Kept
// as exported constants so downstream tools (admin audit surfaces,
// dashboards) can filter on the same strings without drift.
const (
	AuditEventApprovalRequested = "approval.requested"
	AuditEventApprovalApproved  = "approval.approved"
	AuditEventApprovalRejected  = "approval.rejected"
	AuditEventApprovalExpired   = "approval.expired"

	// AuditTargetTypeApproval identifies approval rows in audit_log. The
	// UUID id lives in target_name (since audit_log.target_id is BIGINT
	// and approvals.id is UUID).
	AuditTargetTypeApproval = "approval"
)

// CreateApprovalInput is the service-layer input for persisting a new
// pending approval on behalf of an agent runtime emission.
//
// The approval request is created on behalf of the agent runtime, not a
// human, so the audit row written by Create has a nil actor_id and an
// ActorName defaulting to "system:agent-runtime" (ticket 0134). The
// ForwarderIP field lets the guest-forwarder surface the sandbox's
// source IP for defense-in-depth logging.
type CreateApprovalInput struct {
	SessionID   string
	Kind        string
	Title       string
	Description string
	Payload     []byte // JSON-encoded object; may be empty
	ExpiresAt   time.Time
	ForwarderIP string
}

// DecideApprovalInput is the input to Decide. UserID is the authenticated
// user making the decision; RepositoryID is the route's repo-scope gate.
//
// ActorName + IPAddress were added by ticket 0134 so the audit row has
// the same shape as the rest of Smithers's audit events (username visible in
// admin UI, source IP for incident review). Both are best-effort: empty
// strings are acceptable when the caller can't cheaply derive them.
type DecideApprovalInput struct {
	ApprovalID   string
	RepositoryID int64
	UserID       int64
	ActorName    string
	IPAddress    string
	Decision     string // ApprovalStateApproved | ApprovalStateRejected
	Now          time.Time
}

// ApprovalResponse is the API DTO returned from service methods.
type ApprovalResponse struct {
	ID           string     `json:"id"`
	SessionID    string     `json:"session_id"`
	RepositoryID int64      `json:"repository_id"`
	State        string     `json:"state"`
	Kind         string     `json:"kind"`
	Title        string     `json:"title"`
	Description  string     `json:"description,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
	DecidedAt    *time.Time `json:"decided_at,omitempty"`
	DecidedBy    *int64     `json:"decided_by,omitempty"`
	ExpiresAt    *time.Time `json:"expires_at,omitempty"`
	Payload      []byte     `json:"payload,omitempty"`
}

// ApprovalPushNotifier is a seam for future durable push delivery.
type ApprovalPushNotifier interface {
	EnqueueApprovalPush(userID int64, approval ApprovalResponse)
}

// ApprovalsService owns the approvals lifecycle. Construct via
// NewApprovalsService.
type ApprovalsService struct {
	q            ApprovalsQuerier
	audit        ApprovalsAuditor
	pushNotifier ApprovalPushNotifier
}

type ApprovalsServiceOption func(*ApprovalsService)

func WithApprovalPushNotifier(notifier ApprovalPushNotifier) ApprovalsServiceOption {
	return func(s *ApprovalsService) {
		s.pushNotifier = notifier
	}
}

// NewApprovalsService constructs a service backed by q. Audit logging is
// disabled; use NewApprovalsServiceWithAudit to wire the ticket-0134
// audit trail. The nil-audit constructor is retained so existing tests
// and any caller that only needs the lifecycle semantics compile without
// change.
func NewApprovalsService(q ApprovalsQuerier, opts ...ApprovalsServiceOption) *ApprovalsService {
	s := &ApprovalsService{q: q}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// NewApprovalsServiceWithAudit is the production constructor: approvals
// lifecycle transitions write immutable audit rows via a. Pass nil for a
// to mirror NewApprovalsService behavior (useful in narrow unit tests).
func NewApprovalsServiceWithAudit(q ApprovalsQuerier, a ApprovalsAuditor, opts ...ApprovalsServiceOption) *ApprovalsService {
	s := &ApprovalsService{q: q, audit: a}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// Create persists a pending approval. Called by the guest-agent forwarder
// after the guest emits MethodEmitApprovalRequest (ticket 0110). The
// repository_id is derived from the session, not trusted from the caller,
// because the guest is outside Smithers's trust boundary.
//
// Returns pkgerrors.NotFound if the session is unknown / tombstoned.
func (s *ApprovalsService) Create(ctx context.Context, input CreateApprovalInput) (ApprovalResponse, error) {
	if input.SessionID == "" {
		return ApprovalResponse{}, pkgerrors.BadRequest("session_id is required")
	}
	if input.Kind == "" {
		return ApprovalResponse{}, pkgerrors.BadRequest("kind is required")
	}
	if input.Title == "" {
		return ApprovalResponse{}, pkgerrors.BadRequest("title is required")
	}
	if len(input.Kind) > maxApprovalKindBytes {
		return ApprovalResponse{}, pkgerrors.BadRequest("kind exceeds size limit")
	}
	if len(input.Title) > maxApprovalTitleBytes {
		return ApprovalResponse{}, pkgerrors.BadRequest("title exceeds size limit")
	}
	if len(input.Description) > maxApprovalDescriptionBytes {
		return ApprovalResponse{}, pkgerrors.BadRequest("description exceeds size limit")
	}
	if len(input.Payload) > MaxApprovalPayloadBytes {
		return ApprovalResponse{}, pkgerrors.BadRequest("payload exceeds size limit")
	}

	session, err := s.q.GetAgentSession(ctx, input.SessionID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return ApprovalResponse{}, pkgerrors.NotFound("agent session not found")
		}
		return ApprovalResponse{}, pkgerrors.Internal("load session: " + err.Error())
	}

	// Default payload to '{}' (an empty object) so the JSONB CHECK
	// constraint is satisfied without forcing every caller to construct
	// one.
	payload := input.Payload
	if len(payload) == 0 {
		payload = []byte(`{}`)
	}

	params := db.CreateApprovalParams{
		ID:           uuid.NewString(),
		SessionID:    session.ID,
		RepositoryID: session.RepositoryID,
		Kind:         input.Kind,
		Title:        input.Title,
		Description:  textOrNull(input.Description),
		ExpiresAt:    timestampOrNull(input.ExpiresAt),
		Payload:      payload,
	}

	row, err := s.q.CreateApproval(ctx, params)
	if err != nil {
		return ApprovalResponse{}, pkgerrors.Internal("create approval: " + err.Error())
	}
	resp := toApprovalResponse(row)
	s.logApprovalEvent(ctx, approvalAuditArgs{
		EventType: AuditEventApprovalRequested,
		ActorID:   nil, // system actor: agent runtime, not a human
		ActorName: "system:agent-runtime",
		IPAddress: input.ForwarderIP,
		Action:    "request",
		Row:       row,
		Decision:  "",
	})
	if row.State == ApprovalStatePending && s.pushNotifier != nil {
		s.pushNotifier.EnqueueApprovalPush(session.UserID, resp)
	}
	return resp, nil
}

// Decide transitions a pending approval to approved or rejected.
//
// Contract:
//   - Valid pending -> terminal:     returns the updated row.
//   - Already-decided, same decision: idempotent, returns the existing row.
//   - Already-decided, different:     returns 409 Conflict.
//   - Expired (expires_at < now):     marks row expired + returns 400.
//   - Wrong repo:                     returns 404 (don't leak existence).
//   - Non-existent:                   returns 404.
//
// The `UPDATE ... WHERE state = 'pending'` guard is the atomic fence: the
// row's state can only move from pending to a terminal state exactly once.
// A racing second caller that arrives after the first will see zero rows
// updated and then fall into the re-read branch, which classifies the
// attempt.
func (s *ApprovalsService) Decide(ctx context.Context, input DecideApprovalInput) (ApprovalResponse, error) {
	if input.ApprovalID == "" {
		return ApprovalResponse{}, pkgerrors.BadRequest("approval_id is required")
	}
	if input.Decision != ApprovalStateApproved && input.Decision != ApprovalStateRejected {
		return ApprovalResponse{}, pkgerrors.BadRequest("decision must be 'approved' or 'rejected'")
	}
	if input.UserID <= 0 {
		return ApprovalResponse{}, pkgerrors.Unauthorized("authentication required")
	}
	if input.RepositoryID <= 0 {
		return ApprovalResponse{}, pkgerrors.BadRequest("repository context required")
	}
	now := input.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}

	// Preflight: verify the approval exists and belongs to the route's
	// repo scope. Doing this before the UPDATE lets us return a clean 404
	// for cross-repo ID guessing without leaking existence.
	existing, err := s.q.GetApproval(ctx, input.ApprovalID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return ApprovalResponse{}, pkgerrors.NotFound("approval not found")
		}
		return ApprovalResponse{}, pkgerrors.Internal("load approval: " + err.Error())
	}
	if existing.RepositoryID != input.RepositoryID {
		// Treat cross-repo access as a 404 so route scope acts as a
		// non-discoverable boundary.
		return ApprovalResponse{}, pkgerrors.NotFound("approval not found")
	}
	if existing.State == ApprovalStateExpired {
		return ApprovalResponse{}, pkgerrors.BadRequest("approval has expired")
	}
	// Expiry: enforced at decide time. A pending row whose expires_at is
	// in the past cannot be decided. We opportunistically mark it expired
	// (single-writer UPDATE with state='pending' guard) so repeated
	// decide attempts don't emit duplicate expiry events.
	if existing.State == ApprovalStatePending && existing.ExpiresAt.Valid && existing.ExpiresAt.Time.Before(now) {
		expired, expErr := s.q.ExpireApproval(ctx, db.ExpireApprovalParams{
			ID:           input.ApprovalID,
			RepositoryID: input.RepositoryID,
			ExpiresAt: pgtype.Timestamptz{
				Time:  now,
				Valid: true,
			},
		})
		if expErr != nil && !stdErrors.Is(expErr, pgx.ErrNoRows) {
			return ApprovalResponse{}, pkgerrors.Internal("expire approval: " + expErr.Error())
		}
		if expErr == nil {
			s.logApprovalEvent(ctx, approvalAuditArgs{
				EventType: AuditEventApprovalExpired,
				ActorID:   nil, // system actor: time-based expiry
				ActorName: "system:expiry-policy",
				Action:    "expire",
				Row:       expired,
				Decision:  ApprovalStateExpired,
			})
		}
		return ApprovalResponse{}, pkgerrors.BadRequest("approval has expired")
	}
	// Already-decided branch: classify same vs different decision BEFORE
	// hitting the UPDATE, to keep the DB contention footprint small.
	if existing.State != ApprovalStatePending {
		if existing.State == input.Decision {
			return toApprovalResponse(existing), nil
		}
		return ApprovalResponse{}, pkgerrors.Conflict("approval already decided")
	}

	decided, err := s.q.DecideApproval(ctx, db.DecideApprovalParams{
		ID:           input.ApprovalID,
		State:        input.Decision,
		DecidedBy:    pgtype.Int8{Int64: input.UserID, Valid: true},
		RepositoryID: input.RepositoryID,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			// Lost race: someone else decided between our preflight and
			// our UPDATE. Re-read and classify.
			latest, rerr := s.q.GetApproval(ctx, input.ApprovalID)
			if rerr != nil {
				return ApprovalResponse{}, pkgerrors.Internal("post-race reload: " + rerr.Error())
			}
			if latest.State == input.Decision {
				return toApprovalResponse(latest), nil
			}
			return ApprovalResponse{}, pkgerrors.Conflict("approval already decided")
		}
		return ApprovalResponse{}, pkgerrors.Internal("decide approval: " + err.Error())
	}

	// Audit: only emit on the winning UPDATE path. The idempotent-same-
	// decision and lost-race-same-decision branches above return WITHOUT
	// writing an audit row because the winner already wrote one; double-
	// counting would corrupt any "who approved it?" query.
	actorID := input.UserID
	eventType := AuditEventApprovalApproved
	action := "approve"
	if input.Decision == ApprovalStateRejected {
		eventType = AuditEventApprovalRejected
		action = "reject"
	}
	s.logApprovalEvent(ctx, approvalAuditArgs{
		EventType: eventType,
		ActorID:   &actorID,
		ActorName: input.ActorName,
		IPAddress: input.IPAddress,
		Action:    action,
		Row:       decided,
		Decision:  input.Decision,
	})
	return toApprovalResponse(decided), nil
}

// ListForRepo returns approvals scoped to one repository. Empty state returns
// all states; inbox clients normally pass "pending".
func (s *ApprovalsService) ListForRepo(ctx context.Context, repositoryID int64, state string, page, perPage int) ([]ApprovalResponse, error) {
	if s.q == nil {
		return nil, pkgerrors.Internal("approvals store unavailable")
	}
	if repositoryID <= 0 {
		return nil, pkgerrors.BadRequest("repository context required")
	}
	if perPage <= 0 {
		perPage = 30
	}
	offset := (page - 1) * perPage
	if offset < 0 {
		offset = 0
	}

	rows, err := s.q.ListApprovalsByRepo(ctx, db.ListApprovalsByRepoParams{
		RepositoryID: repositoryID,
		State:        state,
		PageSize:     int32(perPage),
		PageOffset:   ClampInt32(offset),
	})
	if err != nil {
		return nil, pkgerrors.Internal("list approvals: " + err.Error())
	}

	out := make([]ApprovalResponse, len(rows))
	for i, row := range rows {
		out[i] = toApprovalResponse(row)
	}
	return out, nil
}

// approvalAuditArgs bundles the parameters for logApprovalEvent so the
// call sites at Create / Decide stay readable.
type approvalAuditArgs struct {
	EventType string
	ActorID   *int64
	ActorName string
	IPAddress string
	Action    string
	Row       db.Approval
	Decision  string
}

// logApprovalEvent writes a lifecycle audit row via the configured
// auditor. No-op if audit is not wired — this keeps the narrow-unit-test
// constructor (NewApprovalsService) viable.
//
// Metadata policy (ticket 0134):
//   - identifiers only: repository_id, session_id, kind, state, decision
//   - expires_at included when set
//   - payload fingerprint only: payload_sha256 + payload_size_bytes
//   - NO title, description, payload: those may contain user-sensitive
//     context and would bloat audit_log. An operator who needs the full
//     row can join on target_name = approvals.id.
func (s *ApprovalsService) logApprovalEvent(ctx context.Context, args approvalAuditArgs) {
	if s.audit == nil {
		return
	}
	meta := map[string]any{
		"approval_id":   args.Row.ID,
		"repository_id": args.Row.RepositoryID,
		"session_id":    args.Row.SessionID,
		"kind":          args.Row.Kind,
		"state":         args.Row.State,
		// Keep a stable payload identifier without storing the raw blob.
		"payload_sha256":     approvalPayloadSHA256(args.Row.Payload),
		"payload_size_bytes": len(args.Row.Payload),
	}
	if args.Decision != "" {
		meta["decision"] = args.Decision
	}
	if args.Row.ExpiresAt.Valid {
		meta["expires_at"] = args.Row.ExpiresAt.Time.UTC().Format(time.RFC3339)
	}
	if args.Row.DecidedBy.Valid {
		meta["decided_by"] = args.Row.DecidedBy.Int64
	}
	s.audit.Log(ctx, AuditEvent{
		EventType:  args.EventType,
		ActorID:    args.ActorID,
		ActorName:  args.ActorName,
		TargetType: AuditTargetTypeApproval,
		// target_id is BIGINT; approvals use UUIDs, so we store the id
		// in target_name. The (target_type, target_id) index still works
		// as a coarse filter; retrieval queries filter on target_name.
		TargetID:   nil,
		TargetName: args.Row.ID,
		Action:     args.Action,
		Metadata:   meta,
		IPAddress:  args.IPAddress,
	})
}

func approvalPayloadSHA256(payload []byte) string {
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

// GetForRepo fetches an approval scoped to a repository. Callers use this
// from the decide-route preflight path when they want the row without
// mutating it. Served by GET on a single approval in
// internal/routes/approvals.go.
func (s *ApprovalsService) GetForRepo(ctx context.Context, approvalID string, repoID int64) (ApprovalResponse, error) {
	row, err := s.q.GetApproval(ctx, approvalID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return ApprovalResponse{}, pkgerrors.NotFound("approval not found")
		}
		return ApprovalResponse{}, pkgerrors.Internal(err.Error())
	}
	if row.RepositoryID != repoID {
		return ApprovalResponse{}, pkgerrors.NotFound("approval not found")
	}
	return toApprovalResponse(row), nil
}

// toApprovalResponse converts a db.Approval row into its API DTO.
func toApprovalResponse(row db.Approval) ApprovalResponse {
	resp := ApprovalResponse{
		ID:           row.ID,
		SessionID:    row.SessionID,
		RepositoryID: row.RepositoryID,
		State:        row.State,
		Kind:         row.Kind,
		Title:        row.Title,
		CreatedAt:    row.CreatedAt,
		Payload:      row.Payload,
	}
	if row.Description.Valid {
		resp.Description = row.Description.String
	}
	if row.DecidedAt.Valid {
		t := row.DecidedAt.Time
		resp.DecidedAt = &t
	}
	if row.DecidedBy.Valid {
		id := row.DecidedBy.Int64
		resp.DecidedBy = &id
	}
	if row.ExpiresAt.Valid {
		t := row.ExpiresAt.Time
		resp.ExpiresAt = &t
	}
	return resp
}

func textOrNull(s string) pgtype.Text {
	if s == "" {
		return pgtype.Text{}
	}
	return pgtype.Text{String: s, Valid: true}
}

func timestampOrNull(t time.Time) pgtype.Timestamptz {
	if t.IsZero() {
		return pgtype.Timestamptz{}
	}
	return pgtype.Timestamptz{Time: t, Valid: true}
}

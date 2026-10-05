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
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	stdErrors "errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
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
	// todos files the TODO a person confirms (WithConfirmedTodos); nil
	// leaves every confirmation unavailable.
	todos ConfirmedTodoFiler
	now   func() time.Time
}

type ApprovalsServiceOption func(*ApprovalsService)

func WithApprovalPushNotifier(notifier ApprovalPushNotifier) ApprovalsServiceOption {
	return func(s *ApprovalsService) {
		s.pushNotifier = notifier
	}
}

// WithConfirmedTodos makes the service's person confirmations executable:
// a member's Confirm files the TODO through todos (spec §5.4).
func WithConfirmedTodos(todos ConfirmedTodoFiler) ApprovalsServiceOption {
	return func(s *ApprovalsService) {
		s.todos = todos
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
		SessionID:    pgtype.Text{String: session.ID, Valid: true},
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
		"session_id":    args.Row.SessionID.String,
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
		SessionID:    row.SessionID.String,
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

// ── Person confirmations (spec §5.4, T-APP-04) ─────────────────────────────
//
// A delegated credential's command whose policy is confirm runs nothing: it
// records an approvals row for the member it acts for, and only that member's
// own browser session presses Confirm or Cancel. Stage 1 confirms one
// command, a terminal's TODO (todo.new appended to the stack).

// ConfirmationTTL is how long a person confirmation waits for its press.
const ConfirmationTTL = 24 * time.Hour

// ConfirmedTodoFiler files the TODO a member confirmed: MythicalService's
// FileTodo with input.Confirmation set.
type ConfirmedTodoFiler interface {
	FileTodo(ctx context.Context, repositoryID, userID int64, input MythicalTodoInput) (MythicalItemView, error)
}

// TodoConfirmation is the confirmation a TODO filing settles: the filing
// approves it in its own transaction, keys its idempotency by it, and names
// the agent that asked as the TODO's author (By, the TodoCard Actor, and
// ByRef, the facts' {person, via, session}).
type TodoConfirmation struct {
	ID    string
	By    json.RawMessage
	ByRef map[string]any
}

// confirmationStore is the approvals store person confirmations use;
// *db.Queries is one.
type confirmationStore interface {
	GetUserByID(ctx context.Context, id int64) (db.User, error)
	CreateConfirmation(ctx context.Context, arg db.CreateConfirmationParams) (db.Approval, error)
	GetConfirmationByRequest(ctx context.Context, arg db.GetConfirmationByRequestParams) (db.Approval, error)
	GetConfirmation(ctx context.Context, id string) (db.Approval, error)
	ExpireMemberConfirmations(ctx context.Context, memberID pgtype.Int8) error
	ListMemberConfirmations(ctx context.Context, arg db.ListMemberConfirmationsParams) ([]db.Approval, error)
	DecideConfirmation(ctx context.Context, arg db.DecideConfirmationParams) (db.Approval, error)
}

// ConfirmationReceipt is all a delegated caller learns of a confirmation:
// its id and state (spec §5.4).
type ConfirmationReceipt struct {
	Confirmation string `json:"confirmation"`
	State        string `json:"state"`
}

// Confirmation is a person's own confirmation as their app reads it: its id
// and state, the Confirm card (packages/rpc ConfirmCard) and, once
// confirmed, the TODO it committed.
type Confirmation struct {
	ID        string         `json:"id"`
	State     string         `json:"state"`
	CreatedAt time.Time      `json:"created_at"`
	ExpiresAt *time.Time     `json:"expires_at,omitempty"`
	Todo      int64          `json:"todo,omitempty"`
	Card      map[string]any `json:"card"`
	// credential is the credential whose request made it.
	credential int64
}

// confirmationPayload is a confirmation row's payload: the command, its
// validated input, who asked, and once confirmed the TODO it committed.
type confirmationPayload struct {
	Command string            `json:"command"`
	Input   MythicalTodoInput `json:"input"`
	AskedBy json.RawMessage   `json:"asked_by"`
	ByRef   map[string]any    `json:"by_ref"`
	Todo    int64             `json:"todo,omitempty"`
}

func confirmationUnavailable() error {
	return &TodoControlError{http.StatusServiceUnavailable, "confirmation_unavailable", "infra", "Confirmations are unavailable"}
}

func (s *ApprovalsService) confirmationStore() (confirmationStore, error) {
	if s == nil {
		return nil, confirmationUnavailable()
	}
	store, ok := s.q.(confirmationStore)
	if !ok || s.todos == nil {
		return nil, confirmationUnavailable()
	}
	return store, nil
}

func (s *ApprovalsService) clock() time.Time {
	if s.now != nil {
		return s.now()
	}
	return time.Now().UTC()
}

// RequestConfirmation records the private confirmation a terminal
// credential's TODO waits on (spec §5.3.2a, §5.4): a pending one_click row
// for memberID, bound to the credential and the request's Idempotency-Key
// (input.Request), that expires after ConfirmationTTL. It files nothing. The
// same credential's same request answers that confirmation in its current
// state; the same key with another request is 409 idempotency_mismatch. A
// TODO placed anywhere but the end of the stack is 403 permission.
func (s *ApprovalsService) RequestConfirmation(ctx context.Context, repositoryID, memberID int64, input MythicalTodoInput) (ConfirmationReceipt, error) {
	store, err := s.confirmationStore()
	if err != nil {
		return ConfirmationReceipt{}, err
	}
	info := middleware.AuthInfoFromContext(ctx)
	if _, delegated := info.Delegation(); !delegated || info.TokenID <= 0 {
		return ConfirmationReceipt{}, &AccessError{Status: http.StatusForbidden, Class: "permission", Code: "permission", Message: "Only an agent's credential asks for a confirmation"}
	}
	key := input.Request
	if key == "" || len(key) > 256 {
		return ConfirmationReceipt{}, &TodoControlError{http.StatusBadRequest, "idempotency_key_required", "user", "Idempotency-Key is required"}
	}
	if input, err = confirmationTodo(input); err != nil {
		return ConfirmationReceipt{}, err
	}
	person, err := store.GetUserByID(ctx, memberID)
	if err != nil {
		return ConfirmationReceipt{}, err
	}
	payload, err := json.Marshal(confirmationPayload{Command: "todo.new", Input: input, AskedBy: todoActor(ctx, person), ByRef: todoActorRef(ctx, person)})
	if err != nil {
		return ConfirmationReceipt{}, err
	}
	now := s.clock()
	credential := pgtype.Int8{Int64: info.TokenID, Valid: true}
	row, err := store.CreateConfirmation(ctx, db.CreateConfirmationParams{
		ID: uuid.NewString(), RepositoryID: repositoryID, MemberID: pgtype.Int8{Int64: memberID, Valid: true},
		CredentialID: credential, RequestKey: pgtype.Text{String: key, Valid: true}, Kind: "one_click", Title: input.Title,
		ExpiresAt: pgtype.Timestamptz{Time: now.Add(ConfirmationTTL), Valid: true}, Payload: payload,
	})
	if stdErrors.Is(err, pgx.ErrNoRows) {
		// This credential sent this key before: the same request answers its
		// confirmation as it stands now.
		if row, err = store.GetConfirmationByRequest(ctx, db.GetConfirmationByRequestParams{CredentialID: credential, RequestKey: pgtype.Text{String: key, Valid: true}}); err != nil {
			return ConfirmationReceipt{}, err
		}
		var held confirmationPayload
		_ = json.Unmarshal(row.Payload, &held)
		was, _ := json.Marshal(held.Input)
		asked, _ := json.Marshal(input)
		if row.RepositoryID != repositoryID || row.MemberID.Int64 != memberID || held.Command != "todo.new" || !bytes.Equal(was, asked) {
			return ConfirmationReceipt{}, &TodoControlError{http.StatusConflict, "idempotency_mismatch", "conflict", "Idempotency-Key was already used for a different request"}
		}
		return ConfirmationReceipt{Confirmation: row.ID, State: confirmationState(row, now)}, nil
	}
	if err != nil {
		return ConfirmationReceipt{}, err
	}
	s.logApprovalEvent(ctx, approvalAuditArgs{EventType: AuditEventApprovalRequested, ActorID: &memberID, ActorName: person.Username, Action: "request", Row: row})
	return ConfirmationReceipt{Confirmation: row.ID, State: row.State}, nil
}

// confirmationTodo is a terminal's TODO as its confirmation stores it: a
// trimmed title of 1 to 256 bytes and a prompt of up to 64 KiB, neither
// blank, with no NUL byte in any text (PostgreSQL refuses one), appended to
// the stack and made from no issue (spec §5.3.2a: other placements are 403).
// A replay of the request compares this value's JSON with the stored one, so
// the value is unchanged by a JSON round trip and by a second pass.
func confirmationTodo(input MythicalTodoInput) (MythicalTodoInput, error) {
	// Text is stored as JSON, which holds only valid UTF-8.
	valid := func(text string) string { return strings.ToValidUTF8(text, "\uFFFD") }
	title, prompt := strings.TrimSpace(valid(input.Title)), valid(input.Prompt)
	acceptance := make([]string, 0, len(input.Acceptance))
	for _, line := range input.Acceptance {
		acceptance = append(acceptance, valid(line))
	}
	if title == "" || strings.TrimSpace(prompt) == "" || len(title) > 256 || len(prompt) > 64<<10 ||
		strings.ContainsRune(title+prompt+strings.Join(acceptance, ""), 0) {
		return MythicalTodoInput{}, &TodoControlError{http.StatusBadRequest, "invalid_todo", "user", "Title and prompt are required"}
	}
	if input.Issue != nil || input.IssueDigest != "" || input.Fixes != nil || input.Place.N != nil || input.Place.Mode != "" && input.Place.Mode != "append" {
		return MythicalTodoInput{}, &AccessError{Status: http.StatusForbidden, Class: "permission", Code: "permission", Message: "A terminal's TODO goes at the end of the stack"}
	}
	return MythicalTodoInput{Title: title, Prompt: prompt, Acceptance: acceptance, Place: MythicalTodoPlace{Mode: "append"}, Request: input.Request}, nil
}

// Confirmations are memberID's own confirmations on the repository, newest
// first, each with its Confirm card. A pending one past its expiry is stored
// and read as expired.
func (s *ApprovalsService) Confirmations(ctx context.Context, repositoryID, memberID int64) ([]Confirmation, error) {
	store, err := s.confirmationStore()
	if err != nil {
		return nil, err
	}
	member := pgtype.Int8{Int64: memberID, Valid: true}
	if err = store.ExpireMemberConfirmations(ctx, member); err != nil {
		return nil, err
	}
	rows, err := store.ListMemberConfirmations(ctx, db.ListMemberConfirmationsParams{RepositoryID: repositoryID, MemberID: member})
	if err != nil {
		return nil, err
	}
	person, err := store.GetUserByID(ctx, memberID)
	if err != nil {
		return nil, err
	}
	out := make([]Confirmation, 0, len(rows))
	for _, row := range rows {
		out = append(out, confirmationView(row, person))
	}
	return out, nil
}

// ConfirmationReceipts are the {confirmation, state} of the confirmations in
// list that credential's requests made: all a delegated reader sees of its
// member's confirmations (spec §5.4).
func ConfirmationReceipts(list []Confirmation, credential int64) []ConfirmationReceipt {
	out := []ConfirmationReceipt{}
	for _, each := range list {
		if each.credential == credential {
			out = append(out, ConfirmationReceipt{Confirmation: each.ID, State: each.State})
		}
	}
	return out
}

// ApproveConfirmation is memberID's Confirm (spec §5.4), from their own
// browser session (the route authorizes confirmations.decide) on their own
// pending confirmation. It files the TODO as the member, authored by the
// agent that asked, and approves the confirmation in the filing's
// transaction (MythicalService.FileTodo), so a second press from any of the
// member's sessions files nothing more and answers the same TODO. Another
// member's confirmation is 403 permission; a cancelled or expired one 409.
func (s *ApprovalsService) ApproveConfirmation(ctx context.Context, repositoryID, memberID int64, id string) (Confirmation, error) {
	store, row, person, err := s.ownConfirmation(ctx, repositoryID, memberID, id)
	if err != nil {
		return Confirmation{}, err
	}
	if row.State == ApprovalStatePending {
		var asked confirmationPayload
		if json.Unmarshal(row.Payload, &asked) != nil || asked.Command != "todo.new" {
			return Confirmation{}, confirmationUnavailable()
		}
		input := asked.Input
		input.Request = "confirmation-" + row.ID
		input.Confirmation = &TodoConfirmation{ID: row.ID, By: asked.AskedBy, ByRef: asked.ByRef}
		_, err = s.todos.FileTodo(ctx, repositoryID, memberID, input)
		var lost *TodoControlError
		if err != nil && !(stdErrors.As(err, &lost) && lost.Code == "confirmation_decided") {
			return Confirmation{}, err
		}
		if row, err = store.GetConfirmation(ctx, id); err != nil {
			return Confirmation{}, err
		}
		row.State = confirmationState(row, s.clock())
		if lost == nil {
			s.logApprovalEvent(ctx, approvalAuditArgs{EventType: AuditEventApprovalApproved, ActorID: &memberID, ActorName: person.Username, Action: "approve", Row: row, Decision: ApprovalStateApproved})
		}
	}
	return settledConfirmation(row, person, ApprovalStateApproved)
}

// DenyConfirmation is memberID's Cancel on their own pending confirmation:
// nothing runs, and a second Cancel answers the same.
func (s *ApprovalsService) DenyConfirmation(ctx context.Context, repositoryID, memberID int64, id string) (Confirmation, error) {
	store, row, person, err := s.ownConfirmation(ctx, repositoryID, memberID, id)
	if err != nil {
		return Confirmation{}, err
	}
	if row.State == ApprovalStatePending {
		decided, err := store.DecideConfirmation(ctx, db.DecideConfirmationParams{ID: id, MemberID: pgtype.Int8{Int64: memberID, Valid: true}, State: ApprovalStateRejected, Result: json.RawMessage(`{}`)})
		switch {
		case err == nil:
			s.logApprovalEvent(ctx, approvalAuditArgs{EventType: AuditEventApprovalRejected, ActorID: &memberID, ActorName: person.Username, Action: "reject", Row: decided, Decision: ApprovalStateRejected})
		case stdErrors.Is(err, pgx.ErrNoRows):
			decided, err = store.GetConfirmation(ctx, id)
		}
		if err != nil {
			return Confirmation{}, err
		}
		row = decided
	}
	return settledConfirmation(row, person, ApprovalStateRejected)
}

// ownConfirmation reads confirmation id for its member's press: 404 when the
// repository holds no such confirmation, 403 permission when it is another
// person's. A pending one past its expiry is stored as expired first.
func (s *ApprovalsService) ownConfirmation(ctx context.Context, repositoryID, memberID int64, id string) (confirmationStore, db.Approval, db.User, error) {
	store, err := s.confirmationStore()
	if err != nil {
		return nil, db.Approval{}, db.User{}, err
	}
	missing := &TodoControlError{http.StatusNotFound, "confirmation_not_found", "user", "No such confirmation"}
	if _, err = uuid.Parse(id); err != nil {
		return nil, db.Approval{}, db.User{}, missing
	}
	row, err := store.GetConfirmation(ctx, id)
	if stdErrors.Is(err, pgx.ErrNoRows) || err == nil && row.RepositoryID != repositoryID {
		return nil, db.Approval{}, db.User{}, missing
	}
	if err != nil {
		return nil, db.Approval{}, db.User{}, err
	}
	if row.MemberID.Int64 != memberID {
		return nil, db.Approval{}, db.User{}, &AccessError{Status: http.StatusForbidden, Class: "permission", Code: "permission", Message: "Only the person it asks can answer it"}
	}
	if confirmationState(row, s.clock()) == ApprovalStateExpired && row.State == ApprovalStatePending {
		if err = store.ExpireMemberConfirmations(ctx, row.MemberID); err != nil {
			return nil, db.Approval{}, db.User{}, err
		}
		row.State = ApprovalStateExpired
	}
	person, err := store.GetUserByID(ctx, memberID)
	if err != nil {
		return nil, db.Approval{}, db.User{}, err
	}
	return store, row, person, nil
}

// settledConfirmation answers a press: the confirmation when it settled as
// the press asked, else 409 naming how it settled.
func settledConfirmation(row db.Approval, person db.User, want string) (Confirmation, error) {
	switch {
	case row.State == want:
		return confirmationView(row, person), nil
	case row.State == ApprovalStateExpired:
		return Confirmation{}, &TodoControlError{http.StatusConflict, "confirmation_expired", "conflict", "This confirmation expired"}
	case row.State == ApprovalStateApproved:
		return Confirmation{}, &TodoControlError{http.StatusConflict, "confirmation_decided", "conflict", "This confirmation was confirmed"}
	case row.State == ApprovalStateRejected:
		return Confirmation{}, &TodoControlError{http.StatusConflict, "confirmation_decided", "conflict", "This confirmation was cancelled"}
	}
	return Confirmation{}, &TodoControlError{http.StatusConflict, "confirmation_decided", "conflict", "This confirmation is still pending"}
}

// confirmationState is the row's state as of now: a pending row past its
// expiry is expired.
func confirmationState(row db.Approval, now time.Time) string {
	if row.State == ApprovalStatePending && row.ExpiresAt.Valid && !row.ExpiresAt.Time.After(now) {
		return ApprovalStateExpired
	}
	return row.State
}

// confirmationView is row as its member's app reads it, with the Confirm
// card: one_click, Commit, the TODO's title and the exact prompt it sends,
// who asked, and the receipt once it settled.
func confirmationView(row db.Approval, person db.User) Confirmation {
	var asked confirmationPayload
	_ = json.Unmarshal(row.Payload, &asked)
	title := asked.Input.Title
	card := map[string]any{"kind": row.Kind, "action": map[string]any{"tag": asked.Command, "verb": "Commit"},
		"summary": "Commit " + title, "subject": map[string]any{"kind": "todo", "ref": title}, "text": asked.Input.Prompt}
	if len(asked.AskedBy) > 0 {
		card["asked_by"] = asked.AskedBy
	}
	view := Confirmation{ID: row.ID, State: row.State, CreatedAt: row.CreatedAt, Todo: asked.Todo, Card: card, credential: row.CredentialID.Int64}
	if row.ExpiresAt.Valid {
		at := row.ExpiresAt.Time
		view.ExpiresAt = &at
	}
	name := person.DisplayName
	if name == "" {
		name = person.Username
	}
	receipt := map[string]any{"by": map[string]any{"login": person.Username, "name": name, "avatar_url": todoAvatar(person)}}
	if row.DecidedAt.Valid {
		receipt["at"] = row.DecidedAt.Time.UTC().Format(time.RFC3339Nano)
	} else if view.ExpiresAt != nil {
		receipt["at"] = view.ExpiresAt.UTC().Format(time.RFC3339Nano)
	}
	switch row.State {
	case ApprovalStateApproved:
		receipt["result"], receipt["text"] = "done", fmt.Sprintf("Committed T%d", asked.Todo)
	case ApprovalStateRejected:
		receipt["result"] = "cancelled"
	case ApprovalStateExpired:
		receipt["result"] = "expired"
	default:
		return view
	}
	card["receipt"] = receipt
	return view
}

package services

import (
	"context"
	"encoding/json"
	stdErrors "errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// fakeApprovalsQuerier is an in-memory stub for ApprovalsQuerier. Tests
// inject deterministic state instead of mocking row scans.
type fakeApprovalsQuerier struct {
	sessions  map[string]db.AgentSession
	approvals map[string]db.Approval

	// createHook lets tests observe the full params passed into CreateApproval.
	createHook func(db.CreateApprovalParams)
	// decideHook lets tests observe the decide call.
	decideHook func(db.DecideApprovalParams)
	// expireHook lets tests observe the expire call.
	expireHook func(db.ExpireApprovalParams)
	// decideErr, if set, is returned verbatim by DecideApproval. Used to
	// inject ErrNoRows so the race branch in Decide is exercised.
	decideErr error
	// expireErr, if set, is returned verbatim by ExpireApproval.
	expireErr error
}

func newFakeQuerier() *fakeApprovalsQuerier {
	return &fakeApprovalsQuerier{
		sessions:  make(map[string]db.AgentSession),
		approvals: make(map[string]db.Approval),
	}
}

func (f *fakeApprovalsQuerier) GetAgentSession(_ context.Context, id string) (db.AgentSession, error) {
	s, ok := f.sessions[id]
	if !ok {
		return db.AgentSession{}, pgx.ErrNoRows
	}
	return s, nil
}

func (f *fakeApprovalsQuerier) CreateApproval(_ context.Context, arg db.CreateApprovalParams) (db.Approval, error) {
	if f.createHook != nil {
		f.createHook(arg)
	}
	row := db.Approval{
		ID:           arg.ID,
		SessionID:    arg.SessionID,
		RepositoryID: arg.RepositoryID,
		State:        ApprovalStatePending,
		Kind:         arg.Kind,
		Title:        arg.Title,
		Description:  arg.Description,
		CreatedAt:    time.Now().UTC(),
		ExpiresAt:    arg.ExpiresAt,
		Payload:      arg.Payload,
	}
	f.approvals[row.ID] = row
	return row, nil
}

func (f *fakeApprovalsQuerier) GetApproval(_ context.Context, id string) (db.Approval, error) {
	r, ok := f.approvals[id]
	if !ok {
		return db.Approval{}, pgx.ErrNoRows
	}
	return r, nil
}

func (f *fakeApprovalsQuerier) ListApprovalsByRepo(_ context.Context, arg db.ListApprovalsByRepoParams) ([]db.Approval, error) {
	rows := make([]db.Approval, 0, len(f.approvals))
	for _, approval := range f.approvals {
		if approval.RepositoryID != arg.RepositoryID {
			continue
		}
		if arg.State != "" && approval.State != arg.State {
			continue
		}
		rows = append(rows, approval)
	}
	return rows, nil
}

func (f *fakeApprovalsQuerier) DecideApproval(_ context.Context, arg db.DecideApprovalParams) (db.Approval, error) {
	if f.decideHook != nil {
		f.decideHook(arg)
	}
	if f.decideErr != nil {
		return db.Approval{}, f.decideErr
	}
	r, ok := f.approvals[arg.ID]
	if !ok {
		return db.Approval{}, pgx.ErrNoRows
	}
	if r.RepositoryID != arg.RepositoryID {
		return db.Approval{}, pgx.ErrNoRows
	}
	if r.State != ApprovalStatePending {
		// Mirror the SQL guard: no rows match -> ErrNoRows.
		return db.Approval{}, pgx.ErrNoRows
	}
	r.State = arg.State
	r.DecidedAt = pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}
	r.DecidedBy = arg.DecidedBy
	f.approvals[r.ID] = r
	return r, nil
}

func (f *fakeApprovalsQuerier) ExpireApproval(_ context.Context, arg db.ExpireApprovalParams) (db.Approval, error) {
	if f.expireHook != nil {
		f.expireHook(arg)
	}
	if f.expireErr != nil {
		return db.Approval{}, f.expireErr
	}
	r, ok := f.approvals[arg.ID]
	if !ok {
		return db.Approval{}, pgx.ErrNoRows
	}
	if r.RepositoryID != arg.RepositoryID {
		return db.Approval{}, pgx.ErrNoRows
	}
	if r.State != ApprovalStatePending {
		return db.Approval{}, pgx.ErrNoRows
	}
	if !r.ExpiresAt.Valid || !r.ExpiresAt.Time.Before(arg.ExpiresAt.Time) {
		return db.Approval{}, pgx.ErrNoRows
	}
	r.State = ApprovalStateExpired
	r.DecidedAt = pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}
	r.DecidedBy = pgtype.Int8{}
	f.approvals[r.ID] = r
	return r, nil
}

func sampleSession(t *testing.T) db.AgentSession {
	t.Helper()
	return db.AgentSession{
		ID:           "11111111-2222-3333-4444-555555555555",
		RepositoryID: 42,
		UserID:       7,
		Status:       "active",
		CreatedAt:    time.Now().UTC(),
		UpdatedAt:    time.Now().UTC(),
	}
}

func seededApproval(repoID int64, state string) db.Approval {
	r := db.Approval{
		ID:           "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		SessionID:    "11111111-2222-3333-4444-555555555555",
		RepositoryID: repoID,
		State:        state,
		Kind:         "shell_command",
		Title:        "run `rm -rf`",
		CreatedAt:    time.Now().UTC(),
		Payload:      []byte(`{}`),
	}
	if state != ApprovalStatePending {
		r.DecidedAt = pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}
		r.DecidedBy = pgtype.Int8{Int64: 7, Valid: true}
	}
	return r
}

type recordingApprovalPushNotifier struct {
	calls []recordedApprovalPush
}

type recordedApprovalPush struct {
	userID   int64
	approval ApprovalResponse
}

func (r *recordingApprovalPushNotifier) EnqueueApprovalPush(userID int64, approval ApprovalResponse) {
	r.calls = append(r.calls, recordedApprovalPush{userID: userID, approval: approval})
}

func TestApprovalsService_ListForRepo_FiltersByRepositoryAndState(t *testing.T) {
	t.Parallel()
	q := newFakeQuerier()
	pending := seededApproval(42, ApprovalStatePending)
	pending.ID = "pending-approval"
	approved := seededApproval(42, ApprovalStateApproved)
	approved.ID = "approved-approval"
	otherRepo := seededApproval(99, ApprovalStatePending)
	otherRepo.ID = "other-repo-approval"
	q.approvals[pending.ID] = pending
	q.approvals[approved.ID] = approved
	q.approvals[otherRepo.ID] = otherRepo

	svc := NewApprovalsService(q)
	rows, err := svc.ListForRepo(context.Background(), 42, ApprovalStatePending, 1, 30)

	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.Equal(t, pending.ID, rows[0].ID)
	assert.Equal(t, ApprovalStatePending, rows[0].State)
}

func TestApprovalsService_ListForRepo_AllStates(t *testing.T) {
	t.Parallel()
	q := newFakeQuerier()
	pending := seededApproval(42, ApprovalStatePending)
	pending.ID = "pending-approval"
	rejected := seededApproval(42, ApprovalStateRejected)
	rejected.ID = "rejected-approval"
	q.approvals[pending.ID] = pending
	q.approvals[rejected.ID] = rejected

	svc := NewApprovalsService(q)
	rows, err := svc.ListForRepo(context.Background(), 42, "", 1, 30)

	require.NoError(t, err)
	require.Len(t, rows, 2)
}

// -----------------------------------------------------------------------------
// Create
// -----------------------------------------------------------------------------

func TestApprovalsService_Create_PersistsPendingRowWithSessionRepoID(t *testing.T) {
	t.Parallel()
	q := newFakeQuerier()
	s := sampleSession(t)
	q.sessions[s.ID] = s

	var captured db.CreateApprovalParams
	q.createHook = func(arg db.CreateApprovalParams) { captured = arg }

	svc := NewApprovalsService(q)
	resp, err := svc.Create(context.Background(), CreateApprovalInput{
		SessionID:   s.ID,
		Kind:        "shell_command",
		Title:       "run installer",
		Description: "needs sudo",
		Payload:     []byte(`{"cmd":"brew install foo"}`),
	})
	require.NoError(t, err)
	assert.Equal(t, ApprovalStatePending, resp.State)
	// repository_id is derived from the session, not the caller.
	assert.Equal(t, int64(42), resp.RepositoryID)
	assert.Equal(t, int64(42), captured.RepositoryID)
	assert.Equal(t, s.ID, captured.SessionID)
	assert.Equal(t, "shell_command", captured.Kind)
	// Empty payload is replaced with '{}' so the JSONB CHECK passes.
	assert.Equal(t, `{"cmd":"brew install foo"}`, string(captured.Payload))
}

func TestApprovalsService_Create_EnqueuesPushForPendingApproval(t *testing.T) {
	t.Parallel()
	q := newFakeQuerier()
	s := sampleSession(t)
	q.sessions[s.ID] = s
	pushes := &recordingApprovalPushNotifier{}

	svc := NewApprovalsService(q, WithApprovalPushNotifier(pushes))
	resp, err := svc.Create(context.Background(), CreateApprovalInput{
		SessionID: s.ID,
		Kind:      "shell_command",
		Title:     "restart service",
	})
	require.NoError(t, err)

	require.Len(t, pushes.calls, 1)
	assert.Equal(t, s.UserID, pushes.calls[0].userID)
	assert.Equal(t, resp.ID, pushes.calls[0].approval.ID)
	assert.Equal(t, ApprovalStatePending, pushes.calls[0].approval.State)
}

func TestApprovalsService_Create_UnknownSession_ReturnsNotFound(t *testing.T) {
	t.Parallel()
	svc := NewApprovalsService(newFakeQuerier())
	_, err := svc.Create(context.Background(), CreateApprovalInput{
		SessionID: "nope",
		Kind:      "k",
		Title:     "t",
	})
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, httpStatusNotFound, apiErr.Status)
}

func TestApprovalsService_Create_PayloadTooLarge_Rejected(t *testing.T) {
	t.Parallel()
	q := newFakeQuerier()
	s := sampleSession(t)
	q.sessions[s.ID] = s
	svc := NewApprovalsService(q)

	big := make([]byte, MaxApprovalPayloadBytes+1)
	_, err := svc.Create(context.Background(), CreateApprovalInput{
		SessionID: s.ID,
		Kind:      "shell_command",
		Title:     "t",
		Payload:   big,
	})
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, httpStatusBadRequest, apiErr.Status)
	assert.True(t, strings.Contains(apiErr.Message, "payload"))
}

func TestApprovalsService_Create_EmptyPayloadDefaultsToObject(t *testing.T) {
	t.Parallel()
	q := newFakeQuerier()
	s := sampleSession(t)
	q.sessions[s.ID] = s

	var captured db.CreateApprovalParams
	q.createHook = func(arg db.CreateApprovalParams) { captured = arg }

	svc := NewApprovalsService(q)
	_, err := svc.Create(context.Background(), CreateApprovalInput{
		SessionID: s.ID,
		Kind:      "shell_command",
		Title:     "t",
	})
	require.NoError(t, err)
	assert.Equal(t, `{}`, string(captured.Payload))
}

// -----------------------------------------------------------------------------
// Decide — full matrix mandated by the ticket acceptance criteria.
// -----------------------------------------------------------------------------

func TestApprovalsService_Decide_PendingToApproved(t *testing.T) {
	t.Parallel()
	q := newFakeQuerier()
	r := seededApproval(42, ApprovalStatePending)
	q.approvals[r.ID] = r

	svc := NewApprovalsService(q)
	resp, err := svc.Decide(context.Background(), DecideApprovalInput{
		ApprovalID:   r.ID,
		RepositoryID: 42,
		UserID:       7,
		Decision:     ApprovalStateApproved,
	})
	require.NoError(t, err)
	assert.Equal(t, ApprovalStateApproved, resp.State)
	require.NotNil(t, resp.DecidedAt)
	require.NotNil(t, resp.DecidedBy)
	assert.Equal(t, int64(7), *resp.DecidedBy)
}

func TestApprovalsService_Decide_IdempotentSameDecision(t *testing.T) {
	t.Parallel()
	q := newFakeQuerier()
	r := seededApproval(42, ApprovalStateApproved)
	q.approvals[r.ID] = r

	var decideCalled bool
	q.decideHook = func(_ db.DecideApprovalParams) { decideCalled = true }

	svc := NewApprovalsService(q)
	resp, err := svc.Decide(context.Background(), DecideApprovalInput{
		ApprovalID:   r.ID,
		RepositoryID: 42,
		UserID:       7,
		Decision:     ApprovalStateApproved,
	})
	require.NoError(t, err)
	assert.Equal(t, ApprovalStateApproved, resp.State)
	// Idempotent path MUST NOT hit the UPDATE (no state change to make).
	assert.False(t, decideCalled, "decide should be a no-op on same-decision idempotent path")
}

func TestApprovalsService_Decide_ConflictingDecision_Returns409(t *testing.T) {
	t.Parallel()
	q := newFakeQuerier()
	r := seededApproval(42, ApprovalStateApproved)
	q.approvals[r.ID] = r

	svc := NewApprovalsService(q)
	_, err := svc.Decide(context.Background(), DecideApprovalInput{
		ApprovalID:   r.ID,
		RepositoryID: 42,
		UserID:       7,
		Decision:     ApprovalStateRejected,
	})
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, httpStatusConflict, apiErr.Status)
}

func TestApprovalsService_Decide_Expired_Rejected(t *testing.T) {
	t.Parallel()
	q := newFakeQuerier()
	r := seededApproval(42, ApprovalStatePending)
	r.ExpiresAt = pgtype.Timestamptz{Time: time.Now().Add(-1 * time.Hour), Valid: true}
	q.approvals[r.ID] = r

	svc := NewApprovalsService(q)
	_, err := svc.Decide(context.Background(), DecideApprovalInput{
		ApprovalID:   r.ID,
		RepositoryID: 42,
		UserID:       7,
		Decision:     ApprovalStateApproved,
		Now:          time.Now().UTC(),
	})
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, httpStatusBadRequest, apiErr.Status)
	assert.Contains(t, apiErr.Message, "expired")
	assert.Equal(t, ApprovalStateExpired, q.approvals[r.ID].State)
}

func TestApprovalsService_Decide_WrongRepo_Returns404(t *testing.T) {
	t.Parallel()
	q := newFakeQuerier()
	r := seededApproval(42, ApprovalStatePending)
	q.approvals[r.ID] = r

	svc := NewApprovalsService(q)
	_, err := svc.Decide(context.Background(), DecideApprovalInput{
		ApprovalID:   r.ID,
		RepositoryID: 99, // different repo
		UserID:       7,
		Decision:     ApprovalStateApproved,
	})
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, httpStatusNotFound, apiErr.Status)
}

func TestApprovalsService_Decide_NonExistent_Returns404(t *testing.T) {
	t.Parallel()
	q := newFakeQuerier()
	svc := NewApprovalsService(q)
	_, err := svc.Decide(context.Background(), DecideApprovalInput{
		ApprovalID:   "ghost",
		RepositoryID: 42,
		UserID:       7,
		Decision:     ApprovalStateApproved,
	})
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, httpStatusNotFound, apiErr.Status)
}

func TestApprovalsService_Decide_BadDecision_Returns400(t *testing.T) {
	t.Parallel()
	q := newFakeQuerier()
	svc := NewApprovalsService(q)
	_, err := svc.Decide(context.Background(), DecideApprovalInput{
		ApprovalID:   "x",
		RepositoryID: 42,
		UserID:       7,
		Decision:     "maybe",
	})
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, httpStatusBadRequest, apiErr.Status)
}

// TestApprovalsService_Decide_LostRace_SameDecisionIsIdempotent exercises
// the fallback branch: the preflight sees state=pending, the UPDATE
// returns zero rows (because another caller beat us to it), and the
// service re-reads + classifies. When the winning decision matches ours,
// the response is a normal 200, not a 409.
func TestApprovalsService_Decide_LostRace_SameDecisionIsIdempotent(t *testing.T) {
	t.Parallel()
	q := newFakeQuerier()
	r := seededApproval(42, ApprovalStatePending)
	q.approvals[r.ID] = r

	// Override decideErr so DecideApproval returns ErrNoRows, simulating
	// a different caller winning the atomic UPDATE. Simultaneously move
	// the stored row to 'approved' so the re-read sees the winner's state.
	q.decideErr = pgx.ErrNoRows
	q.decideHook = func(_ db.DecideApprovalParams) {
		winner := q.approvals[r.ID]
		winner.State = ApprovalStateApproved
		winner.DecidedAt = pgtype.Timestamptz{Time: time.Now(), Valid: true}
		winner.DecidedBy = pgtype.Int8{Int64: 8, Valid: true}
		q.approvals[r.ID] = winner
	}

	svc := NewApprovalsService(q)
	resp, err := svc.Decide(context.Background(), DecideApprovalInput{
		ApprovalID:   r.ID,
		RepositoryID: 42,
		UserID:       7,
		Decision:     ApprovalStateApproved,
	})
	require.NoError(t, err)
	assert.Equal(t, ApprovalStateApproved, resp.State)
}

// TestApprovalsService_Decide_LostRace_DifferentDecisionReturns409 covers
// the same code path but the winning state disagrees with our attempt.
func TestApprovalsService_Decide_LostRace_DifferentDecisionReturns409(t *testing.T) {
	t.Parallel()
	q := newFakeQuerier()
	r := seededApproval(42, ApprovalStatePending)
	// Keep preflight seeing pending, but flip to rejected in the UPDATE step.
	q.approvals[r.ID] = r

	q.decideErr = pgx.ErrNoRows
	q.decideHook = func(_ db.DecideApprovalParams) {
		winner := q.approvals[r.ID]
		winner.State = ApprovalStateRejected
		winner.DecidedAt = pgtype.Timestamptz{Time: time.Now(), Valid: true}
		q.approvals[r.ID] = winner
	}

	svc := NewApprovalsService(q)
	_, err := svc.Decide(context.Background(), DecideApprovalInput{
		ApprovalID:   r.ID,
		RepositoryID: 42,
		UserID:       7,
		Decision:     ApprovalStateApproved,
	})
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, httpStatusConflict, apiErr.Status)
}

// -----------------------------------------------------------------------------
// Fan-out / integration-shaped check: two readers see the pending state
// pre-decide and the terminal state post-decide, simulating the realtime
// shape delivering the visible->visible-with-new-state transition.
// -----------------------------------------------------------------------------

func TestApprovalsService_FanOut_SharedState(t *testing.T) {
	t.Parallel()
	q := newFakeQuerier()
	s := sampleSession(t)
	q.sessions[s.ID] = s

	svc := NewApprovalsService(q)
	created, err := svc.Create(context.Background(), CreateApprovalInput{
		SessionID: s.ID,
		Kind:      "file_write",
		Title:     "overwrite foo.txt",
	})
	require.NoError(t, err)

	// Two independent reads (simulating two realtime clients) before decide.
	r1, err := svc.GetForRepo(context.Background(), created.ID, 42)
	require.NoError(t, err)
	r2, err := svc.GetForRepo(context.Background(), created.ID, 42)
	require.NoError(t, err)
	assert.Equal(t, ApprovalStatePending, r1.State)
	assert.Equal(t, ApprovalStatePending, r2.State)

	// Decide.
	_, err = svc.Decide(context.Background(), DecideApprovalInput{
		ApprovalID:   created.ID,
		RepositoryID: 42,
		UserID:       7,
		Decision:     ApprovalStateApproved,
	})
	require.NoError(t, err)

	// Both readers now see the terminal state.
	r1, err = svc.GetForRepo(context.Background(), created.ID, 42)
	require.NoError(t, err)
	r2, err = svc.GetForRepo(context.Background(), created.ID, 42)
	require.NoError(t, err)
	assert.Equal(t, ApprovalStateApproved, r1.State)
	assert.Equal(t, ApprovalStateApproved, r2.State)
}

// Ensure pgx.ErrNoRows import stays used even if a test is deleted.
var _ = stdErrors.Is

// -----------------------------------------------------------------------------
// Ticket 0134: audit logging
// -----------------------------------------------------------------------------

// recordingAuditor captures AuditEvents so tests can assert the shape
// of the rows ApprovalsService writes to the audit log.
type recordingAuditor struct {
	events []AuditEvent
}

func (r *recordingAuditor) Log(_ context.Context, e AuditEvent) {
	r.events = append(r.events, e)
}

func TestApprovalsAudit_CreateEmitsRequestedEvent(t *testing.T) {
	t.Parallel()
	q := newFakeQuerier()
	s := sampleSession(t)
	q.sessions[s.ID] = s
	rec := &recordingAuditor{}

	svc := NewApprovalsServiceWithAudit(q, rec)
	resp, err := svc.Create(context.Background(), CreateApprovalInput{
		SessionID:   s.ID,
		Kind:        "shell_command",
		Title:       "run `rm -rf /`", // sensitive title — MUST NOT leak into audit
		Description: "would wipe the box",
		Payload:     []byte(`{"cmd":"rm -rf /"}`), // sensitive payload — MUST NOT leak
		ForwarderIP: "10.1.2.3",
	})
	require.NoError(t, err)

	require.Len(t, rec.events, 1)
	e := rec.events[0]
	assert.Equal(t, AuditEventApprovalRequested, e.EventType)
	assert.Equal(t, AuditTargetTypeApproval, e.TargetType)
	assert.Equal(t, resp.ID, e.TargetName)
	// System actor: no authenticated user behind approval request.
	assert.Nil(t, e.ActorID)
	assert.Equal(t, "system:agent-runtime", e.ActorName)
	assert.Equal(t, "request", e.Action)
	assert.Equal(t, "10.1.2.3", e.IPAddress)

	// Metadata carries identifiers only — never raw payload/title/description.
	assert.Equal(t, resp.ID, e.Metadata["approval_id"])
	assert.Equal(t, int64(42), e.Metadata["repository_id"])
	assert.Equal(t, s.ID, e.Metadata["session_id"])
	assert.Equal(t, "shell_command", e.Metadata["kind"])
	assert.Equal(t, ApprovalStatePending, e.Metadata["state"])
	assert.Equal(t, approvalPayloadSHA256([]byte(`{"cmd":"rm -rf /"}`)), e.Metadata["payload_sha256"])
	assert.Equal(t, len([]byte(`{"cmd":"rm -rf /"}`)), e.Metadata["payload_size_bytes"])

	// Sensitive fields MUST NOT be copied verbatim.
	for _, k := range []string{"title", "description", "payload"} {
		_, ok := e.Metadata[k]
		assert.False(t, ok, "audit metadata must not carry %q", k)
	}
	// Defense in depth: the stringified metadata does not contain the
	// raw title or payload bytes.
	b, _ := json.Marshal(e.Metadata)
	assert.NotContains(t, string(b), "rm -rf")
	assert.NotContains(t, string(b), "would wipe")
}

func TestApprovalsAudit_DecideApproveEmitsApprovedEvent(t *testing.T) {
	t.Parallel()
	q := newFakeQuerier()
	r := seededApproval(42, ApprovalStatePending)
	q.approvals[r.ID] = r
	rec := &recordingAuditor{}

	svc := NewApprovalsServiceWithAudit(q, rec)
	_, err := svc.Decide(context.Background(), DecideApprovalInput{
		ApprovalID:   r.ID,
		RepositoryID: 42,
		UserID:       7,
		ActorName:    "alice",
		IPAddress:    "192.0.2.9",
		Decision:     ApprovalStateApproved,
	})
	require.NoError(t, err)

	require.Len(t, rec.events, 1)
	e := rec.events[0]
	assert.Equal(t, AuditEventApprovalApproved, e.EventType)
	assert.Equal(t, "approval", e.TargetType)
	assert.Equal(t, r.ID, e.TargetName)
	require.NotNil(t, e.ActorID)
	assert.Equal(t, int64(7), *e.ActorID)
	assert.Equal(t, "alice", e.ActorName)
	assert.Equal(t, "approve", e.Action)
	assert.Equal(t, "192.0.2.9", e.IPAddress)
	assert.Equal(t, ApprovalStateApproved, e.Metadata["decision"])
	assert.Equal(t, ApprovalStateApproved, e.Metadata["state"])
	assert.Equal(t, int64(7), e.Metadata["decided_by"])
}

func TestApprovalsAudit_DecideRejectEmitsRejectedEvent(t *testing.T) {
	t.Parallel()
	q := newFakeQuerier()
	r := seededApproval(42, ApprovalStatePending)
	q.approvals[r.ID] = r
	rec := &recordingAuditor{}

	svc := NewApprovalsServiceWithAudit(q, rec)
	_, err := svc.Decide(context.Background(), DecideApprovalInput{
		ApprovalID:   r.ID,
		RepositoryID: 42,
		UserID:       7,
		ActorName:    "alice",
		Decision:     ApprovalStateRejected,
	})
	require.NoError(t, err)

	require.Len(t, rec.events, 1)
	e := rec.events[0]
	assert.Equal(t, AuditEventApprovalRejected, e.EventType)
	assert.Equal(t, "reject", e.Action)
	assert.Equal(t, ApprovalStateRejected, e.Metadata["decision"])
	assert.Equal(t, ApprovalStateRejected, e.Metadata["state"])
}

func TestApprovalsAudit_DecideExpiredEmitsExpiredEvent(t *testing.T) {
	t.Parallel()
	q := newFakeQuerier()
	r := seededApproval(42, ApprovalStatePending)
	r.ExpiresAt = pgtype.Timestamptz{Time: time.Now().Add(-1 * time.Hour), Valid: true}
	q.approvals[r.ID] = r
	rec := &recordingAuditor{}

	svc := NewApprovalsServiceWithAudit(q, rec)
	_, err := svc.Decide(context.Background(), DecideApprovalInput{
		ApprovalID:   r.ID,
		RepositoryID: 42,
		UserID:       7,
		ActorName:    "alice",
		Decision:     ApprovalStateApproved,
		Now:          time.Now().UTC(),
	})
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, httpStatusBadRequest, apiErr.Status)

	require.Len(t, rec.events, 1)
	e := rec.events[0]
	assert.Equal(t, AuditEventApprovalExpired, e.EventType)
	assert.Equal(t, AuditTargetTypeApproval, e.TargetType)
	assert.Equal(t, r.ID, e.TargetName)
	assert.Nil(t, e.ActorID)
	assert.Equal(t, "system:expiry-policy", e.ActorName)
	assert.Equal(t, "expire", e.Action)
	assert.Equal(t, ApprovalStateExpired, e.Metadata["decision"])
	assert.Equal(t, ApprovalStateExpired, e.Metadata["state"])
}

// TestApprovalsAudit_IdempotentSameDecision_NoDoubleWrite asserts the
// idempotent fast-path on the decided-same-decision branch does NOT
// write a second audit row. The winning UPDATE already wrote one;
// double-counting would inflate "who approved?" queries.
func TestApprovalsAudit_IdempotentSameDecision_NoDoubleWrite(t *testing.T) {
	t.Parallel()
	q := newFakeQuerier()
	r := seededApproval(42, ApprovalStateApproved)
	q.approvals[r.ID] = r
	rec := &recordingAuditor{}

	svc := NewApprovalsServiceWithAudit(q, rec)
	_, err := svc.Decide(context.Background(), DecideApprovalInput{
		ApprovalID:   r.ID,
		RepositoryID: 42,
		UserID:       7,
		Decision:     ApprovalStateApproved,
	})
	require.NoError(t, err)
	assert.Len(t, rec.events, 0, "idempotent re-decide must not emit a duplicate audit row")
}

// TestApprovalsAudit_ConflictingDecision_NoAuditWrite asserts we don't
// emit an audit row for a REJECTED attempt on an already-APPROVED row.
// Failed decide attempts are not business events worth recording; only
// successful state transitions are. (Admins can still see the winning
// transition; the failed 409 is visible in access logs + metrics.)
func TestApprovalsAudit_ConflictingDecision_NoAuditWrite(t *testing.T) {
	t.Parallel()
	q := newFakeQuerier()
	r := seededApproval(42, ApprovalStateApproved)
	q.approvals[r.ID] = r
	rec := &recordingAuditor{}

	svc := NewApprovalsServiceWithAudit(q, rec)
	_, err := svc.Decide(context.Background(), DecideApprovalInput{
		ApprovalID:   r.ID,
		RepositoryID: 42,
		UserID:       8,
		Decision:     ApprovalStateRejected,
	})
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, httpStatusConflict, apiErr.Status)
	assert.Len(t, rec.events, 0)
}

// TestApprovalsAudit_LostRace_SameDecision_NoDoubleWrite ensures the
// post-UPDATE zero-rows branch that re-reads and returns idempotently
// doesn't emit a second audit row (the race winner already wrote one).
func TestApprovalsAudit_LostRace_SameDecision_NoDoubleWrite(t *testing.T) {
	t.Parallel()
	q := newFakeQuerier()
	r := seededApproval(42, ApprovalStatePending)
	q.approvals[r.ID] = r
	q.decideErr = pgx.ErrNoRows
	q.decideHook = func(_ db.DecideApprovalParams) {
		winner := q.approvals[r.ID]
		winner.State = ApprovalStateApproved
		winner.DecidedAt = pgtype.Timestamptz{Time: time.Now(), Valid: true}
		winner.DecidedBy = pgtype.Int8{Int64: 8, Valid: true}
		q.approvals[r.ID] = winner
	}
	rec := &recordingAuditor{}

	svc := NewApprovalsServiceWithAudit(q, rec)
	_, err := svc.Decide(context.Background(), DecideApprovalInput{
		ApprovalID:   r.ID,
		RepositoryID: 42,
		UserID:       7,
		Decision:     ApprovalStateApproved,
	})
	require.NoError(t, err)
	assert.Len(t, rec.events, 0, "lost-race branch must not emit an audit row")
}

// TestApprovalsAudit_NilAuditor_NoPanic is the safety net: callers
// using NewApprovalsService (without audit wiring) must not crash on
// the lifecycle paths.
func TestApprovalsAudit_NilAuditor_NoPanic(t *testing.T) {
	t.Parallel()
	q := newFakeQuerier()
	s := sampleSession(t)
	q.sessions[s.ID] = s
	svc := NewApprovalsService(q) // no auditor

	_, err := svc.Create(context.Background(), CreateApprovalInput{
		SessionID: s.ID,
		Kind:      "file_write",
		Title:     "t",
	})
	require.NoError(t, err)
}

// TestApprovalsAudit_ExpiresAtInMetadata asserts the expires_at field
// rides along in the audit metadata when set, so retrieval queries can
// reason about expiry without joining back to approvals (which may have
// been cleaned up by retention by then).
func TestApprovalsAudit_ExpiresAtInMetadata(t *testing.T) {
	t.Parallel()
	q := newFakeQuerier()
	s := sampleSession(t)
	q.sessions[s.ID] = s
	rec := &recordingAuditor{}

	expires := time.Date(2030, 1, 2, 3, 4, 5, 0, time.UTC)
	svc := NewApprovalsServiceWithAudit(q, rec)
	_, err := svc.Create(context.Background(), CreateApprovalInput{
		SessionID: s.ID,
		Kind:      "k",
		Title:     "t",
		ExpiresAt: expires,
	})
	require.NoError(t, err)
	require.Len(t, rec.events, 1)
	assert.Equal(t, expires.Format(time.RFC3339), rec.events[0].Metadata["expires_at"])
}

// HTTP status code aliases to avoid importing net/http in pure service
// tests and to make assertions read symbolically.
const (
	httpStatusBadRequest = 400
	httpStatusNotFound   = 404
	httpStatusConflict   = 409
)

// Exercise the unnumbered migration against the actual product baseline. Its
// final migration number and registration belong to landing; install command
// execution stays unavailable until authorization and consumers are composed.
func TestConfirmationApprovalStoreBindsAudienceRevisionAndRequest(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	repoID := createWorkflowRunIntegrationRepo(t, pool)
	repo, err := q.GetRepoByID(ctx, repoID)
	require.NoError(t, err)
	member := repo.UserID.Int64
	session := uuid.NewString()
	_, err = q.CreateAgentSession(ctx, db.CreateAgentSessionParams{ID: session, RepositoryID: repoID, UserID: member, Title: "legacy", Status: "active"})
	require.NoError(t, err)
	legacy, err := q.CreateApproval(ctx, db.CreateApprovalParams{ID: uuid.NewString(), SessionID: session, RepositoryID: repoID, Kind: "tool", Title: "legacy", Payload: json.RawMessage(`{}`)})
	require.NoError(t, err)
	migration, err := os.ReadFile("../../db/product/migrations/pending/approvals_confirmations.sql")
	require.NoError(t, err)
	_, err = pool.Exec(ctx, string(migration))
	require.NoError(t, err)
	old, err := q.GetApproval(ctx, legacy.ID)
	require.NoError(t, err)
	require.Equal(t, legacy, old, "upgrade preserves the existing guest approval")
	input := func(kind string) db.ConfirmationApproval {
		a := db.ConfirmationApproval{Approval: db.Approval{ID: uuid.NewString(), RepositoryID: repoID, Kind: kind, Title: "Discard", Payload: json.RawMessage(`{"id":"foreign-1","revision":"1111111111111111111111111111111111111111"}`)}, MemberID: member, CredentialID: 17, Command: "branch.discard-foreign", Subject: json.RawMessage(`{"kind":"branch","ref":"smithers/retry"}`), Revision: strings.Repeat("1", 40), RequestKey: uuid.NewString()}
		if kind == "review_merge" {
			a.Command, a.Subject = "merge", json.RawMessage(`{"kind":"todo","ref":"T4"}`)
			a.Generation = pgtype.Int8{Int64: 3, Valid: true}
			a.ReviewedHeadSHA = pgtype.Text{String: strings.Repeat("2", 40), Valid: true}
		}
		return a
	}
	for _, kind := range []string{"one_click", "review_merge"} {
		t.Run(kind, func(t *testing.T) {
			a, err := q.CreateConfirmationApproval(ctx, input(kind))
			require.NoError(t, err)
			require.Equal(t, "pending", a.State)
			require.Empty(t, a.SessionID)
			require.Equal(t, 24*time.Hour, a.ExpiresAt.Time.Sub(a.CreatedAt))
			_, err = q.CreateConfirmationApproval(ctx, a)
			require.ErrorIs(t, err, pgx.ErrNoRows, "same issuer/key cannot insert again")
			changed := a
			changed.ID, changed.Command, changed.Payload = uuid.NewString(), "todo.drop", json.RawMessage(`{"n":9}`)
			_, err = q.CreateConfirmationApproval(ctx, changed)
			require.ErrorIs(t, err, pgx.ErrNoRows, "collision never overwrites original input")
			replay, err := q.GetConfirmationApprovalByRequest(ctx, repoID, member, 17, a.RequestKey)
			require.NoError(t, err)
			require.Equal(t, a, replay)
			_, err = q.GetConfirmationApprovalByRequest(ctx, repoID, member+1, 17, a.RequestKey)
			require.ErrorIs(t, err, pgx.ErrNoRows)
			_, err = q.LockConfirmationApproval(ctx, repoID, member+1, a.ID)
			require.ErrorIs(t, err, pgx.ErrNoRows)
			_, err = q.LockConfirmationApproval(ctx, repoID+1, member, a.ID)
			require.ErrorIs(t, err, pgx.ErrNoRows)
			another := a
			another.ID, another.CredentialID = uuid.NewString(), 18
			_, err = q.CreateConfirmationApproval(ctx, another)
			require.NoError(t, err, "a different issuer has a separate request identity")
			// Legacy endpoints cannot expose the private payload or decide it.
			_, err = q.GetApproval(ctx, a.ID)
			require.ErrorIs(t, err, pgx.ErrNoRows)
			_, err = q.DecideApproval(ctx, db.DecideApprovalParams{ID: a.ID, RepositoryID: repoID, State: "approved", DecidedBy: pgtype.Int8{Int64: member, Valid: true}})
			require.ErrorIs(t, err, pgx.ErrNoRows)
			_, err = q.ExpireApproval(ctx, db.ExpireApprovalParams{ID: a.ID, RepositoryID: repoID, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(48 * time.Hour), Valid: true}})
			require.ErrorIs(t, err, pgx.ErrNoRows)
			listed, err := NewApprovalsService(q).ListForRepo(ctx, repoID, "", 1, 100)
			require.NoError(t, err)
			require.Len(t, listed, 1)
			require.Equal(t, legacy.ID, listed[0].ID)
			for name, change := range map[string]func(*db.ConfirmationApproval){
				"revision":   func(x *db.ConfirmationApproval) { x.Revision = "changed" },
				"generation": func(x *db.ConfirmationApproval) { x.Generation = pgtype.Int8{Int64: 9, Valid: true} },
				"head": func(x *db.ConfirmationApproval) {
					x.ReviewedHeadSHA = pgtype.Text{String: strings.Repeat("3", 40), Valid: true}
				},
				"credential": func(x *db.ConfirmationApproval) { x.CredentialID++ },
				"member":     func(x *db.ConfirmationApproval) { x.MemberID++ },
			} {
				t.Run(name, func(t *testing.T) {
					wrong := a
					change(&wrong)
					_, err := q.DecideConfirmationApproval(ctx, wrong, "approved")
					require.ErrorIs(t, err, pgx.ErrNoRows)
				})
			}
			for _, update := range []string{"id='00000000-0000-4000-8000-000000000099'", "revision='changed'", "credential_id=99", "member_id=NULL", "payload='{}'::jsonb", "generation=9", "expires_at=expires_at+interval '1 hour'"} {
				_, err = pool.Exec(ctx, "UPDATE approvals SET "+update+" WHERE id=$1", a.ID)
				require.Error(t, err, update)
			}
			// The caller's subject transaction owns the decision too.
			tx, err := pool.Begin(ctx)
			require.NoError(t, err)
			locked, err := db.New(tx).LockConfirmationApproval(ctx, repoID, member, a.ID)
			require.NoError(t, err)
			_, err = tx.Exec(ctx, `UPDATE repositories SET description='confirmation effect' WHERE id=$1`, repoID)
			require.NoError(t, err)
			_, err = db.New(tx).DecideConfirmationApproval(ctx, locked, "approved")
			require.NoError(t, err)
			require.NoError(t, tx.Rollback(ctx))
			restored, err := q.GetRepoByID(ctx, repoID)
			require.NoError(t, err)
			require.Equal(t, repo.Description, restored.Description)
			got, err := q.GetConfirmationApprovalByRequest(ctx, repoID, member, 17, a.RequestKey)
			require.NoError(t, err)
			require.Equal(t, "pending", got.State)
			// Racing opposite presses have one winner and one unchanged refusal.
			results := make(chan error, 2)
			for _, state := range []string{"approved", "rejected"} {
				go func() { _, err := q.DecideConfirmationApproval(ctx, a, state); results <- err }()
			}
			wins := 0
			for range 2 {
				if err := <-results; err == nil {
					wins++
				} else {
					require.ErrorIs(t, err, pgx.ErrNoRows)
				}
			}
			require.Equal(t, 1, wins)
			got, err = q.GetConfirmationApprovalByRequest(ctx, repoID, member, 17, a.RequestKey)
			require.NoError(t, err)
			require.Equal(t, member, got.DecidedBy.Int64)
			_, err = pool.Exec(ctx, `UPDATE approvals SET state='pending',decided_at=NULL,decided_by=NULL WHERE id=$1`, a.ID)
			require.Error(t, err, "a decided confirmation cannot be reopened")
			_, err = q.DecideConfirmationApproval(ctx, a, "approved")
			require.ErrorIs(t, err, pgx.ErrNoRows)
			// An expired persisted request cannot be approved or rejected; only
			// expiry settles it. This also covers an unchanged head/generation.
			expired := a
			expired.ID, expired.RequestKey = uuid.NewString(), a.RequestKey+"-expired"
			_, err = pool.Exec(ctx, `INSERT INTO approvals
(id,repository_id,state,kind,title,payload,member_id,credential_id,command,subject,
 revision,generation,reviewed_head_sha,request_key,created_at,expires_at)
SELECT $1,repository_id,'pending',kind,title,payload,member_id,credential_id,command,subject,
 revision,generation,reviewed_head_sha,$2,statement_timestamp()-interval '25 hours',statement_timestamp()-interval '1 hour'
FROM approvals WHERE id=$3`, expired.ID, expired.RequestKey, a.ID)
			require.NoError(t, err)
			for _, decision := range []string{"approved", "rejected", "pending", "unknown"} {
				_, err = q.DecideConfirmationApproval(ctx, expired, decision)
				require.ErrorIs(t, err, pgx.ErrNoRows)
			}
			ended, err := q.DecideConfirmationApproval(ctx, expired, "expired")
			require.NoError(t, err)
			require.Equal(t, "expired", ended.State)
			require.False(t, ended.DecidedBy.Valid, "expiry is not a person's approval")
			_, err = q.DecideConfirmationApproval(ctx, expired, "approved")
			require.ErrorIs(t, err, pgx.ErrNoRows)
		})
	}
	for name, change := range map[string]func(*db.ConfirmationApproval){
		"empty revision":                  func(a *db.ConfirmationApproval) { a.Revision = "" },
		"missing subject ref":             func(a *db.ConfirmationApproval) { a.Subject = json.RawMessage(`{"kind":"branch"}`) },
		"wrong subject kind":              func(a *db.ConfirmationApproval) { a.Subject = json.RawMessage(`{"kind":"settings","ref":"x"}`) },
		"missing issuer":                  func(a *db.ConfirmationApproval) { a.CredentialID = 0 },
		"empty key":                       func(a *db.ConfirmationApproval) { a.RequestKey = "" },
		"one click with merge generation": func(a *db.ConfirmationApproval) { a.Generation = pgtype.Int8{Int64: 1, Valid: true} },
		"unknown kind":                    func(a *db.ConfirmationApproval) { a.Kind = "other" },
	} {
		t.Run(name, func(t *testing.T) {
			a := input("one_click")
			change(&a)
			_, err := q.CreateConfirmationApproval(ctx, a)
			require.Error(t, err)
		})
	}
	for name, change := range map[string]func(*db.ConfirmationApproval){
		"missing generation":  func(a *db.ConfirmationApproval) { a.Generation = pgtype.Int8{} },
		"negative generation": func(a *db.ConfirmationApproval) { a.Generation.Int64 = -1 },
		"missing head":        func(a *db.ConfirmationApproval) { a.ReviewedHeadSHA = pgtype.Text{} },
		"zero head":           func(a *db.ConfirmationApproval) { a.ReviewedHeadSHA.String = strings.Repeat("0", 40) },
		"non TODO merge": func(a *db.ConfirmationApproval) {
			a.Subject = json.RawMessage(`{"kind":"branch","ref":"smithers/retry"}`)
		},
	} {
		t.Run(name, func(t *testing.T) {
			a := input("review_merge")
			change(&a)
			_, err := q.CreateConfirmationApproval(ctx, a)
			require.Error(t, err)
		})
	}
	t.Run("member deletion preserves legacy approval semantics", func(t *testing.T) {
		var otherMember int64
		name := "confirmation_" + strings.ReplaceAll(uuid.NewString(), "-", "")
		err := pool.QueryRow(ctx, `INSERT INTO users (username,lower_username,email,lower_email,display_name)
VALUES ($1,$2,$3,$4,$5) RETURNING id`, name, name, name+"@example.com", name+"@example.com", "Confirmation member").Scan(&otherMember)
		require.NoError(t, err)
		// Keep the approvals in another member's surviving repository so its
		// cascade cannot hide a broken decided_by/member_id interaction.
		guest, err := q.CreateApproval(ctx, db.CreateApprovalParams{ID: uuid.NewString(), SessionID: session, RepositoryID: repoID, Kind: "tool", Title: "legacy decision", Payload: json.RawMessage(`{}`)})
		require.NoError(t, err)
		_, err = q.DecideApproval(ctx, db.DecideApprovalParams{ID: guest.ID, RepositoryID: repoID, State: "approved", DecidedBy: pgtype.Int8{Int64: otherMember, Valid: true}})
		require.NoError(t, err)
		var removed []string
		for _, kind := range []string{"one_click", "review_merge"} {
			for _, state := range []string{"pending", "approved", "rejected", "expired"} {
				a := input(kind)
				a.MemberID = otherMember
				a, err = q.CreateConfirmationApproval(ctx, a)
				require.NoError(t, err)
				if state != "pending" {
					_, err = q.DecideConfirmationApproval(ctx, a, state)
					require.NoError(t, err)
				}
				removed = append(removed, a.ID)
			}
		}
		_, err = pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, otherMember)
		require.NoError(t, err)
		for _, id := range removed {
			var count int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM approvals WHERE id=$1`, id).Scan(&count))
			require.Zero(t, count, "member-owned confirmation is erased")
		}
		kept, err := q.GetApproval(ctx, guest.ID)
		require.NoError(t, err)
		require.Equal(t, "approved", kept.State)
		require.False(t, kept.DecidedBy.Valid, "legacy decision survives with its deleted actor cleared")
		_, err = q.GetRepoByID(ctx, repoID)
		require.NoError(t, err)
	})
}

func TestApprovalsGuestCannotCreatePersonConfirmation(t *testing.T) {
	for _, kind := range []string{"one_click", "review_merge"} {
		_, err := NewApprovalsService(nil).Create(t.Context(), CreateApprovalInput{SessionID: "session", Kind: kind, Title: "Do it"})
		var refused *pkgerrors.APIError
		require.ErrorAs(t, err, &refused)
		require.Equal(t, 403, refused.Status, "refusal precedes even the session lookup")
	}
}

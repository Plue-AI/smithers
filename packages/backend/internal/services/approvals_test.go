package services

import (
	"context"
	"encoding/json"
	stdErrors "errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
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
		SessionID:    pgtype.Text{String: "11111111-2222-3333-4444-555555555555", Valid: true},
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
	assert.Equal(t, s.ID, captured.SessionID.String)
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

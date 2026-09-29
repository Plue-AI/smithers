package services

import (
	"context"
	"errors"
	"io"
	"math/big"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// --- injectable fakes ------------------------------------------------------

var errPairBoom = errors.New("pair store boom")

func pairUniqueViolation() error { return &pgconn.PgError{Code: "23505"} }

// pairFakeStore embeds *db.Queries so every method delegates to the real DB by
// default; individual methods consult errs / hooks to inject failures.
type pairFakeStore struct {
	*db.Queries
	errs                    map[string]error
	getPairSessionFn        func(call int, real db.PairSession, realErr error) (db.PairSession, error)
	getPairSessionCalls     int
	getUserByIDFn           func(id int64) (db.User, error)
	enqueueFn               func(call int) (db.PairPromptQueue, error)
	enqueueCalls            int
	getMemberFn             func(call int, real db.PairSessionMember, realErr error) (db.PairSessionMember, error)
	getMemberCalls          int
	acceptInviteFn          func() (db.PairSessionMember, error)
	getInviteFn             func(real db.PairSessionInvite, realErr error) (db.PairSessionInvite, error)
	getLiveInviteForEmailFn func(real db.PairSessionInvite, realErr error) (db.PairSessionInvite, error)
}

func newPairFakeStore(q *db.Queries, fails ...string) *pairFakeStore {
	m := map[string]error{}
	for _, f := range fails {
		m[f] = errPairBoom
	}
	return &pairFakeStore{Queries: q, errs: m}
}

func (f *pairFakeStore) e(name string) error { return f.errs[name] }

func (f *pairFakeStore) CreatePairSession(ctx context.Context, arg db.CreatePairSessionParams) (db.PairSession, error) {
	if e := f.e("CreatePairSession"); e != nil {
		return db.PairSession{}, e
	}
	return f.Queries.CreatePairSession(ctx, arg)
}

func (f *pairFakeStore) GetPairSession(ctx context.Context, id string) (db.PairSession, error) {
	f.getPairSessionCalls++
	real, realErr := f.Queries.GetPairSession(ctx, id)
	if f.getPairSessionFn != nil {
		return f.getPairSessionFn(f.getPairSessionCalls, real, realErr)
	}
	if e := f.e("GetPairSession"); e != nil {
		return db.PairSession{}, e
	}
	return real, realErr
}

func (f *pairFakeStore) GetLivePairSessionForSource(ctx context.Context, sourceWorkspaceID string) (db.PairSession, error) {
	if e := f.e("GetLivePairSessionForSource"); e != nil {
		return db.PairSession{}, e
	}
	return f.Queries.GetLivePairSessionForSource(ctx, sourceWorkspaceID)
}

func (f *pairFakeStore) SetPairSessionForkBound(ctx context.Context, arg db.SetPairSessionForkBoundParams) (db.PairSession, error) {
	if e := f.e("SetPairSessionForkBound"); e != nil {
		return db.PairSession{}, e
	}
	return f.Queries.SetPairSessionForkBound(ctx, arg)
}

func (f *pairFakeStore) SetPairSessionAccessMode(ctx context.Context, arg db.SetPairSessionAccessModeParams) (db.PairSession, error) {
	if e := f.e("SetPairSessionAccessMode"); e != nil {
		return db.PairSession{}, e
	}
	return f.Queries.SetPairSessionAccessMode(ctx, arg)
}

func (f *pairFakeStore) FailStalePairSessions(ctx context.Context, cutoff time.Time) ([]db.PairSession, error) {
	if e := f.e("FailStalePairSessions"); e != nil {
		return nil, e
	}
	return f.Queries.FailStalePairSessions(ctx, cutoff)
}

func (f *pairFakeStore) UpsertPairSessionMember(ctx context.Context, arg db.UpsertPairSessionMemberParams) (db.PairSessionMember, error) {
	if e := f.e("UpsertPairSessionMember"); e != nil {
		return db.PairSessionMember{}, e
	}
	return f.Queries.UpsertPairSessionMember(ctx, arg)
}

func (f *pairFakeStore) GetLivePairSessionMember(ctx context.Context, arg db.GetLivePairSessionMemberParams) (db.PairSessionMember, error) {
	f.getMemberCalls++
	real, realErr := f.Queries.GetLivePairSessionMember(ctx, arg)
	if f.getMemberFn != nil {
		return f.getMemberFn(f.getMemberCalls, real, realErr)
	}
	if e := f.e("GetLivePairSessionMember"); e != nil {
		return db.PairSessionMember{}, e
	}
	return real, realErr
}

func (f *pairFakeStore) AcceptPairSessionInvite(ctx context.Context, arg db.AcceptPairSessionInviteParams) (db.PairSessionMember, error) {
	if f.acceptInviteFn != nil {
		return f.acceptInviteFn()
	}
	if e := f.e("AcceptPairSessionInvite"); e != nil {
		return db.PairSessionMember{}, e
	}
	return f.Queries.AcceptPairSessionInvite(ctx, arg)
}

func (f *pairFakeStore) GetPairSessionInvite(ctx context.Context, arg db.GetPairSessionInviteParams) (db.PairSessionInvite, error) {
	real, realErr := f.Queries.GetPairSessionInvite(ctx, arg)
	if f.getInviteFn != nil {
		return f.getInviteFn(real, realErr)
	}
	return real, realErr
}

func (f *pairFakeStore) ListLivePairSessionMembers(ctx context.Context, sessionID string) ([]db.PairSessionMember, error) {
	if e := f.e("ListLivePairSessionMembers"); e != nil {
		return nil, e
	}
	return f.Queries.ListLivePairSessionMembers(ctx, sessionID)
}

func (f *pairFakeStore) ListLivePairSessionMemberProfiles(ctx context.Context, sessionID string) ([]db.ListLivePairSessionMemberProfilesRow, error) {
	if e := f.e("ListLivePairSessionMemberProfiles"); e != nil {
		return nil, e
	}
	return f.Queries.ListLivePairSessionMemberProfiles(ctx, sessionID)
}

func (f *pairFakeStore) SetPairSessionMemberRole(ctx context.Context, arg db.SetPairSessionMemberRoleParams) (db.PairSessionMember, error) {
	if e := f.e("SetPairSessionMemberRole"); e != nil {
		return db.PairSessionMember{}, e
	}
	return f.Queries.SetPairSessionMemberRole(ctx, arg)
}

func (f *pairFakeStore) RevokePairSessionMember(ctx context.Context, arg db.RevokePairSessionMemberParams) (db.PairSessionMember, error) {
	if e := f.e("RevokePairSessionMember"); e != nil {
		return db.PairSessionMember{}, e
	}
	return f.Queries.RevokePairSessionMember(ctx, arg)
}

func (f *pairFakeStore) UpdatePairSessionMemberPresence(ctx context.Context, arg db.UpdatePairSessionMemberPresenceParams) (db.PairSessionMember, error) {
	if e := f.e("UpdatePairSessionMemberPresence"); e != nil {
		return db.PairSessionMember{}, e
	}
	return f.Queries.UpdatePairSessionMemberPresence(ctx, arg)
}

func (f *pairFakeStore) EnqueuePairPrompt(ctx context.Context, arg db.EnqueuePairPromptParams) (db.PairPromptQueue, error) {
	f.enqueueCalls++
	if f.enqueueFn != nil {
		return f.enqueueFn(f.enqueueCalls)
	}
	if e := f.e("EnqueuePairPrompt"); e != nil {
		return db.PairPromptQueue{}, e
	}
	return f.Queries.EnqueuePairPrompt(ctx, arg)
}

func (f *pairFakeStore) ListPairPromptQueue(ctx context.Context, sessionID string) ([]db.PairPromptQueue, error) {
	if e := f.e("ListPairPromptQueue"); e != nil {
		return nil, e
	}
	return f.Queries.ListPairPromptQueue(ctx, sessionID)
}

func (f *pairFakeStore) ClaimPairPrompt(ctx context.Context, arg db.ClaimPairPromptParams) (db.PairPromptQueue, error) {
	if e := f.e("ClaimPairPrompt"); e != nil {
		return db.PairPromptQueue{}, e
	}
	return f.Queries.ClaimPairPrompt(ctx, arg)
}

func (f *pairFakeStore) StartPairPrompt(ctx context.Context, arg db.StartPairPromptParams) (db.PairPromptQueue, error) {
	if e := f.e("StartPairPrompt"); e != nil {
		return db.PairPromptQueue{}, e
	}
	return f.Queries.StartPairPrompt(ctx, arg)
}

func (f *pairFakeStore) RenewPairPromptLease(ctx context.Context, arg db.RenewPairPromptLeaseParams) (db.PairPromptQueue, error) {
	if e := f.e("RenewPairPromptLease"); e != nil {
		return db.PairPromptQueue{}, e
	}
	return f.Queries.RenewPairPromptLease(ctx, arg)
}

func (f *pairFakeStore) FinishPairPrompt(ctx context.Context, arg db.FinishPairPromptParams) (db.PairPromptQueue, error) {
	if e := f.e("FinishPairPrompt"); e != nil {
		return db.PairPromptQueue{}, e
	}
	return f.Queries.FinishPairPrompt(ctx, arg)
}

func (f *pairFakeStore) CancelOwnQueuedPairPrompt(ctx context.Context, arg db.CancelOwnQueuedPairPromptParams) (db.PairPromptQueue, error) {
	if e := f.e("CancelOwnQueuedPairPrompt"); e != nil {
		return db.PairPromptQueue{}, e
	}
	return f.Queries.CancelOwnQueuedPairPrompt(ctx, arg)
}

func (f *pairFakeStore) CancelAnyPendingPairPrompt(ctx context.Context, arg db.CancelAnyPendingPairPromptParams) (db.PairPromptQueue, error) {
	if e := f.e("CancelAnyPendingPairPrompt"); e != nil {
		return db.PairPromptQueue{}, e
	}
	return f.Queries.CancelAnyPendingPairPrompt(ctx, arg)
}

func (f *pairFakeStore) SweepStalePairPromptClaims(ctx context.Context) ([]db.PairPromptQueue, error) {
	if e := f.e("SweepStalePairPromptClaims"); e != nil {
		return nil, e
	}
	return f.Queries.SweepStalePairPromptClaims(ctx)
}

func (f *pairFakeStore) FailStaleRunningPairPrompts(ctx context.Context, graceSecs int32) ([]db.PairPromptQueue, error) {
	if e := f.e("FailStaleRunningPairPrompts"); e != nil {
		return nil, e
	}
	return f.Queries.FailStaleRunningPairPrompts(ctx, graceSecs)
}

func (f *pairFakeStore) CreatePairSessionInvite(ctx context.Context, arg db.CreatePairSessionInviteParams) (db.PairSessionInvite, error) {
	if e := f.e("CreatePairSessionInvite"); e != nil {
		return db.PairSessionInvite{}, e
	}
	return f.Queries.CreatePairSessionInvite(ctx, arg)
}

func (f *pairFakeStore) GetLivePairSessionInviteForEmail(ctx context.Context, arg db.GetLivePairSessionInviteForEmailParams) (db.PairSessionInvite, error) {
	real, realErr := f.Queries.GetLivePairSessionInviteForEmail(ctx, arg)
	if f.getLiveInviteForEmailFn != nil {
		return f.getLiveInviteForEmailFn(real, realErr)
	}
	if e := f.e("GetLivePairSessionInviteForEmail"); e != nil {
		return db.PairSessionInvite{}, e
	}
	return real, realErr
}

func (f *pairFakeStore) GetLivePairSessionInviteForUsername(ctx context.Context, arg db.GetLivePairSessionInviteForUsernameParams) (db.PairSessionInvite, error) {
	if e := f.e("GetLivePairSessionInviteForUsername"); e != nil {
		return db.PairSessionInvite{}, e
	}
	return f.Queries.GetLivePairSessionInviteForUsername(ctx, arg)
}

func (f *pairFakeStore) ListPairSessionInvites(ctx context.Context, sessionID string) ([]db.PairSessionInvite, error) {
	if e := f.e("ListPairSessionInvites"); e != nil {
		return nil, e
	}
	return f.Queries.ListPairSessionInvites(ctx, sessionID)
}

func (f *pairFakeStore) RevokePairSessionInvite(ctx context.Context, arg db.RevokePairSessionInviteParams) (db.PairSessionInvite, error) {
	if e := f.e("RevokePairSessionInvite"); e != nil {
		return db.PairSessionInvite{}, e
	}
	return f.Queries.RevokePairSessionInvite(ctx, arg)
}

func (f *pairFakeStore) RevokePairSessionInviteByUsername(ctx context.Context, arg db.RevokePairSessionInviteByUsernameParams) (db.PairSessionInvite, error) {
	if e := f.e("RevokePairSessionInviteByUsername"); e != nil {
		return db.PairSessionInvite{}, e
	}
	return f.Queries.RevokePairSessionInviteByUsername(ctx, arg)
}

func (f *pairFakeStore) CreatePairSessionLink(ctx context.Context, arg db.CreatePairSessionLinkParams) (db.PairSessionLink, error) {
	if e := f.e("CreatePairSessionLink"); e != nil {
		return db.PairSessionLink{}, e
	}
	return f.Queries.CreatePairSessionLink(ctx, arg)
}

func (f *pairFakeStore) GetLivePairSessionLinkBySlug(ctx context.Context, slug string) (db.PairSessionLink, error) {
	if e := f.e("GetLivePairSessionLinkBySlug"); e != nil {
		return db.PairSessionLink{}, e
	}
	return f.Queries.GetLivePairSessionLinkBySlug(ctx, slug)
}

func (f *pairFakeStore) ListLivePairSessionLinks(ctx context.Context, sessionID string) ([]db.PairSessionLink, error) {
	if e := f.e("ListLivePairSessionLinks"); e != nil {
		return nil, e
	}
	return f.Queries.ListLivePairSessionLinks(ctx, sessionID)
}

func (f *pairFakeStore) RevokePairSessionLink(ctx context.Context, arg db.RevokePairSessionLinkParams) (db.PairSessionLink, error) {
	if e := f.e("RevokePairSessionLink"); e != nil {
		return db.PairSessionLink{}, e
	}
	return f.Queries.RevokePairSessionLink(ctx, arg)
}

func (f *pairFakeStore) RevokeLivePairSessionLinksForRole(ctx context.Context, arg db.RevokeLivePairSessionLinksForRoleParams) error {
	if e := f.e("RevokeLivePairSessionLinksForRole"); e != nil {
		return e
	}
	return f.Queries.RevokeLivePairSessionLinksForRole(ctx, arg)
}

func (f *pairFakeStore) UpsertPairSessionDraft(ctx context.Context, arg db.UpsertPairSessionDraftParams) (db.PairSessionDraft, error) {
	if e := f.e("UpsertPairSessionDraft"); e != nil {
		return db.PairSessionDraft{}, e
	}
	return f.Queries.UpsertPairSessionDraft(ctx, arg)
}

func (f *pairFakeStore) GetPairSessionDraft(ctx context.Context, sessionID string) (db.PairSessionDraft, error) {
	if e := f.e("GetPairSessionDraft"); e != nil {
		return db.PairSessionDraft{}, e
	}
	return f.Queries.GetPairSessionDraft(ctx, sessionID)
}

func (f *pairFakeStore) ClearPairSessionDraft(ctx context.Context, arg db.ClearPairSessionDraftParams) (db.PairSessionDraft, error) {
	if e := f.e("ClearPairSessionDraft"); e != nil {
		return db.PairSessionDraft{}, e
	}
	return f.Queries.ClearPairSessionDraft(ctx, arg)
}

func (f *pairFakeStore) UpsertAlphaWhitelistEmail(ctx context.Context, arg db.UpsertAlphaWhitelistEmailParams) (db.AlphaWhitelistEntry, error) {
	if e := f.e("UpsertAlphaWhitelistEmail"); e != nil {
		return db.AlphaWhitelistEntry{}, e
	}
	return f.Queries.UpsertAlphaWhitelistEmail(ctx, arg)
}

func (f *pairFakeStore) UpsertAlphaWhitelistUsername(ctx context.Context, arg db.UpsertAlphaWhitelistUsernameParams) (db.AlphaWhitelistEntry, error) {
	if e := f.e("UpsertAlphaWhitelistUsername"); e != nil {
		return db.AlphaWhitelistEntry{}, e
	}
	return f.Queries.UpsertAlphaWhitelistUsername(ctx, arg)
}

func (f *pairFakeStore) GetPrimaryEmail(ctx context.Context, userID int64) (db.EmailAddress, error) {
	if e := f.e("GetPrimaryEmail"); e != nil {
		return db.EmailAddress{}, e
	}
	return f.Queries.GetPrimaryEmail(ctx, userID)
}

func (f *pairFakeStore) GetUserByID(ctx context.Context, id int64) (db.User, error) {
	if f.getUserByIDFn != nil {
		return f.getUserByIDFn(id)
	}
	if e := f.e("GetUserByID"); e != nil {
		return db.User{}, e
	}
	return f.Queries.GetUserByID(ctx, id)
}

func (f *pairFakeStore) UpsertWorkspaceShare(ctx context.Context, arg db.UpsertWorkspaceShareParams) (db.WorkspaceShare, error) {
	if e := f.e("UpsertWorkspaceShare"); e != nil {
		return db.WorkspaceShare{}, e
	}
	return f.Queries.UpsertWorkspaceShare(ctx, arg)
}

func (f *pairFakeStore) DeleteWorkspaceShare(ctx context.Context, arg db.DeleteWorkspaceShareParams) error {
	if e := f.e("DeleteWorkspaceShare"); e != nil {
		return e
	}
	return f.Queries.DeleteWorkspaceShare(ctx, arg)
}

func (f *pairFakeStore) EndPairSessionForOwner(ctx context.Context, arg db.EndPairSessionForOwnerParams) (db.EndPairSessionForOwnerRow, error) {
	if e := f.e("EndPairSessionForOwner"); e != nil {
		return db.EndPairSessionForOwnerRow{}, e
	}
	return f.Queries.EndPairSessionForOwner(ctx, arg)
}

// pairHidingStore embeds the PairSessionStore interface, so it does NOT expose
// EndPairSessionForOwner / AcceptPairSessionInvite / GetPairSessionInvite — the
// type assertions in EndSession/acceptInvite fail, hitting the "unavailable"
// branches.
type pairHidingStore struct{ PairSessionStore }

// pairCleanerForker adds DestroyWorkspace to stubForker so cleanupUnboundPairFork
// exercises the cleaner path.
type pairCleanerForker struct {
	*stubForker
	destroyErr error
	destroyed  bool
}

func (f *pairCleanerForker) DestroyWorkspace(_ context.Context, _ string) error {
	f.destroyed = true
	return f.destroyErr
}

// pairFakeRow is a pgx.Row whose Scan runs scan (or returns err).
type pairFakeRow struct {
	err  error
	scan func(dest ...any) error
}

func (r pairFakeRow) Scan(dest ...any) error {
	if r.scan != nil {
		return r.scan(dest...)
	}
	return r.err
}

// pairFakeTx is a minimal pgx.Tx: the advisory-lock Exec, the db.New(tx) QueryRow
// calls, Commit and Rollback are stubbed; every other method panics (unused).
type pairFakeTx struct {
	pgx.Tx
	execErr   error
	execErrAt int
	execCalls int
	commitErr error
	rows      []pairFakeRow
	rowIdx    int
}

func (t *pairFakeTx) Exec(_ context.Context, _ string, _ ...any) (pgconn.CommandTag, error) {
	t.execCalls++
	if t.execErr != nil && (t.execErrAt == 0 || t.execCalls == t.execErrAt) {
		return pgconn.CommandTag{}, t.execErr
	}
	return pgconn.NewCommandTag("SELECT 1"), nil
}

func (t *pairFakeTx) QueryRow(_ context.Context, _ string, _ ...any) pgx.Row {
	if t.rowIdx >= len(t.rows) {
		return pairFakeRow{}
	}
	r := t.rows[t.rowIdx]
	t.rowIdx++
	return r
}

func (t *pairFakeTx) Commit(_ context.Context) error   { return t.commitErr }
func (t *pairFakeTx) Rollback(_ context.Context) error { return nil }

// pairFakeTxBeginner returns tx (or beginErr) from Begin.
type pairFakeTxBeginner struct {
	beginErr error
	tx       *pairFakeTx
}

func (b *pairFakeTxBeginner) Begin(_ context.Context) (pgx.Tx, error) {
	if b.beginErr != nil {
		return nil, b.beginErr
	}
	return b.tx, nil
}

// --- shared setup ----------------------------------------------------------

type pairFSetup struct {
	fx       pairFixture
	svc      *PairSessionService
	session  db.PairSession
	owner    int64
	editor   int64
	viewer   int64
	stranger int64
}

// newPairFSetup creates a live session with owner + editor + viewer members and a
// bound fork workspace. The returned svc uses the real store with the pool as
// tx-beginner (the production serial path).
func newPairFSetup(t *testing.T) pairFSetup {
	t.Helper()
	ctx := context.Background()
	fx := newPairFixture(t)
	owner := mkPairUser(t, fx.pool, "f-owner")
	editor := mkPairUser(t, fx.pool, "f-editor")
	viewer := mkPairUser(t, fx.pool, "f-viewer")
	stranger := mkPairUser(t, fx.pool, "f-stranger")
	ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
	svc := newPairService(fx, map[int64]bool{owner: true, editor: true, viewer: true, stranger: true}, false, nil)
	session, err := svc.CreateSession(ctx, owner, fx.repoID, ws)
	require.NoError(t, err)
	_, err = fx.store.UpsertPairSessionMember(ctx, db.UpsertPairSessionMemberParams{SessionID: session.ID, UserID: editor, Role: PairRoleEditor})
	require.NoError(t, err)
	_, err = fx.store.UpsertPairSessionMember(ctx, db.UpsertPairSessionMemberParams{SessionID: session.ID, UserID: viewer, Role: PairRoleViewer})
	require.NoError(t, err)
	return pairFSetup{fx: fx, svc: svc, session: session, owner: owner, editor: editor, viewer: viewer, stranger: stranger}
}

// pairAllowBilling authorizes every user (billing denial is covered elsewhere).
type pairAllowBilling struct{}

func (pairAllowBilling) AuthorizePairing(context.Context, int64) error { return nil }

// pairF_errSvc builds a service backed by a fake store failing the named methods.
func (s pairFSetup) errSvc(fails ...string) (*PairSessionService, *pairFakeStore) {
	fake := newPairFakeStore(s.fx.store, fails...)
	svc := NewPairSessionService(fake, pairAllowBilling{}, &stubForker{pool: s.fx.pool, repoID: s.fx.repoID},
		PairSessionServiceConfig{EmailFrom: "pair@smithers.sh", InviteBaseURL: "https://smithers.sh", TxBeginner: s.fx.pool})
	return svc, fake
}

// pairF_svcWithStore builds a service around an arbitrary store (for hiding-store
// and custom-fake scenarios), permissive billing, real forker, real tx-beginner.
func (s pairFSetup) svcWithStore(store PairSessionStore) *PairSessionService {
	return NewPairSessionService(store, pairAllowBilling{}, &stubForker{pool: s.fx.pool, repoID: s.fx.repoID},
		PairSessionServiceConfig{EmailFrom: "pair@smithers.sh", InviteBaseURL: "https://smithers.sh", TxBeginner: s.fx.pool})
}

// --- tests -----------------------------------------------------------------

// TestPairSession_F_RequireGuards: every owner/role-gated method rejects a
// non-member stranger with 403 (covers all requireOwner/requireRole guards).
func TestPairSession_F_RequireGuards(t *testing.T) {
	ctx := context.Background()
	s := newPairFSetup(t)
	sid, str := s.session.ID, s.stranger
	svc := s.svc

	check := func(name string, err error) {
		t.Helper()
		assert.Equal(t, 403, httpStatus(err), name)
	}

	_, err := svc.SetMemberRole(ctx, sid, str, s.editor, PairRoleViewer)
	check("SetMemberRole", err)
	check("RevokeMember", svc.RevokeMember(ctx, sid, str, s.editor))
	_, err = svc.SetAccessMode(ctx, sid, str, PairAccessLink)
	check("SetAccessMode", err)
	_, err = svc.MintLink(ctx, sid, str, PairRoleViewer)
	check("MintLink", err)
	_, err = svc.ListLinks(ctx, sid, str)
	check("ListLinks", err)
	check("RevokeLink", svc.RevokeLink(ctx, sid, str, "x"))
	_, err = svc.CreateInvite(ctx, sid, str, "a@b.com", PairRoleViewer)
	check("CreateInvite", err)
	_, err = svc.CreateInviteByUsername(ctx, sid, str, "bob", PairRoleViewer)
	check("CreateInviteByUsername", err)
	_, err = svc.ListInvites(ctx, sid, str)
	check("ListInvites", err)
	check("RevokeInvite", svc.RevokeInvite(ctx, sid, str, "a@b.com"))
	check("RevokeInviteByUsername", svc.RevokeInviteByUsername(ctx, sid, str, "bob"))
	check("EndSession", svc.EndSession(ctx, sid, str))
	_, err = svc.ListMembers(ctx, sid, str)
	check("ListMembers", err)
	_, err = svc.ListMemberProfiles(ctx, sid, str)
	check("ListMemberProfiles", err)
	_, err = svc.ListQueue(ctx, sid, str)
	check("ListQueue", err)
	_, err = svc.Cancel(ctx, sid, str, "x")
	check("Cancel", err)
	_, err = svc.GetDraft(ctx, sid, str)
	check("GetDraft", err)
	check("Heartbeat", svc.Heartbeat(ctx, sid, str, nil))
	_, err = svc.Enqueue(ctx, sid, str, pairPromptSourceSolo, "b")
	check("Enqueue", err)
	_, err = svc.Claim(ctx, sid, str, "x", "c", time.Minute)
	check("Claim", err)
	_, err = svc.Start(ctx, sid, str, "x", "c", "r")
	check("Start", err)
	_, err = svc.Renew(ctx, sid, str, "x", "c", time.Minute)
	check("Renew", err)
	_, err = svc.Finish(ctx, sid, str, "x", "c", "done")
	check("Finish", err)
	_, err = svc.PutDraft(ctx, sid, str, "c", 1)
	check("PutDraft", err)
	_, err = svc.SubmitDraft(ctx, sid, str)
	check("SubmitDraft", err)
}

// TestPairSession_F_LoadAndRoleErrors covers loadLiveSession and requireRole DB errors.
func TestPairSession_F_LoadAndRoleErrors(t *testing.T) {
	ctx := context.Background()
	s := newPairFSetup(t)

	// loadLiveSession: GetPairSession non-ErrNoRows error -> Internal.
	svc, _ := s.errSvc("GetPairSession")
	_, err := svc.ResolveSession(ctx, s.session.ID, s.owner)
	assert.Equal(t, 500, httpStatus(err))

	// requireRole: GetLivePairSessionMember non-ErrNoRows error -> Internal (editor path).
	svc2, _ := s.errSvc("GetLivePairSessionMember")
	_, err = svc2.ListQueue(ctx, s.session.ID, s.editor)
	assert.Equal(t, 500, httpStatus(err))
}

// TestPairSession_F_CreateSessionErrors covers CreateSession failure branches.
func TestPairSession_F_CreateSessionErrors(t *testing.T) {
	ctx := context.Background()

	t.Run("mint id failure", func(t *testing.T) {
		fx := newPairFixture(t)
		owner := mkPairUser(t, fx.pool, "f-mint-owner")
		ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
		svc := newPairService(fx, map[int64]bool{owner: true}, false, nil)
		defer pairForceRandFailure(t)()
		_, err := svc.CreateSession(ctx, owner, fx.repoID, ws)
		assert.Equal(t, 500, httpStatus(err))
	})

	t.Run("create pair session db error", func(t *testing.T) {
		fx := newPairFixture(t)
		owner := mkPairUser(t, fx.pool, "f-create-owner")
		ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
		fake := newPairFakeStore(fx.store, "CreatePairSession")
		svc := NewPairSessionService(fake, &stubBilling{paid: map[int64]bool{owner: true}}, &stubForker{pool: fx.pool, repoID: fx.repoID}, PairSessionServiceConfig{})
		_, err := svc.CreateSession(ctx, owner, fx.repoID, ws)
		assert.Equal(t, 500, httpStatus(err))
	})

	t.Run("owner membership db error flips failed", func(t *testing.T) {
		fx := newPairFixture(t)
		owner := mkPairUser(t, fx.pool, "f-member-owner")
		ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
		fake := newPairFakeStore(fx.store, "UpsertPairSessionMember")
		svc := NewPairSessionService(fake, &stubBilling{paid: map[int64]bool{owner: true}}, &stubForker{pool: fx.pool, repoID: fx.repoID}, PairSessionServiceConfig{})
		_, err := svc.CreateSession(ctx, owner, fx.repoID, ws)
		assert.Equal(t, 500, httpStatus(err))
	})

	t.Run("fork bind no rows cleans unbound fork without cleaner", func(t *testing.T) {
		fx := newPairFixture(t)
		owner := mkPairUser(t, fx.pool, "f-bind-owner")
		ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
		fake := newPairFakeStore(fx.store)
		fake.errs["SetPairSessionForkBound"] = pgx.ErrNoRows
		svc := NewPairSessionService(fake, &stubBilling{paid: map[int64]bool{owner: true}}, &stubForker{pool: fx.pool, repoID: fx.repoID}, PairSessionServiceConfig{})
		_, err := svc.CreateSession(ctx, owner, fx.repoID, ws)
		assert.Equal(t, 409, httpStatus(err))
	})

	t.Run("fork bind no rows with cleaner success and failure", func(t *testing.T) {
		for _, destroyErr := range []error{nil, errPairBoom} {
			fx := newPairFixture(t)
			owner := mkPairUser(t, fx.pool, "f-bind2-owner")
			ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
			fake := newPairFakeStore(fx.store)
			fake.errs["SetPairSessionForkBound"] = pgx.ErrNoRows
			cleaner := &pairCleanerForker{stubForker: &stubForker{pool: fx.pool, repoID: fx.repoID}, destroyErr: destroyErr}
			svc := NewPairSessionService(fake, &stubBilling{paid: map[int64]bool{owner: true}}, cleaner, PairSessionServiceConfig{})
			_, err := svc.CreateSession(ctx, owner, fx.repoID, ws)
			assert.Equal(t, 409, httpStatus(err))
			assert.True(t, cleaner.destroyed)
		}
	})

	t.Run("fork bind other error flips failed and reclaims fork", func(t *testing.T) {
		fx := newPairFixture(t)
		owner := mkPairUser(t, fx.pool, "f-bind3-owner")
		ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
		fake := newPairFakeStore(fx.store, "SetPairSessionForkBound")
		cleaner := &pairCleanerForker{stubForker: &stubForker{pool: fx.pool, repoID: fx.repoID}}
		svc := NewPairSessionService(fake, &stubBilling{paid: map[int64]bool{owner: true}}, cleaner, PairSessionServiceConfig{})
		_, err := svc.CreateSession(ctx, owner, fx.repoID, ws)
		assert.Equal(t, 500, httpStatus(err))
		// A generic (non-ErrNoRows) bind failure leaves the session 'failed', so
		// the already-provisioned fork VM must be reclaimed — no sweep ever
		// touches a fork with a VM id.
		assert.True(t, cleaner.destroyed, "generic bind failure must destroy the provisioned fork")
	})
}

// pairForceRandFailure swaps pairRandInt to a failing stub; the returned func restores it.
func pairForceRandFailure(t *testing.T) func() {
	t.Helper()
	prev := pairRandInt
	pairRandInt = func(_ io.Reader, _ *big.Int) (*big.Int, error) {
		return nil, errPairBoom
	}
	return func() { pairRandInt = prev }
}

// TestPairSession_F_EndSessionErrors covers EndSession ender-unavailable + DB errors.
func TestPairSession_F_EndSessionErrors(t *testing.T) {
	ctx := context.Background()
	s := newPairFSetup(t)

	// ender unavailable: hiding store lacks EndPairSessionForOwner.
	hidingSvc := s.svcWithStore(pairHidingStore{PairSessionStore: s.fx.store})
	assert.Equal(t, 500, httpStatus(hidingSvc.EndSession(ctx, s.session.ID, s.owner)))

	// EndPairSessionForOwner ErrNoRows -> NotFound.
	svcNR, fake := s.errSvc()
	fake.errs["EndPairSessionForOwner"] = pgx.ErrNoRows
	assert.Equal(t, 404, httpStatus(svcNR.EndSession(ctx, s.session.ID, s.owner)))

	// EndPairSessionForOwner generic error -> Internal.
	svcErr, _ := s.errSvc("EndPairSessionForOwner")
	assert.Equal(t, 500, httpStatus(svcErr.EndSession(ctx, s.session.ID, s.owner)))
}

// TestPairSession_F_SweepAndSweeper covers SweepStaleProvisioning error + the
// StartStaleSweeper tick body (both warn branches) via a fast interval.
func TestPairSession_F_SweepAndSweeper(t *testing.T) {
	ctx := context.Background()
	s := newPairFSetup(t)

	svc, _ := s.errSvc("FailStalePairSessions")
	_, err := svc.SweepStaleProvisioning(ctx, time.Now().UTC())
	assert.Equal(t, 500, httpStatus(err))

	sweepSvc, _ := s.errSvc("FailStalePairSessions", "SweepStalePairPromptClaims")
	sweepSvc.staleSweepInterval = 2 * time.Millisecond
	sctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { sweepSvc.StartStaleSweeper(sctx); close(done) }()
	time.Sleep(40 * time.Millisecond)
	cancel()
	<-done
}

// TestPairSession_F_ResolveSessionErrors covers ResolveSession error branches.
func TestPairSession_F_ResolveSessionErrors(t *testing.T) {
	ctx := context.Background()
	s := newPairFSetup(t)

	// existing member + bound workspace: ensureWorkspaceShare (upsert) error.
	svcShare, _ := s.errSvc("UpsertWorkspaceShare")
	_, err := svcShare.ResolveSession(ctx, s.session.ID, s.editor)
	assert.Equal(t, 500, httpStatus(err))

	// GetLivePairSessionMember non-ErrNoRows error (non-owner path).
	svcMem, _ := s.errSvc("GetLivePairSessionMember")
	_, err = svcMem.ResolveSession(ctx, s.session.ID, s.editor)
	assert.Equal(t, 500, httpStatus(err))

	// findLiveInviteForVisitor error (non-member visitor).
	svcInv, _ := s.errSvc("GetPrimaryEmail")
	_, err = svcInv.ResolveSession(ctx, s.session.ID, s.stranger)
	assert.Equal(t, 500, httpStatus(err))

	// acceptInvite error path: invite the stranger, then fail the post-accept share.
	strangerEmail := pairUserEmail(t, s.fx.pool, s.stranger)
	_, err = s.svc.CreateInvite(ctx, s.session.ID, s.owner, strangerEmail, PairRoleEditor)
	require.NoError(t, err)
	svcAccept, _ := s.errSvc("UpsertWorkspaceShare")
	_, err = svcAccept.ResolveSession(ctx, s.session.ID, s.stranger)
	assert.Equal(t, 500, httpStatus(err))
}

// TestPairSession_F_PreviewForSourceErrors covers PreviewForSource branches.
func TestPairSession_F_PreviewForSourceErrors(t *testing.T) {
	ctx := context.Background()
	s := newPairFSetup(t)
	src := s.session.SourceWorkspaceID

	// blank source -> BadRequest.
	_, err := s.svc.PreviewForSource(ctx, "  ", s.owner)
	assert.Equal(t, 400, httpStatus(err))

	// GetLivePairSessionForSource non-ErrNoRows error.
	svcSrc, _ := s.errSvc("GetLivePairSessionForSource")
	_, err = svcSrc.PreviewForSource(ctx, src, s.owner)
	assert.Equal(t, 500, httpStatus(err))

	// member internal error (non-owner visitor).
	svcMem, _ := s.errSvc("GetLivePairSessionMember")
	_, err = svcMem.PreviewForSource(ctx, src, s.stranger)
	assert.Equal(t, 500, httpStatus(err))

	// findLiveInvite ferr (non-member visitor).
	svcInv, _ := s.errSvc("GetPrimaryEmail")
	_, err = svcInv.PreviewForSource(ctx, src, s.stranger)
	assert.Equal(t, 500, httpStatus(err))

	// stranger with no relationship -> NotFound (existence-oracle fence).
	_, err = s.svc.PreviewForSource(ctx, src, s.stranger)
	assert.Equal(t, 404, httpStatus(err))
}

// TestPairSession_F_FindLiveInvite covers findLiveInviteForVisitor branches.
func TestPairSession_F_FindLiveInvite(t *testing.T) {
	ctx := context.Background()
	s := newPairFSetup(t)
	nonMember := mkPairUser(t, s.fx.pool, "f-nonmember")

	// email-invite query error.
	svcEmail, _ := s.errSvc("GetLivePairSessionInviteForEmail")
	_, err := svcEmail.ResolveSession(ctx, s.session.ID, nonMember)
	assert.Equal(t, 500, httpStatus(err))

	// GetUserByID error (after email invite miss).
	svcUser, _ := s.errSvc("GetUserByID")
	_, err = svcUser.ResolveSession(ctx, s.session.ID, nonMember)
	assert.Equal(t, 500, httpStatus(err))

	// empty username -> not invited -> Forbidden.
	svcEmpty, fakeEmpty := s.errSvc()
	fakeEmpty.getUserByIDFn = func(id int64) (db.User, error) { return db.User{ID: id, Username: ""}, nil }
	_, err = svcEmpty.ResolveSession(ctx, s.session.ID, nonMember)
	assert.Equal(t, 403, httpStatus(err))

	// username-invite query error.
	svcUname, _ := s.errSvc("GetLivePairSessionInviteForUsername")
	_, err = svcUname.ResolveSession(ctx, s.session.ID, nonMember)
	assert.Equal(t, 500, httpStatus(err))
}

// TestPairSession_F_ResolveByLink covers ResolveByLink branches.
func TestPairSession_F_ResolveByLink(t *testing.T) {
	ctx := context.Background()
	s := newPairFSetup(t)

	// link lookup DB error.
	svcLink, _ := s.errSvc("GetLivePairSessionLinkBySlug")
	_, err := svcLink.ResolveByLink(ctx, "slug", s.owner)
	assert.Equal(t, 500, httpStatus(err))

	// owner resolves by link.
	ownerLink, err := s.svc.MintLink(ctx, s.session.ID, s.owner, PairRoleViewer)
	require.NoError(t, err)
	res, err := s.svc.ResolveByLink(ctx, ownerLink.Slug, s.owner)
	require.NoError(t, err)
	assert.Equal(t, PairRoleOwner, res.Role)

	// GetLivePairSessionMember non-ErrNoRows error (non-owner).
	svcMem, _ := s.errSvc("GetLivePairSessionMember")
	_, err = svcMem.ResolveByLink(ctx, ownerLink.Slug, s.stranger)
	assert.Equal(t, 500, httpStatus(err))

	// elevate member role error (editor link over viewer member).
	editorLink, err := s.svc.MintLink(ctx, s.session.ID, s.owner, PairRoleEditor)
	require.NoError(t, err)
	svcElev, _ := s.errSvc("SetPairSessionMemberRole")
	_, err = svcElev.ResolveByLink(ctx, editorLink.Slug, s.viewer)
	assert.Equal(t, 500, httpStatus(err))

	// ensureWorkspaceShare error after elevation.
	svcElevShare, _ := s.errSvc("UpsertWorkspaceShare")
	_, err = svcElevShare.ResolveByLink(ctx, editorLink.Slug, s.viewer)
	assert.Equal(t, 500, httpStatus(err))

	// link auto-join: UpsertPairSessionMember error.
	viewerLink, err := s.svc.MintLink(ctx, s.session.ID, s.owner, PairRoleViewer)
	require.NoError(t, err)
	joinerA := mkPairUser(t, s.fx.pool, "f-joinerA")
	svcJoin, _ := s.errSvc("UpsertPairSessionMember")
	_, err = svcJoin.ResolveByLink(ctx, viewerLink.Slug, joinerA)
	assert.Equal(t, 500, httpStatus(err))

	// link auto-join: ensureWorkspaceShare error.
	joinerB := mkPairUser(t, s.fx.pool, "f-joinerB")
	svcJoinShare, _ := s.errSvc("UpsertWorkspaceShare")
	_, err = svcJoinShare.ResolveByLink(ctx, viewerLink.Slug, joinerB)
	assert.Equal(t, 500, httpStatus(err))

	// terminal session behind a live link -> NotFound.
	deadLink, err := s.svc.MintLink(ctx, s.session.ID, s.owner, PairRoleViewer)
	require.NoError(t, err)
	require.NoError(t, s.svc.EndSession(ctx, s.session.ID, s.owner))
	_, err = s.svc.ResolveByLink(ctx, deadLink.Slug, s.owner)
	assert.Equal(t, 404, httpStatus(err))
}

// TestPairSession_F_AcceptInviteUnavailable covers acceptInvite accepter-unavailable.
func TestPairSession_F_AcceptInviteUnavailable(t *testing.T) {
	ctx := context.Background()
	s := newPairFSetup(t)
	strangerEmail := pairUserEmail(t, s.fx.pool, s.stranger)
	_, err := s.svc.CreateInvite(ctx, s.session.ID, s.owner, strangerEmail, PairRoleEditor)
	require.NoError(t, err)
	hidingSvc := s.svcWithStore(pairHidingStore{PairSessionStore: s.fx.store})
	_, err = hidingSvc.ResolveSession(ctx, s.session.ID, s.stranger)
	assert.Equal(t, 500, httpStatus(err))
}

// TestPairSession_F_ResolveAcceptedInviteRace covers resolveAcceptedInviteRace.
func TestPairSession_F_ResolveAcceptedInviteRace(t *testing.T) {
	ctx := context.Background()

	// Helper: build a setup with an email invite for the stranger + acceptInviteFn
	// forced to ErrNoRows so acceptInvite always defers to the race resolver.
	newRace := func(t *testing.T) (pairFSetup, *PairSessionService, *pairFakeStore, string) {
		s := newPairFSetup(t)
		strangerEmail := pairUserEmail(t, s.fx.pool, s.stranger)
		_, err := s.svc.CreateInvite(ctx, s.session.ID, s.owner, strangerEmail, PairRoleEditor)
		require.NoError(t, err)
		svc, fake := s.errSvc()
		fake.acceptInviteFn = func() (db.PairSessionMember, error) { return db.PairSessionMember{}, pgx.ErrNoRows }
		return s, svc, fake, strangerEmail
	}

	t.Run("reload invite not found -> forbidden", func(t *testing.T) {
		s, svc, fake, _ := newRace(t)
		fake.getInviteFn = func(_ db.PairSessionInvite, _ error) (db.PairSessionInvite, error) {
			return db.PairSessionInvite{}, pgx.ErrNoRows
		}
		_, err := svc.ResolveSession(ctx, s.session.ID, s.stranger)
		assert.Equal(t, 403, httpStatus(err))
	})

	t.Run("reload invite db error -> internal", func(t *testing.T) {
		s, svc, fake, _ := newRace(t)
		fake.getInviteFn = func(_ db.PairSessionInvite, _ error) (db.PairSessionInvite, error) {
			return db.PairSessionInvite{}, errPairBoom
		}
		_, err := svc.ResolveSession(ctx, s.session.ID, s.stranger)
		assert.Equal(t, 500, httpStatus(err))
	})

	t.Run("accepted by me with matching member -> resolved", func(t *testing.T) {
		s := newPairFSetup(t)
		strangerEmail := pairUserEmail(t, s.fx.pool, s.stranger)
		invRes, err := s.svc.CreateInvite(ctx, s.session.ID, s.owner, strangerEmail, PairRoleEditor)
		require.NoError(t, err)
		// Real accept: creates the member row with invited_via_invite_id set and
		// consumes the invite (now accepted, no longer "live").
		res, err := s.svc.ResolveSession(ctx, s.session.ID, s.stranger)
		require.NoError(t, err)
		assert.Equal(t, PairRoleEditor, res.Role)
		// Now simulate the double-accept race: the accept CAS returns no rows.
		svc, fake := s.errSvc()
		fake.acceptInviteFn = func() (db.PairSessionMember, error) { return db.PairSessionMember{}, pgx.ErrNoRows }
		// Force ResolveSession to treat the stranger as a fresh joiner so acceptInvite runs.
		fake.getMemberFn = func(call int, real db.PairSessionMember, realErr error) (db.PairSessionMember, error) {
			if call == 1 {
				return db.PairSessionMember{}, pgx.ErrNoRows // JOIN path
			}
			return real, realErr // inside race: real member with matching invite id
		}
		// The consumed invite is no longer live; re-surface it so findLiveInvite
		// still routes through acceptInvite (and thus the race resolver).
		fake.getLiveInviteForEmailFn = func(_ db.PairSessionInvite, _ error) (db.PairSessionInvite, error) {
			return invRes.Invite, nil
		}
		res2, err := svc.ResolveSession(ctx, s.session.ID, s.stranger)
		require.NoError(t, err)
		assert.Equal(t, PairRoleEditor, res2.Role)
	})

	t.Run("accepted by me but member load error -> internal", func(t *testing.T) {
		s, svc, fake, _ := newRace(t)
		// invite reload says accepted by stranger, but member load fails inside race.
		fake.getInviteFn = func(real db.PairSessionInvite, _ error) (db.PairSessionInvite, error) {
			real.AcceptedByUserID = pgtype.Int8{Int64: s.stranger, Valid: true}
			return real, nil
		}
		fake.getMemberFn = func(call int, real db.PairSessionMember, realErr error) (db.PairSessionMember, error) {
			if call == 1 {
				return db.PairSessionMember{}, pgx.ErrNoRows
			}
			return db.PairSessionMember{}, errPairBoom
		}
		_, err := svc.ResolveSession(ctx, s.session.ID, s.stranger)
		assert.Equal(t, 500, httpStatus(err))
	})

	t.Run("invite revoked -> forbidden", func(t *testing.T) {
		s, svc, fake, _ := newRace(t)
		fake.getInviteFn = func(real db.PairSessionInvite, _ error) (db.PairSessionInvite, error) {
			real.AcceptedByUserID = pgtype.Int8{}
			real.RevokedAt = pgtype.Timestamptz{Time: time.Now(), Valid: true}
			return real, nil
		}
		_, err := svc.ResolveSession(ctx, s.session.ID, s.stranger)
		assert.Equal(t, 403, httpStatus(err))
	})

	t.Run("accepted by someone else -> conflict", func(t *testing.T) {
		s, svc, fake, _ := newRace(t)
		fake.getInviteFn = func(real db.PairSessionInvite, _ error) (db.PairSessionInvite, error) {
			real.AcceptedByUserID = pgtype.Int8{Int64: s.owner, Valid: true}
			real.RevokedAt = pgtype.Timestamptz{}
			real.ExpiresAt = time.Now().Add(time.Hour)
			return real, nil
		}
		_, err := svc.ResolveSession(ctx, s.session.ID, s.stranger)
		assert.Equal(t, 409, httpStatus(err))
	})

	t.Run("accepted by me but share fails -> internal", func(t *testing.T) {
		s := newPairFSetup(t)
		strangerEmail := pairUserEmail(t, s.fx.pool, s.stranger)
		invRes, err := s.svc.CreateInvite(ctx, s.session.ID, s.owner, strangerEmail, PairRoleEditor)
		require.NoError(t, err)
		_, err = s.svc.ResolveSession(ctx, s.session.ID, s.stranger)
		require.NoError(t, err)
		svc, fake := s.errSvc("UpsertWorkspaceShare")
		fake.acceptInviteFn = func() (db.PairSessionMember, error) { return db.PairSessionMember{}, pgx.ErrNoRows }
		fake.getMemberFn = func(call int, real db.PairSessionMember, realErr error) (db.PairSessionMember, error) {
			if call == 1 {
				return db.PairSessionMember{}, pgx.ErrNoRows
			}
			return real, realErr
		}
		fake.getLiveInviteForEmailFn = func(_ db.PairSessionInvite, _ error) (db.PairSessionInvite, error) {
			return invRes.Invite, nil
		}
		_, err = svc.ResolveSession(ctx, s.session.ID, s.stranger)
		assert.Equal(t, 500, httpStatus(err))
	})
}

// TestPairSession_F_AcceptInviteGenericError covers acceptInvite's non-ErrNoRows
// AcceptPairSessionInvite failure.
func TestPairSession_F_AcceptInviteGenericError(t *testing.T) {
	ctx := context.Background()
	s := newPairFSetup(t)
	strangerEmail := pairUserEmail(t, s.fx.pool, s.stranger)
	_, err := s.svc.CreateInvite(ctx, s.session.ID, s.owner, strangerEmail, PairRoleEditor)
	require.NoError(t, err)
	svc, fake := s.errSvc()
	fake.acceptInviteFn = func() (db.PairSessionMember, error) { return db.PairSessionMember{}, errPairBoom }
	_, err = svc.ResolveSession(ctx, s.session.ID, s.stranger)
	assert.Equal(t, 500, httpStatus(err))
}

// TestPairSession_F_MembershipErrors covers list/mutation DB errors.
func TestPairSession_F_MembershipErrors(t *testing.T) {
	ctx := context.Background()
	s := newPairFSetup(t)
	sid := s.session.ID

	svcLM, _ := s.errSvc("ListLivePairSessionMembers")
	_, err := svcLM.ListMembers(ctx, sid, s.owner)
	assert.Equal(t, 500, httpStatus(err))

	svcLMP, _ := s.errSvc("ListLivePairSessionMemberProfiles")
	_, err = svcLMP.ListMemberProfiles(ctx, sid, s.owner)
	assert.Equal(t, 500, httpStatus(err))

	svcSMR, _ := s.errSvc("SetPairSessionMemberRole")
	_, err = svcSMR.SetMemberRole(ctx, sid, s.owner, s.editor, PairRoleViewer)
	assert.Equal(t, 500, httpStatus(err))

	// SetMemberRole ensureWorkspaceShare error (role update succeeds, share fails).
	svcSMRShare, _ := s.errSvc("UpsertWorkspaceShare")
	_, err = svcSMRShare.SetMemberRole(ctx, sid, s.owner, s.editor, PairRoleViewer)
	assert.Equal(t, 500, httpStatus(err))

	svcRM, _ := s.errSvc("RevokePairSessionMember")
	assert.Equal(t, 500, httpStatus(svcRM.RevokeMember(ctx, sid, s.owner, s.editor)))

	// RevokeMember revokeWorkspaceShare error.
	svcRMShare, _ := s.errSvc("DeleteWorkspaceShare")
	assert.Equal(t, 500, httpStatus(svcRMShare.RevokeMember(ctx, sid, s.owner, s.editor)))

	// SetAccessMode: revoke-links error and set-access-mode error.
	svcRevoke, _ := s.errSvc("RevokeLivePairSessionLinksForRole")
	_, err = svcRevoke.SetAccessMode(ctx, sid, s.owner, PairAccessRestricted)
	assert.Equal(t, 500, httpStatus(err))
	svcSAM, _ := s.errSvc("SetPairSessionAccessMode")
	_, err = svcSAM.SetAccessMode(ctx, sid, s.owner, PairAccessLink)
	assert.Equal(t, 500, httpStatus(err))
}

// TestPairSession_F_ShareVerifyAfterWriteDropsShareWhenMemberGone proves the
// membership verify-after-write in ensureWorkspaceShare: when a concurrent
// RevokeMember lands between SetMemberRole's role update and its share upsert
// (simulated by the verify read seeing no live member), the just-recreated
// share is dropped and the call fails closed — a revoked member can never be
// left holding a workspace share.
func TestPairSession_F_ShareVerifyAfterWriteDropsShareWhenMemberGone(t *testing.T) {
	ctx := context.Background()
	s := newPairFSetup(t)

	svc, fake := s.errSvc()
	verifiedAfterWrite := false
	fake.getMemberFn = func(_ int, member db.PairSessionMember, err error) (db.PairSessionMember, error) {
		require.NoError(t, err)
		if member.Role == PairRoleEditor {
			// The editor exists when SetMemberRole reads the previous role.
			return member, nil
		}
		require.Equal(t, PairRoleViewer, member.Role)
		share, err := fake.Queries.GetWorkspaceShare(ctx, db.GetWorkspaceShareParams{
			WorkspaceID: UUIDString(s.session.WorkspaceID), GranteeUserID: s.editor,
		})
		require.NoError(t, err, "the role change must recreate the share before the injected revoke")
		require.Equal(t, "read", share.Level)
		verifiedAfterWrite = true
		// Only the verify-after-write read observes the member already revoked.
		return db.PairSessionMember{}, pgx.ErrNoRows
	}
	_, err := svc.SetMemberRole(ctx, s.session.ID, s.owner, s.editor, PairRoleViewer)
	assert.Equal(t, 403, httpStatus(err))
	require.True(t, verifiedAfterWrite, "exercise membership verification after the share upsert")

	var shares int
	require.NoError(t, s.fx.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM workspace_shares WHERE workspace_id=$1::uuid AND grantee_user_id=$2`,
		UUIDString(s.session.WorkspaceID), s.editor).Scan(&shares))
	assert.Zero(t, shares, "share recreated past a revoke must be dropped by the verify")
}

// TestPairSession_F_LinksAndInvitesErrors covers link/invite DB errors.
func TestPairSession_F_LinksAndInvitesErrors(t *testing.T) {
	ctx := context.Background()
	s := newPairFSetup(t)
	sid := s.session.ID

	// MintLink invalid role.
	_, err := s.svc.MintLink(ctx, sid, s.owner, PairRoleOwner)
	assert.Equal(t, 400, httpStatus(err))

	// MintLink revoke-links error.
	svcRev, _ := s.errSvc("RevokeLivePairSessionLinksForRole")
	_, err = svcRev.MintLink(ctx, sid, s.owner, PairRoleViewer)
	assert.Equal(t, 500, httpStatus(err))

	// MintLink mint-slug error (rand failure).
	func() {
		defer pairForceRandFailure(t)()
		_, err := s.svc.MintLink(ctx, sid, s.owner, PairRoleViewer)
		assert.Equal(t, 500, httpStatus(err))
	}()

	// MintLink create-link error.
	svcCL, _ := s.errSvc("CreatePairSessionLink")
	_, err = svcCL.MintLink(ctx, sid, s.owner, PairRoleViewer)
	assert.Equal(t, 500, httpStatus(err))

	// MintLink set-access-mode error.
	svcSAM, _ := s.errSvc("SetPairSessionAccessMode")
	_, err = svcSAM.MintLink(ctx, sid, s.owner, PairRoleViewer)
	assert.Equal(t, 500, httpStatus(err))

	// ListLinks error.
	svcLL, _ := s.errSvc("ListLivePairSessionLinks")
	_, err = svcLL.ListLinks(ctx, sid, s.owner)
	assert.Equal(t, 500, httpStatus(err))

	// RevokeLink DB error (non-ErrNoRows).
	svcRL, _ := s.errSvc("RevokePairSessionLink")
	assert.Equal(t, 500, httpStatus(svcRL.RevokeLink(ctx, sid, s.owner, "some-id")))

	// CreateInvite: mint token error.
	func() {
		defer pairForceRandFailure(t)()
		_, err := s.svc.CreateInvite(ctx, sid, s.owner, "x@y.com", PairRoleViewer)
		assert.Equal(t, 500, httpStatus(err))
	}()
	// CreateInvite: insert error.
	svcCI, _ := s.errSvc("CreatePairSessionInvite")
	_, err = svcCI.CreateInvite(ctx, sid, s.owner, "x@y.com", PairRoleViewer)
	assert.Equal(t, 500, httpStatus(err))
	// CreateInvite: whitelist error.
	svcWL, _ := s.errSvc("UpsertAlphaWhitelistEmail")
	_, err = svcWL.CreateInvite(ctx, sid, s.owner, "x@y.com", PairRoleViewer)
	assert.Equal(t, 500, httpStatus(err))

	// CreateInviteByUsername: mint token error.
	func() {
		defer pairForceRandFailure(t)()
		_, err := s.svc.CreateInviteByUsername(ctx, sid, s.owner, "octocat", PairRoleViewer)
		assert.Equal(t, 500, httpStatus(err))
	}()
	// CreateInviteByUsername: insert error.
	svcCIU, _ := s.errSvc("CreatePairSessionInvite")
	_, err = svcCIU.CreateInviteByUsername(ctx, sid, s.owner, "octocat", PairRoleViewer)
	assert.Equal(t, 500, httpStatus(err))
	// CreateInviteByUsername: whitelist error.
	svcWLU, _ := s.errSvc("UpsertAlphaWhitelistUsername")
	_, err = svcWLU.CreateInviteByUsername(ctx, sid, s.owner, "octocat", PairRoleViewer)
	assert.Equal(t, 500, httpStatus(err))

	// ListInvites error.
	svcLI, _ := s.errSvc("ListPairSessionInvites")
	_, err = svcLI.ListInvites(ctx, sid, s.owner)
	assert.Equal(t, 500, httpStatus(err))

	// RevokeInvite DB error.
	svcRI, _ := s.errSvc("RevokePairSessionInvite")
	assert.Equal(t, 500, httpStatus(svcRI.RevokeInvite(ctx, sid, s.owner, "x@y.com")))

	// RevokeInviteByUsername: ErrNoRows -> NotFound and generic -> Internal.
	svcRIUnr, fakeRIU := s.errSvc()
	fakeRIU.errs["RevokePairSessionInviteByUsername"] = pgx.ErrNoRows
	assert.Equal(t, 404, httpStatus(svcRIUnr.RevokeInviteByUsername(ctx, sid, s.owner, "octocat")))
	svcRIU, _ := s.errSvc("RevokePairSessionInviteByUsername")
	assert.Equal(t, 500, httpStatus(svcRIU.RevokeInviteByUsername(ctx, sid, s.owner, "octocat")))
}

// TestPairSession_F_QueueErrors covers queue DB error branches.
func TestPairSession_F_QueueErrors(t *testing.T) {
	ctx := context.Background()
	s := newPairFSetup(t)
	sid := s.session.ID

	// enqueueWithRetry no-tx path (build svc with nil tx-beginner).
	noTx := func(fails ...string) (*PairSessionService, *pairFakeStore) {
		fake := newPairFakeStore(s.fx.store, fails...)
		svc := NewPairSessionService(fake, pairAllowBilling{}, &stubForker{pool: s.fx.pool, repoID: s.fx.repoID}, PairSessionServiceConfig{})
		return svc, fake
	}

	// unique-violation exhausted -> Internal.
	svcUniq, fakeUniq := noTx()
	fakeUniq.enqueueFn = func(call int) (db.PairPromptQueue, error) { return db.PairPromptQueue{}, pairUniqueViolation() }
	_, err := svcUniq.Enqueue(ctx, sid, s.owner, pairPromptSourceSolo, "body")
	assert.Equal(t, 500, httpStatus(err))

	// unique-violation then success -> retried.
	svcRetry, fakeRetry := noTx()
	fakeRetry.enqueueFn = func(call int) (db.PairPromptQueue, error) {
		if call == 1 {
			return db.PairPromptQueue{}, pairUniqueViolation()
		}
		return db.PairPromptQueue{ID: "ok", SessionID: sid}, nil
	}
	got, err := svcRetry.Enqueue(ctx, sid, s.owner, pairPromptSourceSolo, "body")
	require.NoError(t, err)
	assert.Equal(t, "ok", got.ID)

	// non-unique error -> Internal.
	svcGen, fakeGen := noTx()
	fakeGen.enqueueFn = func(call int) (db.PairPromptQueue, error) { return db.PairPromptQueue{}, errPairBoom }
	_, err = svcGen.Enqueue(ctx, sid, s.owner, pairPromptSourceSolo, "body")
	assert.Equal(t, 500, httpStatus(err))

	// enqueueSerial (tx path) failures via fake tx.
	txSvc := func(b *pairFakeTxBeginner) *PairSessionService {
		return NewPairSessionService(s.fx.store, pairAllowBilling{}, &stubForker{pool: s.fx.pool, repoID: s.fx.repoID}, PairSessionServiceConfig{TxBeginner: b})
	}
	sessionRow := pairFakeRow{scan: func(dest ...any) error {
		*dest[1].(*int64) = s.owner
		*dest[5].(*string) = "active"
		return nil
	}}
	// Begin error.
	_, err = txSvc(&pairFakeTxBeginner{beginErr: errPairBoom}).Enqueue(ctx, sid, s.owner, pairPromptSourceSolo, "b")
	assert.Equal(t, 500, httpStatus(err))
	// lock exec error.
	_, err = txSvc(&pairFakeTxBeginner{tx: &pairFakeTx{execErr: errPairBoom}}).Enqueue(ctx, sid, s.owner, pairPromptSourceSolo, "b")
	assert.Equal(t, 500, httpStatus(err))
	// membership lock exec error.
	_, err = txSvc(&pairFakeTxBeginner{tx: &pairFakeTx{execErr: errPairBoom, execErrAt: 2}}).Enqueue(ctx, sid, s.owner, pairPromptSourceSolo, "b")
	assert.Equal(t, 500, httpStatus(err))
	// enqueue query error.
	_, err = txSvc(&pairFakeTxBeginner{tx: &pairFakeTx{rows: []pairFakeRow{sessionRow, {err: errPairBoom}}}}).Enqueue(ctx, sid, s.owner, pairPromptSourceSolo, "b")
	assert.Equal(t, 500, httpStatus(err))
	// commit error (enqueue scan succeeds).
	_, err = txSvc(&pairFakeTxBeginner{tx: &pairFakeTx{rows: []pairFakeRow{sessionRow, {scan: func(dest ...any) error { return nil }}}, commitErr: errPairBoom}}).Enqueue(ctx, sid, s.owner, pairPromptSourceSolo, "b")
	assert.Equal(t, 500, httpStatus(err))

	// ListQueue error.
	svcLQ, _ := s.errSvc("ListPairPromptQueue")
	_, err = svcLQ.ListQueue(ctx, sid, s.owner)
	assert.Equal(t, 500, httpStatus(err))

	// Claim non-conflict error.
	svcClaim, _ := s.errSvc("ClaimPairPrompt")
	_, err = svcClaim.Claim(ctx, sid, s.owner, "p", "c", time.Minute)
	assert.Equal(t, 500, httpStatus(err))

	// Start non-ErrNoRows error.
	svcStart, _ := s.errSvc("StartPairPrompt")
	_, err = svcStart.Start(ctx, sid, s.owner, "p", "c", "run")
	assert.Equal(t, 500, httpStatus(err))

	// Renew non-ErrNoRows error.
	svcRenew, _ := s.errSvc("RenewPairPromptLease")
	_, err = svcRenew.Renew(ctx, sid, s.owner, "p", "c", time.Minute)
	assert.Equal(t, 500, httpStatus(err))

	// Finish invalid status + non-ErrNoRows error.
	_, err = s.svc.Finish(ctx, sid, s.owner, "p", "c", "bogus")
	assert.Equal(t, 400, httpStatus(err))
	svcFinish, _ := s.errSvc("FinishPairPrompt")
	_, err = svcFinish.Finish(ctx, sid, s.owner, "p", "c", "done")
	assert.Equal(t, 500, httpStatus(err))

	// Cancel owner path error and editor path error.
	svcCancelOwner, _ := s.errSvc("CancelAnyPendingPairPrompt")
	_, err = svcCancelOwner.Cancel(ctx, sid, s.owner, "p")
	assert.Equal(t, 500, httpStatus(err))
	svcCancelEditor, _ := s.errSvc("CancelOwnQueuedPairPrompt")
	_, err = svcCancelEditor.Cancel(ctx, sid, s.editor, "p")
	assert.Equal(t, 500, httpStatus(err))

	// SweepStaleClaims: claims error and running error.
	svcSweep, _ := s.errSvc("SweepStalePairPromptClaims")
	_, err = svcSweep.SweepStaleClaims(ctx)
	assert.Equal(t, 500, httpStatus(err))
	svcRun, _ := s.errSvc("FailStaleRunningPairPrompts")
	_, err = svcRun.SweepStaleClaims(ctx)
	assert.Equal(t, 500, httpStatus(err))
}

// TestPairSession_F_DraftAndHeartbeatErrors covers draft + presence branches.
func TestPairSession_F_DraftAndHeartbeatErrors(t *testing.T) {
	ctx := context.Background()
	s := newPairFSetup(t)
	sid := s.session.ID

	// GetDraft non-ErrNoRows error.
	svcGD, _ := s.errSvc("GetPairSessionDraft")
	_, err := svcGD.GetDraft(ctx, sid, s.owner)
	assert.Equal(t, 500, httpStatus(err))

	// PutDraft: stale version (ErrNoRows -> Conflict) and generic error.
	svcPDnr, fakePD := s.errSvc()
	fakePD.errs["UpsertPairSessionDraft"] = pgx.ErrNoRows
	_, err = svcPDnr.PutDraft(ctx, sid, s.owner, "c", 99)
	assert.Equal(t, 409, httpStatus(err))
	svcPD, _ := s.errSvc("UpsertPairSessionDraft")
	_, err = svcPD.PutDraft(ctx, sid, s.owner, "c", 1)
	assert.Equal(t, 500, httpStatus(err))

	// SubmitDraft fallback (no-tx) path.
	noTx := func(fails ...string) *PairSessionService {
		fake := newPairFakeStore(s.fx.store, fails...)
		return NewPairSessionService(fake, pairAllowBilling{}, &stubForker{pool: s.fx.pool, repoID: s.fx.repoID}, PairSessionServiceConfig{})
	}
	// load draft generic error.
	_, err = noTx("GetPairSessionDraft").SubmitDraft(ctx, sid, s.owner)
	assert.Equal(t, 500, httpStatus(err))

	// Seed a non-empty draft, then fallback submit succeeds (clear ok).
	_, err = s.fx.store.UpsertPairSessionDraft(ctx, db.UpsertPairSessionDraftParams{SessionID: sid, Content: "ship", Version: 1, UpdatedBy: pgtype.Int8{Int64: s.owner, Valid: true}})
	require.NoError(t, err)
	// clear conflict: inject ClearPairSessionDraft ErrNoRows.
	fakeClearNR := newPairFakeStore(s.fx.store)
	fakeClearNR.errs["ClearPairSessionDraft"] = pgx.ErrNoRows
	svcClearNR := NewPairSessionService(fakeClearNR, pairAllowBilling{}, &stubForker{pool: s.fx.pool, repoID: s.fx.repoID}, PairSessionServiceConfig{})
	_, err = svcClearNR.SubmitDraft(ctx, sid, s.owner)
	assert.Equal(t, 409, httpStatus(err))
	// clear generic error.
	svcClearGen := noTx("ClearPairSessionDraft")
	_, err = svcClearGen.SubmitDraft(ctx, sid, s.owner)
	assert.Equal(t, 500, httpStatus(err))
	// enqueue error in fallback submit.
	fakeEnq := newPairFakeStore(s.fx.store)
	fakeEnq.enqueueFn = func(call int) (db.PairPromptQueue, error) { return db.PairPromptQueue{}, errPairBoom }
	svcEnq := NewPairSessionService(fakeEnq, pairAllowBilling{}, &stubForker{pool: s.fx.pool, repoID: s.fx.repoID}, PairSessionServiceConfig{})
	_, err = svcEnq.SubmitDraft(ctx, sid, s.owner)
	assert.Equal(t, 500, httpStatus(err))

	// Heartbeat: ErrNoRows -> Forbidden and generic -> Internal.
	svcHBnr, fakeHB := s.errSvc()
	fakeHB.errs["UpdatePairSessionMemberPresence"] = pgx.ErrNoRows
	assert.Equal(t, 403, httpStatus(svcHBnr.Heartbeat(ctx, sid, s.owner, nil)))
	svcHB, _ := s.errSvc("UpdatePairSessionMemberPresence")
	assert.Equal(t, 500, httpStatus(svcHB.Heartbeat(ctx, sid, s.owner, nil)))
}

// TestPairSession_F_SubmitDraftSerialErrors covers submitDraftSerial via fake tx.
func TestPairSession_F_SubmitDraftSerialErrors(t *testing.T) {
	ctx := context.Background()
	s := newPairFSetup(t)
	sid := s.session.ID

	txSvc := func(b *pairFakeTxBeginner) *PairSessionService {
		return NewPairSessionService(s.fx.store, pairAllowBilling{}, &stubForker{pool: s.fx.pool, repoID: s.fx.repoID}, PairSessionServiceConfig{TxBeginner: b})
	}
	sessionRow := pairFakeRow{scan: func(dest ...any) error {
		*dest[1].(*int64) = s.owner
		*dest[5].(*string) = "active"
		return nil
	}}
	setContent := func(v string) func(dest ...any) error {
		return func(dest ...any) error {
			if len(dest) > 1 {
				if p, ok := dest[1].(*string); ok {
					*p = v
				}
			}
			return nil
		}
	}
	okScan := func(dest ...any) error { return nil }

	// Begin error.
	_, err := txSvc(&pairFakeTxBeginner{beginErr: errPairBoom}).SubmitDraft(ctx, sid, s.owner)
	assert.Equal(t, 500, httpStatus(err))
	// lock exec error.
	_, err = txSvc(&pairFakeTxBeginner{tx: &pairFakeTx{execErr: errPairBoom}}).SubmitDraft(ctx, sid, s.owner)
	assert.Equal(t, 500, httpStatus(err))
	// membership lock exec error.
	_, err = txSvc(&pairFakeTxBeginner{tx: &pairFakeTx{execErr: errPairBoom, execErrAt: 2}}).SubmitDraft(ctx, sid, s.owner)
	assert.Equal(t, 500, httpStatus(err))
	// draft load generic error.
	_, err = txSvc(&pairFakeTxBeginner{tx: &pairFakeTx{rows: []pairFakeRow{sessionRow, {err: errPairBoom}}}}).SubmitDraft(ctx, sid, s.owner)
	assert.Equal(t, 500, httpStatus(err))
	// draft load ErrNoRows -> BadRequest (empty).
	_, err = txSvc(&pairFakeTxBeginner{tx: &pairFakeTx{rows: []pairFakeRow{sessionRow, {err: pgx.ErrNoRows}}}}).SubmitDraft(ctx, sid, s.owner)
	assert.Equal(t, 400, httpStatus(err))
	// empty content -> BadRequest.
	_, err = txSvc(&pairFakeTxBeginner{tx: &pairFakeTx{rows: []pairFakeRow{sessionRow, {scan: setContent("   ")}}}}).SubmitDraft(ctx, sid, s.owner)
	assert.Equal(t, 400, httpStatus(err))
	// enqueue error after valid draft.
	_, err = txSvc(&pairFakeTxBeginner{tx: &pairFakeTx{rows: []pairFakeRow{sessionRow, {scan: setContent("go")}, {err: errPairBoom}}}}).SubmitDraft(ctx, sid, s.owner)
	assert.Equal(t, 500, httpStatus(err))
	// clear conflict (ErrNoRows) -> Conflict.
	_, err = txSvc(&pairFakeTxBeginner{tx: &pairFakeTx{rows: []pairFakeRow{sessionRow, {scan: setContent("go")}, {scan: okScan}, {err: pgx.ErrNoRows}}}}).SubmitDraft(ctx, sid, s.owner)
	assert.Equal(t, 409, httpStatus(err))
	// clear generic error -> Internal.
	_, err = txSvc(&pairFakeTxBeginner{tx: &pairFakeTx{rows: []pairFakeRow{sessionRow, {scan: setContent("go")}, {scan: okScan}, {err: errPairBoom}}}}).SubmitDraft(ctx, sid, s.owner)
	assert.Equal(t, 500, httpStatus(err))
	// commit error.
	_, err = txSvc(&pairFakeTxBeginner{tx: &pairFakeTx{rows: []pairFakeRow{sessionRow, {scan: setContent("go")}, {scan: okScan}, {scan: okScan}}, commitErr: errPairBoom}}).SubmitDraft(ctx, sid, s.owner)
	assert.Equal(t, 500, httpStatus(err))
}

// TestPairSession_F_WorkspaceShareHelpers covers ensureWorkspaceShare and
// revokeWorkspaceShare branches by direct invocation.
func TestPairSession_F_WorkspaceShareHelpers(t *testing.T) {
	ctx := context.Background()
	s := newPairFSetup(t)

	// userID == owner -> nil.
	require.NoError(t, s.svc.ensureWorkspaceShare(ctx, s.session, s.owner, PairRoleOwner))

	// session without a bound workspace -> nil (both helpers).
	unbound := db.PairSession{ID: s.session.ID, OwnerUserID: s.owner, WorkspaceID: pgtype.UUID{}}
	require.NoError(t, s.svc.ensureWorkspaceShare(ctx, unbound, s.viewer, PairRoleViewer))
	require.NoError(t, s.svc.revokeWorkspaceShare(ctx, unbound, s.viewer))

	// verify-after-write: GetPairSession error -> revoke + Internal.
	svcVerifyErr, fakeVE := s.errSvc()
	fakeVE.getPairSessionFn = func(call int, real db.PairSession, realErr error) (db.PairSession, error) {
		return db.PairSession{}, errPairBoom
	}
	err := svcVerifyErr.ensureWorkspaceShare(ctx, s.session, s.viewer, PairRoleViewer)
	assert.Equal(t, 500, httpStatus(err))

	// verify-after-write: fresh status terminal -> revoke + NotFound.
	svcVerifyTerm, fakeVT := s.errSvc()
	fakeVT.getPairSessionFn = func(call int, real db.PairSession, realErr error) (db.PairSession, error) {
		real.Status = "ended"
		return real, nil
	}
	err = svcVerifyTerm.ensureWorkspaceShare(ctx, s.session, s.viewer, PairRoleViewer)
	assert.Equal(t, 404, httpStatus(err))

	// revokeWorkspaceShare DB error.
	svcRevErr, _ := s.errSvc("DeleteWorkspaceShare")
	err = svcRevErr.revokeWorkspaceShare(ctx, s.session, s.viewer)
	assert.Equal(t, 500, httpStatus(err))
}

func (pairAllowBilling) AuthorizeSandboxStart(context.Context, int64) error { return nil }
func (pairAllowBilling) SandboxEntitlement(context.Context, int64) (SandboxEntitlement, error) {
	return SandboxEntitlement{}, nil
}

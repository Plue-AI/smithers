package services

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/email"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// httpStatus extracts the HTTP status from an *APIError (0 if not one).
func httpStatus(err error) int {
	var apiErr *pkgerrors.APIError
	if errors.As(err, &apiErr) {
		return apiErr.Status
	}
	return 0
}

// --- test doubles (allowed: interfaces, _test.go only) ---------------------

// stubBilling implements PairBillingPolicy. Users in `paid` pass; everyone else
// is Forbidden — mirroring AuthorizePairing's contract.
type stubBilling struct{ paid map[int64]bool }

func (b *stubBilling) AuthorizePairing(_ context.Context, userID int64) error {
	if b.paid[userID] {
		return nil
	}
	return pkgerrors.Forbidden("pairing requires a paid plan (Hobby or above)")
}

type unavailableCountingTransport struct {
	sends atomic.Int32
}

func (*unavailableCountingTransport) Available() bool { return false }

func (t *unavailableCountingTransport) Send(context.Context, email.Message) error {
	t.sends.Add(1)
	return email.ErrDeliveryNotConfigured
}

// stubForker implements PairForker by inserting a real fork workspace row (so
// pair_sessions.workspace_id's FK is satisfied) and returning its id.
type stubForker struct {
	pool      *pgxpool.Pool
	repoID    int64
	fail      bool
	verifyErr error
	calls     atomic.Int32
}

// pairMutationBarrierStore decorates the real store with test-only barriers at
// the dangerous multi-statement windows. Because it is not a *db.Queries, the
// service keeps this wrapper while its advisory-lock transaction serializes the
// callback, which lets the tests observe whether a competing callback entered.
type pairMutationBarrierStore struct {
	PairSessionStore
	roleUpdated       chan struct{}
	releaseRole       chan struct{}
	revokeEntered     chan struct{}
	modeUpdateReady   chan struct{}
	releaseModeUpdate chan struct{}
	linkCreateEntered chan struct{}
}

func (s *pairMutationBarrierStore) SetPairSessionMemberRole(ctx context.Context, arg db.SetPairSessionMemberRoleParams) (db.PairSessionMember, error) {
	member, err := s.PairSessionStore.SetPairSessionMemberRole(ctx, arg)
	if err == nil && s.roleUpdated != nil {
		close(s.roleUpdated)
		<-s.releaseRole
	}
	return member, err
}

func (s *pairMutationBarrierStore) RevokePairSessionMember(ctx context.Context, arg db.RevokePairSessionMemberParams) (db.PairSessionMember, error) {
	if s.revokeEntered != nil {
		close(s.revokeEntered)
	}
	return s.PairSessionStore.RevokePairSessionMember(ctx, arg)
}

func (s *pairMutationBarrierStore) SetPairSessionAccessMode(ctx context.Context, arg db.SetPairSessionAccessModeParams) (db.PairSession, error) {
	if arg.AccessMode == PairAccessRestricted && s.modeUpdateReady != nil {
		close(s.modeUpdateReady)
		<-s.releaseModeUpdate
	}
	return s.PairSessionStore.SetPairSessionAccessMode(ctx, arg)
}

func (s *pairMutationBarrierStore) CreatePairSessionLink(ctx context.Context, arg db.CreatePairSessionLinkParams) (db.PairSessionLink, error) {
	if s.linkCreateEntered != nil {
		close(s.linkCreateEntered)
	}
	return s.PairSessionStore.CreatePairSessionLink(ctx, arg)
}

func (f *stubForker) VerifyPairSourceWorkspace(_ context.Context, _ string, _ int64, _ int64) error {
	return f.verifyErr
}

func (f *stubForker) ForkWorkspace(ctx context.Context, input ForkWorkspaceInput) (WorkspaceResponse, error) {
	f.calls.Add(1)
	if f.fail {
		return WorkspaceResponse{}, pkgerrors.Internal("fork failed")
	}
	var id string
	err := f.pool.QueryRow(ctx,
		`INSERT INTO workspaces (repository_id, user_id, is_fork, parent_workspace_id) VALUES ($1, $2, TRUE, $3) RETURNING id`,
		f.repoID, input.UserID, input.WorkspaceID,
	).Scan(&id)
	if err != nil {
		return WorkspaceResponse{}, err
	}
	return WorkspaceResponse{ID: id, UserID: input.UserID, IsFork: true}, nil
}

// --- fixtures --------------------------------------------------------------

type pairFixture struct {
	pool   *pgxpool.Pool
	store  *db.Queries
	repoID int64
}

func newPairFixture(t *testing.T) pairFixture {
	t.Helper()
	pool := getAgentTestPool(t)
	owner := mkPairUser(t, pool, "fixture-owner")
	repoID := mkPairRepo(t, pool, owner)
	return pairFixture{pool: pool, store: db.New(pool), repoID: repoID}
}

var pairUserSeq atomic.Int64

func mkPairUser(t *testing.T, pool *pgxpool.Pool, prefix string) int64 {
	t.Helper()
	n := pairUserSeq.Add(1)
	uname := fmt.Sprintf("%s-%d", prefix, n)
	lower := strings.ToLower(uname)
	em := lower + "@example.com"
	var id int64
	err := pool.QueryRow(context.Background(),
		`INSERT INTO users (username, lower_username, email, lower_email, display_name) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
		uname, lower, em, em, uname).Scan(&id)
	require.NoError(t, err)
	_, err = pool.Exec(context.Background(),
		`INSERT INTO email_addresses (user_id, email, lower_email, is_activated, is_primary) VALUES ($1,$2,$3,TRUE,TRUE)`,
		id, em, em)
	require.NoError(t, err)
	return id
}

func pairUserEmail(t *testing.T, pool *pgxpool.Pool, userID int64) string {
	t.Helper()
	var em string
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT lower_email FROM email_addresses WHERE user_id=$1 AND is_primary=TRUE`, userID).Scan(&em))
	return em
}

func mkPairRepo(t *testing.T, pool *pgxpool.Pool, userID int64) int64 {
	t.Helper()
	n := pairUserSeq.Add(1)
	name := fmt.Sprintf("pair-repo-%d", n)
	var id int64
	err := pool.QueryRow(context.Background(),
		`INSERT INTO repositories (user_id, name, lower_name, description, is_public, default_bookmark, next_issue_number) VALUES ($1,$2,$3,'',TRUE,'main',1) RETURNING id`,
		userID, name, strings.ToLower(name)).Scan(&id)
	require.NoError(t, err)
	return id
}

func mkPairWorkspace(t *testing.T, pool *pgxpool.Pool, userID, repoID int64) string {
	t.Helper()
	var id string
	require.NoError(t, pool.QueryRow(context.Background(),
		`INSERT INTO workspaces (repository_id, user_id) VALUES ($1,$2) RETURNING id`, repoID, userID).Scan(&id))
	return id
}

func newPairService(fx pairFixture, paid map[int64]bool, forkFail bool, transport email.Transport) *PairSessionService {
	forker := &stubForker{pool: fx.pool, repoID: fx.repoID, fail: forkFail}
	return NewPairSessionService(fx.store, &stubBilling{paid: paid}, forker,
		PairSessionServiceConfig{EmailFrom: "pair@smithers.sh", Transport: transport, InviteBaseURL: "https://smithers.sh", TxBeginner: fx.pool})
}

// --- tests -----------------------------------------------------------------

// TestCreatePairSession_GatesOwnerOnPaidPlan: a free owner is denied; a paid
// (trialing/active) owner succeeds with an unguessable id, an owner member row,
// and a bound fork (status active).
func TestCreatePairSession_GatesOwnerOnPaidPlan(t *testing.T) {
	fx := newPairFixture(t)

	freeOwner := mkPairUser(t, fx.pool, "free-owner")
	freeWS := mkPairWorkspace(t, fx.pool, freeOwner, fx.repoID)
	svcFree := newPairService(fx, map[int64]bool{}, false, nil)
	_, err := svcFree.CreateSession(context.Background(), freeOwner, fx.repoID, freeWS)
	require.Error(t, err)
	assert.Equal(t, 403, httpStatus(err), "free owner must be 403")

	paidOwner := mkPairUser(t, fx.pool, "paid-owner")
	paidWS := mkPairWorkspace(t, fx.pool, paidOwner, fx.repoID)
	svc := newPairService(fx, map[int64]bool{paidOwner: true}, false, nil)
	session, err := svc.CreateSession(context.Background(), paidOwner, fx.repoID, paidWS)
	require.NoError(t, err)
	assert.Equal(t, "active", session.Status)
	assert.True(t, session.WorkspaceID.Valid, "fork workspace must be bound")
	assert.GreaterOrEqual(t, len(session.ID), 22, "id must be >=128-bit base62 (>=22 chars)")

	member, err := fx.store.GetLivePairSessionMember(context.Background(), db.GetLivePairSessionMemberParams{SessionID: session.ID, UserID: paidOwner})
	require.NoError(t, err)
	assert.Equal(t, PairRoleOwner, member.Role)
}

// TestCreatePairSession_ForkFailureMarksFailed: a fork failure flips the session
// to 'failed' (freeing the source) and surfaces an honest error.
func TestCreatePairSession_ForkFailureMarksFailed(t *testing.T) {
	fx := newPairFixture(t)
	owner := mkPairUser(t, fx.pool, "fork-fail-owner")
	ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
	svc := newPairService(fx, map[int64]bool{owner: true}, true, nil)

	_, err := svc.CreateSession(context.Background(), owner, fx.repoID, ws)
	require.Error(t, err)

	// A fresh create for the same source must now succeed (the failed session is
	// excluded from the live-per-source index).
	svcOK := newPairService(fx, map[int64]bool{owner: true}, false, nil)
	session, err := svcOK.CreateSession(context.Background(), owner, fx.repoID, ws)
	require.NoError(t, err, "a failed fork must not wedge the owner")
	assert.Equal(t, "active", session.Status)
}

// TestCreatePairSession_OneLivePerSource: a second live session for the same
// source is a 409.
func TestCreatePairSession_OneLivePerSource(t *testing.T) {
	fx := newPairFixture(t)
	owner := mkPairUser(t, fx.pool, "one-live-owner")
	ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
	svc := newPairService(fx, map[int64]bool{owner: true}, false, nil)

	_, err := svc.CreateSession(context.Background(), owner, fx.repoID, ws)
	require.NoError(t, err)
	_, err = svc.CreateSession(context.Background(), owner, fx.repoID, ws)
	require.Error(t, err)
	assert.Equal(t, 409, httpStatus(err))
}

// TestResolveSession_AclLadder exercises the full fail-closed ladder.
func TestResolveSession_AclLadder(t *testing.T) {
	fx := newPairFixture(t)
	owner := mkPairUser(t, fx.pool, "acl-owner")
	ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
	invited := mkPairUser(t, fx.pool, "acl-invited")
	uninvited := mkPairUser(t, fx.pool, "acl-uninvited")
	unpaidInvited := mkPairUser(t, fx.pool, "acl-unpaid")

	paid := map[int64]bool{owner: true, invited: true, uninvited: true}
	svc := newPairService(fx, paid, false, nil)
	session, err := svc.CreateSession(context.Background(), owner, fx.repoID, ws)
	require.NoError(t, err)

	// Owner resolves as owner.
	res, err := svc.ResolveSession(context.Background(), session.ID, owner)
	require.NoError(t, err)
	assert.Equal(t, PairRoleOwner, res.Role)

	// Unknown id -> 404.
	_, err = svc.ResolveSession(context.Background(), "does-not-exist", owner)
	assert.Equal(t, 404, httpStatus(err))

	// Uninvited signed-in (paid) -> 403 (restricted, no invite).
	_, err = svc.ResolveSession(context.Background(), session.ID, uninvited)
	assert.Equal(t, 403, httpStatus(err))

	// Invite the invited user as editor, then resolve -> materialize member.
	_, err = svc.CreateInvite(context.Background(), session.ID, owner, pairUserEmail(t, fx.pool, invited), PairRoleEditor)
	require.NoError(t, err)
	res, err = svc.ResolveSession(context.Background(), session.ID, invited)
	require.NoError(t, err)
	assert.Equal(t, PairRoleEditor, res.Role)
	assert.True(t, res.Materialized)
	// Second resolve finds the existing member (grandfathered, still allowed).
	res, err = svc.ResolveSession(context.Background(), session.ID, invited)
	require.NoError(t, err)
	assert.Equal(t, PairRoleEditor, res.Role)
	assert.False(t, res.Materialized)

	// Unpaid visitor is denied on EVERY allow path — even with a matching invite.
	_, err = svc.CreateInvite(context.Background(), session.ID, owner, pairUserEmail(t, fx.pool, unpaidInvited), PairRoleEditor)
	require.NoError(t, err)
	_, err = svc.ResolveSession(context.Background(), session.ID, unpaidInvited)
	assert.Equal(t, 403, httpStatus(err), "unpaid must be denied even with an invite")

	// Revoke the invited member -> next resolve 403s (live revocation).
	require.NoError(t, svc.RevokeMember(context.Background(), session.ID, owner, invited))
	_, err = svc.ResolveSession(context.Background(), session.ID, invited)
	assert.Equal(t, 403, httpStatus(err), "revoked member degrades honestly")
}

// TestResolveByLink covers amendment A: link-mode auto-join at the link's role,
// paid-gated, with revocation and no-demote semantics.
func TestResolveByLink(t *testing.T) {
	fx := newPairFixture(t)
	owner := mkPairUser(t, fx.pool, "link-owner")
	ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
	visitor := mkPairUser(t, fx.pool, "link-visitor")
	unpaid := mkPairUser(t, fx.pool, "link-unpaid")

	svc := newPairService(fx, map[int64]bool{owner: true, visitor: true}, false, nil)
	session, err := svc.CreateSession(context.Background(), owner, fx.repoID, ws)
	require.NoError(t, err)

	link, err := svc.MintLink(context.Background(), session.ID, owner, PairRoleViewer)
	require.NoError(t, err)

	// Paid visitor auto-joins at viewer (link default).
	res, err := svc.ResolveByLink(context.Background(), link.Slug, visitor)
	require.NoError(t, err)
	assert.Equal(t, PairRoleViewer, res.Role)
	assert.True(t, res.Materialized)

	// Unpaid visitor is denied via link too (no unpaid drive-by members).
	_, err = svc.ResolveByLink(context.Background(), link.Slug, unpaid)
	assert.Equal(t, 403, httpStatus(err))

	// Revoked link -> 404.
	require.NoError(t, svc.RevokeLink(context.Background(), session.ID, owner, link.ID))
	_, err = svc.ResolveByLink(context.Background(), link.Slug, visitor)
	assert.Equal(t, 404, httpStatus(err))
}

// TestRevokedMemberCannotRejoinViaLiveLink proves RevokeMember sticks even in
// 'link' access mode: the removed member re-opening the SAME still-live link is
// refused (the member upsert never resurrects a removed row), keeps no member
// row and no workspace share, and readmission requires an owner-granted invite.
func TestRevokedMemberCannotRejoinViaLiveLink(t *testing.T) {
	ctx := context.Background()
	fx := newPairFixture(t)
	owner := mkPairUser(t, fx.pool, "rvk-owner")
	ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
	intruder := mkPairUser(t, fx.pool, "rvk-intruder")

	svc := newPairService(fx, map[int64]bool{owner: true, intruder: true}, false, nil)
	session, err := svc.CreateSession(ctx, owner, fx.repoID, ws)
	require.NoError(t, err)
	forkID := UUIDString(session.WorkspaceID)

	link, err := svc.MintLink(ctx, session.ID, owner, PairRoleEditor)
	require.NoError(t, err)

	res, err := svc.ResolveByLink(ctx, link.Slug, intruder)
	require.NoError(t, err)
	require.True(t, res.Materialized)

	require.NoError(t, svc.RevokeMember(ctx, session.ID, owner, intruder))

	// The same live link must NOT readmit the revoked member.
	_, err = svc.ResolveByLink(ctx, link.Slug, intruder)
	assert.Equal(t, 403, httpStatus(err), "revoked member must not auto-rejoin via the still-live link")

	_, err = fx.store.GetLivePairSessionMember(ctx, db.GetLivePairSessionMemberParams{SessionID: session.ID, UserID: intruder})
	assert.ErrorIs(t, err, pgx.ErrNoRows, "member row must stay removed")
	var shares int
	require.NoError(t, fx.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM workspace_shares WHERE workspace_id=$1::uuid AND grantee_user_id=$2`, forkID, intruder).Scan(&shares))
	assert.Zero(t, shares, "revoked member must not regain a workspace share")

	// An owner-granted invite is the deliberate readmission path.
	_, err = svc.CreateInvite(ctx, session.ID, owner, pairUserEmail(t, fx.pool, intruder), PairRoleViewer)
	require.NoError(t, err)
	res, err = svc.ResolveSession(ctx, session.ID, intruder)
	require.NoError(t, err)
	assert.Equal(t, PairRoleViewer, res.Role, "owner re-invite readmits the removed member")
}

// TestResolveByLink_RestrictedModeFailsClosed proves ResolveByLink enforces the
// session access mode independently of link-row liveness: a link row that
// survived a SetAccessMode(restricted)/MintLink interleaving (simulated by
// flipping the mode without revoking links) admits nobody.
func TestResolveByLink_RestrictedModeFailsClosed(t *testing.T) {
	ctx := context.Background()
	fx := newPairFixture(t)
	owner := mkPairUser(t, fx.pool, "amode-owner")
	ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
	visitor := mkPairUser(t, fx.pool, "amode-visitor")

	svc := newPairService(fx, map[int64]bool{owner: true, visitor: true}, false, nil)
	session, err := svc.CreateSession(ctx, owner, fx.repoID, ws)
	require.NoError(t, err)
	link, err := svc.MintLink(ctx, session.ID, owner, PairRoleEditor)
	require.NoError(t, err)

	// Simulate the non-transactional race outcome: access_mode=restricted with
	// the link row still live (SetAccessMode normally revokes links first).
	_, err = fx.pool.Exec(ctx, `UPDATE pair_sessions SET access_mode='restricted' WHERE id=$1`, session.ID)
	require.NoError(t, err)

	_, err = svc.ResolveByLink(ctx, link.Slug, visitor)
	assert.Equal(t, 404, httpStatus(err), "a live link row must admit nobody while the session is restricted")
	_, err = fx.store.GetLivePairSessionMember(ctx, db.GetLivePairSessionMemberParams{SessionID: session.ID, UserID: visitor})
	assert.ErrorIs(t, err, pgx.ErrNoRows, "no member row may be materialized in restricted mode")
}

// TestPairSessionMutationLockSerializesRoleAndRevoke controls the exact #341
// interleaving: SetMemberRole has updated the member but has not repaired the
// share yet when RevokeMember starts. The revoke callback must remain outside
// the critical section until the role operation commits, after which revoke
// wins cleanly and leaves neither membership nor a workspace share.
func TestPairSessionMutationLockSerializesRoleAndRevoke(t *testing.T) {
	ctx := context.Background()
	fx := newPairFixture(t)
	owner := mkPairUser(t, fx.pool, "role-revoke-owner")
	member := mkPairUser(t, fx.pool, "role-revoke-member")
	ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
	billing := &stubBilling{paid: map[int64]bool{owner: true, member: true}}
	forker := &stubForker{pool: fx.pool, repoID: fx.repoID}

	base := NewPairSessionService(fx.store, billing, forker, PairSessionServiceConfig{TxBeginner: fx.pool})
	session, err := base.CreateSession(ctx, owner, fx.repoID, ws)
	require.NoError(t, err)
	link, err := base.MintLink(ctx, session.ID, owner, PairRoleEditor)
	require.NoError(t, err)
	_, err = base.ResolveByLink(ctx, link.Slug, member)
	require.NoError(t, err)

	roleUpdated := make(chan struct{})
	releaseRole := make(chan struct{})
	released := false
	defer func() {
		if !released {
			close(releaseRole)
		}
	}()
	revokeEntered := make(chan struct{})
	roleStore := &pairMutationBarrierStore{
		PairSessionStore: fx.store,
		roleUpdated:      roleUpdated,
		releaseRole:      releaseRole,
	}
	revokeStore := &pairMutationBarrierStore{
		PairSessionStore: fx.store,
		revokeEntered:    revokeEntered,
	}
	roleSvc := NewPairSessionService(roleStore, billing, forker, PairSessionServiceConfig{TxBeginner: fx.pool})
	revokeSvc := NewPairSessionService(revokeStore, billing, forker, PairSessionServiceConfig{TxBeginner: fx.pool})

	roleDone := make(chan error, 1)
	go func() {
		_, roleErr := roleSvc.SetMemberRole(ctx, session.ID, owner, member, PairRoleViewer)
		roleDone <- roleErr
	}()
	select {
	case <-roleUpdated:
	case roleErr := <-roleDone:
		require.NoError(t, roleErr)
		t.Fatal("role mutation completed before reaching the barrier")
	case <-time.After(5 * time.Second):
		t.Fatal("role mutation did not reach the barrier")
	}

	revokeStarted := make(chan struct{})
	revokeDone := make(chan error, 1)
	go func() {
		close(revokeStarted)
		revokeDone <- revokeSvc.RevokeMember(ctx, session.ID, owner, member)
	}()
	<-revokeStarted
	enteredBeforeRelease := false
	select {
	case <-revokeEntered:
		enteredBeforeRelease = true
	case <-time.After(150 * time.Millisecond):
	}

	close(releaseRole)
	released = true
	require.NoError(t, <-roleDone)
	require.NoError(t, <-revokeDone)
	assert.False(t, enteredBeforeRelease, "revoke callback entered while the role mutation held the session lock")

	_, err = fx.store.GetLivePairSessionMember(ctx, db.GetLivePairSessionMemberParams{SessionID: session.ID, UserID: member})
	assert.ErrorIs(t, err, pgx.ErrNoRows)
	var shares int
	require.NoError(t, fx.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM workspace_shares WHERE workspace_id=$1::uuid AND grantee_user_id=$2`,
		UUIDString(session.WorkspaceID), member).Scan(&shares))
	assert.Zero(t, shares, "revoke must be the complete final state")
}

// TestPairSessionMutationLockSerializesRestrictedAndMint controls the #340
// interleaving after SetAccessMode has revoked links but before it writes
// restricted. MintLink must not create a replacement link inside that window;
// it runs afterward as one transaction, leaving link mode plus a live link.
func TestPairSessionMutationLockSerializesRestrictedAndMint(t *testing.T) {
	ctx := context.Background()
	fx := newPairFixture(t)
	owner := mkPairUser(t, fx.pool, "mode-mint-owner")
	ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
	billing := &stubBilling{paid: map[int64]bool{owner: true}}
	forker := &stubForker{pool: fx.pool, repoID: fx.repoID}

	base := NewPairSessionService(fx.store, billing, forker, PairSessionServiceConfig{TxBeginner: fx.pool})
	session, err := base.CreateSession(ctx, owner, fx.repoID, ws)
	require.NoError(t, err)
	_, err = base.MintLink(ctx, session.ID, owner, PairRoleViewer)
	require.NoError(t, err)

	modeUpdateReady := make(chan struct{})
	releaseModeUpdate := make(chan struct{})
	released := false
	defer func() {
		if !released {
			close(releaseModeUpdate)
		}
	}()
	linkCreateEntered := make(chan struct{})
	modeStore := &pairMutationBarrierStore{
		PairSessionStore:  fx.store,
		modeUpdateReady:   modeUpdateReady,
		releaseModeUpdate: releaseModeUpdate,
	}
	mintStore := &pairMutationBarrierStore{
		PairSessionStore:  fx.store,
		linkCreateEntered: linkCreateEntered,
	}
	modeSvc := NewPairSessionService(modeStore, billing, forker, PairSessionServiceConfig{TxBeginner: fx.pool})
	mintSvc := NewPairSessionService(mintStore, billing, forker, PairSessionServiceConfig{TxBeginner: fx.pool})

	modeDone := make(chan error, 1)
	go func() {
		_, modeErr := modeSvc.SetAccessMode(ctx, session.ID, owner, PairAccessRestricted)
		modeDone <- modeErr
	}()
	select {
	case <-modeUpdateReady:
	case modeErr := <-modeDone:
		require.NoError(t, modeErr)
		t.Fatal("mode mutation completed before reaching the barrier")
	case <-time.After(5 * time.Second):
		t.Fatal("mode mutation did not reach the barrier")
	}

	mintStarted := make(chan struct{})
	mintDone := make(chan struct {
		link db.PairSessionLink
		err  error
	}, 1)
	go func() {
		close(mintStarted)
		link, mintErr := mintSvc.MintLink(ctx, session.ID, owner, PairRoleEditor)
		mintDone <- struct {
			link db.PairSessionLink
			err  error
		}{link: link, err: mintErr}
	}()
	<-mintStarted
	createdBeforeRelease := false
	select {
	case <-linkCreateEntered:
		createdBeforeRelease = true
	case <-time.After(150 * time.Millisecond):
	}

	close(releaseModeUpdate)
	released = true
	require.NoError(t, <-modeDone)
	minted := <-mintDone
	require.NoError(t, minted.err)
	assert.False(t, createdBeforeRelease, "link mint entered while the restricted transition held the session lock")

	fresh, err := fx.store.GetPairSession(ctx, session.ID)
	require.NoError(t, err)
	assert.Equal(t, PairAccessLink, fresh.AccessMode)
	live, err := fx.store.GetLivePairSessionLinkBySlug(ctx, minted.link.Slug)
	require.NoError(t, err)
	assert.Equal(t, session.ID, live.SessionID)
}

// TestUnverifiedPrimaryEmailCannotClaimInvite proves the invite ACL ignores an
// unverified primary email: an attacker who self-attaches the invitee's address
// (AddEmail stores it unverified) cannot satisfy the invite, while a verified
// primary still can.
func TestUnverifiedPrimaryEmailCannotClaimInvite(t *testing.T) {
	ctx := context.Background()
	fx := newPairFixture(t)
	owner := mkPairUser(t, fx.pool, "uve-owner")
	ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
	attacker := mkPairUser(t, fx.pool, "uve-attacker")

	svc := newPairService(fx, map[int64]bool{owner: true, attacker: true}, false, nil)
	session, err := svc.CreateSession(ctx, owner, fx.repoID, ws)
	require.NoError(t, err)

	const target = "uve-victim@example.com"
	_, err = svc.CreateInvite(ctx, session.ID, owner, target, PairRoleEditor)
	require.NoError(t, err)

	// Attacker swaps their primary to the invitee's address WITHOUT verifying it
	// (exactly what the email API's AddEmail allows).
	_, err = fx.pool.Exec(ctx, `UPDATE email_addresses SET is_primary=FALSE WHERE user_id=$1`, attacker)
	require.NoError(t, err)
	_, err = fx.pool.Exec(ctx,
		`INSERT INTO email_addresses (user_id, email, lower_email, is_activated, is_primary) VALUES ($1,$2,$2,FALSE,TRUE)`,
		attacker, target)
	require.NoError(t, err)

	_, err = svc.ResolveSession(ctx, session.ID, attacker)
	assert.Equal(t, 403, httpStatus(err), "an unverified primary email must not satisfy an invite")
	_, err = fx.store.GetLivePairSessionMember(ctx, db.GetLivePairSessionMemberParams{SessionID: session.ID, UserID: attacker})
	assert.ErrorIs(t, err, pgx.ErrNoRows, "no member row may be materialized")

	// Once the address is verified (the real invitee), the invite matches.
	_, err = fx.pool.Exec(ctx, `UPDATE email_addresses SET is_activated=TRUE WHERE user_id=$1 AND lower_email=$2`, attacker, target)
	require.NoError(t, err)
	res, err := svc.ResolveSession(ctx, session.ID, attacker)
	require.NoError(t, err)
	assert.Equal(t, PairRoleEditor, res.Role)
}

// TestPairSessionPreviewsDoNotMaterializeAccess proves the GET-facing service
// methods are read-only. They may report the role an invite or link would grant,
// but only the explicit Resolve* join methods may consume an invite, create a
// member, or grant a workspace share.
func TestPairSessionPreviewsDoNotMaterializeAccess(t *testing.T) {
	ctx := context.Background()
	fx := newPairFixture(t)
	owner := mkPairUser(t, fx.pool, "preview-owner")
	invitee := mkPairUser(t, fx.pool, "preview-invitee")
	linkVisitor := mkPairUser(t, fx.pool, "preview-link-visitor")
	ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)

	svc := newPairService(fx, map[int64]bool{owner: true, invitee: true, linkVisitor: true}, false, nil)
	session, err := svc.CreateSession(ctx, owner, fx.repoID, ws)
	require.NoError(t, err)
	forkID := UUIDString(session.WorkspaceID)

	inviteeEmail := pairUserEmail(t, fx.pool, invitee)
	_, err = svc.CreateInvite(ctx, session.ID, owner, inviteeEmail, PairRoleEditor)
	require.NoError(t, err)

	assertNoMaterializedAccess := func(userID int64) {
		t.Helper()
		_, memberErr := fx.store.GetLivePairSessionMember(ctx, db.GetLivePairSessionMemberParams{
			SessionID: session.ID,
			UserID:    userID,
		})
		assert.ErrorIs(t, memberErr, pgx.ErrNoRows, "preview must not create a member")

		var shares int
		require.NoError(t, fx.pool.QueryRow(ctx,
			`SELECT COUNT(*) FROM workspace_shares WHERE workspace_id=$1::uuid AND grantee_user_id=$2`,
			forkID, userID).Scan(&shares))
		assert.Zero(t, shares, "preview must not grant a workspace share")
	}

	preview, err := svc.PreviewSession(ctx, session.ID, invitee)
	require.NoError(t, err)
	assert.Equal(t, PairRoleEditor, preview.Role)
	assert.False(t, preview.Materialized)
	assertNoMaterializedAccess(invitee)

	preview, err = svc.PreviewForSource(ctx, ws, invitee)
	require.NoError(t, err)
	assert.Equal(t, PairRoleEditor, preview.Role)
	assert.False(t, preview.Materialized)
	assertNoMaterializedAccess(invitee)
	_, err = fx.store.GetLivePairSessionInviteForEmail(ctx, db.GetLivePairSessionInviteForEmailParams{
		SessionID:  session.ID,
		LowerEmail: inviteeEmail,
	})
	require.NoError(t, err, "preview must not consume the invite")

	link, err := svc.MintLink(ctx, session.ID, owner, PairRoleViewer)
	require.NoError(t, err)
	preview, err = svc.PreviewByLink(ctx, link.Slug, linkVisitor)
	require.NoError(t, err)
	assert.Equal(t, PairRoleViewer, preview.Role)
	assert.False(t, preview.Materialized)
	assertNoMaterializedAccess(linkVisitor)
}

// TestWorkspaceShareGrantedOnJoinAndRevoked proves the workspace_shares write
// path: a member materialized via invite/link gets a workspace_shares row on the
// session's forked workspace (so they pass requireWorkspaceAccess on the
// workspace-scoped surface), its level tracks their role, revoking the member
// drops the share, and ending the session clears all shares. Without this a
// joined member would 403 on every workspace route despite holding pair_* shapes.
func TestWorkspaceShareGrantedOnJoinAndRevoked(t *testing.T) {
	fx := newPairFixture(t)
	owner := mkPairUser(t, fx.pool, "wss-owner")
	ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
	editor := mkPairUser(t, fx.pool, "wss-editor")
	viewer := mkPairUser(t, fx.pool, "wss-viewer")

	svc := newPairService(fx, map[int64]bool{owner: true, editor: true, viewer: true}, false, nil)
	session, err := svc.CreateSession(context.Background(), owner, fx.repoID, ws)
	require.NoError(t, err)
	forkID := UUIDString(session.WorkspaceID)
	require.NotEmpty(t, forkID, "fork workspace must be bound")

	shareLevel := func(grantee int64) (string, bool) {
		var level string
		err := fx.pool.QueryRow(context.Background(),
			`SELECT level FROM workspace_shares WHERE workspace_id=$1::uuid AND grantee_user_id=$2`, forkID, grantee).Scan(&level)
		if errors.Is(err, pgx.ErrNoRows) {
			return "", false
		}
		require.NoError(t, err)
		return level, true
	}

	// Owner needs no share — they own the fork.
	_, ownerHasShare := shareLevel(owner)
	assert.False(t, ownerHasShare, "owner owns the fork; no share row needed")

	// Editor joins via an edit link -> write-level share.
	editLink, err := svc.MintLink(context.Background(), session.ID, owner, PairRoleEditor)
	require.NoError(t, err)
	_, err = svc.ResolveByLink(context.Background(), editLink.Slug, editor)
	require.NoError(t, err)
	lvl, ok := shareLevel(editor)
	require.True(t, ok, "editor member must have a workspace share")
	assert.Equal(t, "write", lvl)

	// Viewer joins via invite -> read-level share.
	_, err = svc.CreateInvite(context.Background(), session.ID, owner, pairUserEmail(t, fx.pool, viewer), PairRoleViewer)
	require.NoError(t, err)
	_, err = svc.ResolveSession(context.Background(), session.ID, viewer)
	require.NoError(t, err)
	lvl, ok = shareLevel(viewer)
	require.True(t, ok, "viewer member must have a workspace share")
	assert.Equal(t, "read", lvl)

	// Demoting the editor to viewer downgrades the share to read.
	_, err = svc.SetMemberRole(context.Background(), session.ID, owner, editor, PairRoleViewer)
	require.NoError(t, err)
	lvl, _ = shareLevel(editor)
	assert.Equal(t, "read", lvl, "share level tracks the role")

	// Revoking the viewer drops their share (live de-authorization).
	require.NoError(t, svc.RevokeMember(context.Background(), session.ID, owner, viewer))
	_, ok = shareLevel(viewer)
	assert.False(t, ok, "revoked member loses their workspace share")

	// Ending the session clears every remaining share.
	require.NoError(t, svc.EndSession(context.Background(), session.ID, owner))
	_, ok = shareLevel(editor)
	assert.False(t, ok, "ending the session clears all workspace shares")
}

// TestEnqueue_ConcurrentMonotonicSeq proves the serial-FIFO seq assignment is
// race-free under concurrent multi-user submission (the core decision-#3
// scenario): N concurrent enqueues all succeed with strictly unique, contiguous
// seqs — none is rejected with a UNIQUE(session_id, seq) 500.
func TestEnqueue_ConcurrentMonotonicSeq(t *testing.T) {
	fx := newPairFixture(t)
	owner := mkPairUser(t, fx.pool, "seq-owner")
	ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
	svc := newPairService(fx, map[int64]bool{owner: true}, false, nil)
	session, err := svc.CreateSession(context.Background(), owner, fx.repoID, ws)
	require.NoError(t, err)

	const n = 12
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		go func(i int) {
			_, err := svc.Enqueue(context.Background(), session.ID, owner, pairPromptSourceSolo, fmt.Sprintf("prompt-%d", i))
			errs <- err
		}(i)
	}
	for i := 0; i < n; i++ {
		require.NoError(t, <-errs, "concurrent enqueue must not collide on seq")
	}

	rows, err := svc.ListQueue(context.Background(), session.ID, owner)
	require.NoError(t, err)
	require.Len(t, rows, n)
	seen := map[int64]bool{}
	for _, row := range rows {
		assert.False(t, seen[row.Seq], "seq %d assigned twice", row.Seq)
		seen[row.Seq] = true
	}
	for i := int64(1); i <= n; i++ {
		assert.True(t, seen[i], "seq %d missing — not contiguous", i)
	}
}

// TestInviteAccept_InsertsAlphaWhitelistBeforeSignup proves the growth loop:
// creating an invite whitelists the email immediately (before the invitee has
// an account).
func TestInviteAccept_InsertsAlphaWhitelistBeforeSignup(t *testing.T) {
	fx := newPairFixture(t)
	owner := mkPairUser(t, fx.pool, "wl-owner")
	ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
	svc := newPairService(fx, map[int64]bool{owner: true}, false, nil)
	session, err := svc.CreateSession(context.Background(), owner, fx.repoID, ws)
	require.NoError(t, err)

	brandNew := "brand-new-invitee@example.com"
	_, err = svc.CreateInvite(context.Background(), session.ID, owner, brandNew, PairRoleViewer)
	require.NoError(t, err)

	var count int
	require.NoError(t, fx.pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM alpha_whitelist_entries WHERE identity_type='email' AND lower_identity_value=$1`, brandNew).Scan(&count))
	assert.Equal(t, 1, count, "invited email must be whitelisted before signup")
}

// TestInvite_UnavailableTransportDoesNotSend: without a configured provider,
// including when the disabled provider is wrapped, the invite is recorded and
// honestly reports delivery unavailable without calling Send.
func TestInvite_UnavailableTransportDoesNotSend(t *testing.T) {
	fx := newPairFixture(t)
	owner := mkPairUser(t, fx.pool, "notx-owner")
	ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)

	unavailable := &unavailableCountingTransport{}
	wrappedUnavailable := email.NewRateLimitedTransport(unavailable, email.RateLimitConfig{
		MaxPerSecond:           10,
		MaxPerRecipientPerHour: 20,
	})
	for i, tr := range []email.Transport{nil, wrappedUnavailable} {
		svc := newPairService(fx, map[int64]bool{owner: true}, false, tr)
		session, err := svc.CreateSession(context.Background(), owner, fx.repoID, ws)
		if err != nil {
			// second iteration: reuse the live session (one-live-per-source)
			live, gerr := fx.store.GetLivePairSessionForSource(context.Background(), ws)
			require.NoError(t, gerr)
			session = live
		}
		invitee := fmt.Sprintf("someone-%d@example.com", i)
		res, err := svc.CreateInvite(context.Background(), session.ID, owner, invitee, PairRoleViewer)
		require.NoError(t, err)
		assert.False(t, res.Delivered)
		assert.Equal(t, "email delivery unavailable", res.DeliveryDetail)
	}
	assert.Zero(t, unavailable.sends.Load(), "unavailable delivery must not call Send")
}

// TestQueue_ViewerForbiddenEditorAllowed proves role enforcement on the queue:
// viewers 403 on enqueue/cancel; editors enqueue with attributed, monotonic seq;
// authors cancel their own, the owner cancels any.
func TestQueue_ViewerForbiddenEditorAllowed(t *testing.T) {
	fx := newPairFixture(t)
	owner := mkPairUser(t, fx.pool, "q-owner")
	ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
	editor := mkPairUser(t, fx.pool, "q-editor")
	viewer := mkPairUser(t, fx.pool, "q-viewer")

	svc := newPairService(fx, map[int64]bool{owner: true, editor: true, viewer: true}, false, nil)
	session, err := svc.CreateSession(context.Background(), owner, fx.repoID, ws)
	require.NoError(t, err)

	// Add members directly with roles.
	_, err = fx.store.UpsertPairSessionMember(context.Background(), db.UpsertPairSessionMemberParams{SessionID: session.ID, UserID: editor, Role: PairRoleEditor})
	require.NoError(t, err)
	_, err = fx.store.UpsertPairSessionMember(context.Background(), db.UpsertPairSessionMemberParams{SessionID: session.ID, UserID: viewer, Role: PairRoleViewer})
	require.NoError(t, err)

	// Viewer cannot enqueue.
	_, err = svc.Enqueue(context.Background(), session.ID, viewer, pairPromptSourceSolo, "hi")
	assert.Equal(t, 403, httpStatus(err))

	// Editor enqueues; seq is monotonic and attributed.
	p1, err := svc.Enqueue(context.Background(), session.ID, editor, pairPromptSourceSolo, "first")
	require.NoError(t, err)
	assert.Equal(t, int64(1), p1.Seq)
	assert.Equal(t, editor, p1.AuthorUserID)
	p2, err := svc.Enqueue(context.Background(), session.ID, owner, pairPromptSourceSolo, "second")
	require.NoError(t, err)
	assert.Equal(t, int64(2), p2.Seq)

	// A different editor/viewer cannot cancel someone else's prompt.
	_, err = svc.Cancel(context.Background(), session.ID, viewer, p1.ID)
	assert.Equal(t, 403, httpStatus(err), "viewers cannot cancel")

	// Author cancels their own queued prompt.
	canceled, err := svc.Cancel(context.Background(), session.ID, editor, p1.ID)
	require.NoError(t, err)
	assert.Equal(t, "canceled", canceled.Status)

	// Owner cancels ANY queued prompt (p2 authored by owner here; verify owner
	// can cancel an editor-authored one too).
	p3, err := svc.Enqueue(context.Background(), session.ID, editor, pairPromptSourceSolo, "third")
	require.NoError(t, err)
	ownerCancel, err := svc.Cancel(context.Background(), session.ID, owner, p3.ID)
	require.NoError(t, err)
	assert.Equal(t, "canceled", ownerCancel.Status)
}

// TestDraft_VersionGatedAndEditorOnly proves editor-only, version-gated draft
// writes and together-submit.
func TestDraft_VersionGatedAndEditorOnly(t *testing.T) {
	fx := newPairFixture(t)
	owner := mkPairUser(t, fx.pool, "d-owner")
	ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
	viewer := mkPairUser(t, fx.pool, "d-viewer")

	svc := newPairService(fx, map[int64]bool{owner: true, viewer: true}, false, nil)
	session, err := svc.CreateSession(context.Background(), owner, fx.repoID, ws)
	require.NoError(t, err)
	_, err = fx.store.UpsertPairSessionMember(context.Background(), db.UpsertPairSessionMemberParams{SessionID: session.ID, UserID: viewer, Role: PairRoleViewer})
	require.NoError(t, err)

	// Viewer cannot write the draft.
	_, err = svc.PutDraft(context.Background(), session.ID, viewer, "nope", 1)
	assert.Equal(t, 403, httpStatus(err))

	// Owner writes v1, a stale v1 is rejected, v2 applies.
	_, err = svc.PutDraft(context.Background(), session.ID, owner, "v1", 1)
	require.NoError(t, err)
	_, err = svc.PutDraft(context.Background(), session.ID, owner, "stale", 1)
	assert.Equal(t, 409, httpStatus(err))
	_, err = svc.PutDraft(context.Background(), session.ID, owner, "v2", 2)
	require.NoError(t, err)

	// Submitting enqueues ONE 'together' prompt and clears the draft.
	prompt, err := svc.SubmitDraft(context.Background(), session.ID, owner)
	require.NoError(t, err)
	assert.Equal(t, pairPromptSourceTogether, prompt.Source)
	assert.Equal(t, "v2", prompt.Body)
	draft, err := svc.GetDraft(context.Background(), session.ID, owner)
	require.NoError(t, err)
	assert.Equal(t, "", draft.Content)
}

// TestInviteByUsername_KnownUser proves a username invite for an existing plue
// account NEVER touches that account's stored email (privacy: the API must not
// resolve a GitHub username into someone's private address, and the response
// must be indistinguishable from an unknown username's — no account-existence
// oracle), whitelists the username, and admits the invitee through
// ResolveSession by username match at the invited role.
func TestInviteByUsername_KnownUser(t *testing.T) {
	fx := newPairFixture(t)
	owner := mkPairUser(t, fx.pool, "ubn-owner")
	ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
	invitee := mkPairUser(t, fx.pool, "ubn-invitee")
	var inviteeUsername string
	require.NoError(t, fx.pool.QueryRow(context.Background(),
		`SELECT username FROM users WHERE id=$1`, invitee).Scan(&inviteeUsername))

	svc := newPairService(fx, map[int64]bool{owner: true, invitee: true}, false, nil)
	session, err := svc.CreateSession(context.Background(), owner, fx.repoID, ws)
	require.NoError(t, err)

	// "@name" and mixed case must normalize to the login.
	res, err := svc.CreateInviteByUsername(context.Background(), session.ID, owner, "@"+strings.ToUpper(inviteeUsername), PairRoleEditor)
	require.NoError(t, err)
	assert.True(t, res.Invite.LowerGithubUsername.Valid)
	assert.Equal(t, strings.ToLower(inviteeUsername), res.Invite.LowerGithubUsername.String)
	assert.False(t, res.Invite.LowerEmail.Valid, "a username invite must NEVER carry the account's private email")
	assert.False(t, res.Delivered)
	assert.Equal(t, "share the link so they can join", res.DeliveryDetail,
		"known-username response must be byte-identical to the unknown-username one (no existence oracle)")

	var count int
	require.NoError(t, fx.pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM alpha_whitelist_entries WHERE identity_type='username' AND lower_identity_value=$1`,
		strings.ToLower(inviteeUsername)).Scan(&count))
	assert.Equal(t, 1, count, "invited username must be whitelisted")

	join, err := svc.ResolveSession(context.Background(), session.ID, invitee)
	require.NoError(t, err)
	assert.Equal(t, PairRoleEditor, join.Role)
	assert.True(t, join.Materialized, "resolve must materialize the invited member")
}

// TestInviteByUsername_UnknownUser proves a username with no plue account yet is
// honestly reported as link-delivered (nothing is emailed), whitelisted for the
// alpha gate, and matches by username when that GitHub login later signs in
// with a DIFFERENT email than anything on the invite.
func TestInviteByUsername_UnknownUser(t *testing.T) {
	fx := newPairFixture(t)
	owner := mkPairUser(t, fx.pool, "ubu-owner")
	ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
	svc := newPairService(fx, map[int64]bool{owner: true}, false, nil)
	session, err := svc.CreateSession(context.Background(), owner, fx.repoID, ws)
	require.NoError(t, err)

	ghLogin := fmt.Sprintf("gh-late-%d", pairUserSeq.Add(1))
	res, err := svc.CreateInviteByUsername(context.Background(), session.ID, owner, ghLogin, PairRoleViewer)
	require.NoError(t, err)
	assert.False(t, res.Delivered)
	assert.Contains(t, res.DeliveryDetail, "share the link")
	assert.False(t, res.Invite.LowerEmail.Valid, "unknown username has no email to attach")
	assert.NotEmpty(t, res.Token, "raw token must be returned for a copyable link")

	var count int
	require.NoError(t, fx.pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM alpha_whitelist_entries WHERE identity_type='username' AND lower_identity_value=$1`,
		ghLogin).Scan(&count))
	assert.Equal(t, 1, count)

	// The login signs up later with an unrelated email.
	em := ghLogin + "-other@example.com"
	var lateUser int64
	require.NoError(t, fx.pool.QueryRow(context.Background(),
		`INSERT INTO users (username, lower_username, email, lower_email, display_name) VALUES ($1,$1,$2,$2,$1) RETURNING id`,
		ghLogin, em).Scan(&lateUser))
	_, err = fx.pool.Exec(context.Background(),
		`INSERT INTO email_addresses (user_id, email, lower_email, is_activated, is_primary) VALUES ($1,$2,$2,TRUE,TRUE)`,
		lateUser, em)
	require.NoError(t, err)

	// Unpaid → billing gate fires only AFTER the invite matched (honest upsell).
	_, err = svc.ResolveSession(context.Background(), session.ID, lateUser)
	require.Error(t, err)
	assert.Equal(t, 403, httpStatus(err))
	assert.Contains(t, err.Error(), "paid plan", "an invited-but-unpaid visitor must see the billing gate, not no-access")

	svcPaid := newPairService(fx, map[int64]bool{owner: true, lateUser: true}, false, nil)
	join, err := svcPaid.ResolveSession(context.Background(), session.ID, lateUser)
	require.NoError(t, err)
	assert.Equal(t, PairRoleViewer, join.Role)
	assert.True(t, join.Materialized)
}

// TestInviteByUsername_RejectsInvalid proves GitHub-login syntax enforcement.
func TestInviteByUsername_RejectsInvalid(t *testing.T) {
	fx := newPairFixture(t)
	owner := mkPairUser(t, fx.pool, "ubv-owner")
	ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
	svc := newPairService(fx, map[int64]bool{owner: true}, false, nil)
	session, err := svc.CreateSession(context.Background(), owner, fx.repoID, ws)
	require.NoError(t, err)

	for _, bad := range []string{"", "-lead", "trail-", "dou--ble", "has space", "way-too-long-name-way-too-long-name-way-x", "em@il"} {
		_, err := svc.CreateInviteByUsername(context.Background(), session.ID, owner, bad, PairRoleViewer)
		require.Error(t, err, "username %q must be rejected", bad)
		assert.Equal(t, 400, httpStatus(err), "username %q", bad)
	}
	_, err = svc.CreateInviteByUsername(context.Background(), session.ID, owner, "octocat", "owner")
	require.Error(t, err)
	assert.Equal(t, 400, httpStatus(err), "role must be viewer or editor")
}

// TestRevokeInviteByUsername proves a live username invite can be revoked and no
// longer admits the login.
func TestRevokeInviteByUsername(t *testing.T) {
	fx := newPairFixture(t)
	owner := mkPairUser(t, fx.pool, "ubr-owner")
	ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
	invitee := mkPairUser(t, fx.pool, "ubr-invitee")
	var inviteeUsername string
	require.NoError(t, fx.pool.QueryRow(context.Background(),
		`SELECT lower_username FROM users WHERE id=$1`, invitee).Scan(&inviteeUsername))

	svc := newPairService(fx, map[int64]bool{owner: true, invitee: true}, false, nil)
	session, err := svc.CreateSession(context.Background(), owner, fx.repoID, ws)
	require.NoError(t, err)

	_, err = svc.CreateInviteByUsername(context.Background(), session.ID, owner, inviteeUsername, PairRoleEditor)
	require.NoError(t, err)
	require.NoError(t, svc.RevokeInviteByUsername(context.Background(), session.ID, owner, inviteeUsername))

	_, err = svc.ResolveSession(context.Background(), session.ID, invitee)
	require.Error(t, err)
	assert.Equal(t, 403, httpStatus(err), "revoked invite must not admit")
}

// TestPreviewForSource_NoExistenceOracle proves the share-modal lookup returns
// the SAME NotFound for an unrelated visitor as for a workspace with no live
// session — a 403 here would let anyone holding a workspace id (e.g. a revoked
// ex-member) poll whether the owner is pairing again. Owners and invitees still
// preview normally, and an invitee then joins via the explicit join path.
func TestPreviewForSource_NoExistenceOracle(t *testing.T) {
	fx := newPairFixture(t)
	owner := mkPairUser(t, fx.pool, "rfs-owner")
	ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
	stranger := mkPairUser(t, fx.pool, "rfs-stranger")
	svc := newPairService(fx, map[int64]bool{owner: true, stranger: true}, false, nil)

	// Baseline: no live session for the workspace.
	_, err := svc.PreviewForSource(context.Background(), ws, stranger)
	require.Error(t, err)
	noSession, isAPI := err.(*pkgerrors.APIError)
	if !isAPI {
		var apiErr *pkgerrors.APIError
		require.True(t, errors.As(err, &apiErr))
		noSession = apiErr
	}
	require.Equal(t, 404, noSession.Status)

	session, err := svc.CreateSession(context.Background(), owner, fx.repoID, ws)
	require.NoError(t, err)

	// Unrelated visitor with a LIVE session: byte-identical status + message.
	_, err = svc.PreviewForSource(context.Background(), ws, stranger)
	require.Error(t, err)
	var withSession *pkgerrors.APIError
	require.True(t, errors.As(err, &withSession))
	assert.Equal(t, noSession.Status, withSession.Status)
	assert.Equal(t, noSession.Message, withSession.Message)

	// The owner still previews.
	res, err := svc.PreviewForSource(context.Background(), ws, owner)
	require.NoError(t, err)
	assert.Equal(t, PairRoleOwner, res.Role)
	assert.Equal(t, session.ID, res.Session.ID)

	// An invitee (by username) previews their invite role through the same
	// lookup — without joining — and then joins via the explicit join path.
	var strangerUsername string
	require.NoError(t, fx.pool.QueryRow(context.Background(),
		`SELECT lower_username FROM users WHERE id=$1`, stranger).Scan(&strangerUsername))
	_, err = svc.CreateInviteByUsername(context.Background(), session.ID, owner, strangerUsername, PairRoleViewer)
	require.NoError(t, err)
	preview, err := svc.PreviewForSource(context.Background(), ws, stranger)
	require.NoError(t, err)
	assert.Equal(t, PairRoleViewer, preview.Role)
	assert.False(t, preview.Materialized, "source preview must not materialize membership")
	join, err := svc.ResolveSession(context.Background(), session.ID, stranger)
	require.NoError(t, err)
	assert.Equal(t, PairRoleViewer, join.Role)
	assert.True(t, join.Materialized)
}

// TestInviteByUsername_VisitorWithNoEmail proves the join ladder tolerates a
// visitor with NO email_addresses row: findLiveInviteForVisitor must fall
// through to the username rung instead of erroring, so a GitHub login whose
// account has no primary email still joins via a username invite.
func TestInviteByUsername_VisitorWithNoEmail(t *testing.T) {
	fx := newPairFixture(t)
	owner := mkPairUser(t, fx.pool, "noem-owner")
	ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)

	// A user row WITHOUT any email_addresses row (mkPairUser would add one).
	n := pairUserSeq.Add(1)
	uname := fmt.Sprintf("noem-invitee-%d", n)
	var invitee int64
	require.NoError(t, fx.pool.QueryRow(context.Background(),
		`INSERT INTO users (username, lower_username, email, lower_email, display_name) VALUES ($1,$1,$2,$2,$1) RETURNING id`,
		uname, uname+"@unverified.example").Scan(&invitee))

	svc := newPairService(fx, map[int64]bool{owner: true, invitee: true}, false, nil)
	session, err := svc.CreateSession(context.Background(), owner, fx.repoID, ws)
	require.NoError(t, err)

	_, err = svc.CreateInviteByUsername(context.Background(), session.ID, owner, uname, PairRoleEditor)
	require.NoError(t, err)

	join, err := svc.ResolveSession(context.Background(), session.ID, invitee)
	require.NoError(t, err)
	assert.Equal(t, PairRoleEditor, join.Role)
	assert.True(t, join.Materialized, "no-email visitor must still join by username match")
}

// TestQueue_CrossSessionConfusedDeputy pins the WS1 review's blocking finding:
// the service role-checks the actor against the URL's session, so every queue
// mutation must ALSO be session-scoped in its WHERE clause. Prompt ids and
// executor client ids are visible to every member of a session via the
// pair_prompt_queue shape, and any paid user is owner of their own session —
// so without the scope, a stranger to session B could cancel B's prompts or
// poison a claimed prompt's run_id (the never-re-dispatch marker) through
// their own session A's role check.
func TestQueue_CrossSessionConfusedDeputy(t *testing.T) {
	fx := newPairFixture(t)
	victim := mkPairUser(t, fx.pool, "cd-victim")
	attacker := mkPairUser(t, fx.pool, "cd-attacker")
	wsVictim := mkPairWorkspace(t, fx.pool, victim, fx.repoID)
	wsAttacker := mkPairWorkspace(t, fx.pool, attacker, fx.repoID)

	svc := newPairService(fx, map[int64]bool{victim: true, attacker: true}, false, nil)
	sessionB, err := svc.CreateSession(context.Background(), victim, fx.repoID, wsVictim)
	require.NoError(t, err)
	sessionA, err := svc.CreateSession(context.Background(), attacker, fx.repoID, wsAttacker)
	require.NoError(t, err)

	// Victim enqueues into B. The attacker is NOT a member of B — only owner
	// of their own unrelated session A.
	prompt, err := svc.Enqueue(context.Background(), sessionB.ID, victim, pairPromptSourceSolo, "victim work")
	require.NoError(t, err)

	// Cross-session owner-cancel must not reach B's row.
	_, err = svc.Cancel(context.Background(), sessionA.ID, attacker, prompt.ID)
	assert.Equal(t, 409, httpStatus(err), "cross-session cancel must be rejected")
	fresh, err := fx.store.GetPairPrompt(context.Background(), prompt.ID)
	require.NoError(t, err)
	assert.Equal(t, "queued", fresh.Status, "victim's prompt must be untouched")

	// Legitimate claim inside B (executor election).
	_, err = svc.Claim(context.Background(), sessionB.ID, victim, prompt.ID, "victim-client", time.Minute)
	require.NoError(t, err)

	// Cross-session start with the shape-visible clientId must not poison run_id.
	_, err = svc.Start(context.Background(), sessionA.ID, attacker, prompt.ID, "victim-client", "attacker-run")
	assert.Equal(t, 409, httpStatus(err), "cross-session start must be rejected")
	fresh, err = fx.store.GetPairPrompt(context.Background(), prompt.ID)
	require.NoError(t, err)
	assert.Equal(t, "claimed", fresh.Status)
	assert.False(t, fresh.RunID.Valid, "run_id must never be attacker-writable")

	// Cross-session renew is equally fenced.
	_, err = svc.Renew(context.Background(), sessionA.ID, attacker, prompt.ID, "victim-client", time.Minute)
	assert.Equal(t, 409, httpStatus(err), "cross-session renew must be rejected")

	// The real executor proceeds in B; a cross-session finish cannot settle it.
	started, err := svc.Start(context.Background(), sessionB.ID, victim, prompt.ID, "victim-client", "real-run")
	require.NoError(t, err)
	assert.Equal(t, "running", started.Status)
	_, err = svc.Finish(context.Background(), sessionA.ID, attacker, prompt.ID, "victim-client", "canceled")
	assert.Equal(t, 409, httpStatus(err), "cross-session finish must be rejected")

	// The executor lifecycle inside the right session still works end-to-end.
	_, err = svc.Renew(context.Background(), sessionB.ID, victim, prompt.ID, "victim-client", time.Minute)
	require.NoError(t, err)
	finished, err := svc.Finish(context.Background(), sessionB.ID, victim, prompt.ID, "victim-client", "done")
	require.NoError(t, err)
	assert.Equal(t, "done", finished.Status)
}

// TestQueue_FinishValidatesStatusAndExecutor: finish accepts only terminal
// statuses and only from the client holding the running row.
func TestQueue_FinishValidatesStatusAndExecutor(t *testing.T) {
	fx := newPairFixture(t)
	owner := mkPairUser(t, fx.pool, "fin-owner")
	ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)

	svc := newPairService(fx, map[int64]bool{owner: true}, false, nil)
	session, err := svc.CreateSession(context.Background(), owner, fx.repoID, ws)
	require.NoError(t, err)
	prompt, err := svc.Enqueue(context.Background(), session.ID, owner, pairPromptSourceSolo, "work")
	require.NoError(t, err)
	_, err = svc.Claim(context.Background(), session.ID, owner, prompt.ID, "exec-1", time.Minute)
	require.NoError(t, err)

	// Not running yet → finish rejected.
	_, err = svc.Finish(context.Background(), session.ID, owner, prompt.ID, "exec-1", "done")
	assert.Equal(t, 409, httpStatus(err), "claimed-but-not-started rows cannot finish")

	_, err = svc.Start(context.Background(), session.ID, owner, prompt.ID, "exec-1", "run-1")
	require.NoError(t, err)

	// Invalid status → 400; wrong client → 409.
	_, err = svc.Finish(context.Background(), session.ID, owner, prompt.ID, "exec-1", "queued")
	assert.Equal(t, 400, httpStatus(err))
	_, err = svc.Finish(context.Background(), session.ID, owner, prompt.ID, "other-client", "done")
	assert.Equal(t, 409, httpStatus(err))

	finished, err := svc.Finish(context.Background(), session.ID, owner, prompt.ID, "exec-1", "failed")
	require.NoError(t, err)
	assert.Equal(t, "failed", finished.Status)
	assert.True(t, finished.FinishedAt.Valid)
}

// CreateSession must verify source-workspace ownership BEFORE inserting a
// session row, so a client-supplied foreign/missing workspace id is rejected
// with a uniform NotFound and never forks or touches the store (no oracle, no
// slot pollution). Runs without a DB: the ownership gate short-circuits ahead
// of the store.
func TestCreateSession_RejectsForeignSourceWorkspaceBeforeInsert(t *testing.T) {
	t.Parallel()

	forker := &stubForker{verifyErr: pkgerrors.NotFound("source workspace not found")}
	svc := NewPairSessionService(nil, &stubBilling{paid: map[int64]bool{1: true}}, forker, PairSessionServiceConfig{})

	_, err := svc.CreateSession(context.Background(), 1, 10, "ws-belongs-to-someone-else")
	require.Error(t, err)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 404, apiErr.Status, "foreign/missing source workspace must be a uniform NotFound")
	assert.Equal(t, int32(0), forker.calls.Load(), "must not fork when the source workspace is not owned")
}

// TestQueue_ClaimEnforcesFIFO proves the serial FIFO contract on executor
// election: only the earliest 'queued' prompt is claimable — naming a later
// prompt id cannot jump the queue (issue #347).
func TestQueue_ClaimEnforcesFIFO(t *testing.T) {
	ctx := context.Background()
	fx := newPairFixture(t)
	owner := mkPairUser(t, fx.pool, "fifo-owner")
	ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
	svc := newPairService(fx, map[int64]bool{owner: true}, false, nil)
	session, err := svc.CreateSession(ctx, owner, fx.repoID, ws)
	require.NoError(t, err)

	p1, err := svc.Enqueue(ctx, session.ID, owner, pairPromptSourceSolo, "first")
	require.NoError(t, err)
	p2, err := svc.Enqueue(ctx, session.ID, owner, pairPromptSourceSolo, "second")
	require.NoError(t, err)

	// Claiming the later prompt while an earlier one is queued must be rejected.
	_, err = svc.Claim(ctx, session.ID, owner, p2.ID, "exec-1", time.Minute)
	assert.Equal(t, 409, httpStatus(err), "claiming a later prompt must not bypass FIFO")
	fresh, err := fx.store.GetPairPrompt(ctx, p2.ID)
	require.NoError(t, err)
	assert.Equal(t, "queued", fresh.Status, "rejected claim must not mutate the row")

	// The earliest queued prompt claims fine; running it through to done frees
	// the active slot and makes p2 the new FIFO head.
	_, err = svc.Claim(ctx, session.ID, owner, p1.ID, "exec-1", time.Minute)
	require.NoError(t, err)
	_, err = svc.Start(ctx, session.ID, owner, p1.ID, "exec-1", "run-1")
	require.NoError(t, err)
	_, err = svc.Finish(ctx, session.ID, owner, p1.ID, "exec-1", "done")
	require.NoError(t, err)

	claimed, err := svc.Claim(ctx, session.ID, owner, p2.ID, "exec-1", time.Minute)
	require.NoError(t, err, "after the earlier prompt settles, the next one is claimable")
	assert.Equal(t, "claimed", claimed.Status)
}

// TestQueue_ReplayedExecutorKeyRejected proves finalize/renew authorization is
// bound to the authenticated claimer, not the publicly-readable
// executor_client_id: a co-editor replaying the victim's client id — raw or as
// stored on the row — can neither settle nor extend the victim's running
// prompt (issue #215).
func TestQueue_ReplayedExecutorKeyRejected(t *testing.T) {
	ctx := context.Background()
	fx := newPairFixture(t)
	owner := mkPairUser(t, fx.pool, "replay-owner")
	ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
	editor := mkPairUser(t, fx.pool, "replay-editor")

	svc := newPairService(fx, map[int64]bool{owner: true, editor: true}, false, nil)
	session, err := svc.CreateSession(ctx, owner, fx.repoID, ws)
	require.NoError(t, err)
	_, err = fx.store.UpsertPairSessionMember(ctx, db.UpsertPairSessionMemberParams{SessionID: session.ID, UserID: editor, Role: PairRoleEditor})
	require.NoError(t, err)

	prompt, err := svc.Enqueue(ctx, session.ID, editor, pairPromptSourceSolo, "victim work")
	require.NoError(t, err)
	_, err = svc.Claim(ctx, session.ID, editor, prompt.ID, "a1", time.Minute)
	require.NoError(t, err)
	started, err := svc.Start(ctx, session.ID, editor, prompt.ID, "a1", "run-1")
	require.NoError(t, err)
	require.True(t, started.ExecutorClientID.Valid)

	// The owner (a co-editor-rank member, different authenticated user) replays
	// both the raw client id and the stored key every member can read.
	for _, replay := range []string{"a1", started.ExecutorClientID.String} {
		_, err = svc.Finish(ctx, session.ID, owner, prompt.ID, replay, "canceled")
		assert.Equal(t, 409, httpStatus(err), "replayed finish (%q) must be rejected", replay)
		_, err = svc.Renew(ctx, session.ID, owner, prompt.ID, replay, time.Minute)
		assert.Equal(t, 409, httpStatus(err), "replayed renew (%q) must be rejected", replay)
	}
	fresh, err := fx.store.GetPairPrompt(ctx, prompt.ID)
	require.NoError(t, err)
	assert.Equal(t, "running", fresh.Status, "victim's running prompt must be untouched")

	// The real executor (same user + client) still renews and finishes.
	_, err = svc.Renew(ctx, session.ID, editor, prompt.ID, "a1", time.Minute)
	require.NoError(t, err)
	finished, err := svc.Finish(ctx, session.ID, editor, prompt.ID, "a1", "done")
	require.NoError(t, err)
	assert.Equal(t, "done", finished.Status)
}

// TestQueue_EnqueueCapacityCaps proves the per-session queue caps (issue #226):
// pending prompts stop at pairQueueMaxPending (enqueue AND draft-submit paths)
// and a session whose lifetime rows reached pairQueueMaxTotal refuses new
// prompts even with nothing pending.
func TestQueue_EnqueueCapacityCaps(t *testing.T) {
	ctx := context.Background()
	fx := newPairFixture(t)
	owner := mkPairUser(t, fx.pool, "cap-owner")
	ws := mkPairWorkspace(t, fx.pool, owner, fx.repoID)
	svc := newPairService(fx, map[int64]bool{owner: true}, false, nil)
	session, err := svc.CreateSession(ctx, owner, fx.repoID, ws)
	require.NoError(t, err)

	// Bulk-seed just below the pending cap, then prove the boundary behavior.
	_, err = fx.pool.Exec(ctx,
		`INSERT INTO pair_prompt_queue (session_id, seq, author_user_id, source, body)
		 SELECT $1, g, $2, 'solo', 'seed' FROM generate_series(1, $3::bigint) g`,
		session.ID, owner, pairQueueMaxPending-1)
	require.NoError(t, err)

	_, err = svc.Enqueue(ctx, session.ID, owner, pairPromptSourceSolo, "last one in")
	require.NoError(t, err, "enqueue below the pending cap must succeed")
	_, err = svc.Enqueue(ctx, session.ID, owner, pairPromptSourceSolo, "overflow")
	assert.Equal(t, 429, httpStatus(err), "enqueue at the pending cap must be rejected")

	// The co-compose submit path is capped by the same guard.
	_, err = svc.PutDraft(ctx, session.ID, owner, "overflow draft", 1)
	require.NoError(t, err)
	_, err = svc.SubmitDraft(ctx, session.ID, owner)
	assert.Equal(t, 429, httpStatus(err), "draft submit at the pending cap must be rejected")

	// Lifetime cap: a fresh session with pairQueueMaxTotal SETTLED rows (zero
	// pending) still refuses new prompts — total rows bound the queue listing.
	// uq_workspaces_active reserves one live workspace per repository, user,
	// kind, bookmark and name, so the second session's workspace is named.
	var ws2 string
	require.NoError(t, fx.pool.QueryRow(ctx,
		`INSERT INTO workspaces (repository_id, user_id, name) VALUES ($1,$2,'lifetime-cap') RETURNING id`,
		fx.repoID, owner).Scan(&ws2))
	session2, err := svc.CreateSession(ctx, owner, fx.repoID, ws2)
	require.NoError(t, err)
	_, err = fx.pool.Exec(ctx,
		`INSERT INTO pair_prompt_queue (session_id, seq, author_user_id, source, body, status, finished_at)
		 SELECT $1, g, $2, 'solo', 'settled', 'done', NOW() FROM generate_series(1, $3::bigint) g`,
		session2.ID, owner, pairQueueMaxTotal)
	require.NoError(t, err)
	_, err = svc.Enqueue(ctx, session2.ID, owner, pairPromptSourceSolo, "beyond lifetime")
	assert.Equal(t, 429, httpStatus(err), "enqueue past the lifetime cap must be rejected")
}

func (*stubBilling) AuthorizeSandboxStart(context.Context, int64) error { return nil }
func (*stubBilling) SandboxEntitlement(context.Context, int64) (SandboxEntitlement, error) {
	return SandboxEntitlement{}, nil
}

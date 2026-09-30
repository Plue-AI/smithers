package services

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"log/slog"
	"math/big"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/email"
	"github.com/smithersai/smithers/packages/backend/internal/pairauth"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

// Pair session roles (decision #8). Exactly one owner (the creator); editors may
// prompt and co-compose; viewers see everything live but cannot mutate.
const (
	PairRoleViewer = "viewer"
	PairRoleEditor = "editor"
	PairRoleOwner  = "owner"
)

// Access modes (decision #7 + amendment A). 'restricted' = invited-only, no live
// links; 'link' = one or more anyone-with-link slugs are live.
const (
	PairAccessRestricted = "restricted"
	PairAccessLink       = "link"
)

const (
	pairPromptSourceSolo     = "solo"
	pairPromptSourceTogether = "together"

	pairInviteTTL          = 14 * 24 * time.Hour
	pairProvisionTTL       = 10 * time.Minute
	pairForkCleanupTimeout = 30 * time.Second
)

// pairRandInt is the crypto/rand source used by mintPairSessionID. It is a
// package variable purely so tests can force the (otherwise unreachable)
// rand-failure branch; production always uses crypto/rand.
var pairRandInt = rand.Int

// pairRoleRank orders roles so requireRole can compare a member's grant against
// a minimum. Unknown roles rank 0 and satisfy nothing.
func pairRoleRank(role string) int {
	switch role {
	case PairRoleViewer:
		return 1
	case PairRoleEditor:
		return 2
	case PairRoleOwner:
		return 3
	default:
		return 0
	}
}

// PairBillingPolicy gates a user on the paid-plan requirement (decision #1).
// Satisfied by *BillingService.AuthorizePairing.
type PairBillingPolicy interface {
	AuthorizePairing(ctx context.Context, userID int64) error
}

// PairForker forks + resume/provision the owner's workspace for a session
// (decision #2). Satisfied by *WorkspaceService.ForkWorkspace.
type PairForker interface {
	ForkWorkspace(ctx context.Context, input ForkWorkspaceInput) (WorkspaceResponse, error)
	VerifyPairSourceWorkspace(ctx context.Context, workspaceID string, repositoryID, userID int64) error
}

type pairForkCleaner interface {
	DestroyWorkspace(ctx context.Context, workspaceID string) error
}

type pairInviteAccepter interface {
	AcceptPairSessionInvite(ctx context.Context, arg db.AcceptPairSessionInviteParams) (db.PairSessionMember, error)
	GetPairSessionInvite(ctx context.Context, arg db.GetPairSessionInviteParams) (db.PairSessionInvite, error)
}

type pairSessionEnder interface {
	EndPairSessionForOwner(ctx context.Context, arg db.EndPairSessionForOwnerParams) (db.EndPairSessionForOwnerRow, error)
}

// PairEmailQuerier resolves a signed-in visitor's primary email for the ACL
// ladder and is the store surface the service needs. Satisfied by *db.Queries.
type PairSessionStore interface {
	CreatePairSession(ctx context.Context, arg db.CreatePairSessionParams) (db.PairSession, error)
	GetPairSession(ctx context.Context, id string) (db.PairSession, error)
	GetLivePairSessionForSource(ctx context.Context, sourceWorkspaceID string) (db.PairSession, error)
	SetPairSessionForkBound(ctx context.Context, arg db.SetPairSessionForkBoundParams) (db.PairSession, error)
	SetPairSessionStatus(ctx context.Context, arg db.SetPairSessionStatusParams) (db.PairSession, error)
	SetPairSessionAccessMode(ctx context.Context, arg db.SetPairSessionAccessModeParams) (db.PairSession, error)
	FailStalePairSessions(ctx context.Context, cutoff time.Time) ([]db.PairSession, error)

	UpsertPairSessionMember(ctx context.Context, arg db.UpsertPairSessionMemberParams) (db.PairSessionMember, error)
	GetLivePairSessionMember(ctx context.Context, arg db.GetLivePairSessionMemberParams) (db.PairSessionMember, error)
	ListLivePairSessionMembers(ctx context.Context, sessionID string) ([]db.PairSessionMember, error)
	ListLivePairSessionMemberProfiles(ctx context.Context, sessionID string) ([]db.ListLivePairSessionMemberProfilesRow, error)
	SetPairSessionMemberRole(ctx context.Context, arg db.SetPairSessionMemberRoleParams) (db.PairSessionMember, error)
	RevokePairSessionMember(ctx context.Context, arg db.RevokePairSessionMemberParams) (db.PairSessionMember, error)
	UpdatePairSessionMemberPresence(ctx context.Context, arg db.UpdatePairSessionMemberPresenceParams) (db.PairSessionMember, error)

	EnqueuePairPrompt(ctx context.Context, arg db.EnqueuePairPromptParams) (db.PairPromptQueue, error)
	ListPairPromptQueue(ctx context.Context, sessionID string) ([]db.PairPromptQueue, error)
	GetPairPrompt(ctx context.Context, id string) (db.PairPromptQueue, error)
	ClaimPairPrompt(ctx context.Context, arg db.ClaimPairPromptParams) (db.PairPromptQueue, error)
	StartPairPrompt(ctx context.Context, arg db.StartPairPromptParams) (db.PairPromptQueue, error)
	RenewPairPromptLease(ctx context.Context, arg db.RenewPairPromptLeaseParams) (db.PairPromptQueue, error)
	FinishPairPrompt(ctx context.Context, arg db.FinishPairPromptParams) (db.PairPromptQueue, error)
	CancelOwnQueuedPairPrompt(ctx context.Context, arg db.CancelOwnQueuedPairPromptParams) (db.PairPromptQueue, error)
	CancelAnyPendingPairPrompt(ctx context.Context, arg db.CancelAnyPendingPairPromptParams) (db.PairPromptQueue, error)
	SweepStalePairPromptClaims(ctx context.Context) ([]db.PairPromptQueue, error)
	FailStaleRunningPairPrompts(ctx context.Context, graceSecs int32) ([]db.PairPromptQueue, error)

	CreatePairSessionInvite(ctx context.Context, arg db.CreatePairSessionInviteParams) (db.PairSessionInvite, error)
	GetLivePairSessionInviteForEmail(ctx context.Context, arg db.GetLivePairSessionInviteForEmailParams) (db.PairSessionInvite, error)
	GetLivePairSessionInviteForUsername(ctx context.Context, arg db.GetLivePairSessionInviteForUsernameParams) (db.PairSessionInvite, error)
	ListPairSessionInvites(ctx context.Context, sessionID string) ([]db.PairSessionInvite, error)
	MarkPairSessionInviteAccepted(ctx context.Context, arg db.MarkPairSessionInviteAcceptedParams) (db.PairSessionInvite, error)
	RevokePairSessionInvite(ctx context.Context, arg db.RevokePairSessionInviteParams) (db.PairSessionInvite, error)
	RevokePairSessionInviteByUsername(ctx context.Context, arg db.RevokePairSessionInviteByUsernameParams) (db.PairSessionInvite, error)

	CreatePairSessionLink(ctx context.Context, arg db.CreatePairSessionLinkParams) (db.PairSessionLink, error)
	GetLivePairSessionLinkBySlug(ctx context.Context, slug string) (db.PairSessionLink, error)
	ListLivePairSessionLinks(ctx context.Context, sessionID string) ([]db.PairSessionLink, error)
	RevokePairSessionLink(ctx context.Context, arg db.RevokePairSessionLinkParams) (db.PairSessionLink, error)
	RevokeLivePairSessionLinksForRole(ctx context.Context, arg db.RevokeLivePairSessionLinksForRoleParams) error

	UpsertPairSessionDraft(ctx context.Context, arg db.UpsertPairSessionDraftParams) (db.PairSessionDraft, error)
	GetPairSessionDraft(ctx context.Context, sessionID string) (db.PairSessionDraft, error)
	ClearPairSessionDraft(ctx context.Context, arg db.ClearPairSessionDraftParams) (db.PairSessionDraft, error)

	UpsertAlphaWhitelistEmail(ctx context.Context, arg db.UpsertAlphaWhitelistEmailParams) (db.AlphaWhitelistEntry, error)
	UpsertAlphaWhitelistUsername(ctx context.Context, arg db.UpsertAlphaWhitelistUsernameParams) (db.AlphaWhitelistEntry, error)
	GetPrimaryEmail(ctx context.Context, userID int64) (db.EmailAddress, error)
	GetUserByID(ctx context.Context, id int64) (db.User, error)

	// Workspace-share write path: members must hold a workspace_shares row on the
	// session's forked workspace so they pass requireWorkspaceAccess on the
	// workspace-scoped routes/shapes (terminal, files, runs). Without this a
	// joined member could subscribe to the pair_* shapes but 403 on everything
	// else — a session usable only for queue metadata.
	UpsertWorkspaceShare(ctx context.Context, arg db.UpsertWorkspaceShareParams) (db.WorkspaceShare, error)
	DeleteWorkspaceShare(ctx context.Context, arg db.DeleteWorkspaceShareParams) error
	DeleteWorkspaceSharesForWorkspace(ctx context.Context, workspaceID string) error
}

// pairShareLevelForRole maps a pair-session role to a workspace_shares level.
// Viewers get read-only workspace access (they can open the terminal/files/runs
// but not mutate the sandbox); editors and owners get write.
func pairShareLevelForRole(role string) string {
	if role == PairRoleEditor || role == PairRoleOwner {
		return "write"
	}
	return "read"
}

// PairSessionService is the server-authoritative Smithers Pair backend: session
// mint + fork-and-swap, the ACL ladder, roles, invites (+ alpha-bypass growth
// loop), per-link slugs, the serial FIFO prompt queue with executor election,
// and the co-compose draft. Identity is the real signed-in user everywhere.
type PairSessionService struct {
	revocations revocation.Publisher
	store       PairSessionStore
	billing     PairBillingPolicy
	forker      PairForker
	txBeginner  PairTxBeginner // optional; serializes session mutations and queue seq assignment
	emailFrom   string
	transport   email.Transport // optional; provider availability is delegated through wrappers
	inviteBase  string          // e.g. https://smithers.sh — invite links point at /s/... acceptance
	// staleSweepInterval overrides the StartStaleSweeper tick cadence. Zero means
	// use pairStaleSweepInterval; only tests set it (to a small value) so the
	// sweep loop body is exercisable without waiting a full minute.
	staleSweepInterval time.Duration
}

// PairTxBeginner opens transactions for per-session advisory locks. Those locks
// serialize membership/link state changes and make FIFO seq assignment
// race-free. Satisfied by *pgxpool.Pool. When nil, state changes use the store
// directly and enqueue falls back to a unique-violation retry loop so simple
// store-only test doubles still work.
type PairTxBeginner interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

// PairSessionServiceConfig configures a PairSessionService.
type PairSessionServiceConfig struct {
	EmailFrom     string
	Transport     email.Transport
	InviteBaseURL string
	// TxBeginner enables transaction-scoped session mutation locks and the serial
	// enqueue path. In production this is the pgxpool.Pool; omit it only for
	// store-only tests that use the enqueue retry fallback.
	TxBeginner PairTxBeginner
}

// NewPairSessionService constructs the service. store must be non-nil; billing
// and forker are required for session creation but the read/ACL paths tolerate
// a nil forker.
func NewPairSessionService(store PairSessionStore, billing PairBillingPolicy, forker PairForker, cfg PairSessionServiceConfig) *PairSessionService {
	return &PairSessionService{
		store:      store,
		billing:    billing,
		forker:     forker,
		txBeginner: cfg.TxBeginner,
		emailFrom:  strings.TrimSpace(cfg.EmailFrom),
		transport:  cfg.Transport,
		inviteBase: strings.TrimRight(strings.TrimSpace(cfg.InviteBaseURL), "/"),
	}
}

// withPairSessionMutation serializes state-machine changes for one session
// across API instances. The advisory lock is transaction-scoped, so every
// membership/share and access-mode/link statement in the callback observes a
// single ordered mutation. A direct *db.Queries store is rebound to the lock
// transaction; decorated test stores retain their wrapper while the advisory
// transaction still serializes the callback.
func (s *PairSessionService) withPairSessionMutation(ctx context.Context, sessionID string, fn func(*PairSessionService) error) error {
	if s.txBeginner == nil {
		return fn(s)
	}
	tx, err := s.txBeginner.Begin(ctx)
	if err != nil {
		return pkgerrors.Internal("begin pair session mutation: " + err.Error())
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext($1))", "pair-session:"+sessionID); err != nil {
		return pkgerrors.Internal("lock pair session mutation: " + err.Error())
	}
	txService := *s
	// Production wires *db.Queries directly, so run every callback statement in
	// this transaction as well as under the advisory lock. Decorated stores used
	// by focused tests must stay intact so their injected failures are observed;
	// the lock transaction still serializes those callbacks, but cannot make an
	// arbitrary wrapper transactional without a store-level transaction factory.
	if _, ok := s.store.(*db.Queries); ok {
		txService.store = db.New(tx)
	}
	txService.txBeginner = nil
	// Collect events while the mutation runs. Durable publication is a required
	// transaction step, so neither insert nor NOTIFY failures can be swallowed
	// by the mutation helpers' best-effort publication calls.
	var pendingRevocations pairMutationRevocations
	if s.revocations != nil {
		txService.revocations = &pendingRevocations
	}
	if err := fn(&txService); err != nil {
		return err
	}
	_, databasePublisher := s.revocations.(*revocation.DBPublisher)
	if databasePublisher {
		// PostgreSQL delivers NOTIFY at commit. No local bus is attached because
		// it would announce authorization state that is not committed yet.
		publisher := revocation.NewTransactionalDBPublisher(db.New(tx))
		for _, event := range pendingRevocations.events {
			if err := publisher.Publish(ctx, event); err != nil {
				return pkgerrors.Internal("publish pair session revocation: " + err.Error()).WithCause(err)
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return pkgerrors.Internal("commit pair session mutation: " + err.Error())
	}
	if !databasePublisher && len(pendingRevocations.events) > 0 {
		// A disconnect after commit cannot cancel the committed revocation.
		// Keep custom publishers bounded even after detaching the request.
		publishCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		for _, event := range pendingRevocations.events {
			revocation.PublishBestEffort(publishCtx, s.revocations, event)
		}
	}
	return nil
}

// Collect mutation events for transactional persistence or post-commit fan-out.
// A failed mutation discards them without announcing an authorization change.
type pairMutationRevocations struct {
	events []revocation.Event
}

func (p *pairMutationRevocations) Publish(_ context.Context, event revocation.Event) error {
	p.events = append(p.events, event)
	return nil
}

// PairResolution is the outcome of evaluating a signed-in visitor against a
// session: the session row and the visitor's effective role.
type PairResolution struct {
	Session db.PairSession
	Role    string
	// Materialized is true when this resolve created the member row (invite or
	// link auto-join) rather than finding an existing one.
	Materialized bool
}

// --- Session lifecycle -----------------------------------------------------

// CreateSession gates the owner on the paid plan, mints an unguessable id,
// records the session + owner member row, then FORKS the owner's workspace and
// binds the fork as the session sandbox (decision #2). A fork failure flips the
// session to 'failed' (excluded from the live-per-source index) and returns an
// honest error — never a fake-ready sandbox.
func (s *PairSessionService) CreateSession(ctx context.Context, ownerID, repositoryID int64, sourceWorkspaceID string) (db.PairSession, error) {
	if s.billing == nil || s.forker == nil {
		return db.PairSession{}, pkgerrors.Internal("pair session service is not fully configured")
	}
	if strings.TrimSpace(sourceWorkspaceID) == "" {
		return db.PairSession{}, pkgerrors.BadRequest("source workspace id is required")
	}
	// Gate #1: the owner must be on a paid plan (trialing counts).
	if err := s.billing.AuthorizePairing(ctx, ownerID); err != nil {
		return db.PairSession{}, err
	}

	// Gate #2: the caller must own the source workspace. This MUST run before
	// CreatePairSession — otherwise a client-supplied workspace id could oracle a
	// victim's live-session state (the unique-violation 409) or briefly occupy
	// the victim's live-per-source slot before ForkWorkspace's own ownership
	// check fails. Returns a uniform NotFound for missing/foreign/malformed ids.
	if err := s.forker.VerifyPairSourceWorkspace(ctx, sourceWorkspaceID, repositoryID, ownerID); err != nil {
		return db.PairSession{}, err
	}

	id, err := mintPairSessionID()
	if err != nil {
		return db.PairSession{}, pkgerrors.Internal("mint pair session id: " + err.Error())
	}

	session, err := s.store.CreatePairSession(ctx, db.CreatePairSessionParams{
		ID:                id,
		OwnerUserID:       ownerID,
		SourceWorkspaceID: sourceWorkspaceID,
		AccessMode:        PairAccessRestricted,
	})
	if err != nil {
		if isUniqueViolation(err) {
			return db.PairSession{}, pkgerrors.Conflict("a live pair session already exists for this workspace")
		}
		return db.PairSession{}, pkgerrors.Internal("create pair session: " + err.Error())
	}

	if _, err := s.store.UpsertPairSessionMember(ctx, db.UpsertPairSessionMemberParams{
		SessionID: session.ID,
		UserID:    ownerID,
		Role:      PairRoleOwner,
	}); err != nil {
		_, _ = s.store.SetPairSessionStatus(ctx, db.SetPairSessionStatusParams{ID: session.ID, Status: "failed"})
		return db.PairSession{}, pkgerrors.Internal("record owner membership: " + err.Error())
	}

	fork, err := s.forker.ForkWorkspace(ctx, ForkWorkspaceInput{
		RepositoryID: repositoryID,
		UserID:       ownerID,
		WorkspaceID:  sourceWorkspaceID,
		Name:         "pair-" + session.ID[:8],
	})
	if err != nil {
		_, _ = s.store.SetPairSessionStatus(ctx, db.SetPairSessionStatusParams{ID: session.ID, Status: "failed"})
		return db.PairSession{}, err
	}

	bound, err := s.store.SetPairSessionForkBound(ctx, db.SetPairSessionForkBoundParams{
		ID:          session.ID,
		WorkspaceID: stringToUUID(fork.ID),
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// The status='provisioning' guard did not match: the session was
			// ended/failed concurrently while the fork provisioned. Do NOT
			// resurrect it. Reclaim the already-created fork before returning.
			s.cleanupUnboundPairFork(ctx, session.ID, fork.ID)
			slog.Warn("pair fork bind found no provisioning session; ended concurrently",
				"session_id", session.ID, "fork_workspace_id", fork.ID)
			return db.PairSession{}, pkgerrors.Conflict("pair session was ended before it finished provisioning")
		}
		// Generic bind failure (transient DB error, timeout, ...): the session is
		// flipped 'failed' below, and nothing else ever reclaims the provisioned
		// fork — the workspace zombie/stale sweeps skip forks and VM-holding rows.
		// Reclaim it here, mirroring the ErrNoRows branch.
		s.cleanupUnboundPairFork(ctx, session.ID, fork.ID)
		_, _ = s.store.SetPairSessionStatus(ctx, db.SetPairSessionStatusParams{ID: session.ID, Status: "failed"})
		return db.PairSession{}, pkgerrors.Internal("bind fork to session: " + err.Error())
	}
	return bound, nil
}

func (s *PairSessionService) cleanupUnboundPairFork(ctx context.Context, sessionID, forkWorkspaceID string) {
	cleaner, ok := s.forker.(pairForkCleaner)
	if !ok {
		slog.Warn("pair fork cleanup unavailable", "session_id", sessionID, "fork_workspace_id", forkWorkspaceID)
		return
	}
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), pairForkCleanupTimeout)
	defer cancel()
	if err := cleaner.DestroyWorkspace(cleanupCtx, forkWorkspaceID); err != nil {
		slog.Warn("pair fork cleanup failed", "session_id", sessionID, "fork_workspace_id", forkWorkspaceID, "error", err)
	}
}

// EndSession flips a session terminal (owner only). Freeing the source from the
// live-per-source index.
func (s *PairSessionService) EndSession(ctx context.Context, sessionID string, actorID int64) error {
	return s.withPairSessionMutation(ctx, sessionID, func(locked *PairSessionService) error {
		res, err := locked.requireOwner(ctx, sessionID, actorID)
		if err != nil {
			return err
		}
		ender, ok := locked.store.(pairSessionEnder)
		if !ok {
			return pkgerrors.Internal("pair session ender unavailable")
		}
		if _, err := ender.EndPairSessionForOwner(ctx, db.EndPairSessionForOwnerParams{ID: sessionID, OwnerUserID: res.Session.OwnerUserID}); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return pkgerrors.NotFound("pair session has ended")
			}
			return pkgerrors.Internal("end pair session: " + err.Error())
		}
		return nil
	})
}

// pairStaleSweepInterval is how often the compensation sweeps run.
const pairStaleSweepInterval = time.Minute

// StartStaleSweeper runs the compensation sweeps on an interval until ctx is
// cancelled. Without it, SweepStaleProvisioning/SweepStaleClaims have no caller:
// a session stuck 'provisioning' (crash between CreatePairSession and the status
// flip) permanently occupies the one-live-session-per-source slot and 409s every
// future create for that workspace, and expired 'claimed' prompts never release
// the single-active-prompt queue. Intended to be launched as `go
// svc.StartStaleSweeper(workerCtx)`; it exits when the context is cancelled.
func (s *PairSessionService) StartStaleSweeper(ctx context.Context) {
	interval := s.staleSweepInterval
	if interval <= 0 {
		interval = pairStaleSweepInterval
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			if _, err := s.SweepStaleProvisioning(ctx, now); err != nil {
				slog.Warn("pair session stale-provisioning sweep failed", "error", err)
			}
			if _, err := s.SweepStaleClaims(ctx); err != nil {
				slog.Warn("pair session stale-claims sweep failed", "error", err)
			}
		}
	}
}

// SweepStaleProvisioning is the compensation sweep: sessions stuck in
// 'provisioning' past the TTL are flipped to 'failed' so a wedged fork can never
// lock the owner out of the one-live-session-per-source index.
func (s *PairSessionService) SweepStaleProvisioning(ctx context.Context, now time.Time) (int, error) {
	failed, err := s.store.FailStalePairSessions(ctx, now.Add(-pairProvisionTTL))
	if err != nil {
		return 0, pkgerrors.Internal("sweep stale provisioning sessions: " + err.Error())
	}
	return len(failed), nil
}

// --- ACL ladder ------------------------------------------------------------

// PreviewSession evaluates the visitor's ACL without materializing membership
// or repairing a workspace share. It is the side-effect-free half of the pair
// session resolve flow and is safe to call from GET. A matching invite reports
// the role the visitor may accept; the explicit POST join path calls
// ResolveSession to consume the invite and grant the workspace share.
func (s *PairSessionService) PreviewSession(ctx context.Context, sessionID string, visitorID int64) (PairResolution, error) {
	session, err := s.loadLiveSession(ctx, sessionID)
	if err != nil {
		return PairResolution{}, err
	}
	if session.OwnerUserID == visitorID {
		return PairResolution{Session: session, Role: PairRoleOwner}, nil
	}
	if member, err := s.store.GetLivePairSessionMember(ctx, db.GetLivePairSessionMemberParams{SessionID: sessionID, UserID: visitorID}); err == nil {
		return PairResolution{Session: session, Role: member.Role}, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return PairResolution{}, pkgerrors.Internal("load member: " + err.Error())
	}

	invite, invited, err := s.findLiveInviteForVisitor(ctx, sessionID, visitorID)
	if err != nil {
		return PairResolution{}, err
	}
	if !invited {
		return PairResolution{}, pkgerrors.Forbidden("no access — ask the owner for an invite")
	}
	if err := s.billing.AuthorizePairing(ctx, visitorID); err != nil {
		return PairResolution{}, err
	}
	return PairResolution{Session: session, Role: invite.Role}, nil
}

// PreviewByLink is the side-effect-free GET counterpart to ResolveByLink. It
// validates both the live slug and the session's link-enabled mode, then reports
// the role an explicit POST join would grant without touching members, roles,
// or workspace shares.
func (s *PairSessionService) PreviewByLink(ctx context.Context, slug string, visitorID int64) (PairResolution, error) {
	link, err := s.store.GetLivePairSessionLinkBySlug(ctx, slug)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return PairResolution{}, pkgerrors.NotFound("this link is no longer active")
		}
		return PairResolution{}, pkgerrors.Internal("resolve link: " + err.Error())
	}
	session, err := s.loadLiveSession(ctx, link.SessionID)
	if err != nil {
		return PairResolution{}, err
	}
	if session.AccessMode != PairAccessLink {
		return PairResolution{}, pkgerrors.NotFound("this link is no longer active")
	}
	if session.OwnerUserID == visitorID {
		return PairResolution{Session: session, Role: PairRoleOwner}, nil
	}
	if member, err := s.store.GetLivePairSessionMember(ctx, db.GetLivePairSessionMemberParams{SessionID: session.ID, UserID: visitorID}); err == nil {
		role := member.Role
		if pairRoleRank(link.Role) > pairRoleRank(role) {
			role = link.Role
		}
		return PairResolution{Session: session, Role: role}, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return PairResolution{}, pkgerrors.Internal("load member: " + err.Error())
	}
	if err := s.billing.AuthorizePairing(ctx, visitorID); err != nil {
		return PairResolution{}, err
	}
	return PairResolution{Session: session, Role: link.Role}, nil
}

// PreviewForSource performs the share-modal source lookup — "is there already a
// live session forked from this workspace?" — without accepting an invite.
//
// Existence-oracle fence: an owner/member/invitee previews normally, but a
// visitor with NO relationship to the session gets the SAME NotFound as the
// no-session case (never rung 5's Forbidden). Workspace ids travel further
// than session ids (e.g. a revoked ex-member keeps the source id from old
// session JSON), so a 403-vs-404 split here would let them poll whether the
// owner is pairing again.
func (s *PairSessionService) PreviewForSource(ctx context.Context, sourceWorkspaceID string, visitorID int64) (PairResolution, error) {
	if strings.TrimSpace(sourceWorkspaceID) == "" {
		return PairResolution{}, pkgerrors.BadRequest("source workspace id is required")
	}
	session, err := s.store.GetLivePairSessionForSource(ctx, sourceWorkspaceID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return PairResolution{}, pkgerrors.NotFound("no live pair session for this workspace")
		}
		return PairResolution{}, pkgerrors.Internal("find session for source: " + err.Error())
	}
	if session.OwnerUserID != visitorID {
		if _, err := s.store.GetLivePairSessionMember(ctx, db.GetLivePairSessionMemberParams{SessionID: session.ID, UserID: visitorID}); err != nil {
			if !errors.Is(err, pgx.ErrNoRows) {
				return PairResolution{}, pkgerrors.Internal("load member: " + err.Error())
			}
			_, invited, ferr := s.findLiveInviteForVisitor(ctx, session.ID, visitorID)
			if ferr != nil {
				return PairResolution{}, ferr
			}
			if !invited {
				return PairResolution{}, pkgerrors.NotFound("no live pair session for this workspace")
			}
		}
	}
	return s.PreviewSession(ctx, session.ID, visitorID)
}

// ResolveSession evaluates a signed-in visitor against a session id (decision
// #7). The ladder, fail-closed:
//  1. session missing or terminal        -> NotFound (honest error page)
//  2. owner                              -> allow (owner)
//  3. live member                        -> allow at member.role (grandfathered:
//     amendment B — existing members are NOT re-gated on the paid plan)
//  4. restricted + matching live invite  -> AuthorizePairing, then materialize a
//     member at the invite role, accept the invite, auto-whitelist
//  5. otherwise                          -> Forbidden (no key-entry form)
func (s *PairSessionService) ResolveSession(ctx context.Context, sessionID string, visitorID int64) (PairResolution, error) {
	var result PairResolution
	err := s.withPairSessionMutation(ctx, sessionID, func(locked *PairSessionService) error {
		var err error
		result, err = locked.resolveSession(ctx, sessionID, visitorID)
		return err
	})
	return result, err
}

func (s *PairSessionService) resolveSession(ctx context.Context, sessionID string, visitorID int64) (PairResolution, error) {
	session, err := s.loadLiveSession(ctx, sessionID)
	if err != nil {
		return PairResolution{}, err
	}

	if session.OwnerUserID == visitorID {
		return PairResolution{Session: session, Role: PairRoleOwner}, nil
	}

	if member, err := s.store.GetLivePairSessionMember(ctx, db.GetLivePairSessionMemberParams{SessionID: sessionID, UserID: visitorID}); err == nil {
		// Self-heal: an existing member who joined while the session was still
		// provisioning (fork not yet bound) gets their workspace share here once
		// workspace_id is set.
		if err := s.ensureWorkspaceShare(ctx, session, visitorID, member.Role); err != nil {
			return PairResolution{}, err
		}
		return PairResolution{Session: session, Role: member.Role}, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return PairResolution{}, pkgerrors.Internal("load member: " + err.Error())
	}

	// Not yet a member: this is a JOIN. Check invite existence FIRST so an
	// uninvited visitor gets the honest "no access" page regardless of plan; only
	// an actually-invited visitor is then gated on the paid plan (so an invited
	// but unpaid visitor sees the billing upsell, never a member row).
	invite, invited, err := s.findLiveInviteForVisitor(ctx, sessionID, visitorID)
	if err != nil {
		return PairResolution{}, err
	}
	if !invited {
		return PairResolution{}, pkgerrors.Forbidden("no access — ask the owner for an invite")
	}

	if err := s.billing.AuthorizePairing(ctx, visitorID); err != nil {
		return PairResolution{}, err
	}

	res, err := s.acceptInvite(ctx, session, visitorID, invite)
	if err != nil {
		return PairResolution{}, err
	}
	return res, nil
}

// findLiveInviteForVisitor matches a visitor against a session's live invites:
// by primary email first, then by GitHub username (plue usernames ARE GitHub
// logins). A visitor with no email on file can still match a username invite,
// so a missing email is not an error here.
func (s *PairSessionService) findLiveInviteForVisitor(ctx context.Context, sessionID string, visitorID int64) (db.PairSessionInvite, bool, error) {
	emailRow, err := s.store.GetPrimaryEmail(ctx, visitorID)
	if err == nil {
		// Only a VERIFIED primary email may satisfy an email invite. AddEmail
		// stores any user-supplied address as an unverified primary, so without
		// this gate an attacker could self-attach the invitee's address and
		// claim their invite. OAuth-provisioned primaries are activated, so
		// legitimate invitees are unaffected.
		if !emailRow.IsActivated {
			return s.findLiveUsernameInviteForVisitor(ctx, sessionID, visitorID)
		}
		invite, err := s.store.GetLivePairSessionInviteForEmail(ctx, db.GetLivePairSessionInviteForEmailParams{SessionID: sessionID, LowerEmail: emailRow.LowerEmail})
		if err == nil {
			return invite, true, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return db.PairSessionInvite{}, false, pkgerrors.Internal("resolve invite: " + err.Error())
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return db.PairSessionInvite{}, false, pkgerrors.Internal("load visitor email: " + err.Error())
	}
	return s.findLiveUsernameInviteForVisitor(ctx, sessionID, visitorID)
}

// findLiveUsernameInviteForVisitor is the username half of the invite match:
// plue usernames ARE GitHub logins, so a username invite matches when that
// login is the signed-in visitor.
func (s *PairSessionService) findLiveUsernameInviteForVisitor(ctx context.Context, sessionID string, visitorID int64) (db.PairSessionInvite, bool, error) {
	visitor, err := s.store.GetUserByID(ctx, visitorID)
	if err != nil {
		return db.PairSessionInvite{}, false, pkgerrors.Internal("load visitor: " + err.Error())
	}
	lowerUsername := strings.ToLower(strings.TrimSpace(visitor.Username))
	if lowerUsername == "" {
		return db.PairSessionInvite{}, false, nil
	}
	invite, err := s.store.GetLivePairSessionInviteForUsername(ctx, db.GetLivePairSessionInviteForUsernameParams{SessionID: sessionID, LowerGithubUsername: lowerUsername})
	if err == nil {
		return invite, true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return db.PairSessionInvite{}, false, pkgerrors.Internal("resolve username invite: " + err.Error())
	}
	return db.PairSessionInvite{}, false, nil
}

// ResolveByLink evaluates a signed-in visitor against an anyone-with-link slug
// (amendment A). A live slug grants access at THAT link's role; owner/members
// keep their existing (never demoted) role. Joining still requires the paid gate.
func (s *PairSessionService) ResolveByLink(ctx context.Context, slug string, visitorID int64) (PairResolution, error) {
	link, err := s.store.GetLivePairSessionLinkBySlug(ctx, slug)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return PairResolution{}, pkgerrors.NotFound("this link is no longer active")
		}
		return PairResolution{}, pkgerrors.Internal("resolve link: " + err.Error())
	}
	var result PairResolution
	// Resolve the link under the same session lock as mode/link mutations. This
	// prevents a caller from passing the link-mode check while SetAccessMode is
	// concurrently transitioning the session to restricted.
	err = s.withPairSessionMutation(ctx, link.SessionID, func(locked *PairSessionService) error {
		var err error
		result, err = locked.resolveByLink(ctx, slug, visitorID)
		return err
	})
	return result, err
}

func (s *PairSessionService) resolveByLink(ctx context.Context, slug string, visitorID int64) (PairResolution, error) {
	link, err := s.store.GetLivePairSessionLinkBySlug(ctx, slug)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return PairResolution{}, pkgerrors.NotFound("this link is no longer active")
		}
		return PairResolution{}, pkgerrors.Internal("resolve link: " + err.Error())
	}

	session, err := s.loadLiveSession(ctx, link.SessionID)
	if err != nil {
		return PairResolution{}, err
	}

	// Fail closed on the access mode, independent of link-row liveness. The
	// mutation lock prevents new inconsistent states, while this check also
	// protects against legacy rows or out-of-band repair that leave a live link
	// attached to a restricted session.
	if session.AccessMode != PairAccessLink {
		return PairResolution{}, pkgerrors.NotFound("this link is no longer active")
	}

	if session.OwnerUserID == visitorID {
		return PairResolution{Session: session, Role: PairRoleOwner}, nil
	}
	if member, err := s.store.GetLivePairSessionMember(ctx, db.GetLivePairSessionMemberParams{SessionID: session.ID, UserID: visitorID}); err == nil {
		// Existing member: keep the higher of their role and the link role
		// (a link never demotes an editor to viewer). Persist an elevation so the
		// stored role and workspace-share level track what the visitor is granted.
		role := member.Role
		if pairRoleRank(link.Role) > pairRoleRank(role) {
			role = link.Role
			if _, err := s.store.SetPairSessionMemberRole(ctx, db.SetPairSessionMemberRoleParams{SessionID: session.ID, UserID: visitorID, Role: role}); err != nil {
				return PairResolution{}, pkgerrors.Internal("elevate member role: " + err.Error())
			}
		}
		if err := s.ensureWorkspaceShare(ctx, session, visitorID, role); err != nil {
			return PairResolution{}, err
		}
		return PairResolution{Session: session, Role: role}, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return PairResolution{}, pkgerrors.Internal("load member: " + err.Error())
	}

	// Auto-join via link — still paid-gated (no unpaid drive-by member rows).
	if err := s.billing.AuthorizePairing(ctx, visitorID); err != nil {
		return PairResolution{}, err
	}
	member, err := s.store.UpsertPairSessionMember(ctx, db.UpsertPairSessionMemberParams{
		SessionID: session.ID,
		UserID:    visitorID,
		Role:      link.Role,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// The upsert refuses to resurrect a removed member row: a visitor the
			// owner explicitly revoked cannot readmit themselves through a
			// still-live link. Readmission requires an owner-granted invite
			// (AcceptPairSessionInvite), which is allowed to clear removed_at.
			return PairResolution{}, pkgerrors.Forbidden("you were removed from this session — ask the owner for an invite")
		}
		return PairResolution{}, pkgerrors.Internal("materialize link member: " + err.Error())
	}
	if err := s.ensureWorkspaceShare(ctx, session, visitorID, member.Role); err != nil {
		return PairResolution{}, err
	}
	return PairResolution{Session: session, Role: member.Role, Materialized: true}, nil
}

func (s *PairSessionService) acceptInvite(ctx context.Context, session db.PairSession, visitorID int64, invite db.PairSessionInvite) (PairResolution, error) {
	accepter, ok := s.store.(pairInviteAccepter)
	if !ok {
		return PairResolution{}, pkgerrors.Internal("pair invite accepter unavailable")
	}
	member, err := accepter.AcceptPairSessionInvite(ctx, db.AcceptPairSessionInviteParams{
		ID:               invite.ID,
		SessionID:        session.ID,
		AcceptedByUserID: pgtype.Int8{Int64: visitorID, Valid: true},
		UserID:           visitorID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return s.resolveAcceptedInviteRace(ctx, session, visitorID, invite, accepter)
		}
		return PairResolution{}, pkgerrors.Internal("accept invite: " + err.Error())
	}
	if err := s.ensureWorkspaceShare(ctx, session, visitorID, member.Role); err != nil {
		return PairResolution{}, err
	}
	return PairResolution{Session: session, Role: member.Role, Materialized: true}, nil
}

func (s *PairSessionService) resolveAcceptedInviteRace(ctx context.Context, session db.PairSession, visitorID int64, invite db.PairSessionInvite, accepter pairInviteAccepter) (PairResolution, error) {
	fresh, err := accepter.GetPairSessionInvite(ctx, db.GetPairSessionInviteParams{ID: invite.ID, SessionID: session.ID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return PairResolution{}, pkgerrors.Forbidden("invite is no longer active")
		}
		return PairResolution{}, pkgerrors.Internal("reload invite: " + err.Error())
	}
	if fresh.AcceptedByUserID.Valid && fresh.AcceptedByUserID.Int64 == visitorID {
		member, err := s.store.GetLivePairSessionMember(ctx, db.GetLivePairSessionMemberParams{SessionID: session.ID, UserID: visitorID})
		if err == nil && UUIDString(member.InvitedViaInviteID) == fresh.ID {
			if err := s.ensureWorkspaceShare(ctx, session, visitorID, member.Role); err != nil {
				return PairResolution{}, err
			}
			return PairResolution{Session: session, Role: member.Role}, nil
		}
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return PairResolution{}, pkgerrors.Internal("load accepted member: " + err.Error())
		}
	}
	if fresh.RevokedAt.Valid || time.Now().After(fresh.ExpiresAt) {
		return PairResolution{}, pkgerrors.Forbidden("invite is no longer active")
	}
	return PairResolution{}, pkgerrors.Conflict("invite was already accepted")
}

// --- Membership + roles (owner-only mutations) -----------------------------

func (s *PairSessionService) ListMembers(ctx context.Context, sessionID string, actorID int64) ([]db.PairSessionMember, error) {
	if _, err := s.requireRole(ctx, sessionID, actorID, PairRoleViewer); err != nil {
		return nil, err
	}
	members, err := s.store.ListLivePairSessionMembers(ctx, sessionID)
	if err != nil {
		return nil, pkgerrors.Internal("list members: " + err.Error())
	}
	return members, nil
}

// ListMemberProfiles is ListMembers joined with public identity (username /
// display name / avatar) so presence and attribution render the real user.
func (s *PairSessionService) ListMemberProfiles(ctx context.Context, sessionID string, actorID int64) ([]db.ListLivePairSessionMemberProfilesRow, error) {
	if _, err := s.requireRole(ctx, sessionID, actorID, PairRoleViewer); err != nil {
		return nil, err
	}
	members, err := s.store.ListLivePairSessionMemberProfiles(ctx, sessionID)
	if err != nil {
		return nil, pkgerrors.Internal("list member profiles: " + err.Error())
	}
	return members, nil
}

func (s *PairSessionService) SetMemberRole(ctx context.Context, sessionID string, actorID, targetUserID int64, role string) (db.PairSessionMember, error) {
	var result db.PairSessionMember
	err := s.withPairSessionMutation(ctx, sessionID, func(locked *PairSessionService) error {
		var err error
		result, err = locked.setMemberRole(ctx, sessionID, actorID, targetUserID, role)
		return err
	})
	return result, err
}

func (s *PairSessionService) setMemberRole(ctx context.Context, sessionID string, actorID, targetUserID int64, role string) (db.PairSessionMember, error) {
	res, err := s.requireOwner(ctx, sessionID, actorID)
	if err != nil {
		return db.PairSessionMember{}, err
	}
	if role != PairRoleViewer && role != PairRoleEditor {
		return db.PairSessionMember{}, pkgerrors.BadRequest("role must be viewer or editor")
	}
	if targetUserID == res.Session.OwnerUserID {
		// The owner's member row must stay 'owner' — demoting it leaves the
		// session with no live owner member row (RevokePairSessionMember's
		// role<>'owner' guard then no longer protects it) and misrenders the
		// owner as a viewer in the member list.
		return db.PairSessionMember{}, pkgerrors.BadRequest("the session owner's role cannot be changed")
	}
	previous, err := s.store.GetLivePairSessionMember(ctx, db.GetLivePairSessionMemberParams{SessionID: sessionID, UserID: targetUserID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return db.PairSessionMember{}, pkgerrors.NotFound("member not found")
		}
		return db.PairSessionMember{}, pkgerrors.Internal("load member role: " + err.Error())
	}
	member, err := s.store.SetPairSessionMemberRole(ctx, db.SetPairSessionMemberRoleParams{SessionID: sessionID, UserID: targetUserID, Role: role})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return db.PairSessionMember{}, pkgerrors.NotFound("member not found")
		}
		return db.PairSessionMember{}, pkgerrors.Internal("set member role: " + err.Error())
	}
	// Keep the workspace-share level in lockstep with the role (editor→write,
	// viewer→read) so a demoted editor loses sandbox write access.
	if err := s.ensureWorkspaceShare(ctx, res.Session, targetUserID, member.Role); err != nil {
		return db.PairSessionMember{}, err
	}
	if previous.Role == PairRoleEditor && member.Role == PairRoleViewer && res.Session.WorkspaceID.Valid {
		// Existing desktop and terminal connections were authorized for writing.
		// End them when the member loses that grant; read access remains intact.
		s.publishWorkspaceShareRevocation(ctx, UUIDString(res.Session.WorkspaceID), targetUserID, "workspace write access removed")
	}
	return member, nil
}

func (s *PairSessionService) RevokeMember(ctx context.Context, sessionID string, actorID, targetUserID int64) error {
	return s.withPairSessionMutation(ctx, sessionID, func(locked *PairSessionService) error {
		return locked.revokeMember(ctx, sessionID, actorID, targetUserID)
	})
}

func (s *PairSessionService) revokeMember(ctx context.Context, sessionID string, actorID, targetUserID int64) error {
	res, err := s.requireOwner(ctx, sessionID, actorID)
	if err != nil {
		return err
	}
	if _, err := s.store.RevokePairSessionMember(ctx, db.RevokePairSessionMemberParams{SessionID: sessionID, UserID: targetUserID}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("member not found or is the owner")
		}
		return pkgerrors.Internal("revoke member: " + err.Error())
	}
	// Live revocation: drop the member's workspace share so their next
	// workspace-scoped request 403s.
	if err := s.revokeWorkspaceShare(ctx, res.Session, targetUserID); err != nil {
		return err
	}
	return nil
}

// SetAccessMode flips restricted<->link (owner only). Flipping to restricted
// revokes all live links so the "restricted = no active links" invariant holds.
func (s *PairSessionService) SetAccessMode(ctx context.Context, sessionID string, actorID int64, mode string) (db.PairSession, error) {
	var result db.PairSession
	err := s.withPairSessionMutation(ctx, sessionID, func(locked *PairSessionService) error {
		var err error
		result, err = locked.setAccessMode(ctx, sessionID, actorID, mode)
		return err
	})
	return result, err
}

func (s *PairSessionService) setAccessMode(ctx context.Context, sessionID string, actorID int64, mode string) (db.PairSession, error) {
	if _, err := s.requireOwner(ctx, sessionID, actorID); err != nil {
		return db.PairSession{}, err
	}
	if mode != PairAccessRestricted && mode != PairAccessLink {
		return db.PairSession{}, pkgerrors.BadRequest("access mode must be restricted or link")
	}
	if mode == PairAccessRestricted {
		for _, role := range []string{PairRoleViewer, PairRoleEditor} {
			if err := s.store.RevokeLivePairSessionLinksForRole(ctx, db.RevokeLivePairSessionLinksForRoleParams{SessionID: sessionID, Role: role}); err != nil {
				return db.PairSession{}, pkgerrors.Internal("revoke links: " + err.Error())
			}
		}
	}
	session, err := s.store.SetPairSessionAccessMode(ctx, db.SetPairSessionAccessModeParams{ID: sessionID, AccessMode: mode})
	if err != nil {
		return db.PairSession{}, pkgerrors.Internal("set access mode: " + err.Error())
	}
	return session, nil
}

// --- Per-link slugs (amendment A) ------------------------------------------

// MintLink creates (rotating any existing link of the same role) an
// anyone-with-link slug at the given role. Also flips the session into 'link'
// access mode so the ACL admits link joins.
func (s *PairSessionService) MintLink(ctx context.Context, sessionID string, actorID int64, role string) (db.PairSessionLink, error) {
	var result db.PairSessionLink
	err := s.withPairSessionMutation(ctx, sessionID, func(locked *PairSessionService) error {
		var err error
		result, err = locked.mintLink(ctx, sessionID, actorID, role)
		return err
	})
	return result, err
}

func (s *PairSessionService) mintLink(ctx context.Context, sessionID string, actorID int64, role string) (db.PairSessionLink, error) {
	if _, err := s.requireOwner(ctx, sessionID, actorID); err != nil {
		return db.PairSessionLink{}, err
	}
	if role != PairRoleViewer && role != PairRoleEditor {
		return db.PairSessionLink{}, pkgerrors.BadRequest("link role must be viewer or editor")
	}
	// Rotate: revoke any existing live link of this role first.
	if err := s.store.RevokeLivePairSessionLinksForRole(ctx, db.RevokeLivePairSessionLinksForRoleParams{SessionID: sessionID, Role: role}); err != nil {
		return db.PairSessionLink{}, pkgerrors.Internal("rotate link: " + err.Error())
	}
	slug, err := mintPairSessionID()
	if err != nil {
		return db.PairSessionLink{}, pkgerrors.Internal("mint link slug: " + err.Error())
	}
	link, err := s.store.CreatePairSessionLink(ctx, db.CreatePairSessionLinkParams{SessionID: sessionID, Slug: slug, Role: role, CreatedBy: actorID})
	if err != nil {
		return db.PairSessionLink{}, pkgerrors.Internal("create link: " + err.Error())
	}
	if _, err := s.store.SetPairSessionAccessMode(ctx, db.SetPairSessionAccessModeParams{ID: sessionID, AccessMode: PairAccessLink}); err != nil {
		return db.PairSessionLink{}, pkgerrors.Internal("set link access mode: " + err.Error())
	}
	return link, nil
}

func (s *PairSessionService) ListLinks(ctx context.Context, sessionID string, actorID int64) ([]db.PairSessionLink, error) {
	if _, err := s.requireOwner(ctx, sessionID, actorID); err != nil {
		return nil, err
	}
	links, err := s.store.ListLivePairSessionLinks(ctx, sessionID)
	if err != nil {
		return nil, pkgerrors.Internal("list links: " + err.Error())
	}
	return links, nil
}

func (s *PairSessionService) RevokeLink(ctx context.Context, sessionID string, actorID int64, linkID string) error {
	return s.withPairSessionMutation(ctx, sessionID, func(locked *PairSessionService) error {
		return locked.revokeLink(ctx, sessionID, actorID, linkID)
	})
}

func (s *PairSessionService) revokeLink(ctx context.Context, sessionID string, actorID int64, linkID string) error {
	if _, err := s.requireOwner(ctx, sessionID, actorID); err != nil {
		return err
	}
	if _, err := s.store.RevokePairSessionLink(ctx, db.RevokePairSessionLinkParams{ID: linkID, SessionID: sessionID}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("link not found")
		}
		return pkgerrors.Internal("revoke link: " + err.Error())
	}
	return nil
}

// --- Invites (+ alpha-bypass growth loop) ----------------------------------

// InviteResult carries the created invite plus honest delivery status.
type InviteResult struct {
	Invite    db.PairSessionInvite
	Token     string
	Delivered bool
	// DeliveryDetail is a human-facing note when Delivered is false, e.g.
	// "email delivery unavailable".
	DeliveryDetail string
}

// CreateInvite records an invite (owner only), auto-whitelists the email through
// the closed alpha BEFORE sign-up (decision #6, the growth loop), and attempts
// delivery when a transport is configured. When no transport exists the invite
// is still joinable on a matching lower_email sign-in and the result reports
// "email delivery unavailable" honestly — never a fake sent state.
func (s *PairSessionService) CreateInvite(ctx context.Context, sessionID string, actorID int64, rawEmail, role string) (InviteResult, error) {
	var result InviteResult
	err := s.withPairSessionMutation(ctx, sessionID, func(locked *PairSessionService) error {
		var err error
		result, err = locked.recordEmailInvite(ctx, sessionID, actorID, rawEmail, role)
		return err
	})
	if err != nil {
		return InviteResult{}, err
	}
	// Deliver only after the invite commits, outside the session lock: a slow
	// mail transport must not hold membership changes behind it.
	lowerEmail := strings.ToLower(strings.TrimSpace(rawEmail))
	if s.deliveryConfigured() {
		if sendErr := s.sendInviteEmail(ctx, lowerEmail, sessionID, result.Token); sendErr != nil {
			result.Delivered = false
			result.DeliveryDetail = "email delivery failed; the invite is still joinable on sign-in"
		} else {
			result.Delivered = true
		}
	} else {
		result.Delivered = false
		result.DeliveryDetail = "email delivery unavailable"
	}
	return result, nil
}

func (s *PairSessionService) recordEmailInvite(ctx context.Context, sessionID string, actorID int64, rawEmail, role string) (InviteResult, error) {
	if _, err := s.requireOwner(ctx, sessionID, actorID); err != nil {
		return InviteResult{}, err
	}
	lowerEmail := strings.ToLower(strings.TrimSpace(rawEmail))
	// Use the same strict validation as everywhere else (rejects CRLF/header
	// injection, display-name/angle-addr forms, and non-bare addresses) rather than
	// a bare "contains @" check that would persist malformed addresses.
	if err := validateEmail(lowerEmail); err != nil {
		return InviteResult{}, pkgerrors.BadRequest("a valid email is required")
	}
	if role != PairRoleViewer && role != PairRoleEditor {
		return InviteResult{}, pkgerrors.BadRequest("invite role must be viewer or editor")
	}

	token, err := mintPairSessionID()
	if err != nil {
		return InviteResult{}, pkgerrors.Internal("mint invite token: " + err.Error())
	}
	invite, err := s.store.CreatePairSessionInvite(ctx, db.CreatePairSessionInviteParams{
		SessionID:  sessionID,
		LowerEmail: pgtype.Text{String: lowerEmail, Valid: true},
		Role:       role,
		TokenHash:  pairauth.TokenHash(token),
		InvitedBy:  actorID,
		ExpiresAt:  time.Now().Add(pairInviteTTL),
	})
	if err != nil {
		return InviteResult{}, pkgerrors.Internal("create invite: " + err.Error())
	}

	// Growth loop: whitelist the email NOW, before the invitee has signed up.
	if _, err := s.store.UpsertAlphaWhitelistEmail(ctx, db.UpsertAlphaWhitelistEmailParams{
		Email:      strings.TrimSpace(rawEmail),
		LowerEmail: lowerEmail,
		CreatedBy:  pgtype.Int8{Int64: actorID, Valid: true},
	}); err != nil {
		return InviteResult{}, pkgerrors.Internal("whitelist invited email: " + err.Error())
	}
	return InviteResult{Invite: invite, Token: token}, nil
}

// githubUsernameRe accepts GitHub login syntax on the lowercased value:
// alphanumerics with single interior hyphens, no leading/trailing hyphen
// (length capped separately at GitHub's 39).
var githubUsernameRe = regexp.MustCompile(`^[a-z0-9](?:-?[a-z0-9])*$`)

// CreateInviteByUsername records a GitHub-username-keyed invite (owner only).
// Plue usernames ARE GitHub logins, so the invite matches when that login signs
// in (GitHub OAuth sets users.username = profile.login) — whether the account
// exists yet or not. Deliberately NO account lookup, NO email attach, and NO
// email send: resolving a username to its account's private email would
// disclose that email to the owner (and make the response an oracle for
// "does this GitHub user have an account here"). The response is therefore
// UNIFORM for every username — the copyable link is always the delivery path.
// The username is auto-whitelisted through the closed alpha (the username
// flavor of the decision #6 growth loop); a whitelist row for a suspended
// account is inert (login is blocked upstream of the alpha gate).
func (s *PairSessionService) CreateInviteByUsername(ctx context.Context, sessionID string, actorID int64, rawUsername, role string) (InviteResult, error) {
	var result InviteResult
	err := s.withPairSessionMutation(ctx, sessionID, func(locked *PairSessionService) error {
		var err error
		result, err = locked.createInviteByUsername(ctx, sessionID, actorID, rawUsername, role)
		return err
	})
	return result, err
}

func (s *PairSessionService) createInviteByUsername(ctx context.Context, sessionID string, actorID int64, rawUsername, role string) (InviteResult, error) {
	if _, err := s.requireOwner(ctx, sessionID, actorID); err != nil {
		return InviteResult{}, err
	}
	username := strings.TrimPrefix(strings.TrimSpace(rawUsername), "@")
	lowerUsername := strings.ToLower(username)
	if lowerUsername == "" || len(lowerUsername) > 39 || !githubUsernameRe.MatchString(lowerUsername) {
		return InviteResult{}, pkgerrors.BadRequest("a valid GitHub username is required")
	}
	if role != PairRoleViewer && role != PairRoleEditor {
		return InviteResult{}, pkgerrors.BadRequest("invite role must be viewer or editor")
	}

	token, err := mintPairSessionID()
	if err != nil {
		return InviteResult{}, pkgerrors.Internal("mint invite token: " + err.Error())
	}
	invite, err := s.store.CreatePairSessionInvite(ctx, db.CreatePairSessionInviteParams{
		SessionID:           sessionID,
		LowerGithubUsername: pgtype.Text{String: lowerUsername, Valid: true},
		Role:                role,
		TokenHash:           pairauth.TokenHash(token),
		InvitedBy:           actorID,
		ExpiresAt:           time.Now().Add(pairInviteTTL),
	})
	if err != nil {
		return InviteResult{}, pkgerrors.Internal("create invite: " + err.Error())
	}

	// Growth loop: whitelist the username NOW, before the invitee has signed up.
	if _, err := s.store.UpsertAlphaWhitelistUsername(ctx, db.UpsertAlphaWhitelistUsernameParams{
		Username:      username,
		LowerUsername: lowerUsername,
		CreatedBy:     pgtype.Int8{Int64: actorID, Valid: true},
	}); err != nil {
		return InviteResult{}, pkgerrors.Internal("whitelist invited username: " + err.Error())
	}

	return InviteResult{
		Invite: invite,
		Token:  token,
		// Uniform (account-existence-blind) and honest: nothing was emailed.
		Delivered:      false,
		DeliveryDetail: "share the link so they can join",
	}, nil
}

func (s *PairSessionService) ListInvites(ctx context.Context, sessionID string, actorID int64) ([]db.PairSessionInvite, error) {
	if _, err := s.requireOwner(ctx, sessionID, actorID); err != nil {
		return nil, err
	}
	invites, err := s.store.ListPairSessionInvites(ctx, sessionID)
	if err != nil {
		return nil, pkgerrors.Internal("list invites: " + err.Error())
	}
	return invites, nil
}

func (s *PairSessionService) RevokeInvite(ctx context.Context, sessionID string, actorID int64, rawEmail string) error {
	return s.withPairSessionMutation(ctx, sessionID, func(locked *PairSessionService) error {
		return locked.revokeInvite(ctx, sessionID, actorID, rawEmail)
	})
}

func (s *PairSessionService) revokeInvite(ctx context.Context, sessionID string, actorID int64, rawEmail string) error {
	if _, err := s.requireOwner(ctx, sessionID, actorID); err != nil {
		return err
	}
	lowerEmail := strings.ToLower(strings.TrimSpace(rawEmail))
	if _, err := s.store.RevokePairSessionInvite(ctx, db.RevokePairSessionInviteParams{SessionID: sessionID, LowerEmail: lowerEmail}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("invite not found")
		}
		return pkgerrors.Internal("revoke invite: " + err.Error())
	}
	return nil
}

func (s *PairSessionService) RevokeInviteByUsername(ctx context.Context, sessionID string, actorID int64, rawUsername string) error {
	return s.withPairSessionMutation(ctx, sessionID, func(locked *PairSessionService) error {
		return locked.revokeInviteByUsername(ctx, sessionID, actorID, rawUsername)
	})
}

func (s *PairSessionService) revokeInviteByUsername(ctx context.Context, sessionID string, actorID int64, rawUsername string) error {
	if _, err := s.requireOwner(ctx, sessionID, actorID); err != nil {
		return err
	}
	lowerUsername := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(rawUsername), "@"))
	if _, err := s.store.RevokePairSessionInviteByUsername(ctx, db.RevokePairSessionInviteByUsernameParams{SessionID: sessionID, LowerGithubUsername: lowerUsername}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("invite not found")
		}
		return pkgerrors.Internal("revoke invite: " + err.Error())
	}
	return nil
}

func (s *PairSessionService) deliveryConfigured() bool {
	return s.emailFrom != "" && email.DeliveryConfigured(s.transport)
}

func (s *PairSessionService) sendInviteEmail(ctx context.Context, lowerEmail, sessionID, token string) error {
	link := s.inviteBase + "/s/" + sessionID + "?invite=" + token
	return s.transport.Send(ctx, email.Message{
		From:    s.emailFrom,
		To:      []string{lowerEmail},
		Subject: "You've been invited to a Smithers Pair session",
		Text:    "You've been invited to pair on Smithers. Open " + link + " to join.",
		HTML:    `<p>You've been invited to pair on Smithers.</p><p><a href="` + link + `">Join the session</a></p>`,
	})
}

// --- Prompt queue (serial FIFO; executor election server half) -------------

// Enqueue appends an attributed prompt to the serial FIFO (decision #3/#5).
// Editors and the owner may enqueue; viewers get 403. Per amendment B there is
// NO paid-plan re-check here — existing members are grandfathered for the
// session's lifetime.
func (s *PairSessionService) Enqueue(ctx context.Context, sessionID string, actorID int64, source, body string) (db.PairPromptQueue, error) {
	if _, err := s.requireRole(ctx, sessionID, actorID, PairRoleEditor); err != nil {
		return db.PairPromptQueue{}, err
	}
	if source != pairPromptSourceSolo && source != pairPromptSourceTogether {
		return db.PairPromptQueue{}, pkgerrors.BadRequest("source must be solo or together")
	}
	if strings.TrimSpace(body) == "" {
		return db.PairPromptQueue{}, pkgerrors.BadRequest("prompt body is required")
	}
	if err := s.checkQueueCapacity(ctx, sessionID); err != nil {
		return db.PairPromptQueue{}, err
	}
	return s.enqueueWithRetry(ctx, sessionID, actorID, source, body)
}

// pairQueueMaxPending caps unsettled (queued/claimed/running) prompts per
// session; pairQueueMaxTotal caps a session's lifetime queue rows. Both exist
// so a looping editor cannot grow pair_prompt_queue without bound: the queue
// listing (GET /queue and the pair_prompt_queue shape) re-ships EVERY row for
// the session, so unbounded rows turn every poll into an unbounded read.
const (
	pairQueueMaxPending = 100
	pairQueueMaxTotal   = 1000
)

// pairPromptSettled reports whether a queue row is in a terminal status.
func pairPromptSettled(status string) bool {
	switch status {
	case "done", "failed", "canceled":
		return true
	}
	return false
}

// checkQueueCapacity enforces the per-session queue caps against a fresh
// listing. The check runs outside the enqueue transaction, so concurrent
// enqueues can overshoot by at most the request concurrency — acceptable for a
// resource guard whose caps sit far above legitimate use.
func (s *PairSessionService) checkQueueCapacity(ctx context.Context, sessionID string) error {
	rows, err := s.store.ListPairPromptQueue(ctx, sessionID)
	if err != nil {
		return pkgerrors.Internal("check queue capacity: " + err.Error())
	}
	if len(rows) >= pairQueueMaxTotal {
		return pkgerrors.QuotaExceeded("this session's prompt queue reached its lifetime limit — start a new session")
	}
	pending := 0
	for _, row := range rows {
		if !pairPromptSettled(row.Status) {
			pending++
		}
	}
	if pending >= pairQueueMaxPending {
		return pkgerrors.QuotaExceeded("prompt queue is full — wait for pending prompts to settle")
	}
	return nil
}

// pairEnqueueSeqRetries bounds the retry loop that resolves concurrent seq
// collisions (two enqueues computing the same MAX(seq)+1). Contention is
// per-session and short-lived, so a small bound is ample; exceeding it surfaces
// as an honest error rather than a hang.
const pairEnqueueSeqRetries = 8

// enqueueWithRetry appends a prompt with a race-free FIFO seq. The primary path
// serializes seq assignment under a per-session advisory lock inside a
// transaction (decision #3); when no tx-beginner is configured it falls back to
// recomputing the seq on a UNIQUE(session_id, seq) collision. Either way
// concurrent submissions all succeed instead of one getting a 500.
func (s *PairSessionService) enqueueWithRetry(ctx context.Context, sessionID string, actorID int64, source, body string) (db.PairPromptQueue, error) {
	params := db.EnqueuePairPromptParams{SessionID: sessionID, AuthorUserID: actorID, Source: source, Body: body}
	if s.txBeginner != nil {
		return s.enqueueSerial(ctx, sessionID, params)
	}
	var lastErr error
	for attempt := 0; attempt < pairEnqueueSeqRetries; attempt++ {
		prompt, err := s.store.EnqueuePairPrompt(ctx, params)
		if err == nil {
			return prompt, nil
		}
		if isUniqueViolation(err) {
			lastErr = err
			continue
		}
		return db.PairPromptQueue{}, pkgerrors.Internal("enqueue prompt: " + err.Error())
	}
	return db.PairPromptQueue{}, pkgerrors.Internal("enqueue prompt: seq contention did not resolve: " + lastErr.Error())
}

// enqueueSerial acquires a per-session transaction-scoped advisory lock, then
// inserts the prompt. Because the INSERT runs as a second statement in the same
// READ COMMITTED transaction — after the lock is held — its MAX(seq) read sees
// every previously-committed enqueue for the session, so two concurrent
// enqueues can never compute the same seq.
func (s *PairSessionService) enqueueSerial(ctx context.Context, sessionID string, params db.EnqueuePairPromptParams) (db.PairPromptQueue, error) {
	tx, err := s.txBeginner.Begin(ctx)
	if err != nil {
		return db.PairPromptQueue{}, pkgerrors.Internal("begin enqueue tx: " + err.Error())
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext($1))", sessionID); err != nil {
		return db.PairPromptQueue{}, pkgerrors.Internal("lock session queue: " + err.Error())
	}
	// Wait for the queue lock before fencing membership changes, so a removal
	// completed while this request waited is visible to the fresh role check.
	// Enqueue and SubmitDraft take queue then membership; mutations take
	// only membership. Hold both locks through the write transaction's commit.
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext($1))", "pair-session:"+sessionID); err != nil {
		return db.PairPromptQueue{}, pkgerrors.Internal("lock pair session mutation: " + err.Error())
	}
	locked := *s
	locked.store = db.New(tx)
	if _, err := locked.requireRole(ctx, sessionID, params.AuthorUserID, PairRoleEditor); err != nil {
		return db.PairPromptQueue{}, err
	}

	prompt, err := db.New(tx).EnqueuePairPrompt(ctx, params)
	if err != nil {
		return db.PairPromptQueue{}, pkgerrors.Internal("enqueue prompt: " + err.Error())
	}
	if err := tx.Commit(ctx); err != nil {
		return db.PairPromptQueue{}, pkgerrors.Internal("commit enqueue: " + err.Error())
	}
	return prompt, nil
}

func (s *PairSessionService) ListQueue(ctx context.Context, sessionID string, actorID int64) ([]db.PairPromptQueue, error) {
	if _, err := s.requireRole(ctx, sessionID, actorID, PairRoleViewer); err != nil {
		return nil, err
	}
	rows, err := s.store.ListPairPromptQueue(ctx, sessionID)
	if err != nil {
		return nil, pkgerrors.Internal("list queue: " + err.Error())
	}
	return rows, nil
}

// pairExecutorKey derives the stored executor_client_id from the authenticated
// claiming user plus the client-chosen id. The raw client id is serialized to
// every session member (queue listing + pair_prompt_queue shape), so on its own
// it must never function as the start/renew/finish credential: binding the
// server-verified actor id into the key means those CASes can only match for
// the SAME signed-in user that claimed the row. A co-editor replaying a peer's
// visible executor_client_id composes a different key and gets Conflict, never
// a write. The "u<id>:" prefix is unambiguous — the actor id is all digits and
// terminates at the first ':'.
func pairExecutorKey(actorID int64, clientID string) string {
	return "u" + strconv.FormatInt(actorID, 10) + ":" + clientID
}

// Claim is the executor-election CAS (exactly-once across N clients). Only
// editors/owners may claim, and only the EARLIEST queued prompt is claimable
// (the serial FIFO contract, decision #3) — naming a later prompt id cannot
// jump the queue. Returns Conflict when another client already holds the
// (single) active slot or the prompt is not next in line.
func (s *PairSessionService) Claim(ctx context.Context, sessionID string, actorID int64, promptID, clientID string, lease time.Duration) (db.PairPromptQueue, error) {
	var result db.PairPromptQueue
	err := s.withPairSessionMutation(ctx, sessionID, func(locked *PairSessionService) error {
		var err error
		result, err = locked.claim(ctx, sessionID, actorID, promptID, clientID, lease)
		return err
	})
	return result, err
}

func (s *PairSessionService) claim(ctx context.Context, sessionID string, actorID int64, promptID, clientID string, lease time.Duration) (db.PairPromptQueue, error) {
	if _, err := s.requireRole(ctx, sessionID, actorID, PairRoleEditor); err != nil {
		return db.PairPromptQueue{}, err
	}
	if err := s.requireNextClaimable(ctx, sessionID, promptID); err != nil {
		return db.PairPromptQueue{}, err
	}
	prompt, err := s.store.ClaimPairPrompt(ctx, db.ClaimPairPromptParams{
		ID:               promptID,
		SessionID:        sessionID,
		ExecutorClientID: pairExecutorKey(actorID, clientID),
		ClaimExpiresAt:   pgtype.Timestamptz{Time: time.Now().Add(lease), Valid: true},
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) || isUniqueViolation(err) {
			return db.PairPromptQueue{}, pkgerrors.Conflict("prompt is already claimed")
		}
		return db.PairPromptQueue{}, pkgerrors.Internal("claim prompt: " + err.Error())
	}
	return prompt, nil
}

// requireNextClaimable enforces the FIFO contract on a claim: a 'queued'
// prompt is claimable only when no other 'queued' prompt in the session has a
// lower seq. An expired-claim takeover (row already 'claimed') is exempt — the
// one-active index guarantees it is the single actionable row. Ids not in the
// session's queue fall through to the claim CAS, which answers Conflict.
// Check-then-claim is not atomic, but seq assignment is monotonic (MAX+1 under
// the per-session advisory lock), so no EARLIER 'queued' row can appear between
// the check and the CAS; a concurrent settle of the earliest row can only cause
// a transient spurious Conflict, which the claiming client simply retries.
func (s *PairSessionService) requireNextClaimable(ctx context.Context, sessionID, promptID string) error {
	rows, err := s.store.ListPairPromptQueue(ctx, sessionID)
	if err != nil {
		return pkgerrors.Internal("list queue: " + err.Error())
	}
	var target *db.PairPromptQueue
	minQueuedSeq := int64(-1)
	for i := range rows {
		if rows[i].ID == promptID {
			target = &rows[i]
		}
		if rows[i].Status == "queued" && (minQueuedSeq < 0 || rows[i].Seq < minQueuedSeq) {
			minQueuedSeq = rows[i].Seq
		}
	}
	if target != nil && target.Status == "queued" && target.Seq != minQueuedSeq {
		return pkgerrors.Conflict("prompt is not the next queued prompt")
	}
	return nil
}

// Start writes the real gateway run_id and flips to 'running' BEFORE streaming
// (the start-CAS). A failure means the claim was cancelled/taken over — the
// caller must abort without dispatch.
func (s *PairSessionService) Start(ctx context.Context, sessionID string, actorID int64, promptID, clientID, runID string) (db.PairPromptQueue, error) {
	var result db.PairPromptQueue
	err := s.withPairSessionMutation(ctx, sessionID, func(locked *PairSessionService) error {
		var err error
		result, err = locked.start(ctx, sessionID, actorID, promptID, clientID, runID)
		return err
	})
	return result, err
}

func (s *PairSessionService) start(ctx context.Context, sessionID string, actorID int64, promptID, clientID, runID string) (db.PairPromptQueue, error) {
	if _, err := s.requireRole(ctx, sessionID, actorID, PairRoleEditor); err != nil {
		return db.PairPromptQueue{}, err
	}
	if strings.TrimSpace(runID) == "" {
		return db.PairPromptQueue{}, pkgerrors.BadRequest("run id is required")
	}
	prompt, err := s.store.StartPairPrompt(ctx, db.StartPairPromptParams{ID: promptID, SessionID: sessionID, RunID: runID, ExecutorClientID: pairExecutorKey(actorID, clientID)})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return db.PairPromptQueue{}, pkgerrors.Conflict("start rejected: claim was cancelled or taken over")
		}
		return db.PairPromptQueue{}, pkgerrors.Internal("start prompt: " + err.Error())
	}
	return prompt, nil
}

// Renew extends the executor's lease on its claimed/running prompt. The CAS is
// session- and executor-scoped (executor key = authenticated claimer + client
// id): any other caller — including a co-editor replaying the visible client
// id — gets Conflict, never a write.
func (s *PairSessionService) Renew(ctx context.Context, sessionID string, actorID int64, promptID, clientID string, lease time.Duration) (db.PairPromptQueue, error) {
	var result db.PairPromptQueue
	err := s.withPairSessionMutation(ctx, sessionID, func(locked *PairSessionService) error {
		var err error
		result, err = locked.renew(ctx, sessionID, actorID, promptID, clientID, lease)
		return err
	})
	return result, err
}

func (s *PairSessionService) renew(ctx context.Context, sessionID string, actorID int64, promptID, clientID string, lease time.Duration) (db.PairPromptQueue, error) {
	if _, err := s.requireRole(ctx, sessionID, actorID, PairRoleEditor); err != nil {
		return db.PairPromptQueue{}, err
	}
	prompt, err := s.store.RenewPairPromptLease(ctx, db.RenewPairPromptLeaseParams{
		ID:               promptID,
		SessionID:        sessionID,
		ExecutorClientID: pairExecutorKey(actorID, clientID),
		ClaimExpiresAt:   pgtype.Timestamptz{Time: time.Now().Add(lease), Valid: true},
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return db.PairPromptQueue{}, pkgerrors.Conflict("renew rejected: lease is not held by this client")
		}
		return db.PairPromptQueue{}, pkgerrors.Internal("renew lease: " + err.Error())
	}
	return prompt, nil
}

// Finish is the executor finalizing its own running prompt (done/failed/canceled).
// Completion makes the next 'queued' row claimable. The executor key binds the
// CAS to the authenticated user that claimed the row, so no other member can
// settle a peer's running prompt by replaying its visible client id.
func (s *PairSessionService) Finish(ctx context.Context, sessionID string, actorID int64, promptID, clientID, status string) (db.PairPromptQueue, error) {
	var result db.PairPromptQueue
	err := s.withPairSessionMutation(ctx, sessionID, func(locked *PairSessionService) error {
		var err error
		result, err = locked.finish(ctx, sessionID, actorID, promptID, clientID, status)
		return err
	})
	return result, err
}

func (s *PairSessionService) finish(ctx context.Context, sessionID string, actorID int64, promptID, clientID, status string) (db.PairPromptQueue, error) {
	if _, err := s.requireRole(ctx, sessionID, actorID, PairRoleEditor); err != nil {
		return db.PairPromptQueue{}, err
	}
	switch status {
	case "done", "failed", "canceled":
	default:
		return db.PairPromptQueue{}, pkgerrors.BadRequest("status must be done, failed, or canceled")
	}
	prompt, err := s.store.FinishPairPrompt(ctx, db.FinishPairPromptParams{
		ID:               promptID,
		SessionID:        sessionID,
		ExecutorClientID: pairExecutorKey(actorID, clientID),
		Status:           status,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return db.PairPromptQueue{}, pkgerrors.Conflict("finish rejected: prompt is not running under this client")
		}
		return db.PairPromptQueue{}, pkgerrors.Internal("finish prompt: " + err.Error())
	}
	return prompt, nil
}

// Cancel enforces decision #3/#8: authors cancel their OWN queued prompts; the
// owner cancels ANY queued/claimed prompt.
func (s *PairSessionService) Cancel(ctx context.Context, sessionID string, actorID int64, promptID string) (db.PairPromptQueue, error) {
	var result db.PairPromptQueue
	err := s.withPairSessionMutation(ctx, sessionID, func(locked *PairSessionService) error {
		var err error
		result, err = locked.cancel(ctx, sessionID, actorID, promptID)
		return err
	})
	return result, err
}

func (s *PairSessionService) cancel(ctx context.Context, sessionID string, actorID int64, promptID string) (db.PairPromptQueue, error) {
	res, err := s.requireRole(ctx, sessionID, actorID, PairRoleViewer)
	if err != nil {
		return db.PairPromptQueue{}, err
	}
	if res.Role == PairRoleOwner {
		prompt, err := s.store.CancelAnyPendingPairPrompt(ctx, db.CancelAnyPendingPairPromptParams{
			ID:         promptID,
			SessionID:  sessionID,
			CanceledBy: pgtype.Int8{Int64: actorID, Valid: true},
		})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return db.PairPromptQueue{}, pkgerrors.Conflict("prompt is not cancelable (already running or settled)")
			}
			return db.PairPromptQueue{}, pkgerrors.Internal("cancel prompt: " + err.Error())
		}
		return prompt, nil
	}
	// Author path: viewers cannot enqueue so cannot own a prompt; editors cancel
	// only their own queued rows.
	prompt, err := s.store.CancelOwnQueuedPairPrompt(ctx, db.CancelOwnQueuedPairPromptParams{
		ID:         promptID,
		SessionID:  sessionID,
		CanceledBy: pgtype.Int8{Int64: actorID, Valid: true},
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return db.PairPromptQueue{}, pkgerrors.Forbidden("you can only cancel your own queued prompts")
		}
		return db.PairPromptQueue{}, pkgerrors.Internal("cancel prompt: " + err.Error())
	}
	return prompt, nil
}

// SweepStaleClaims reverts expired 'claimed' rows WITHOUT a run_id back to
// 'queued'. Rows WITH a run_id are never touched (run_id is the never-re-dispatch
// idempotency marker).
func (s *PairSessionService) SweepStaleClaims(ctx context.Context) (int, error) {
	rows, err := s.store.SweepStalePairPromptClaims(ctx)
	if err != nil {
		return 0, pkgerrors.Internal("sweep stale claims: " + err.Error())
	}
	// Also recover 'running' rows whose executor died (expired lease past the
	// grace window): otherwise the one-active-prompt index wedges the session's
	// queue forever.
	running, err := s.store.FailStaleRunningPairPrompts(ctx, int32(pairRunningLeaseGrace/time.Second))
	if err != nil {
		return len(rows), pkgerrors.Internal("recover stale running prompts: " + err.Error())
	}
	return len(rows) + len(running), nil
}

// pairRunningLeaseGrace is how long past an expired lease a 'running' prompt is
// tolerated before the recovery sweep declares its executor dead. It sits above
// the lease-renewal cadence so a briefly-late renewal never kills a live prompt.
const pairRunningLeaseGrace = 90 * time.Second

// --- Co-compose draft (decision #5, editor+) -------------------------------

func (s *PairSessionService) GetDraft(ctx context.Context, sessionID string, actorID int64) (db.PairSessionDraft, error) {
	if _, err := s.requireRole(ctx, sessionID, actorID, PairRoleViewer); err != nil {
		return db.PairSessionDraft{}, err
	}
	draft, err := s.store.GetPairSessionDraft(ctx, sessionID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return db.PairSessionDraft{SessionID: sessionID}, nil
		}
		return db.PairSessionDraft{}, pkgerrors.Internal("get draft: " + err.Error())
	}
	return draft, nil
}

// PutDraft is a version-gated write (editor+). A stale version is rejected with
// Conflict rather than clobbering the buffer.
func (s *PairSessionService) PutDraft(ctx context.Context, sessionID string, actorID int64, content string, version int64) (db.PairSessionDraft, error) {
	var result db.PairSessionDraft
	err := s.withPairSessionMutation(ctx, sessionID, func(locked *PairSessionService) error {
		var err error
		result, err = locked.putDraft(ctx, sessionID, actorID, content, version)
		return err
	})
	return result, err
}

func (s *PairSessionService) putDraft(ctx context.Context, sessionID string, actorID int64, content string, version int64) (db.PairSessionDraft, error) {
	if _, err := s.requireRole(ctx, sessionID, actorID, PairRoleEditor); err != nil {
		return db.PairSessionDraft{}, err
	}
	draft, err := s.store.UpsertPairSessionDraft(ctx, db.UpsertPairSessionDraftParams{
		SessionID: sessionID,
		Content:   content,
		Version:   version,
		UpdatedBy: pgtype.Int8{Int64: actorID, Valid: true},
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return db.PairSessionDraft{}, pkgerrors.Conflict("stale draft version")
		}
		return db.PairSessionDraft{}, pkgerrors.Internal("put draft: " + err.Error())
	}
	return draft, nil
}

// SubmitDraft enqueues the shared buffer as ONE 'together' prompt (attributed to
// the submitter) and clears the draft (editor+). The read+enqueue+clear runs
// atomically under the per-session advisory lock (see submitDraftSerial) so two
// concurrent submits cannot enqueue duplicate prompts and a concurrent PutDraft
// cannot be silently clobbered.
func (s *PairSessionService) SubmitDraft(ctx context.Context, sessionID string, actorID int64) (db.PairPromptQueue, error) {
	if _, err := s.requireRole(ctx, sessionID, actorID, PairRoleEditor); err != nil {
		return db.PairPromptQueue{}, err
	}
	if err := s.checkQueueCapacity(ctx, sessionID); err != nil {
		return db.PairPromptQueue{}, err
	}
	if s.txBeginner != nil {
		return s.submitDraftSerial(ctx, sessionID, actorID)
	}
	// Fallback for the store-only test double (no tx): non-atomic, but still
	// version-gated so a concurrent PutDraft is not clobbered.
	draft, err := s.store.GetPairSessionDraft(ctx, sessionID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return db.PairPromptQueue{}, pkgerrors.BadRequest("draft is empty")
		}
		return db.PairPromptQueue{}, pkgerrors.Internal("load draft: " + err.Error())
	}
	if strings.TrimSpace(draft.Content) == "" {
		return db.PairPromptQueue{}, pkgerrors.BadRequest("draft is empty")
	}
	prompt, err := s.enqueueWithRetry(ctx, sessionID, actorID, pairPromptSourceTogether, draft.Content)
	if err != nil {
		return db.PairPromptQueue{}, err
	}
	if _, err := s.store.ClearPairSessionDraft(ctx, db.ClearPairSessionDraftParams{SessionID: sessionID, UpdatedBy: pgtype.Int8{Int64: actorID, Valid: true}, ExpectedVersion: draft.Version}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return db.PairPromptQueue{}, pkgerrors.Conflict("draft changed during submit")
		}
		return db.PairPromptQueue{}, pkgerrors.Internal("clear draft: " + err.Error())
	}
	return prompt, nil
}

// submitDraftSerial runs read + enqueue + version-gated clear as ONE transaction
// under the same per-session transaction-scoped advisory lock enqueueSerial
// uses. Serializing on the lock makes concurrent submits mutually exclusive: the
// loser reads an already-cleared (empty) draft and returns "draft is empty"
// instead of enqueueing a second 'together' prompt. The version-gated clear
// detects a concurrent PutDraft that landed between the read and the clear
// (stored version advanced) and aborts with Conflict — rolling back the enqueue
// — rather than clobbering that write.
func (s *PairSessionService) submitDraftSerial(ctx context.Context, sessionID string, actorID int64) (db.PairPromptQueue, error) {
	tx, err := s.txBeginner.Begin(ctx)
	if err != nil {
		return db.PairPromptQueue{}, pkgerrors.Internal("begin submit tx: " + err.Error())
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext($1))", sessionID); err != nil {
		return db.PairPromptQueue{}, pkgerrors.Internal("lock session queue: " + err.Error())
	}
	// Wait for the queue lock before fencing membership changes, so a removal
	// completed while this request waited is visible to the fresh role check.
	// Enqueue and SubmitDraft take queue then membership; mutations take
	// only membership. Hold both locks through the write transaction's commit.
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext($1))", "pair-session:"+sessionID); err != nil {
		return db.PairPromptQueue{}, pkgerrors.Internal("lock pair session mutation: " + err.Error())
	}
	locked := *s
	locked.store = db.New(tx)
	if _, err := locked.requireRole(ctx, sessionID, actorID, PairRoleEditor); err != nil {
		return db.PairPromptQueue{}, err
	}

	q := db.New(tx)
	draft, err := q.GetPairSessionDraft(ctx, sessionID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return db.PairPromptQueue{}, pkgerrors.BadRequest("draft is empty")
		}
		return db.PairPromptQueue{}, pkgerrors.Internal("load draft: " + err.Error())
	}
	if strings.TrimSpace(draft.Content) == "" {
		return db.PairPromptQueue{}, pkgerrors.BadRequest("draft is empty")
	}

	prompt, err := q.EnqueuePairPrompt(ctx, db.EnqueuePairPromptParams{
		SessionID:    sessionID,
		AuthorUserID: actorID,
		Source:       pairPromptSourceTogether,
		Body:         draft.Content,
	})
	if err != nil {
		return db.PairPromptQueue{}, pkgerrors.Internal("enqueue prompt: " + err.Error())
	}

	if _, err := q.ClearPairSessionDraft(ctx, db.ClearPairSessionDraftParams{
		SessionID:       sessionID,
		UpdatedBy:       pgtype.Int8{Int64: actorID, Valid: true},
		ExpectedVersion: draft.Version,
	}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return db.PairPromptQueue{}, pkgerrors.Conflict("draft changed during submit")
		}
		return db.PairPromptQueue{}, pkgerrors.Internal("clear draft: " + err.Error())
	}

	if err := tx.Commit(ctx); err != nil {
		return db.PairPromptQueue{}, pkgerrors.Internal("commit submit: " + err.Error())
	}
	return prompt, nil
}

// --- Presence (keep-awake) -------------------------------------------------

// Heartbeat writes ONLY the caller's own member row (any live member, viewers
// included — their activity still counts for keep-awake). A beat re-ships one
// row, never the room.
func (s *PairSessionService) Heartbeat(ctx context.Context, sessionID string, actorID int64, presence json.RawMessage) error {
	if _, err := s.requireRole(ctx, sessionID, actorID, PairRoleViewer); err != nil {
		return err
	}
	if len(presence) == 0 {
		presence = json.RawMessage(`{}`)
	}
	if _, err := s.store.UpdatePairSessionMemberPresence(ctx, db.UpdatePairSessionMemberPresenceParams{
		SessionID: sessionID,
		UserID:    actorID,
		Presence:  presence,
	}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.Forbidden("no access")
		}
		return pkgerrors.Internal("presence beat: " + err.Error())
	}
	return nil
}

// --- Shared helpers --------------------------------------------------------

func (s *PairSessionService) loadLiveSession(ctx context.Context, sessionID string) (db.PairSession, error) {
	return loadLivePairSession(ctx, s.store, sessionID)
}

func loadLivePairSession(ctx context.Context, store PairSessionStore, sessionID string) (db.PairSession, error) {
	session, err := store.GetPairSession(ctx, sessionID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return db.PairSession{}, pkgerrors.NotFound("pair session not found")
		}
		return db.PairSession{}, pkgerrors.Internal("load session: " + err.Error())
	}
	if pairSessionTerminal(session.Status) {
		return db.PairSession{}, pkgerrors.NotFound("pair session has ended")
	}
	return session, nil
}

// requireRole resolves the actor's live membership and enforces a minimum role.
// The owner is always treated as owner even without a member row. Non-members
// (or revoked members) get Forbidden — fail closed.
func (s *PairSessionService) requireRole(ctx context.Context, sessionID string, actorID int64, min string) (PairResolution, error) {
	session, err := s.loadLiveSession(ctx, sessionID)
	if err != nil {
		return PairResolution{}, err
	}
	role := ""
	if session.OwnerUserID == actorID {
		role = PairRoleOwner
	} else {
		member, err := s.store.GetLivePairSessionMember(ctx, db.GetLivePairSessionMemberParams{SessionID: sessionID, UserID: actorID})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return PairResolution{}, pkgerrors.Forbidden("no access")
			}
			return PairResolution{}, pkgerrors.Internal("load member: " + err.Error())
		}
		role = member.Role
	}
	if pairRoleRank(role) < pairRoleRank(min) {
		return PairResolution{}, pkgerrors.Forbidden(min + " access required")
	}
	return PairResolution{Session: session, Role: role}, nil
}

func (s *PairSessionService) requireOwner(ctx context.Context, sessionID string, actorID int64) (PairResolution, error) {
	return s.requireRole(ctx, sessionID, actorID, PairRoleOwner)
}

// ensureWorkspaceShare grants (idempotently, at the level for `role`) a
// workspace_shares row on the session's forked workspace to a non-owner member,
// so the member passes requireWorkspaceAccess on the workspace-scoped surface.
// The owner already owns the fork (ForkWorkspace assigns it to source.UserID) so
// needs no share. When the fork is not yet bound (session still provisioning) the
// grant is skipped and self-heals on a later resolve once workspace_id is set.
func (s *PairSessionService) ensureWorkspaceShare(ctx context.Context, session db.PairSession, userID int64, role string) error {
	if userID == session.OwnerUserID {
		return nil
	}
	if !session.WorkspaceID.Valid {
		return nil
	}
	if _, err := s.store.UpsertWorkspaceShare(ctx, db.UpsertWorkspaceShareParams{
		WorkspaceID:   UUIDString(session.WorkspaceID),
		OwnerUserID:   session.OwnerUserID,
		GranteeUserID: userID,
		Level:         pairShareLevelForRole(role),
	}); err != nil {
		if workspaceGatewaySharingConflict(err) {
			return pkgerrors.Conflict("Stop this box's flows before sharing it for writing.")
		}
		return pkgerrors.Internal("grant workspace share: " + err.Error())
	}
	// Verify-after-write closes the EndSession/RevokeMember TOCTOU: a concurrent
	// end/revoke may have flipped the session terminal (and cleared shares)
	// between the caller's liveness check and the upsert above. Re-read the
	// authoritative status NOW — EndSession flips status BEFORE deleting shares —
	// and revoke the share we just (re)created if the session is no longer live,
	// so a write-level share can never outlive the session that authorized it.
	fresh, err := s.store.GetPairSession(ctx, session.ID)
	if err != nil || pairSessionTerminal(fresh.Status) {
		_ = s.revokeWorkspaceShare(ctx, session, userID)
		if err != nil {
			return pkgerrors.Internal("verify session liveness: " + err.Error())
		}
		return pkgerrors.NotFound("pair session has ended")
	}
	// Same verify-after-write for MEMBERSHIP: a concurrent RevokeMember may have
	// removed the member (and deleted their share) between the caller's
	// membership read and the upsert above — e.g. a SetMemberRole racing a
	// revoke would otherwise recreate the revoked member's share. Re-read the
	// live member row NOW — RevokeMember removes the member BEFORE deleting the
	// share — and drop the share we just (re)created if the member is gone.
	if _, err := s.store.GetLivePairSessionMember(ctx, db.GetLivePairSessionMemberParams{SessionID: session.ID, UserID: userID}); err != nil {
		_ = s.revokeWorkspaceShare(ctx, session, userID)
		if errors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.Forbidden("no access")
		}
		return pkgerrors.Internal("verify membership: " + err.Error())
	}
	return nil
}

// pairSessionTerminal reports whether a session status is a terminal (dead)
// state — used both for the ACL ladder and the share verify-after-write guard.
func pairSessionTerminal(status string) bool {
	return status == "ended" || status == "failed"
}

// revokeWorkspaceShare removes a member's workspace_shares row on the fork so a
// revoked member loses workspace access on their next request.
func (s *PairSessionService) revokeWorkspaceShare(ctx context.Context, session db.PairSession, userID int64) error {
	if !session.WorkspaceID.Valid {
		return nil
	}
	workspaceID := UUIDString(session.WorkspaceID)
	if err := s.store.DeleteWorkspaceShare(ctx, db.DeleteWorkspaceShareParams{
		WorkspaceID:   workspaceID,
		GranteeUserID: userID,
	}); err != nil {
		return pkgerrors.Internal("revoke workspace share: " + err.Error())
	}
	s.publishWorkspaceShareRevocation(ctx, workspaceID, userID, "workspace share removed")
	return nil
}

func (s *PairSessionService) publishWorkspaceShareRevocation(ctx context.Context, workspaceID string, userID int64, reason string) {
	var sandboxIDs []string
	if getter, ok := s.store.(workspaceGetter); ok {
		if workspace, err := getter.GetWorkspace(ctx, workspaceID); err == nil && workspace.VmID != "" {
			sandboxIDs = []string{workspace.VmID}
		}
	}
	revocation.PublishBestEffort(ctx, s.revocations, revocation.Event{
		Kind:        revocation.KindWorkspaceShareRemoved,
		UserID:      userID,
		WorkspaceID: workspaceID,
		SandboxIDs:  sandboxIDs,
		Reason:      reason,
	})
}

// mintPairSessionID returns a >=128-bit unguessable base62 slug from crypto/rand.
func mintPairSessionID() (string, error) {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
	// 22 base62 chars ~= 131 bits of entropy.
	const n = 22
	out := make([]byte, n)
	max := big.NewInt(int64(len(alphabet)))
	for i := range out {
		idx, err := pairRandInt(rand.Reader, max)
		if err != nil {
			return "", err
		}
		out[i] = alphabet[idx.Int64()]
	}
	return string(out), nil
}

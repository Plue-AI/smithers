package services

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// AppTimelineService is the write path for the realtime-synchronized app-machine
// timelines (SPEC.md §1.1): the authoritative copy of the multi frontend's
// xstate event log, sealed fork branches, and periodic snapshots. Clients
// write through REST (append / rewrite / snapshot); every member's local
// replica converges by streaming the app_timeline_* realtime streams.
//
// Ownership is membership-based from day one (pair_session_members pattern)
// so a timeline is shareable for pairing without schema redesign: the owner
// holds a live 'owner' member row; AddMember grants 'editor'/'viewer' rows.
type AppTimelineService struct {
	store      AppTimelineStore
	txBeginner AppTimelineTxBeginner // optional; serializes per-timeline writes
}

// AppTimelineStore is the sqlc query surface the service consumes.
type AppTimelineStore interface {
	CreateAppTimeline(ctx context.Context, arg db.CreateAppTimelineParams) (db.AppTimeline, error)
	GetAppTimeline(ctx context.Context, id string) (db.AppTimeline, error)
	GetAppTimelineByOwnerClientKey(ctx context.Context, arg db.GetAppTimelineByOwnerClientKeyParams) (db.AppTimeline, error)
	CountAppTimelinesForOwner(ctx context.Context, ownerUserID int64) (int64, error)
	TouchAppTimeline(ctx context.Context, arg db.TouchAppTimelineParams) (db.AppTimeline, error)

	UpsertAppTimelineMember(ctx context.Context, arg db.UpsertAppTimelineMemberParams) (db.AppTimelineMember, error)
	ReAddAppTimelineMember(ctx context.Context, arg db.ReAddAppTimelineMemberParams) (db.AppTimelineMember, error)
	GetLiveAppTimelineMember(ctx context.Context, arg db.GetLiveAppTimelineMemberParams) (db.AppTimelineMember, error)
	ListLiveAppTimelineMemberProfiles(ctx context.Context, timelineID string) ([]db.ListLiveAppTimelineMemberProfilesRow, error)
	RevokeAppTimelineMember(ctx context.Context, arg db.RevokeAppTimelineMemberParams) (db.AppTimelineMember, error)

	InsertAppTimelineEvent(ctx context.Context, arg db.InsertAppTimelineEventParams) (db.AppTimelineEvent, error)
	DeleteAppTimelineEventsFrom(ctx context.Context, arg db.DeleteAppTimelineEventsFromParams) error
	DeleteAllAppTimelineEvents(ctx context.Context, timelineID string) error

	InsertAppTimelineBranch(ctx context.Context, arg db.InsertAppTimelineBranchParams) (db.AppTimelineBranch, error)
	DeleteAllAppTimelineBranches(ctx context.Context, timelineID string) error

	UpsertAppTimelineSnapshot(ctx context.Context, arg db.UpsertAppTimelineSnapshotParams) (db.AppTimelineSnapshot, error)
	DeleteAppTimelineSnapshotsFrom(ctx context.Context, arg db.DeleteAppTimelineSnapshotsFromParams) error
	DeleteAllAppTimelineSnapshots(ctx context.Context, timelineID string) error
	PruneAppTimelineSnapshots(ctx context.Context, arg db.PruneAppTimelineSnapshotsParams) error

	GetUserByLowerUsername(ctx context.Context, lowerUsername string) (db.User, error)
}

// AppTimelineTxBeginner opens transactions for per-timeline advisory locks.
// Those locks serialize membership changes and append/rewrite/snapshot writes so the truncate +
// insert + head-seq update lands atomically and gap checks cannot race.
// Transactions must use READ COMMITTED (the PostgreSQL default) so authority
// reads see membership changes committed while waiting for the lock.
// Satisfied by *pgxpool.Pool. When nil (store-only test doubles), writes run
// unserialized against the store directly.
type AppTimelineTxBeginner interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

// AppTimelineServiceOption customizes an AppTimelineService.
type AppTimelineServiceOption func(*AppTimelineService)

// WithAppTimelineTxBeginner wires the transaction opener (production: the
// pgxpool.Pool).
func WithAppTimelineTxBeginner(tx AppTimelineTxBeginner) AppTimelineServiceOption {
	return func(s *AppTimelineService) {
		s.txBeginner = tx
	}
}

// NewAppTimelineService constructs the service.
func NewAppTimelineService(store AppTimelineStore, opts ...AppTimelineServiceOption) *AppTimelineService {
	s := &AppTimelineService{store: store}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// Timeline roles (same ladder as pair sessions; viewers sync, editors write).
const (
	AppTimelineRoleOwner  = "owner"
	AppTimelineRoleEditor = "editor"
	AppTimelineRoleViewer = "viewer"
)

// AppTimelineDumpVersion is the only dump format this service accepts
// (multi's TimelineDump.version).
const AppTimelineDumpVersion = 1

// MaxAppTimelinesPerOwner bounds live timelines per owner. The app uses one
// ('default'); the cap only stops a runaway client from parking unbounded
// per-client_key rows.
const MaxAppTimelinesPerOwner = 20

// MaxAppTimelineEventBytes bounds one serialized machine event. Machine
// events are UI-intent records (chat lines, flow transitions), not payload
// storage; 64 KiB is far beyond any real event while keeping shape rows sane.
const MaxAppTimelineEventBytes = 64 << 10

// MaxAppTimelineAppendEvents bounds one append batch.
const MaxAppTimelineAppendEvents = 500

// MaxAppTimelineRewriteBytes bounds the total payload bytes of one rewrite
// (whole-dump) request, matching the route's 4 MiB body cap.
const MaxAppTimelineRewriteBytes = 4 << 20

// MaxAppTimelineRewriteEvents bounds the total event count (live line plus
// sealed branch events) of one rewrite, so a dump of tiny events cannot turn
// into hundreds of thousands of row inserts.
const MaxAppTimelineRewriteEvents = 10000

// MaxAppTimelineSnapshotBytes bounds one serialized machine snapshot.
const MaxAppTimelineSnapshotBytes = 512 << 10

// AppTimelineSnapshotKeep is the pruned snapshot window (newest N by seq).
const AppTimelineSnapshotKeep = 8

// AppTimelineEventWrite is one sequence-numbered event in an append batch.
type AppTimelineEventWrite struct {
	Seq     int64
	Payload json.RawMessage
}

// AppTimelineBranchWrite is one sealed fork branch in a rewrite dump.
type AppTimelineBranchWrite struct {
	FromSeq int64
	Events  []json.RawMessage
}

// AppTimelineDump is the whole-log rewrite payload (multi's TimelineDump):
// the live event line positionally plus the sealed branches.
type AppTimelineDump struct {
	Version  int
	Events   []json.RawMessage
	Branches []AppTimelineBranchWrite
}

// AppTimelineResolution is a timeline plus the caller's effective role.
type AppTimelineResolution struct {
	Timeline db.AppTimeline
	Role     string
	// Created is true when FindOrCreate minted the timeline on this call.
	Created bool
}

// withAppTimelineMutation serializes writes for one timeline across API
// instances (transaction-scoped advisory lock), mirroring
// withPairSessionMutation: a direct *db.Queries store is rebound to the lock
// transaction so truncate + inserts + head update commit atomically.
func (s *AppTimelineService) withAppTimelineMutation(ctx context.Context, timelineID string, fn func(*AppTimelineService) error) error {
	return s.withAppTimelineLock(ctx, "app-timeline:"+timelineID, fn)
}

// withAppTimelineOwnerLock serializes timeline creation for one owner so the
// MaxAppTimelinesPerOwner count and the insert commit as one step.
func (s *AppTimelineService) withAppTimelineOwnerLock(ctx context.Context, ownerUserID int64, fn func(*AppTimelineService) error) error {
	return s.withAppTimelineLock(ctx, "app-timeline-owner:"+strconv.FormatInt(ownerUserID, 10), fn)
}

func (s *AppTimelineService) withAppTimelineLock(ctx context.Context, lockKey string, fn func(*AppTimelineService) error) error {
	if s.txBeginner == nil {
		return fn(s)
	}
	tx, err := s.txBeginner.Begin(ctx)
	if err != nil {
		return pkgerrors.Internal("begin app timeline mutation: " + err.Error())
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext($1))", lockKey); err != nil {
		return pkgerrors.Internal("lock app timeline mutation: " + err.Error())
	}
	txService := *s
	if _, ok := s.store.(*db.Queries); ok {
		txService.store = db.New(tx)
	}
	txService.txBeginner = nil
	if err := fn(&txService); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return pkgerrors.Internal("commit app timeline mutation: " + err.Error())
	}
	return nil
}

// resolve loads a live timeline and computes the caller's role. Unknown
// timeline and non-member are the same uniform NotFound so the API is not an
// existence oracle (the realtime gateway makes the same choice with 403; REST
// prefers 404 for unresolvable resources).
func (s *AppTimelineService) resolve(ctx context.Context, userID int64, timelineID string) (db.AppTimeline, string, error) {
	timeline, err := s.store.GetAppTimeline(ctx, timelineID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return db.AppTimeline{}, "", pkgerrors.NotFound("timeline not found")
		}
		return db.AppTimeline{}, "", pkgerrors.Internal("load timeline: " + err.Error())
	}
	if timeline.OwnerUserID == userID {
		return timeline, AppTimelineRoleOwner, nil
	}
	member, err := s.store.GetLiveAppTimelineMember(ctx, db.GetLiveAppTimelineMemberParams{
		TimelineID: timelineID,
		UserID:     userID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return db.AppTimeline{}, "", pkgerrors.NotFound("timeline not found")
		}
		return db.AppTimeline{}, "", pkgerrors.Internal("load timeline membership: " + err.Error())
	}
	return timeline, member.Role, nil
}

// requireEditor asserts the caller may write the timeline (owner or editor).
func requireAppTimelineEditor(role string) error {
	if role == AppTimelineRoleOwner || role == AppTimelineRoleEditor {
		return nil
	}
	return pkgerrors.Forbidden("timeline is read-only for viewers")
}

func normalizeAppTimelineClientKey(clientKey string) (string, error) {
	clientKey = strings.TrimSpace(clientKey)
	if clientKey == "" {
		clientKey = "default"
	}
	if len(clientKey) > 128 {
		return "", pkgerrors.BadRequest("client_key must be at most 128 characters")
	}
	return clientKey, nil
}

// FindOrCreate returns the caller's timeline for clientKey (default:
// "default"), minting it (plus the owner member row) on first use. Race-safe:
// the partial-unique conflict target makes the losing concurrent create
// re-read the winner.
func (s *AppTimelineService) FindOrCreate(ctx context.Context, ownerUserID int64, clientKey string) (AppTimelineResolution, error) {
	clientKey, err := normalizeAppTimelineClientKey(clientKey)
	if err != nil {
		return AppTimelineResolution{}, err
	}

	byKey := db.GetAppTimelineByOwnerClientKeyParams{OwnerUserID: ownerUserID, ClientKey: clientKey}
	timeline, err := s.store.GetAppTimelineByOwnerClientKey(ctx, byKey)
	if err == nil {
		s.ensureOwnerMember(ctx, timeline)
		return AppTimelineResolution{Timeline: timeline, Role: AppTimelineRoleOwner}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return AppTimelineResolution{}, pkgerrors.Internal("load timeline: " + err.Error())
	}

	var resolution AppTimelineResolution
	err = s.withAppTimelineOwnerLock(ctx, ownerUserID, func(tx *AppTimelineService) error {
		resolution, err = tx.createAppTimelineUnderOwnerLock(ctx, ownerUserID, byKey)
		return err
	})
	if err != nil {
		return AppTimelineResolution{}, err
	}
	return resolution, nil
}

// createAppTimelineUnderOwnerLock counts and inserts while the caller holds
// the owner lock, so concurrent creates for different client keys cannot
// both pass the cap check.
func (s *AppTimelineService) createAppTimelineUnderOwnerLock(ctx context.Context, ownerUserID int64, byKey db.GetAppTimelineByOwnerClientKeyParams) (AppTimelineResolution, error) {
	count, err := s.store.CountAppTimelinesForOwner(ctx, ownerUserID)
	if err != nil {
		return AppTimelineResolution{}, pkgerrors.Internal("count timelines: " + err.Error())
	}
	if count >= MaxAppTimelinesPerOwner {
		// A concurrent request may have created this client key while we
		// waited for the lock; that row is the caller's, not a new one.
		if timeline, getErr := s.store.GetAppTimelineByOwnerClientKey(ctx, byKey); getErr == nil {
			s.ensureOwnerMember(ctx, timeline)
			return AppTimelineResolution{Timeline: timeline, Role: AppTimelineRoleOwner}, nil
		}
		return AppTimelineResolution{}, pkgerrors.QuotaExceeded("too many timelines; delete unused client keys first")
	}

	timeline, err := s.store.CreateAppTimeline(ctx, db.CreateAppTimelineParams{OwnerUserID: ownerUserID, ClientKey: byKey.ClientKey})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Lost the create race: the conflict target swallowed the insert.
			timeline, err = s.store.GetAppTimelineByOwnerClientKey(ctx, byKey)
			if err != nil {
				return AppTimelineResolution{}, pkgerrors.Internal("load timeline after create race: " + err.Error())
			}
			s.ensureOwnerMember(ctx, timeline)
			return AppTimelineResolution{Timeline: timeline, Role: AppTimelineRoleOwner}, nil
		}
		return AppTimelineResolution{}, pkgerrors.Internal("create timeline: " + err.Error())
	}
	s.ensureOwnerMember(ctx, timeline)
	return AppTimelineResolution{Timeline: timeline, Role: AppTimelineRoleOwner, Created: true}, nil
}

// ensureOwnerMember records/repairs the owner's member row. Best-effort:
// ownership authority is app_timelines.owner_user_id (resolve() checks it
// first), the member row exists so the membership-authorized realtime streams
// and future pairing see the owner uniformly. Owner rows are never revoked
// (RevokeAppTimelineMember excludes role='owner'), so the upsert's
// no-resurrect guard cannot drop this write.
func (s *AppTimelineService) ensureOwnerMember(ctx context.Context, timeline db.AppTimeline) {
	_, _ = s.store.UpsertAppTimelineMember(ctx, db.UpsertAppTimelineMemberParams{
		TimelineID: timeline.ID,
		UserID:     timeline.OwnerUserID,
		Role:       AppTimelineRoleOwner,
	})
}

// Get returns the timeline plus the caller's role (owner or live member).
func (s *AppTimelineService) Get(ctx context.Context, userID int64, timelineID string) (AppTimelineResolution, error) {
	timeline, role, err := s.resolve(ctx, userID, timelineID)
	if err != nil {
		return AppTimelineResolution{}, err
	}
	return AppTimelineResolution{Timeline: timeline, Role: role}, nil
}

// validateAppTimelineEvents checks an append batch: bounded, valid JSON,
// strictly contiguous ascending seqs.
func validateAppTimelineEvents(events []AppTimelineEventWrite) error {
	if len(events) == 0 {
		return pkgerrors.BadRequest("events must not be empty")
	}
	if len(events) > MaxAppTimelineAppendEvents {
		return pkgerrors.BadRequest("append batch exceeds the event limit")
	}
	if events[0].Seq < 0 {
		return pkgerrors.BadRequest("event seq must be non-negative")
	}
	for i, ev := range events {
		if ev.Seq != events[0].Seq+int64(i) {
			return pkgerrors.BadRequest("event seqs must be strictly contiguous ascending")
		}
		if len(ev.Payload) == 0 || !json.Valid(ev.Payload) {
			return pkgerrors.BadRequest("event payload must be valid JSON")
		}
		if len(ev.Payload) > MaxAppTimelineEventBytes {
			return pkgerrors.BadRequest("event payload exceeds the 64 KiB limit")
		}
	}
	return nil
}

// AppendEvents applies one contiguous event batch at its first seq,
// truncating any existing tail from that seq (the client's append-at-seq
// fork-overwrite semantics) and invalidating snapshots past the boundary.
// A first seq beyond head_seq is a gap — 409 so the client resyncs from the
// shape stream and retries.
func (s *AppTimelineService) AppendEvents(ctx context.Context, userID int64, timelineID string, events []AppTimelineEventWrite) error {
	_, role, err := s.resolve(ctx, userID, timelineID)
	if err != nil {
		return err
	}
	if err := requireAppTimelineEditor(role); err != nil {
		return err
	}
	if err := validateAppTimelineEvents(events); err != nil {
		return err
	}

	firstSeq := events[0].Seq
	lastSeq := events[len(events)-1].Seq
	return s.withAppTimelineMutation(ctx, timelineID, func(s *AppTimelineService) error {
		// Re-read authority and head under the same lock as membership changes.
		timeline, role, err := s.resolve(ctx, userID, timelineID)
		if err != nil {
			return err
		}
		if err := requireAppTimelineEditor(role); err != nil {
			return err
		}
		if firstSeq > timeline.HeadSeq {
			return pkgerrors.Conflict("event seq is ahead of the timeline head; resync and retry")
		}
		if err := s.store.DeleteAppTimelineEventsFrom(ctx, db.DeleteAppTimelineEventsFromParams{TimelineID: timelineID, Seq: firstSeq}); err != nil {
			return pkgerrors.Internal("truncate events: " + err.Error())
		}
		for _, ev := range events {
			if _, err := s.store.InsertAppTimelineEvent(ctx, db.InsertAppTimelineEventParams{
				TimelineID: timelineID,
				Seq:        ev.Seq,
				Payload:    ev.Payload,
			}); err != nil {
				return pkgerrors.Internal("insert event: " + err.Error())
			}
		}
		if err := s.store.DeleteAppTimelineSnapshotsFrom(ctx, db.DeleteAppTimelineSnapshotsFromParams{TimelineID: timelineID, Seq: firstSeq}); err != nil {
			return pkgerrors.Internal("invalidate snapshots: " + err.Error())
		}
		if _, err := s.store.TouchAppTimeline(ctx, db.TouchAppTimelineParams{ID: timelineID, HeadSeq: lastSeq + 1}); err != nil {
			return pkgerrors.Internal("advance timeline head: " + err.Error())
		}
		return nil
	})
}

// validateAppTimelineDump checks a rewrite payload's version and budgets.
func validateAppTimelineDump(dump AppTimelineDump) error {
	if dump.Version != AppTimelineDumpVersion {
		return pkgerrors.BadRequest("unsupported dump version")
	}
	totalBytes := 0
	totalEvents := len(dump.Events)
	for _, ev := range dump.Events {
		if len(ev) == 0 || !json.Valid(ev) {
			return pkgerrors.BadRequest("event payload must be valid JSON")
		}
		if len(ev) > MaxAppTimelineEventBytes {
			return pkgerrors.BadRequest("event payload exceeds the 64 KiB limit")
		}
		totalBytes += len(ev)
	}
	for _, branch := range dump.Branches {
		if branch.FromSeq < 0 {
			return pkgerrors.BadRequest("branch from_seq must be non-negative")
		}
		totalEvents += len(branch.Events)
		for _, ev := range branch.Events {
			if len(ev) == 0 || !json.Valid(ev) {
				return pkgerrors.BadRequest("branch event payload must be valid JSON")
			}
			if len(ev) > MaxAppTimelineEventBytes {
				return pkgerrors.BadRequest("branch event payload exceeds the 64 KiB limit")
			}
			totalBytes += len(ev)
		}
	}
	if totalEvents > MaxAppTimelineRewriteEvents {
		return pkgerrors.BadRequest("dump exceeds the total event limit")
	}
	if totalBytes > MaxAppTimelineRewriteBytes {
		return pkgerrors.BadRequest("dump exceeds the 4 MiB payload limit")
	}
	return nil
}

// Rewrite replaces the whole log with the dump (multi's fork/restore path
// rewrites whole tables instead of diffing). Empty events + branches = clear.
// Snapshots are dropped: a rewritten log invalidates every replay point.
func (s *AppTimelineService) Rewrite(ctx context.Context, userID int64, timelineID string, dump AppTimelineDump) error {
	_, role, err := s.resolve(ctx, userID, timelineID)
	if err != nil {
		return err
	}
	if err := requireAppTimelineEditor(role); err != nil {
		return err
	}
	if err := validateAppTimelineDump(dump); err != nil {
		return err
	}

	return s.withAppTimelineMutation(ctx, timelineID, func(s *AppTimelineService) error {
		_, role, err := s.resolve(ctx, userID, timelineID)
		if err != nil {
			return err
		}
		if err := requireAppTimelineEditor(role); err != nil {
			return err
		}
		if err := s.store.DeleteAllAppTimelineEvents(ctx, timelineID); err != nil {
			return pkgerrors.Internal("clear events: " + err.Error())
		}
		if err := s.store.DeleteAllAppTimelineBranches(ctx, timelineID); err != nil {
			return pkgerrors.Internal("clear branches: " + err.Error())
		}
		if err := s.store.DeleteAllAppTimelineSnapshots(ctx, timelineID); err != nil {
			return pkgerrors.Internal("clear snapshots: " + err.Error())
		}
		for i, ev := range dump.Events {
			if _, err := s.store.InsertAppTimelineEvent(ctx, db.InsertAppTimelineEventParams{
				TimelineID: timelineID,
				Seq:        int64(i),
				Payload:    ev,
			}); err != nil {
				return pkgerrors.Internal("insert event: " + err.Error())
			}
		}
		for i, branch := range dump.Branches {
			events, err := json.Marshal(branch.Events)
			if err != nil {
				return pkgerrors.Internal("encode branch events: " + err.Error())
			}
			if _, err := s.store.InsertAppTimelineBranch(ctx, db.InsertAppTimelineBranchParams{
				TimelineID: timelineID,
				Ordinal:    int32(i),
				FromSeq:    branch.FromSeq,
				Events:     events,
			}); err != nil {
				return pkgerrors.Internal("insert branch: " + err.Error())
			}
		}
		if _, err := s.store.TouchAppTimeline(ctx, db.TouchAppTimelineParams{ID: timelineID, HeadSeq: int64(len(dump.Events))}); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return pkgerrors.NotFound("timeline not found")
			}
			return pkgerrors.Internal("advance timeline head: " + err.Error())
		}
		return nil
	})
}

// PutSnapshot upserts a serialized machine snapshot at seq (state after
// replaying events [0, seq)) and prunes to the newest window.
func (s *AppTimelineService) PutSnapshot(ctx context.Context, userID int64, timelineID string, seq int64, state json.RawMessage) error {
	_, role, err := s.resolve(ctx, userID, timelineID)
	if err != nil {
		return err
	}
	if err := requireAppTimelineEditor(role); err != nil {
		return err
	}
	if seq < 0 {
		return pkgerrors.BadRequest("snapshot seq must be non-negative")
	}
	if len(state) == 0 || !json.Valid(state) {
		return pkgerrors.BadRequest("snapshot state must be valid JSON")
	}
	if len(state) > MaxAppTimelineSnapshotBytes {
		return pkgerrors.BadRequest("snapshot state exceeds the 512 KiB limit")
	}

	return s.withAppTimelineMutation(ctx, timelineID, func(s *AppTimelineService) error {
		timeline, role, err := s.resolve(ctx, userID, timelineID)
		if err != nil {
			return err
		}
		if err := requireAppTimelineEditor(role); err != nil {
			return err
		}
		if seq > timeline.HeadSeq {
			return pkgerrors.Conflict("snapshot seq is ahead of the timeline head; resync and retry")
		}
		if _, err := s.store.UpsertAppTimelineSnapshot(ctx, db.UpsertAppTimelineSnapshotParams{
			TimelineID: timelineID,
			Seq:        seq,
			State:      state,
		}); err != nil {
			return pkgerrors.Internal("save snapshot: " + err.Error())
		}
		if err := s.store.PruneAppTimelineSnapshots(ctx, db.PruneAppTimelineSnapshotsParams{
			TimelineID: timelineID,
			KeepCount:  AppTimelineSnapshotKeep,
		}); err != nil {
			return pkgerrors.Internal("prune snapshots: " + err.Error())
		}
		return nil
	})
}

// Members lists live members with public profile fields (any member may look).
func (s *AppTimelineService) Members(ctx context.Context, userID int64, timelineID string) ([]db.ListLiveAppTimelineMemberProfilesRow, error) {
	if _, _, err := s.resolve(ctx, userID, timelineID); err != nil {
		return nil, err
	}
	members, err := s.store.ListLiveAppTimelineMemberProfiles(ctx, timelineID)
	if err != nil {
		return nil, pkgerrors.Internal("list timeline members: " + err.Error())
	}
	return members, nil
}

// AddMember grants a user editor/viewer membership (owner only). Explicit
// re-adds resurrect previously revoked members (ReAddAppTimelineMember).
func (s *AppTimelineService) AddMember(ctx context.Context, actorID int64, timelineID, username, role string) (db.AppTimelineMember, error) {
	timeline, actorRole, err := s.resolve(ctx, actorID, timelineID)
	if err != nil {
		return db.AppTimelineMember{}, err
	}
	if actorRole != AppTimelineRoleOwner {
		return db.AppTimelineMember{}, pkgerrors.Forbidden("only the timeline owner can manage members")
	}
	if role != AppTimelineRoleEditor && role != AppTimelineRoleViewer {
		return db.AppTimelineMember{}, pkgerrors.BadRequest("role must be editor or viewer")
	}
	username = strings.TrimSpace(username)
	if username == "" {
		return db.AppTimelineMember{}, pkgerrors.BadRequest("username is required")
	}
	user, err := s.store.GetUserByLowerUsername(ctx, strings.ToLower(username))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return db.AppTimelineMember{}, pkgerrors.NotFound("user not found")
		}
		return db.AppTimelineMember{}, pkgerrors.Internal("look up user: " + err.Error())
	}
	if user.ID == timeline.OwnerUserID {
		return db.AppTimelineMember{}, pkgerrors.BadRequest("the owner is already a member")
	}
	var member db.AppTimelineMember
	err = s.withAppTimelineMutation(ctx, timelineID, func(s *AppTimelineService) error {
		_, actorRole, err := s.resolve(ctx, actorID, timelineID)
		if err != nil {
			return err
		}
		if actorRole != AppTimelineRoleOwner {
			return pkgerrors.Forbidden("only the timeline owner can manage members")
		}
		member, err = s.store.ReAddAppTimelineMember(ctx, db.ReAddAppTimelineMemberParams{
			TimelineID: timelineID,
			UserID:     user.ID,
			Role:       role,
		})
		if err != nil {
			return pkgerrors.Internal("add timeline member: " + err.Error())
		}
		return nil
	})
	if err != nil {
		return db.AppTimelineMember{}, err
	}
	return member, nil
}

// RemoveMember revokes a member (owner only; the owner row is irrevocable).
func (s *AppTimelineService) RemoveMember(ctx context.Context, actorID int64, timelineID string, memberUserID int64) error {
	_, actorRole, err := s.resolve(ctx, actorID, timelineID)
	if err != nil {
		return err
	}
	if actorRole != AppTimelineRoleOwner {
		return pkgerrors.Forbidden("only the timeline owner can manage members")
	}
	return s.withAppTimelineMutation(ctx, timelineID, func(s *AppTimelineService) error {
		_, actorRole, err := s.resolve(ctx, actorID, timelineID)
		if err != nil {
			return err
		}
		if actorRole != AppTimelineRoleOwner {
			return pkgerrors.Forbidden("only the timeline owner can manage members")
		}
		if _, err := s.store.RevokeAppTimelineMember(ctx, db.RevokeAppTimelineMemberParams{
			TimelineID: timelineID,
			UserID:     memberUserID,
		}); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return pkgerrors.NotFound("no such member")
			}
			return pkgerrors.Internal("revoke timeline member: " + err.Error())
		}
		return nil
	})
}

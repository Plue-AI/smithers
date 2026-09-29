package services

import (
	"context"
	stdErrors "errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// BranchLockStaleAfter is the liveness window for a branch lock: the holder's
// client heartbeats while its workspace is open, and a lock whose heartbeat is
// older than this may be taken over by the next acquirer. Long enough that a
// flaky network never steals a live lock, short enough that a crashed holder
// cannot wedge a branch.
const BranchLockStaleAfter = 5 * time.Minute

// BranchLockQuerier is the narrow sqlc surface BranchLockService needs;
// *db.Queries satisfies it implicitly.
type BranchLockQuerier interface {
	AcquireBranchLockInsert(ctx context.Context, arg db.AcquireBranchLockInsertParams) (db.BranchLock, error)
	GetBranchLock(ctx context.Context, arg db.GetBranchLockParams) (db.BranchLock, error)
	TakeOverStaleBranchLock(ctx context.Context, arg db.TakeOverStaleBranchLockParams) (db.BranchLock, error)
	HeartbeatBranchLock(ctx context.Context, arg db.HeartbeatBranchLockParams) (int64, error)
	ReleaseBranchLock(ctx context.Context, arg db.ReleaseBranchLockParams) (int64, error)
	CreateBranchLockJoinRequest(ctx context.Context, arg db.CreateBranchLockJoinRequestParams) (db.BranchLockJoinRequest, error)
	GetBranchLockJoinRequest(ctx context.Context, id int64) (db.BranchLockJoinRequest, error)
	GetBranchLockJoinRequestForRequester(ctx context.Context, arg db.GetBranchLockJoinRequestForRequesterParams) (db.BranchLockJoinRequest, error)
	HasApprovedBranchLockJoin(ctx context.Context, arg db.HasApprovedBranchLockJoinParams) (bool, error)
	ListPendingBranchLockJoinRequests(ctx context.Context, arg db.ListPendingBranchLockJoinRequestsParams) ([]db.BranchLockJoinRequest, error)
	ListPendingBranchLockJoinRequestsForHolder(ctx context.Context, userID int64) ([]db.BranchLockJoinRequest, error)
	ResolveBranchLockJoinRequest(ctx context.Context, arg db.ResolveBranchLockJoinRequestParams) (db.BranchLockJoinRequest, error)
	GetUsernameByID(ctx context.Context, id int64) (string, error)
}

// BranchLockJoinAuthorizer is the plan gate for asking to join an occupied
// branch. Satisfied by *BillingService.AuthorizeBranchLockJoin.
type BranchLockJoinAuthorizer interface {
	AuthorizeBranchLockJoin(ctx context.Context, userID int64) error
}

// BranchLockNotifier is the notification surface the service uses to tell a
// holder about a join request and a requester about the decision. Satisfied
// by *NotificationService.
type BranchLockNotifier interface {
	Create(ctx context.Context, arg db.CreateNotificationParams) (NotificationResponse, error)
}

type BranchLockService struct {
	queries    BranchLockQuerier
	authorizer BranchLockJoinAuthorizer
	notifier   BranchLockNotifier
}

type BranchLockServiceOption func(*BranchLockService)

func WithBranchLockJoinAuthorizer(authorizer BranchLockJoinAuthorizer) BranchLockServiceOption {
	return func(s *BranchLockService) { s.authorizer = authorizer }
}

func WithBranchLockNotifier(notifier BranchLockNotifier) BranchLockServiceOption {
	return func(s *BranchLockService) { s.notifier = notifier }
}

func NewBranchLockService(queries BranchLockQuerier, opts ...BranchLockServiceOption) *BranchLockService {
	s := &BranchLockService{queries: queries}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

type AcquireBranchLockInput struct {
	RepositoryID int64
	Branch       string
	UserID       int64
	// WorkspaceID is optional: the lock can be taken before the workspace
	// exists (the client's open flow acquires first, then branches).
	WorkspaceID string
}

type BranchLockResponse struct {
	RepositoryID int64  `json:"repository_id"`
	Branch       string `json:"branch"`
	// Status is "acquired" (the caller now holds or shares the lock) or
	// "took_over" (the previous holder's heartbeat had gone stale).
	Status         string `json:"status"`
	HolderUsername string `json:"holder_username"`
	WorkspaceID    string `json:"workspace_id,omitempty"`
	// Shared is true when the caller did not take the lock but rides on an
	// approved join request.
	Shared bool `json:"shared"`
}

// BranchLockHeldDetails is the structured payload attached to the 409
// conflict (APIError.Details) so the client can render the occupied-branch
// dialog without a second round trip.
type BranchLockHeldDetails struct {
	HolderUsername string `json:"holder_username"`
	Branch         string `json:"branch"`
	CanRequestJoin bool   `json:"can_request_join"`
	PendingRequest bool   `json:"pending_request"`
}

type BranchLockJoinRequestResponse struct {
	ID                int64   `json:"id"`
	RepositoryID      int64   `json:"repository_id"`
	Branch            string  `json:"branch"`
	RequesterUsername string  `json:"requester_username"`
	Status            string  `json:"status"`
	CreatedAt         string  `json:"created_at"`
	ResolvedAt        *string `json:"resolved_at,omitempty"`
}

func mapBranchLockJoinRequest(row db.BranchLockJoinRequest, requesterUsername string) BranchLockJoinRequestResponse {
	response := BranchLockJoinRequestResponse{
		ID:                row.ID,
		RepositoryID:      row.RepositoryID,
		Branch:            row.Branch,
		RequesterUsername: requesterUsername,
		Status:            row.Status,
		CreatedAt:         row.CreatedAt.UTC().Format(time.RFC3339),
	}
	if row.ResolvedAt.Valid {
		resolved := row.ResolvedAt.Time.UTC().Format(time.RFC3339)
		response.ResolvedAt = &resolved
	}
	return response
}

func (s *BranchLockService) username(ctx context.Context, userID int64) string {
	username, err := s.queries.GetUsernameByID(ctx, userID)
	if err != nil {
		return ""
	}
	return username
}

// AcquireBranchLock takes the (repository, branch) lock for the caller. One
// person checks out a branch at a time: a live lock held by someone else is a
// 409 (code branch_lock_held) carrying BranchLockHeldDetails; a stale lock is
// taken over; an approved join request lets the caller share the holder's
// lock. Re-acquiring your own lock simply renews it.
func (s *BranchLockService) AcquireBranchLock(ctx context.Context, input AcquireBranchLockInput) (BranchLockResponse, error) {
	if input.Branch == "" {
		return BranchLockResponse{}, pkgerrors.BadRequest("branch is required")
	}
	inserted, err := s.queries.AcquireBranchLockInsert(ctx, db.AcquireBranchLockInsertParams{
		RepositoryID: input.RepositoryID,
		Branch:       input.Branch,
		UserID:       input.UserID,
		WorkspaceID:  stringToUUID(input.WorkspaceID),
	})
	if err == nil {
		return BranchLockResponse{
			RepositoryID:   inserted.RepositoryID,
			Branch:         inserted.Branch,
			Status:         "acquired",
			HolderUsername: s.username(ctx, inserted.UserID),
			WorkspaceID:    UUIDString(inserted.WorkspaceID),
		}, nil
	}
	if !isUniqueViolation(err) {
		return BranchLockResponse{}, pkgerrors.Internal("failed to acquire branch lock")
	}

	lock, err := s.queries.GetBranchLock(ctx, db.GetBranchLockParams{
		RepositoryID: input.RepositoryID,
		Branch:       input.Branch,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			// The conflicting row vanished between insert and select (holder
			// released): the caller may retry the acquire.
			return BranchLockResponse{}, pkgerrors.Conflict("branch lock was just released; retry")
		}
		return BranchLockResponse{}, pkgerrors.Internal("failed to load branch lock").WithCause(err)
	}

	if lock.UserID == input.UserID {
		if _, err := s.queries.HeartbeatBranchLock(ctx, db.HeartbeatBranchLockParams{
			RepositoryID: input.RepositoryID,
			Branch:       input.Branch,
			UserID:       input.UserID,
		}); err != nil {
			return BranchLockResponse{}, pkgerrors.Internal("failed to renew branch lock").WithCause(err)
		}
		return BranchLockResponse{
			RepositoryID:   lock.RepositoryID,
			Branch:         lock.Branch,
			Status:         "acquired",
			HolderUsername: s.username(ctx, lock.UserID),
			WorkspaceID:    UUIDString(lock.WorkspaceID),
		}, nil
	}

	// A stale lock may be taken over: the previous holder crashed or left
	// without releasing.
	taken, err := s.queries.TakeOverStaleBranchLock(ctx, db.TakeOverStaleBranchLockParams{
		RepositoryID: input.RepositoryID,
		Branch:       input.Branch,
		UserID:       input.UserID,
		WorkspaceID:  stringToUUID(input.WorkspaceID),
		HeartbeatAt:  time.Now().Add(-BranchLockStaleAfter),
	})
	if err == nil {
		return BranchLockResponse{
			RepositoryID:   taken.RepositoryID,
			Branch:         taken.Branch,
			Status:         "took_over",
			HolderUsername: s.username(ctx, taken.UserID),
			WorkspaceID:    UUIDString(taken.WorkspaceID),
		}, nil
	}
	if !stdErrors.Is(err, pgx.ErrNoRows) {
		return BranchLockResponse{}, pkgerrors.Internal("failed to take over branch lock")
	}

	// The lock is live and held by someone else. A join request the current
	// holder approved for this lock generation is the membership that lets the
	// caller share it; an approval from an earlier holder does not count.
	approved, err := s.queries.HasApprovedBranchLockJoin(ctx, db.HasApprovedBranchLockJoinParams{
		RepositoryID:   input.RepositoryID,
		Branch:         input.Branch,
		RequesterID:    input.UserID,
		LockGeneration: lock.Generation,
	})
	if err != nil {
		return BranchLockResponse{}, pkgerrors.Internal("failed to check branch-lock membership").WithCause(err)
	}
	if approved {
		return BranchLockResponse{
			RepositoryID:   lock.RepositoryID,
			Branch:         lock.Branch,
			Status:         "acquired",
			HolderUsername: s.username(ctx, lock.UserID),
			WorkspaceID:    UUIDString(lock.WorkspaceID),
			Shared:         true,
		}, nil
	}

	// Report the holder plus everything the client needs to render the
	// occupied-branch dialog in one shot: whether this user may ask to join
	// (paid plan) or must upgrade first, and whether an ask is already open.
	holderUsername := s.username(ctx, lock.UserID)
	canRequestJoin := false
	if s.authorizer != nil {
		if err := s.authorizer.AuthorizeBranchLockJoin(ctx, input.UserID); err == nil {
			canRequestJoin = true
		}
	}
	pendingRequest := false
	if latest, err := s.queries.GetBranchLockJoinRequestForRequester(ctx, db.GetBranchLockJoinRequestForRequesterParams{
		RepositoryID:   input.RepositoryID,
		Branch:         input.Branch,
		RequesterID:    input.UserID,
		LockGeneration: lock.Generation,
	}); err == nil {
		pendingRequest = latest.Status == "pending"
	}
	return BranchLockResponse{}, &pkgerrors.APIError{
		Status:  409,
		Code:    pkgerrors.CodeBranchLockHeld,
		Message: "branch " + input.Branch + " is checked out by " + holderUsername,
		Details: BranchLockHeldDetails{
			HolderUsername: holderUsername,
			Branch:         input.Branch,
			CanRequestJoin: canRequestJoin,
			PendingRequest: pendingRequest,
		},
	}
}

// HeartbeatBranchLock renews the lock the caller holds or shares as a joiner
// approved for the current lock generation. NotFound when the caller no
// longer holds or shares it (released, or taken over after a stale window)
// so the client stops beating and can re-acquire.
func (s *BranchLockService) HeartbeatBranchLock(ctx context.Context, input AcquireBranchLockInput) error {
	rows, err := s.queries.HeartbeatBranchLock(ctx, db.HeartbeatBranchLockParams{
		RepositoryID: input.RepositoryID,
		Branch:       input.Branch,
		UserID:       input.UserID,
	})
	if err != nil {
		return pkgerrors.Internal("failed to heartbeat branch lock").WithCause(err)
	}
	if rows == 0 {
		return pkgerrors.NotFound("branch lock not held")
	}
	return nil
}

// ReleaseBranchLock drops the caller's lock. Idempotent: releasing a lock you
// do not hold is a no-op.
func (s *BranchLockService) ReleaseBranchLock(ctx context.Context, input AcquireBranchLockInput) error {
	if _, err := s.queries.ReleaseBranchLock(ctx, db.ReleaseBranchLockParams{
		RepositoryID: input.RepositoryID,
		Branch:       input.Branch,
		UserID:       input.UserID,
	}); err != nil {
		return pkgerrors.Internal("failed to release branch lock").WithCause(err)
	}
	return nil
}

type RequestBranchLockJoinInput struct {
	RepositoryID int64
	Branch       string
	UserID       int64
	Username     string
}

// RequestBranchLockJoin records the caller's ask to join an occupied branch
// and notifies the holder. Plan-gated (Hobby or above — joining a held branch
// is multiplayer participation); a free user is Forbidden, which the client
// turns into the request-upgrade path. Asking again while an ask is pending
// returns the pending request unchanged.
func (s *BranchLockService) RequestBranchLockJoin(ctx context.Context, input RequestBranchLockJoinInput) (BranchLockJoinRequestResponse, error) {
	lock, err := s.queries.GetBranchLock(ctx, db.GetBranchLockParams{
		RepositoryID: input.RepositoryID,
		Branch:       input.Branch,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return BranchLockJoinRequestResponse{}, pkgerrors.Conflict("branch is not locked; acquire it directly")
		}
		return BranchLockJoinRequestResponse{}, pkgerrors.Internal("failed to load branch lock").WithCause(err)
	}
	if lock.UserID == input.UserID {
		return BranchLockJoinRequestResponse{}, pkgerrors.BadRequest("you already hold this branch lock")
	}
	if lock.HeartbeatAt.Before(time.Now().Add(-BranchLockStaleAfter)) {
		return BranchLockJoinRequestResponse{}, pkgerrors.Conflict("branch lock is stale; acquire it directly")
	}

	if s.authorizer != nil {
		if err := s.authorizer.AuthorizeBranchLockJoin(ctx, input.UserID); err != nil {
			return BranchLockJoinRequestResponse{}, err
		}
	}

	if latest, err := s.queries.GetBranchLockJoinRequestForRequester(ctx, db.GetBranchLockJoinRequestForRequesterParams{
		RepositoryID:   input.RepositoryID,
		Branch:         input.Branch,
		RequesterID:    input.UserID,
		LockGeneration: lock.Generation,
	}); err == nil {
		switch latest.Status {
		case "pending":
			return mapBranchLockJoinRequest(latest, input.Username), nil
		case "approved":
			return BranchLockJoinRequestResponse{}, pkgerrors.Conflict("your join request was already approved; acquire the branch")
		}
	}

	created, err := s.queries.CreateBranchLockJoinRequest(ctx, db.CreateBranchLockJoinRequestParams{
		RepositoryID:   input.RepositoryID,
		Branch:         input.Branch,
		RequesterID:    input.UserID,
		LockGeneration: lock.Generation,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			// The lock was released or taken over between the read above and
			// the insert; the caller re-reads the holder and asks again.
			return BranchLockJoinRequestResponse{}, pkgerrors.Conflict("branch lock changed hands; retry")
		}
		if isUniqueViolation(err) {
			latest, latestErr := s.queries.GetBranchLockJoinRequestForRequester(ctx, db.GetBranchLockJoinRequestForRequesterParams{
				RepositoryID:   input.RepositoryID,
				Branch:         input.Branch,
				RequesterID:    input.UserID,
				LockGeneration: lock.Generation,
			})
			if latestErr == nil {
				return mapBranchLockJoinRequest(latest, input.Username), nil
			}
		}
		return BranchLockJoinRequestResponse{}, pkgerrors.Internal("failed to create join request").WithCause(err)
	}

	if s.notifier != nil {
		if _, err := s.notifier.Create(ctx, db.CreateNotificationParams{
			UserID:     lock.UserID,
			SourceType: "branch_lock",
			SourceID:   pgtype.Int8{Int64: created.ID, Valid: true},
			Subject:    "@" + input.Username + " asked to join " + input.Branch,
			Body:       "Approve to let them share your branch, or deny.",
		}); err != nil {
			slog.Warn("branch-lock join notification failed", "error", err, "join_request_id", created.ID)
		}
	}
	return mapBranchLockJoinRequest(created, input.Username), nil
}

// ListPendingBranchLockJoinRequests is the holder's inbox for one branch.
func (s *BranchLockService) ListPendingBranchLockJoinRequests(ctx context.Context, input AcquireBranchLockInput) ([]BranchLockJoinRequestResponse, error) {
	lock, err := s.queries.GetBranchLock(ctx, db.GetBranchLockParams{
		RepositoryID: input.RepositoryID,
		Branch:       input.Branch,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return []BranchLockJoinRequestResponse{}, nil
		}
		return nil, pkgerrors.Internal("failed to load branch lock").WithCause(err)
	}
	if lock.UserID != input.UserID {
		return nil, pkgerrors.Forbidden("only the branch holder can list join requests")
	}
	rows, err := s.queries.ListPendingBranchLockJoinRequests(ctx, db.ListPendingBranchLockJoinRequestsParams{
		RepositoryID:   input.RepositoryID,
		Branch:         input.Branch,
		LockGeneration: lock.Generation,
	})
	if err != nil {
		return nil, pkgerrors.Internal("failed to list join requests").WithCause(err)
	}
	responses := make([]BranchLockJoinRequestResponse, 0, len(rows))
	for _, row := range rows {
		responses = append(responses, mapBranchLockJoinRequest(row, s.username(ctx, row.RequesterID)))
	}
	return responses, nil
}

type DecideBranchLockJoinInput struct {
	RepositoryID  int64
	JoinRequestID int64
	ResolverID    int64
	Approve       bool
}

// DecideBranchLockJoin lets the branch holder approve (the requester may now
// share the branch) or deny a pending join request, notifying the requester.
func (s *BranchLockService) DecideBranchLockJoin(ctx context.Context, input DecideBranchLockJoinInput) (BranchLockJoinRequestResponse, error) {
	request, err := s.queries.GetBranchLockJoinRequest(ctx, input.JoinRequestID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return BranchLockJoinRequestResponse{}, pkgerrors.NotFound("join request not found")
		}
		return BranchLockJoinRequestResponse{}, pkgerrors.Internal("failed to load join request").WithCause(err)
	}
	if request.RepositoryID != input.RepositoryID {
		return BranchLockJoinRequestResponse{}, pkgerrors.NotFound("join request not found")
	}
	lock, err := s.queries.GetBranchLock(ctx, db.GetBranchLockParams{
		RepositoryID: request.RepositoryID,
		Branch:       request.Branch,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return BranchLockJoinRequestResponse{}, pkgerrors.Conflict("branch lock is gone; the request is moot")
		}
		return BranchLockJoinRequestResponse{}, pkgerrors.Internal("failed to load branch lock").WithCause(err)
	}
	if lock.UserID != input.ResolverID {
		return BranchLockJoinRequestResponse{}, pkgerrors.Forbidden("only the branch holder can decide join requests")
	}
	if request.LockGeneration != lock.Generation {
		// The request was made to an earlier holder of this branch. The
		// current holder never saw it, so it cannot be approved into their
		// lock.
		return BranchLockJoinRequestResponse{}, pkgerrors.Conflict("branch lock changed hands; the request is moot")
	}

	status := "denied"
	if input.Approve {
		status = "approved"
	}
	resolved, err := s.queries.ResolveBranchLockJoinRequest(ctx, db.ResolveBranchLockJoinRequestParams{
		ID:         input.JoinRequestID,
		Status:     status,
		ResolverID: pgtype.Int8{Int64: input.ResolverID, Valid: true},
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return BranchLockJoinRequestResponse{}, pkgerrors.Conflict("join request was already resolved")
		}
		return BranchLockJoinRequestResponse{}, pkgerrors.Internal("failed to resolve join request").WithCause(err)
	}

	if s.notifier != nil {
		verb := "denied"
		if input.Approve {
			verb = "approved"
		}
		if _, err := s.notifier.Create(ctx, db.CreateNotificationParams{
			UserID:     resolved.RequesterID,
			SourceType: "branch_lock",
			SourceID:   pgtype.Int8{Int64: resolved.ID, Valid: true},
			Subject:    "Your request to join " + resolved.Branch + " was " + verb,
			Body:       "",
		}); err != nil {
			slog.Warn("branch-lock decision notification failed", "error", err, "join_request_id", resolved.ID)
		}
	}
	return mapBranchLockJoinRequest(resolved, s.username(ctx, resolved.RequesterID)), nil
}

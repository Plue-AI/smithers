package services

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// WorkspaceAccessLevel is the minimum permission required to operate on a workspace.
type WorkspaceAccessLevel string

const (
	// WorkspaceAccessRead permits listing, viewing status, and streaming SSE.
	WorkspaceAccessRead WorkspaceAccessLevel = "read"
	// WorkspaceAccessWrite permits all mutations: suspend, resume, fork, snapshot,
	// create/destroy sessions, and access SSH credentials.
	WorkspaceAccessWrite WorkspaceAccessLevel = "write"
)

// requireWorkspaceAccess returns nil if requesterUserID either owns the
// workspace or holds an explicit share grant at or above minLevel.
//
// Access matrix:
//
//	owner + any level  → allowed
//	non-owner, share.level == "write", minLevel == "read"  → allowed
//	non-owner, share.level == "write", minLevel == "write" → allowed
//	non-owner, share.level == "read",  minLevel == "read"  → allowed
//	non-owner, share.level == "read",  minLevel == "write" → 403
//	non-owner, no share row                                 → 403
//
// The function purposefully does not distinguish "workspace not found" from
// "you are not the owner" when no explicit share exists — both return 403.
// This prevents ownership enumeration via timing or error shape differences.
func (s *WorkspaceService) requireWorkspaceAccess(ctx context.Context, workspaceID string, ownerUserID, requesterUserID int64, minLevel WorkspaceAccessLevel) error {
	if ownerUserID == requesterUserID {
		return nil
	}

	share, err := s.q.GetWorkspaceShare(ctx, db.GetWorkspaceShareParams{
		WorkspaceID:   workspaceID,
		GranteeUserID: requesterUserID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.Forbidden("access denied")
		}
		return pkgerrors.Internal("check workspace share: " + err.Error())
	}

	// read share satisfies read-level only; write share satisfies both.
	if minLevel == WorkspaceAccessWrite && share.Level != string(WorkspaceAccessWrite) {
		return pkgerrors.Forbidden("access denied: write permission required")
	}
	return nil
}

// workspaceMutationAuthorityKey marks a context whose caller already holds a
// requester's mutation authority over one workspace, so nested lifecycle steps
// reuse it instead of opening a second lock transaction.
type workspaceMutationAuthorityKey struct{}

type workspaceMutationAuthority struct {
	workspaceID string
	userID      int64
}

// withWorkspaceMutationAuthority runs fn, a mutation of row (start, resume,
// exec, preview publish, snapshot, fork), with the requester's write authority
// checked inside the same transaction that fn runs under (#3212). The owner
// needs no grant. A grantee's share row is held FOR SHARE until fn returns, so
// a revocation or demotion waits for the authorized mutation, and a mutation
// begun after it is refused. fn's own statements use the service store; the
// transaction only holds the grant.
func (s *WorkspaceService) withWorkspaceMutationAuthority(ctx context.Context, row db.Workspace, requesterID int64, fn func(context.Context) error) error {
	if requesterID == row.UserID {
		return fn(ctx)
	}
	authority := workspaceMutationAuthority{workspaceID: row.ID, userID: requesterID}
	if held, ok := ctx.Value(workspaceMutationAuthorityKey{}).(workspaceMutationAuthority); ok && held == authority {
		return fn(ctx)
	}
	held := context.WithValue(ctx, workspaceMutationAuthorityKey{}, authority)
	if s.transactions == nil {
		// Without a database transaction factory (unit stores) the check is
		// still made at mutation time, only not held.
		if err := s.requireWorkspaceAccess(ctx, row.ID, row.UserID, requesterID, WorkspaceAccessWrite); err != nil {
			return err
		}
		return fn(held)
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return pkgerrors.Internal("begin workspace mutation authority").WithCause(err)
	}
	// The transaction writes nothing; ending it releases the grant.
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	level, err := db.New(tx).LockWorkspaceShareForMutation(ctx, db.LockWorkspaceShareForMutationParams{
		WorkspaceID: row.ID, GranteeUserID: requesterID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.Forbidden("access denied")
		}
		return pkgerrors.Internal("lock workspace share").WithCause(err)
	}
	if level != string(WorkspaceAccessWrite) {
		return pkgerrors.Forbidden("access denied: write permission required")
	}
	return fn(held)
}

// withWorkspaceMutation loads a workspace the requester may write and runs fn
// under withWorkspaceMutationAuthority.
func (s *WorkspaceService) withWorkspaceMutation(ctx context.Context, workspaceID string, repositoryID, userID int64, fn func(context.Context, db.Workspace) error) error {
	if s == nil || s.q == nil {
		return pkgerrors.Internal("workspace store unavailable")
	}
	row, err := s.loadWorkspaceWithAccess(ctx, workspaceID, repositoryID, userID, WorkspaceAccessWrite)
	if err != nil {
		return err
	}
	return s.withWorkspaceMutationAuthority(ctx, row, userID, func(ctx context.Context) error {
		return fn(ctx, row)
	})
}

// workspaceWritable reports whether the requester may mutate row. Read-level
// callers use it to decide between starting a stopped workspace and reporting
// it stopped: a reader never starts the owner's machine or publishes ingress.
func (s *WorkspaceService) workspaceWritable(ctx context.Context, row db.Workspace, requesterID int64) (bool, error) {
	err := s.requireWorkspaceAccess(ctx, row.ID, row.UserID, requesterID, WorkspaceAccessWrite)
	if err == nil {
		return true, nil
	}
	var apiErr *pkgerrors.APIError
	if errors.As(err, &apiErr) && apiErr.Status == http.StatusForbidden {
		return false, nil
	}
	return false, err
}

// errWorkspaceStopped answers a reader whose workspace is not running.
func errWorkspaceStopped() error {
	return pkgerrors.Conflict("workspace is stopped")
}

// touchWorkspaceEntryRecency centralizes ticket 0136 semantics:
// real user-entry flows bump workspaces.last_accessed_at, while passive
// reads (list/detail/polling) must not call this helper.
func (s *WorkspaceService) touchWorkspaceEntryRecency(ctx context.Context, workspaceID, accessPath string) {
	if s == nil || s.q == nil {
		return
	}
	id := strings.TrimSpace(workspaceID)
	if id == "" {
		return
	}
	if err := s.q.TouchWorkspaceLastAccessed(ctx, id); err != nil {
		slog.Warn("touch workspace last_accessed_at failed", "workspace_id", id, "access_path", accessPath, "error", err)
	}
}

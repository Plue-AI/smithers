package services

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

// BranchMachineProviders are activation contracts, intentionally unwired in the
// install until their named integration/security checks pass. Membership must
// hold current collaborator authority in tx until commit; Authorize consumes
// the actual stored credential, never the machine's database owner. LaneBinding
// refuses an item branch without its existing lane. MicroVM validates R1–R5;
// SessionIdentity requires distinct non-root/no-sudo execution identities.
type BranchMachineProviders struct {
	Membership      func(context.Context, pgx.Tx, int64, int64) error
	Authorize       func(context.Context, pgx.Tx, string, int64, string, int64) error
	LaneBinding     func(context.Context, pgx.Tx, int64, string) error
	MicroVM         func(context.Context) error
	SessionIdentity func(context.Context) error
}

func WithBranchMachineProviders(providers BranchMachineProviders) WorkspaceServiceOption {
	return func(s *WorkspaceService) { s.branchMachineProviders = providers }
}

func (s *WorkspaceService) requireBranchMachineProviders() error {
	p := s.branchMachineProviders
	if s.transactions == nil || p.Membership == nil || p.Authorize == nil ||
		p.LaneBinding == nil || p.MicroVM == nil || p.SessionIdentity == nil {
		return pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branch machine providers unavailable")
	}
	return nil
}

var errBranchMachineAdmission = errors.New("branch machine admission refused")

func (s *WorkspaceService) authorizeBranchMachine(ctx context.Context, tx pgx.Tx, repositoryID, actorID int64, branch string) (retErr error) {
	defer func() {
		if retErr != nil {
			retErr = fmt.Errorf("%w: %w", errBranchMachineAdmission, retErr)
		}
	}()

	if err := s.requireBranchMachineProviders(); err != nil {
		return err
	}
	p := s.branchMachineProviders
	if err := p.Membership(ctx, tx, repositoryID, actorID); err != nil {
		return err
	}
	if err := p.Authorize(ctx, tx, "branch.join", repositoryID, branch, actorID); err != nil {
		return err
	}
	if err := p.LaneBinding(ctx, tx, repositoryID, branch); err != nil {
		return err
	}
	if err := p.MicroVM(ctx); err != nil {
		return err
	}
	return p.SessionIdentity(ctx)
}

// Every creation source uses this transaction, including fork, snapshot and
// pushed-ref rows that the legacy active index excludes. The existing runtime
// provisioning lock subsequently owns VM creation for this one durable row.
func (s *WorkspaceService) createBranchMachineRow(ctx context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
	if err := s.requireBranchMachineProviders(); err != nil {
		return db.Workspace{}, err
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return db.Workspace{}, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	actorID := arg.UserID
	branch := targetWorkspaceBookmark(arg.TargetBookmark)
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", fmt.Sprintf("branch-machine:%d:%s", arg.RepositoryID, branch)); err != nil {
		return db.Workspace{}, err
	}
	if err := s.authorizeBranchMachine(ctx, tx, arg.RepositoryID, arg.UserID, branch); err != nil {
		return db.Workspace{}, err
	}
	q := db.New(tx)
	owner, err := q.GetBranchMachineOwner(ctx)
	if err != nil {
		return db.Workspace{}, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branch machine owner unavailable").WithCause(err)
	}
	row, err := q.GetBranchWorkspace(ctx, db.GetBranchWorkspaceParams{RepositoryID: arg.RepositoryID, TargetBookmark: branch})
	if errors.Is(err, pgx.ErrNoRows) {
		arg.UserID, arg.TargetBookmark, arg.AgentSessionID = owner, branch, pgUUIDFromString("")
		row, err = q.CreateWorkspace(ctx, arg)
	} else if err == nil {
		err = branchMachineCompatible(row, arg, owner)
	}
	if err != nil {
		return db.Workspace{}, err
	}
	if err := ensureWorkspaceShare(ctx, q, row, actorID); err != nil {
		return db.Workspace{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return db.Workspace{}, err
	}
	return row, nil
}

func branchMachineCompatible(row db.Workspace, arg db.CreateWorkspaceParams, owner int64) error {
	if row.RebuildRequiredAt.Valid {
		return pkgerrors.New(pkgerrors.CodeWorkspaceRebuildRequired, "branch machine requires rebuild")
	}
	if row.UserID != owner {
		return pkgerrors.Conflict("branch machine owner requires migration")
	}
	if row.Status == "failed" || row.Status == "stopped" {
		return pkgerrors.Conflict("branch machine is retained; recover it before joining")
	}
	if arg.SourceCommit != "" && arg.SourceCommit != row.SourceCommit ||
		arg.SourceSnapshotID.Valid && arg.SourceSnapshotID != row.SourceSnapshotID ||
		arg.ParentWorkspaceID.Valid && arg.ParentWorkspaceID != row.ParentWorkspaceID {
		return pkgerrors.Conflict("branch already has a different machine source")
	}
	if arg.VcpuCount.Valid && arg.VcpuCount != row.VcpuCount ||
		arg.MemoryMb.Valid && arg.MemoryMb != row.MemoryMb ||
		arg.DiskMb.Valid && arg.DiskMb != row.DiskMb {
		return pkgerrors.Conflict("branch already has different machine resources")
	}
	return nil
}

// Restored workspace-share producer, adapted from a73a77de36. Current member
// authority is locked by authorizeBranchMachine in the enclosing transaction.
func ensureWorkspaceShare(ctx context.Context, q *db.Queries, row db.Workspace, actorID int64) error {
	if actorID == row.UserID {
		return nil
	}
	_, err := q.UpsertWorkspaceShare(ctx, db.UpsertWorkspaceShareParams{
		WorkspaceID: row.ID, OwnerUserID: row.UserID, GranteeUserID: actorID, Level: string(WorkspaceAccessWrite),
	})
	return err
}

func (s *WorkspaceService) attachBranchMachineSession(ctx context.Context, workspaceID string, input CreateAgentWorkspaceInput) error {
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	q := db.New(tx)
	row, err := q.GetWorkspace(ctx, workspaceID)
	if err != nil {
		return err
	}
	if row.RepositoryID != input.RepositoryID {
		return pkgerrors.Forbidden("agent session repository binding denied")
	}
	if err := s.authorizeBranchMachine(ctx, tx, row.RepositoryID, input.UserID, row.TargetBookmark); err != nil {
		return err
	}
	// No cross-session, cross-repository or rebinding fallback. Multiple
	// distinct sessions may point to this one workspace.
	result, err := tx.Exec(ctx, `UPDATE agent_sessions SET workspace_id=$1, updated_at=NOW()
        WHERE id=$2 AND repository_id=$3 AND user_id=$4 AND deleted_at IS NULL AND status='active' AND (workspace_id IS NULL OR workspace_id=$1)`,
		pgUUIDFromString(workspaceID), pgUUIDFromString(input.SessionID), row.RepositoryID, input.UserID)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return pkgerrors.Forbidden("agent session binding denied")
	}
	return tx.Commit(ctx)
}

// Existing hosted/mocked legacy rows are not branch machines. The service
// identity is read from the migrated database, never inferred from request IDs.
type branchMachineOwnerStore interface {
	GetBranchMachineOwner(context.Context) (int64, error)
}

func (s *WorkspaceService) branchMachineOwned(ctx context.Context, ownerID int64) (bool, error) {
	store, ok := s.q.(branchMachineOwnerStore)
	if !ok {
		if s.branchMachineProviders.Membership != nil {
			return false, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branch machine owner store unavailable")
		}
		return false, nil
	}
	owner, err := store.GetBranchMachineOwner(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return owner == ownerID, err
}

func (s *WorkspaceService) preflightBranchMachine(ctx context.Context, repositoryID, actorID int64, branch string) error {
	if err := s.requireBranchMachineProviders(); err != nil {
		return err
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	return s.authorizeBranchMachine(ctx, tx, repositoryID, actorID, branch)
}

func (s *WorkspaceService) withBranchMachineMutation(ctx context.Context, row db.Workspace, actorID int64, fn func(context.Context) error) error {
	if err := s.requireBranchMachineProviders(); err != nil {
		return fmt.Errorf("%w: %w", errBranchMachineAdmission, err)
	}
	authority := workspaceMutationAuthority{workspaceID: row.ID, userID: actorID}
	if held, ok := ctx.Value(workspaceMutationAuthorityKey{}).(workspaceMutationAuthority); ok && held == authority {
		return fn(ctx)
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return fmt.Errorf("%w: %w", errBranchMachineAdmission, err)
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	if err := s.authorizeBranchMachine(ctx, tx, row.RepositoryID, actorID, row.TargetBookmark); err != nil {
		return fmt.Errorf("%w: %w", errBranchMachineAdmission, err)
	}
	level, err := db.New(tx).LockWorkspaceShareForMutation(ctx, db.LockWorkspaceShareForMutationParams{WorkspaceID: row.ID, GranteeUserID: actorID})
	if errors.Is(err, pgx.ErrNoRows) || err == nil && level != string(WorkspaceAccessWrite) {
		return fmt.Errorf("%w: %w", errBranchMachineAdmission, pkgerrors.Forbidden("access denied"))
	}
	if err != nil {
		return fmt.Errorf("%w: %w", errBranchMachineAdmission, err)
	}
	return fn(context.WithValue(ctx, workspaceMutationAuthorityKey{}, authority))
}

// RevokeBranchMachineShare composes with T-ACC-02's authorized member-removal
// transaction. The caller holds the collaborator's removal lock in this same
// tx. Deleting the share waits for the existing mutation grant lock; durable
// revocation and NOTIFY become visible only when the caller commits.
func (s *WorkspaceService) RevokeBranchMachineShare(ctx context.Context, tx pgx.Tx, workspaceID string, memberID int64) error {
	if err := s.requireBranchMachineProviders(); err != nil {
		return err
	}
	q := db.New(tx)
	row, err := q.GetWorkspace(ctx, workspaceID)
	if err != nil {
		return err
	}
	owner, err := q.GetBranchMachineOwner(ctx)
	if err != nil {
		return err
	}
	if row.UserID != owner {
		return pkgerrors.Conflict("workspace is not a branch machine")
	}
	return revokeWorkspaceShare(ctx, q, row, memberID)
}

func revokeWorkspaceShare(ctx context.Context, q *db.Queries, row db.Workspace, memberID int64) error {
	if err := q.DeleteWorkspaceShare(ctx, db.DeleteWorkspaceShareParams{WorkspaceID: row.ID, GranteeUserID: memberID}); err != nil {
		return err
	}
	return publishWorkspaceShareRevocation(ctx, q, row, memberID)
}

func publishWorkspaceShareRevocation(ctx context.Context, q *db.Queries, row db.Workspace, memberID int64) error {
	event := revocation.Event{Kind: revocation.KindWorkspaceShareRemoved, UserID: memberID, WorkspaceID: row.ID, Reason: "workspace share removed"}
	if row.VmID != "" {
		event.SandboxIDs = []string{row.VmID}
	}
	return revocation.NewTransactionalDBPublisher(q).Publish(ctx, event)
}

func (s *WorkspaceService) validateBranchMachineSession(ctx context.Context, input CreateAgentWorkspaceInput) error {
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	session, err := db.New(tx).GetAgentSession(ctx, input.SessionID)
	if err != nil {
		return pkgerrors.Forbidden("agent session binding denied")
	}
	if session.RepositoryID != input.RepositoryID || session.UserID != input.UserID || session.Status != "active" {
		return pkgerrors.Forbidden("agent session binding denied")
	}
	if session.WorkspaceID.Valid {
		row, err := db.New(tx).GetWorkspace(ctx, UUIDString(session.WorkspaceID))
		if err != nil {
			return err
		}
		bookmark, _, err := s.resolveWorkspaceBookmark(ctx, input.RepositoryID, input.SourceBookmark)
		if err != nil {
			return err
		}
		if row.TargetBookmark != bookmark {
			return pkgerrors.Forbidden("agent session branch binding denied")
		}
	}
	return nil
}

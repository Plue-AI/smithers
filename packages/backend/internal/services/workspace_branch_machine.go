package services

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

// BranchMachineProviders are activation contracts. The install composes them
// on its microVM runtime (InstallBranchMachineProviders); without them every
// machine stays dark. Membership must hold current collaborator authority in
// tx until commit; Authorize consumes the actual stored credential, never the
// machine's database owner. LaneBinding answers for the branch's machine,
// workspaceID, or "" for a machine about to be created: it refuses an item
// branch without its existing lane. MicroVM validates R1–R5; SessionIdentity
// requires distinct non-root/no-sudo execution identities.
type BranchMachineProviders struct {
	Membership      func(context.Context, pgx.Tx, int64, int64) error
	Authorize       func(context.Context, pgx.Tx, string, int64, string, int64) error
	LaneBinding     func(ctx context.Context, tx pgx.Tx, repositoryID int64, branch, workspaceID string) error
	MicroVM         func(context.Context) error
	SessionIdentity func(context.Context) error
}

type stackLaneCreationKey struct{}

// withStackLaneCreation marks the stack service creating one of its own lanes
// (workspaceMythicalLanes.Create). A lane is created before BindMythicalLane
// records it, so no binding exists yet to admit it. Only the stack sets this
// value; no request can.
func withStackLaneCreation(ctx context.Context) context.Context {
	return context.WithValue(ctx, stackLaneCreationKey{}, true)
}

// StackLaneCreation reports whether ctx is the stack service creating a lane.
func StackLaneCreation(ctx context.Context) bool {
	creating, _ := ctx.Value(stackLaneCreationKey{}).(bool)
	return creating
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

func (s *WorkspaceService) authorizeBranchMachine(ctx context.Context, tx pgx.Tx, repositoryID, actorID int64, branch, workspaceID string) (retErr error) {
	defer func() {
		if retErr != nil {
			retErr = fmt.Errorf("%w: %w", errBranchMachineAdmission, retErr)
		}
	}()

	if err := s.requireBranchMachineProviders(); err != nil {
		return err
	}
	// The machine service owns every branch machine and is no member: it
	// cannot sign in, so only the product's own steps (the box's head reporter
	// and coding runtime) act as it.
	if service, err := s.branchMachineOwned(ctx, actorID); err == nil && service {
		return nil
	}
	p := s.branchMachineProviders
	if err := p.Membership(ctx, tx, repositoryID, actorID); err != nil {
		return err
	}
	if err := p.Authorize(ctx, tx, "branch.join", repositoryID, branch, actorID); err != nil {
		return err
	}
	if err := p.LaneBinding(ctx, tx, repositoryID, branch, workspaceID); err != nil {
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
	// Every stack lane works from the stack's bookmark, yet each is its own
	// branch machine: its identity is its lane name, unique to its item and
	// attempt (the lane binding, spec §8.1.2), so a second TODO never joins
	// the first one's machine.
	lane := strings.TrimSpace(arg.Name)
	stackLane := branch == MythicalBookmark && StackLaneCreation(ctx) && lane != ""
	identity := fmt.Sprintf("branch-machine:%d:%s", arg.RepositoryID, branch)
	if stackLane {
		// Git refuses ":" in a branch name, so no branch spells this key.
		identity += ":lane:" + lane
	}
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", identity); err != nil {
		return db.Workspace{}, err
	}
	if err := s.authorizeBranchMachine(ctx, tx, arg.RepositoryID, arg.UserID, branch, ""); err != nil {
		return db.Workspace{}, err
	}
	q := db.New(tx)
	owner, err := q.GetBranchMachineOwner(ctx)
	if err != nil {
		return db.Workspace{}, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branch machine owner unavailable").WithCause(err)
	}
	var row db.Workspace
	if stackLane {
		row, err = stackLaneWorkspace(ctx, tx, q, arg.RepositoryID, lane)
	} else {
		row, err = q.GetBranchWorkspace(ctx, db.GetBranchWorkspaceParams{RepositoryID: arg.RepositoryID, TargetBookmark: branch})
	}
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

// stackLaneWorkspace is the lane's own machine, created earlier under the same
// lock when a crash came between its insert and its binding.
func stackLaneWorkspace(ctx context.Context, tx pgx.Tx, q *db.Queries, repositoryID int64, lane string) (db.Workspace, error) {
	var id string
	if err := tx.QueryRow(ctx, `SELECT id::text FROM workspaces
        WHERE repository_id = $1 AND target_bookmark = $2 AND name = $3 AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, repositoryID, MythicalBookmark, lane).Scan(&id); err != nil {
		return db.Workspace{}, err
	}
	return q.GetWorkspace(ctx, id)
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
		arg.ParentWorkspaceID.Valid && arg.ParentWorkspaceID != row.ParentWorkspaceID ||
		arg.ForkedFromItem.Valid && arg.ForkedFromItem != row.ForkedFromItem ||
		arg.ForkedFromBase != "" && arg.ForkedFromBase != row.ForkedFromBase {
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
	if err := s.authorizeBranchMachine(ctx, tx, row.RepositoryID, input.UserID, row.TargetBookmark, row.ID); err != nil {
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

// preflightBranchMachine authorizes actorID on branch's machine, workspaceID,
// or "" before the machine exists.
func (s *WorkspaceService) preflightBranchMachine(ctx context.Context, repositoryID, actorID int64, branch, workspaceID string) error {
	if err := s.requireBranchMachineProviders(); err != nil {
		return err
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	return s.authorizeBranchMachine(ctx, tx, repositoryID, actorID, branch, workspaceID)
}

func (s *WorkspaceService) withBranchMachineMutation(ctx context.Context, row db.Workspace, actorID int64, fn func(context.Context) error) error {
	if err := s.requireBranchMachineProviders(); err != nil {
		return fmt.Errorf("%w: %w", errBranchMachineAdmission, err)
	}
	authority := workspaceMutationAuthority{workspaceID: row.ID, userID: actorID}
	if held, ok := ctx.Value(workspaceMutationAuthorityKey{}).(workspaceMutationAuthority); ok && held == authority {
		return fn(ctx)
	}
	// The machine service mutates its own machine without a member's share.
	if owned, err := s.branchMachineOwned(ctx, actorID); err != nil {
		return fmt.Errorf("%w: %w", errBranchMachineAdmission, err)
	} else if owned && actorID == row.UserID {
		return fn(ctx)
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return fmt.Errorf("%w: %w", errBranchMachineAdmission, err)
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	if err := s.authorizeBranchMachine(ctx, tx, row.RepositoryID, actorID, row.TargetBookmark, row.ID); err != nil {
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

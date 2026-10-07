package services

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// CodeDocumentActor is a committed historical identity, not a reusable grant.
// The caller must repeat admission on each operation and require the current
// authenticated daemon connection to match MachineID before sending anything.
type CodeDocumentActor struct {
	Reference []byte
	MachineID string
}

// AdmitCodeDocument uses the branch-machine member, lane and write-share policy.
// It never starts a machine or executes repository code. Attribution is durable
// before the reference escapes; neither guest data nor presence chooses it.
func (s *WorkspaceService) AdmitCodeDocument(ctx context.Context, branch, filePath string, repository, member int64) (CodeDocumentActor, error) {
	refused := func() (CodeDocumentActor, error) {
		return CodeDocumentActor{}, pkgerrors.Forbidden("document access denied")
	}
	id, err := uuid.Parse(branch)
	if err != nil || id == uuid.Nil || id.String() != branch || repository <= 0 || member <= 0 {
		return refused()
	}
	if _, _, err := workspaceFilePath(filePath, false); err != nil {
		return CodeDocumentActor{}, err
	}
	if s == nil {
		return CodeDocumentActor{}, machined.ErrNotReady
	}
	if err := s.requireBranchMachineRuntime(ctx); err != nil {
		return CodeDocumentActor{}, err
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return CodeDocumentActor{}, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	// Membership is always required, even for the database owner/service
	// identity. Hold the same roster-first lock order as member revocation.
	p := s.branchMachineProviders
	if err := p.Membership(ctx, tx, repository, member); err != nil {
		return CodeDocumentActor{}, err
	}
	q := db.New(tx)
	row, err := q.GetWorkspace(ctx, branch)
	if errors.Is(err, pgx.ErrNoRows) {
		return refused()
	}
	if err != nil {
		return CodeDocumentActor{}, err
	}
	if row.RepositoryID != repository || row.DeletedAt.Valid {
		return refused()
	}
	if err := p.Authorize(ctx, tx, "branch.join", repository, row.TargetBookmark, member); err != nil {
		return CodeDocumentActor{}, err
	}
	// Keep any existing lane/load binding stable while the shared provider
	// checks it. Retiring a lane or replacing a flow load must wait for this
	// admission; a later admission sees the retired/replaced binding.
	if _, err := tx.Exec(ctx, `SELECT workspace_id FROM mythical_lanes WHERE workspace_id=$1 FOR SHARE`, branch); err != nil {
		return CodeDocumentActor{}, err
	}
	if _, err := tx.Exec(ctx, `SELECT workspace_id FROM flow_loads WHERE workspace_id=$1 FOR SHARE`, branch); err != nil {
		return CodeDocumentActor{}, err
	}
	if err := p.LaneBinding(ctx, tx, repository, row.TargetBookmark, branch); err != nil {
		return CodeDocumentActor{}, err
	}
	if row.UserID != member {
		level, err := q.LockWorkspaceShareForMutation(ctx, db.LockWorkspaceShareForMutationParams{WorkspaceID: branch, GranteeUserID: member})
		if errors.Is(err, pgx.ErrNoRows) || err == nil && level != string(WorkspaceAccessWrite) {
			return refused()
		}
		if err != nil {
			return CodeDocumentActor{}, err
		}
	}
	// Lock and recheck the exact machine and branch read above. A concurrent
	// replacement, deletion or suspension cannot publish an obsolete reference.
	var current int
	err = tx.QueryRow(ctx, `SELECT 1 FROM workspaces WHERE id=$1 AND repository_id=$2
		AND user_id=$3 AND target_bookmark=$4 AND vm_id=$5 AND vm_id<>''
		AND status='running' AND deleted_at IS NULL FOR SHARE`, branch, repository, row.UserID, row.TargetBookmark, row.VmID).Scan(&current)
	if errors.Is(err, pgx.ErrNoRows) {
		return CodeDocumentActor{}, machined.ErrNotReady
	}
	if err != nil {
		return CodeDocumentActor{}, err
	}
	reference, err := machined.RecordActorInTx(ctx, tx, branch, row.VmID, machined.ActorIdentity{Kind: "person", MemberID: member, Via: "web"})
	if err != nil {
		return CodeDocumentActor{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CodeDocumentActor{}, err
	}
	return CodeDocumentActor{Reference: reference, MachineID: row.VmID}, nil
}

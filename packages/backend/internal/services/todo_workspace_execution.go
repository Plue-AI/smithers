package services

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// TodoWorkspaceExecution identifies the admitted attempt using a workspace.
// It supplies the same pin and configuration snapshot to launches and reads.
type TodoWorkspaceExecution struct {
	ItemID  string
	Attempt int32
	Pin     flowruntime.Pin
}

// ResolveTodoWorkspaceExecution follows trusted lane records after workspace
// access has been authorized. An ordinary workspace has no TODO execution;
// stale, retired or malformed TODO bindings must never fall back to unpinned.
func ResolveTodoWorkspaceExecution(ctx context.Context, q interface {
	GetMythicalLane(context.Context, string) (db.MythicalLane, error)
	GetMythicalItem(context.Context, pgtype.UUID) (db.MythicalItem, error)
}, repositoryID int64, workspaceID string) (*TodoWorkspaceExecution, error) {
	lane, err := q.GetMythicalLane(ctx, workspaceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if lane.RepositoryID != repositoryID || lane.WorkspaceID != workspaceID || lane.RetiredAt.Valid {
		return nil, mythicalFlowFailure{code: "runtime_target_forbidden"}
	}
	item, err := q.GetMythicalItem(ctx, lane.ItemID)
	if err != nil {
		return nil, err
	}
	if item.ID != lane.ItemID || item.RepositoryID != repositoryID || !todoExecutionWorkspace(item, workspaceID) || item.Attempt < 1 {
		return nil, mythicalFlowFailure{code: "runtime_target_forbidden"}
	}
	pin, ok := mythicalPinOf(item)
	if !ok {
		return nil, mythicalFlowFailure{code: "runtime_pin_invalid"}
	}
	return &TodoWorkspaceExecution{ItemID: uuid.UUID(item.ID.Bytes).String(), Attempt: item.Attempt, Pin: pin}, nil
}

// The engine's current isolated review shares the attempt's immutable pin,
// while its implementing run retains its own workspace for later steers.
func todoExecutionWorkspace(item db.MythicalItem, workspaceID string) bool {
	if workspaceID == "" {
		return false
	}
	if item.WorkspaceID == workspaceID {
		return true
	}
	checks := mythicalChecksOf(item)
	review := checks.Review
	retainedReview := item.State == "proposed"
	if item.State == "running" {
		// An input arriving after publication must not revoke the already-bound
		// reviewer while the pinned delivery waits for its result. Its exact
		// head and attempt remain fenced below; no new review is admitted here.
		for _, steer := range checks.Steers {
			retainedReview = retainedReview || steer.AfterProposal && steer.Attempt == item.Attempt
		}
	}
	return retainedReview && review != nil && review.Lane == workspaceID && item.PRHead != "" && review.Head == item.PRHead && review.Candidate == item.CandidateHead && review.Verdict == ""
}

package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

const mythicalLearningBindingKind = "mythical-learning"

type mythicalLearning struct {
	WorkspaceID string          `json:"workspaceId"`
	StartedAt   int64           `json:"startedAt"`
	RunID       string          `json:"runId,omitempty"`
	State       string          `json:"state"`
	Error       string          `json:"error,omitempty"`
	Output      json.RawMessage `json:"output,omitempty"`
}

func (s *MythicalService) SetLearning(store LearningStore) { s.learningStore = store }

// Launch separately from the coding attempt: its pin, result and Merged state
// remain immutable. The item save and canonical admission share a transaction.
func (st *mythicalItemStep) learn(ctx context.Context, item db.MythicalItem) error {
	if item.State != "landed" || !item.Number.Valid || !mythicalTodo(item) {
		return nil
	}
	s, r := st.s, st.r
	checks := mythicalChecksOf(item)
	if learning := checks.Learning; learning != nil {
		if learning.State == "completed" || learning.State == "failed" || learning.State == "cancelled" {
			return s.retireLane(ctx, r, learning.WorkspaceID)
		}
		if learning.State != "committing" {
			if learning.StartedAt > 0 {
				timeout := mythicalWikiTimeout
				if learning.State == "requested" {
					timeout = mythicalWikiStartTimeout
				}
				deadline := time.UnixMilli(learning.StartedAt).Add(timeout)
				if st.now.Before(deadline) {
					r.dueAt(deadline)
					return nil
				}
				learning.State, learning.Error = "failed", "Learning timed out"
				item.Checks = checks.encode()
				saved, err := s.queries().SaveMythicalItem(ctx, item)
				if err != nil {
					return err
				}
				s.itemChanged(ctx, s.queries(), r.row, saved.ID)
				return s.retireLane(ctx, r, learning.WorkspaceID)
			}
			return nil
		}
		var output LearningOutput
		if err := json.Unmarshal(learning.Output, &output); err != nil {
			return err
		}
		repository, owner, err := s.repository(ctx, item.RepositoryID)
		if err != nil {
			return err
		}
		binding := LearningBinding{Repository: owner + "/" + repository.Name, Todo: item.Number.Int64, Run: learning.RunID, State: "merged"}
		if err := CommitLearning(ctx, nil, binding, output, s.now()); !errors.Is(err, ErrLearningUnavailable) {
			learning.State, learning.Error = "failed", "Invalid learning output"
		} else if err := CommitLearning(ctx, s.learningStore, binding, output, s.now()); err != nil {
			return err
		} else {
			learning.State = "completed"
		}
		learning.Output = nil
		item.Checks = checks.encode()
		saved, err := s.queries().SaveMythicalItem(ctx, item)
		if err != nil {
			return err
		}
		s.itemChanged(ctx, s.queries(), r.row, saved.ID)
		return s.retireLane(ctx, r, learning.WorkspaceID)
	}
	if s.launcher == nil || s.lanes == nil || !r.row.ActorUserID.Valid {
		return errors.New("learning launch unavailable")
	}
	placement, refused := st.place(ctx, item)
	if refused != nil {
		return errors.New("learning placement unavailable")
	}
	workspace, err := st.lane(ctx, item, fmt.Sprintf("TODO %d learning", item.Number.Int64), placement)
	if err != nil {
		return err
	}
	checks.Learning = &mythicalLearning{WorkspaceID: workspace, State: "requested", StartedAt: st.now.UnixMilli()}
	item.Checks = checks.encode()
	return pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT 1 FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, item.RepositoryID); err != nil {
			return err
		}
		saved, err := db.New(tx).SaveMythicalItem(ctx, item)
		if err != nil {
			return err
		}
		tenant, principal := "repository:"+strconv.FormatInt(item.RepositoryID, 10), "user:"+strconv.FormatInt(r.row.ActorUserID.Int64, 10)
		projection, _ := json.Marshal(mythicalProjection{Kind: mythicalLearningBindingKind, ItemID: uuidString(item.ID)})
		payload, _ := json.Marshal(map[string]any{"todo": item.Number.Int64})
		auth, _ := json.Marshal(map[string]any{"repositoryId": item.RepositoryID, "userId": r.row.ActorUserID.Int64, "workspaceId": workspace, "itemId": uuidString(item.ID)})
		_, err = s.launcher.AdmitInTx(ctx, tx, flowdispatch.LaunchRequest{Scope: jobs.Scope{TenantID: tenant, PrincipalID: principal}, RequestID: "todo-learning:" + uuidString(item.ID), Target: flowruntime.FlowRuntimeTarget{TenantID: tenant, PrincipalID: principal, WorkspaceID: workspace, BindingKind: mythicalLearningBindingKind, BindingID: uuidString(item.ID)}, FlowID: "learning", Payload: payload, Projection: projection, AuthorizationContext: auth, ApprovalPolicy: flowdispatch.ApprovalAuto})
		if err != nil {
			return err
		}
		s.itemChanged(ctx, db.New(tx), r.row, saved.ID)
		return nil
	})
}
func (s *MythicalService) projectLearning(ctx context.Context, update flowdispatch.ProjectionUpdate, projection mythicalProjection) error {
	id, err := uuid.Parse(projection.ItemID)
	if err != nil {
		return nil
	}
	return pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		q := db.New(tx)
		item, err := q.GetMythicalItem(ctx, pgtype.UUID{Bytes: id, Valid: true})
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `SELECT 1 FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, item.RepositoryID); err != nil {
			return err
		}
		// Read after the stack lock, in the same order as every item writer.
		item, err = q.GetMythicalItem(ctx, item.ID)
		if err != nil {
			return err
		}
		checks := mythicalChecksOf(item)
		learning := checks.Learning
		if item.State != "landed" || learning == nil || learning.State == "completed" || learning.State == "committing" || learning.State == "failed" || learning.State == "cancelled" {
			return nil
		}
		run := strings.TrimSpace(update.Checkpoint.RunID)
		if learning.RunID != "" && run != learning.RunID {
			return nil
		}
		if run != "" {
			learning.RunID = run
			learning.State = "running"
		}
		switch update.State {
		case jobs.StateCompleted:
			var output LearningOutput
			if run == "" || update.Checkpoint.Run == nil || update.Checkpoint.Run.FinalOutput == nil || json.Unmarshal([]byte(*update.Checkpoint.Run.FinalOutput), &output) != nil {
				learning.State, learning.Error = "failed", "Invalid learning output"
			} else {
				learning.State = "committing"
				learning.Output = json.RawMessage(*update.Checkpoint.Run.FinalOutput)
			}
		case jobs.StateFailed:
			learning.State = "failed"
			learning.Error = "Learning failed"
		case jobs.StateCancelled:
			learning.State = "cancelled"
		}
		item.Checks = checks.encode()
		saved, err := q.SaveMythicalItem(ctx, item)
		if err != nil {
			return err
		}
		stack, err := q.GetMythicalStack(ctx, item.RepositoryID)
		if err != nil {
			return err
		}
		s.itemChanged(ctx, q, stack, saved.ID)
		return nil
	})
}
func (resolver *MythicalFlowHostTargetResolver) resolveLearningTarget(ctx context.Context, target flowruntime.FlowRuntimeTarget) (flowhost.Authority, error) {
	repository, ok := scopedFlowRuntimeID(target.TenantID, "repository:")
	user, userOK := scopedFlowRuntimeID(target.PrincipalID, "user:")
	id, err := uuid.Parse(target.BindingID)
	if !ok || !userOK || err != nil {
		return flowhost.Authority{}, mythicalFlowFailure{code: "runtime_target_invalid"}
	}
	q := resolver.service.queries()
	item, err := q.GetMythicalItem(ctx, pgtype.UUID{Bytes: id, Valid: true})
	if err != nil {
		return flowhost.Authority{}, err
	}
	learning := mythicalChecksOf(item).Learning
	stack, err := q.GetMythicalStack(ctx, repository)
	if err != nil {
		return flowhost.Authority{}, err
	}
	if item.RepositoryID != repository || item.State != "landed" || learning == nil || (learning.State != "requested" && learning.State != "running") || !stack.ActorUserID.Valid || stack.ActorUserID.Int64 != user || target.WorkspaceID != learning.WorkspaceID {
		return flowhost.Authority{}, mythicalFlowFailure{code: "runtime_target_forbidden"}
	}
	lane, err := q.GetWorkspace(ctx, learning.WorkspaceID)
	if err != nil || lane.Status != "running" {
		return flowhost.Authority{}, mythicalLaneNotRunning(lane, err)
	}
	return flowhost.Authority{Target: target, RepositoryID: repository, UserID: user, WorkspaceID: learning.WorkspaceID, CatalogKey: flowhost.CatalogCoding}, nil
}

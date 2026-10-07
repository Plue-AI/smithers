package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// One pause cycle belongs to one attempt run. Its signal intents and receipts
// use the existing jobs journal; only an observed resume wait sets paused_at.
type todoPause struct {
	Failure    string          `json:"failure,omitempty"`
	FailureOp  string          `json:"failureOp,omitempty"`
	Generation int64           `json:"generation"`
	Run        string          `json:"run"`
	Requested  bool            `json:"requested"`
	Resuming   bool            `json:"resuming,omitempty"`
	Delivered  bool            `json:"delivered,omitempty"`
	At         *time.Time      `json:"at,omitempty"`
	Wait       *TodoWaitSignal `json:"wait,omitempty"`
}

func (s *MythicalService) pauseTodo(ctx context.Context, number int64, input TodoControlInput) (TodoControlReceipt, error) {
	info := middleware.AuthInfoFromContext(ctx)
	if info == nil || info.CredentialKind() != middleware.CredentialPerson {
		return TodoControlReceipt{}, &TodoControlError{http.StatusForbidden, "permission", "permission", "A person must control this TODO"}
	}
	signaler, ok := s.launcher.(mythicalSignaler)
	if !ok || s.todoFlow == nil {
		return TodoControlReceipt{}, todoControlUnavailable()
	}
	var receipt TodoControlReceipt
	err := pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		q := db.New(tx)
		person, credential, err := lockTodoRequest(ctx, tx, q, "todo."+input.Op, input)
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `SELECT 1 FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, input.Repository); err != nil {
			return err
		}
		item, err := q.GetMythicalItemByNumber(ctx, input.Repository, number)
		if errors.Is(err, pgx.ErrNoRows) {
			return &TodoControlError{http.StatusNotFound, "todo_not_found", "user", "TODO not found"}
		}
		if err != nil {
			return err
		}
		operation := "todo." + input.Op + ".requested"
		if prior, found, err := todoControlReplay(ctx, tx, q, item, input, credential, operation); found || err != nil {
			receipt = prior
			return err
		}
		checks := mythicalChecksOf(item)
		facts := todoControlFacts{Executing: item.State == "running" && checks.RunAttached && item.RequestOutcome == "" && !item.PausedAt.Valid,
			Paused: item.PausedAt.Valid && checks.Pause != nil && checks.Pause.Wait != nil && !checks.Pause.Resuming}
		for _, wait := range todoOpenWaits(item) {
			facts.Waits = append(facts.Waits, wait.Kind)
		}
		if err := todoControlGuard(item, input, facts); err != nil {
			return err
		}
		pin, pinned := mythicalPinOf(item)
		digests, err := builtinFlowDigests()
		// Historical and unqualified overrides cannot promise this pause protocol.
		if err != nil || !pinned || pin.ExecutionDigest != digests["todo"] || item.RequestRunID == "" || item.WorkspaceID == "" {
			return todoControlUnavailable()
		}
		stack, err := q.GetMythicalStack(ctx, input.Repository)
		if err != nil {
			return err
		}
		if !stack.ActorUserID.Valid {
			return todoControlUnavailable()
		}
		id := uuidString(item.ID)
		scope := jobs.Scope{TenantID: "repository:" + strconv.FormatInt(item.RepositoryID, 10), PrincipalID: "user:" + strconv.FormatInt(stack.ActorUserID.Int64, 10)}
		target := flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, WorkspaceID: item.WorkspaceID, BindingKind: mythicalBindingKind, BindingID: id}
		generation := int64(1)
		if checks.Pause != nil {
			generation = checks.Pause.Generation + 1
			if generation <= 0 || generation > 9007199254740991 {
				return todoControlUnavailable()
			}
		}
		name := "pause"
		if input.Op == "stop" {
			if checks.Pause != nil && checks.Pause.Requested {
				return todoControlConflict("Stop is already requested")
			}
			checks.Pause = &todoPause{Generation: generation, Run: item.RequestRunID, Requested: true}
		} else {
			pause := checks.Pause
			if pause.Run != item.RequestRunID || pause.Wait.Run != item.RequestRunID || pause.Wait.Target != target {
				return todoControlUnavailable()
			}
			generation = pause.Generation
			name = fmt.Sprintf("resume#%d", generation)
			pause.Resuming, pause.Delivered = true, false
			pause.Failure, pause.FailureOp = "", ""
			item.PausedAt = pgtype.Timestamptz{}
			checks.RunAttached = false
		}
		item.Checks = checks.encode()
		saved, err := q.SaveMythicalItem(ctx, item)
		if err != nil {
			return err
		}
		payload, _ := json.Marshal(generation)
		projection, _ := json.Marshal(map[string]any{"kind": "mythical-pause", "itemId": id, "run": item.RequestRunID, "attempt": item.Attempt, "generation": generation, "op": input.Op})
		authorization, _ := json.Marshal(map[string]any{"repositoryId": input.Repository, "userId": input.Actor, "itemId": id})
		_, err = signaler.SignalInTx(ctx, tx, flowdispatch.SignalRequest{Scope: scope, Target: target, RequestID: "todo-" + input.Op + ":" + uuid.NewString(), FlowID: flowdispatch.TodoFlow, RunID: item.RequestRunID, Name: name, Payload: payload, Projection: projection, AuthorizationContext: authorization})
		if err != nil {
			return err
		}
		receipt = TodoControlReceipt{State: "accepted", Attempt: item.Attempt}
		if err := s.recordTodoControl(ctx, tx, saved, input, credential, operation, receipt, map[string]any{"item": id, "n": number, "run": item.RequestRunID, "actor": todoActor(ctx, person)}); err != nil {
			return err
		}
		s.itemChanged(ctx, q, stack, saved.ID)
		return nil
	})
	return receipt, err
}

func projectTodoPause(next *db.MythicalItem, projection mythicalProjection, update flowdispatch.ProjectionUpdate, now time.Time) {
	checks := mythicalChecksOf(*next)
	pause := checks.Pause
	run := update.Checkpoint.Run
	if projection.Phase != "todo" || pause == nil || !pause.Requested || pause.Run != next.RequestRunID || run == nil || run.RunID != pause.Run || update.Checkpoint.Target.WorkspaceID != next.WorkspaceID {
		return
	}
	if update.State.Terminal() {
		if !pause.Resuming && pause.At == nil {
			pause.Failure, pause.FailureOp = "Finished before Stop", "stop"
		}
		pause.Requested, pause.Resuming = false, false
		next.PausedAt = pgtype.Timestamptz{}
		next.Checks = checks.encode()
		return
	}
	name := fmt.Sprintf("resume#%d", pause.Generation)
	if pause.Resuming {
		checks.RunAttached = false
	}
	for _, wait := range run.PendingWaits {
		var request struct {
			Kind string `json:"kind"`
		}
		raw := wait.Request
		var text string
		if json.Unmarshal(raw, &text) == nil {
			raw = json.RawMessage(text)
		}
		if json.Unmarshal(raw, &request) != nil || request.Kind != "pause" {
			continue
		}
		if (wait.Name == name || wait.Name == "resume" && wait.Attempt == float64(pause.Generation)) && wait.Reason == "approval" && wait.Token != "" {
			if !pause.Resuming {
				if pause.At == nil {
					pause.At = &now
				}
				next.PausedAt = pgtype.Timestamptz{Time: *pause.At, Valid: true}
				pause.Wait = &TodoWaitSignal{Scope: update.Scope, Target: update.Checkpoint.Target, Flow: flowdispatch.TodoFlow, Run: pause.Run, Name: name}
			}
			next.Checks = checks.encode()
			return
		}
	}
	if pause.Resuming && pause.Delivered && run.Status == "running" {
		pause.Requested, pause.Resuming = false, false
		checks.RunAttached = true
	}
	next.Checks = checks.encode()
}

func (s *MythicalService) projectTodoPauseReceipt(ctx context.Context, update flowdispatch.ProjectionUpdate) error {
	var p struct {
		ItemID     string `json:"itemId"`
		Run        string `json:"run"`
		Attempt    int32  `json:"attempt"`
		Generation int64  `json:"generation"`
		Op         string `json:"op"`
	}
	if json.Unmarshal(update.Checkpoint.Projection, &p) != nil || !update.State.Terminal() {
		return nil
	}
	id, err := uuid.Parse(p.ItemID)
	if err != nil {
		return nil
	}
	return pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		q := db.New(tx)
		for range 3 {
			item, err := q.GetMythicalItem(ctx, pgtype.UUID{Bytes: id, Valid: true})
			if err != nil {
				return err
			}
			checks := mythicalChecksOf(item)
			pause := checks.Pause
			if pause == nil || !pause.Requested || pause.Run != p.Run || item.RequestRunID != p.Run || item.Attempt != p.Attempt || pause.Generation != p.Generation {
				return nil
			}
			if update.State == jobs.StateCompleted {
				if p.Op != "resume" {
					return nil
				}
				pause.Delivered = true
			} else if p.Op == "resume" {
				pause.Failure, pause.FailureOp = "Resume failed", "resume"
				pause.Resuming = false
				if pause.At != nil {
					item.PausedAt = pgtype.Timestamptz{Time: *pause.At, Valid: true}
				}
			} else if pause.At == nil {
				pause.Requested = false
				pause.Failure, pause.FailureOp = "Stop failed", "stop"
			}
			item.Checks = checks.encode()
			saved, err := q.SaveMythicalItem(ctx, item)
			if errors.Is(err, pgx.ErrNoRows) {
				continue
			}
			if err != nil {
				return err
			}
			stack, err := q.GetMythicalStack(ctx, item.RepositoryID)
			if err != nil {
				return err
			}
			s.itemChanged(ctx, q, stack, saved.ID)
			return nil
		}
		return todoControlConflict("TODO is busy")
	})
}

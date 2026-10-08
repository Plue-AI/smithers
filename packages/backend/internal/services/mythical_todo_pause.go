package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// One pause cycle belongs to one attempt run. Its signal intents and receipts
// use the existing jobs journal; only an observed resume wait sets paused_at.
type todoPause struct {
	State      string          `json:"state,omitempty"`
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

// The same committed run fact drives Stop admission and the installed card.
// A composition held for stack events remains live after its PR is proposed;
// retained run IDs on ended attempts never confer execution authority.
func todoRunExecuting(item db.MythicalItem) bool {
	checks := mythicalChecksOf(item)
	if !checks.RunLaunched || !checks.RunAttached || item.RequestRunID == "" || item.RequestOutcome != "" || item.PausedAt.Valid {
		return false
	}
	switch item.State {
	case "running", "delivering", "integrating", "verifying", "proposing", "waiting", "retrying", "proposed":
		return true
	default:
		return false
	}
}

func (s *MythicalService) pauseTodo(ctx context.Context, number int64, input TodoControlInput) (TodoControlReceipt, error) {
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
		from := todoState(item)
		facts := todoControlFacts{Executing: todoRunExecuting(item),
			Paused: item.PausedAt.Valid && checks.Pause != nil && checks.Pause.Wait != nil && !checks.Pause.Resuming}
		for _, wait := range todoOpenWaits(item) {
			facts.Waits = append(facts.Waits, wait.Kind)
		}
		if err := todoControlGuard(item, input, facts); err != nil {
			return err
		}
		pin, pinned := mythicalPinOf(item)
		digests, err := builtinFlowDigests()
		// A repository override must have a successfully inspected packaged pause
		// boundary on its exact retained pin. Never borrow the current Active graph.
		if err != nil || !pinned || item.RequestRunID == "" || item.WorkspaceID == "" {
			return todoControlUnavailable()
		}
		if pin.ExecutionDigest != digests["todo"] {
			var config []byte
			err := tx.QueryRow(ctx, `SELECT config FROM workflow_definitions
 WHERE repository_id=$1 AND name='todo' AND digest=$2 AND source_commit=$3 AND status='loaded'`, item.RepositoryID, pin.ExecutionDigest, pin.SourceCommit).Scan(&config)
			if err != nil || !todoInspectedPauseBoundary(config) {
				return todoControlUnavailable()
			}
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
			checks.Pause = &todoPause{State: item.State, Generation: generation, Run: item.RequestRunID, Requested: true}
		} else {
			pause := checks.Pause
			if pause.Run != item.RequestRunID || pause.Wait.Run != item.RequestRunID || pause.Wait.Target != target ||
				pause.Wait.Scope != scope || pause.Wait.Flow != flowdispatch.TodoFlow ||
				pause.Wait.Name != fmt.Sprintf("resume#%d", pause.Generation) {
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
		if err := s.recordTodoControl(ctx, tx, saved, input, credential, operation, receipt, map[string]any{"item": id, "n": number, "run": item.RequestRunID, "from": from, "to": todoState(saved), "actor": todoActor(ctx, person)}); err != nil {
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
	if pause.Resuming && pause.Delivered && (run.Status == "running" || run.Status == "parked") {
		pause.Requested, pause.Resuming = false, false
		checks.RunAttached = true
		// A parked working composition can have its candidate rebased and
		// verified while paused. Attachment restores that unfinished work;
		// the retained open PR must not project it as a review rebuild.
		if slices.Contains([]string{"running", "delivering", "integrating", "verifying", "proposing", "waiting", "retrying"}, pause.State) && next.RequestOutcome == "" &&
			(next.State == "integrating" || next.State == "verifying" || next.State == "proposing" || next.State == "waiting" || next.State == "proposed") {
			next.State = "running"
		}
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
			from := todoState(item)
			pause := checks.Pause
			if pause == nil || !pause.Requested || pause.Run != p.Run || item.RequestRunID != p.Run || item.Attempt != p.Attempt || pause.Generation != p.Generation {
				return nil
			}
			if update.State == jobs.StateCompleted {
				if p.Op != "resume" || pause.Delivered {
					return nil
				}
				pause.Delivered = true
			} else if p.Op == "resume" {
				if !pause.Resuming && pause.FailureOp == "resume" && pause.Failure == "Resume failed" {
					return nil
				}
				pause.Failure, pause.FailureOp = "Resume failed", "resume"
				pause.Resuming = false
				if pause.At != nil {
					item.PausedAt = pgtype.Timestamptz{Time: *pause.At, Valid: true}
				}
			} else if pause.At == nil {
				pause.Requested = false
				pause.Failure, pause.FailureOp = "Stop failed", "stop"
			} else {
				return nil
			}
			item.Checks = checks.encode()
			saved, err := q.SaveMythicalItem(ctx, item)
			if errors.Is(err, pgx.ErrNoRows) {
				continue
			}
			if err != nil {
				return err
			}
			kind := "todo." + p.Op + ".failed"
			if update.State == jobs.StateCompleted {
				kind = "todo.resume.delivered"
			}
			fact, err := json.Marshal(map[string]any{"item": p.ItemID, "n": saved.Number.Int64, "run": p.Run,
				"from": from, "to": todoState(saved), "actor": map[string]string{"kind": "system", "id": "smithers"}})
			if err != nil {
				return err
			}
			if _, err := s.recordTodoFact(ctx, tx, saved, uuid.NewString(), kind, todoState(saved), fact); err != nil {
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

// Inspection is the pinned loader's graph, not the display steps (which older
// versions may inherit). Opaque or invalid declarations remain unavailable.
func todoInspectedPauseBoundary(config []byte) bool {
	var metadata struct {
		Inspection *struct {
			Nodes []struct {
				Kind  string `json:"kind"`
				Label string `json:"label"`
			} `json:"nodes"`
			Diagnostics *[]json.RawMessage `json:"diagnostics"`
		} `json:"inspection"`
	}
	if json.Unmarshal(config, &metadata) != nil || metadata.Inspection == nil || metadata.Inspection.Diagnostics == nil || len(*metadata.Inspection.Diagnostics) != 0 {
		return false
	}
	for _, node := range metadata.Inspection.Nodes {
		if node.Kind == "FlowCall" && node.Label == "coding/todo-boundary" {
			return true
		}
	}
	return false
}

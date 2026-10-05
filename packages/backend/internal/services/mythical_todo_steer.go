package services

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"net/http"
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

type mythicalSteerer interface {
	SteerInTx(context.Context, pgx.Tx, flowdispatch.SteerRequest) (jobs.RequestReceipt, error)
}

// AuthorizeFlowSteer binds a delivery to the stored input and its author's
// current membership, and commits a held input's release before delivery.
// The stack's runtime owner is not the feedback author.
// No browser credential is synthesized from the durable authorization data.
func (s *MythicalService) AuthorizeFlowSteer(ctx context.Context, request flowdispatch.SteerRequest) error {
	if request.FlowID != flowdispatch.TodoFlow && request.Target.BindingKind != mythicalBindingKind {
		return nil
	}
	if s == nil || s.store == nil || !s.todoSteering || s.todoFlow == nil {
		return mythicalFlowFailure{code: "steer_authorizer_unavailable", retryable: true}
	}
	refused := mythicalFlowFailure{code: "steer_input_mismatch"}
	var authority struct {
		RepositoryID int64  `json:"repositoryId"`
		UserID       int64  `json:"userId"`
		ItemID       string `json:"itemId"`
		Input        string `json:"input"`
	}
	if json.Unmarshal(request.AuthorizationContext, &authority) != nil || authority.UserID <= 0 ||
		authority.RepositoryID <= 0 || request.FlowID != flowdispatch.TodoFlow || request.Target.BindingKind != mythicalBindingKind ||
		authority.ItemID != request.Target.BindingID || authority.Input != request.MessageID ||
		request.RequestID != "todo-steer:"+request.MessageID || request.Scope.TenantID != "repository:"+strconv.FormatInt(authority.RepositoryID, 10) ||
		request.Target.TenantID != request.Scope.TenantID || request.Target.PrincipalID != request.Scope.PrincipalID {
		return refused
	}
	id, err := uuid.Parse(authority.ItemID)
	if err != nil {
		return refused
	}
	err = pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT 1 FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, authority.RepositoryID); err != nil {
			return err
		}
		q := db.New(tx)
		item, err := q.GetMythicalItem(ctx, pgtype.UUID{Bytes: id, Valid: true})
		if errors.Is(err, pgx.ErrNoRows) {
			return refused
		}
		if err != nil {
			return mythicalFlowFailure{code: "steer_authorization_unavailable", retryable: true}
		}
		if item.RepositoryID != authority.RepositoryID || !mythicalTodo(item) || request.RunID == "" ||
			item.RequestRunID != request.RunID || item.WorkspaceID == "" || item.WorkspaceID != request.Target.WorkspaceID {
			return refused
		}
		checks := mythicalChecksOf(item)
		matched := -1
		for index, feedback := range checks.Steers {
			if feedback.ID == request.MessageID && feedback.Author == authority.UserID && feedback.Attempt == item.Attempt &&
				feedback.Text == request.Body && float64(feedback.At.UnixMilli()) == request.CreatedAt && maps.Equal(feedback.Attribution, request.Attribution) {
				matched = index
				break
			}
		}
		if matched < 0 {
			return refused
		}
		stack, err := q.GetMythicalStack(ctx, item.RepositoryID)
		if err != nil {
			return mythicalFlowFailure{code: "steer_authorization_unavailable", retryable: true}
		}
		if !stack.ActorUserID.Valid || request.Scope.PrincipalID != "user:"+strconv.FormatInt(stack.ActorUserID.Int64, 10) {
			return refused
		}
		repository, err := InstallRepositoryID(ctx, q)
		if err != nil {
			return mythicalFlowFailure{code: "steer_authorization_unavailable", retryable: true}
		}
		if repository != authority.RepositoryID {
			return refused
		}
		role, err := InstallRoleOf(ctx, q, authority.UserID)
		if err != nil {
			return mythicalFlowFailure{code: "steer_authorization_unavailable", retryable: true}
		}
		if role == "" {
			return mythicalFlowFailure{code: "steer_author_revoked"}
		}
		// Admission may have committed before Stop, a merge claim, or settlement.
		// Re-read those facts at both delivery boundaries. A hold keeps the same
		// durable input retryable; it is never consent to resume the run.
		switch item.State {
		case "landed", "cancelled", "rejected", "declined":
			return mythicalFlowFailure{code: "steer_todo_closed"}
		}
		if !todoSteerReady(item) {
			return mythicalFlowFailure{code: "steer_held", retryable: true}
		}
		if _, pinned := mythicalPinOf(item); !pinned {
			return mythicalFlowFailure{code: "steer_authorizer_unavailable", retryable: true}
		}
		if checks.Steers[matched].ReleasePending {
			checks.Steers[matched].ReleasePending = false
			checks.Land = nil
			item.CandidateVerified = false
			if item.State == "proposed" {
				item.State, item.NextAttemptAt = "running", pgtype.Timestamptz{}
			}
			item.Checks = checks.encode()
			if _, err := q.SaveMythicalItem(ctx, item); err != nil {
				return err
			}
			s.itemChanged(ctx, q, stack, item.ID)
		}
		return nil
	})
	var failure flowruntime.FlowRuntimeFailure
	if err != nil && !errors.As(err, &failure) {
		return mythicalFlowFailure{code: "steer_authorization_unavailable", retryable: true}
	}
	return err
}

// todoSteerReady reads lifecycle facts, not the card's state: an open question
// can mask a paused, queued, or failed attempt as needs_you. The question
// itself remains open and does not hold feedback for an otherwise live run.
func todoSteerReady(item db.MythicalItem) bool {
	if item.PausedAt.Valid || mythicalMergeFenced(item) {
		return false
	}
	checks := mythicalChecksOf(item)
	if !checks.RunLaunched || !checks.RunAttached {
		return false
	}
	switch item.State {
	case "running", "delivering", "integrating", "verifying", "proposing", "waiting", "proposed":
		return true
	default:
		return false
	}
}

// steerTodo joins feedback, activity and a bound run's Message intent in
// the existing product transaction. Production leaves todoSteering false until
// held-input delivery and ordered model-turn consumption have acceptance proof.
// In particular, merely binding a launcher or a pinned flow cannot enable it.
func (s *MythicalService) steerTodo(ctx context.Context, number int64, input TodoControlInput) (TodoControlReceipt, error) {
	if s == nil || !s.todoSteering || s.todoFlow == nil || s.store == nil {
		return TodoControlReceipt{}, todoControlUnavailable()
	}
	steerer, ok := s.launcher.(mythicalSteerer)
	if !ok {
		return TodoControlReceipt{}, todoControlUnavailable()
	}
	if input.Request == "" {
		input.Request = uuid.NewString()
	}
	var receipt TodoControlReceipt
	err := pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		q := db.New(tx)
		// Repeat the route's authority check before subject reads or replay.
		auth, err := Authorize(ctx, q, "todo.steer")
		if err != nil {
			return err
		}
		repository, err := InstallRepositoryID(ctx, q)
		if err != nil {
			return err
		}
		if auth.UserID != input.Actor || repository != input.Repository {
			return &TodoControlError{http.StatusForbidden, "permission", "permission", "Invalid TODO authority"}
		}
		if _, err := tx.Exec(ctx, `SELECT 1 FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, repository); err != nil {
			return err
		}
		// The stack lock may have waited behind another mutation. Revocation
		// during that wait must also refuse replay and admission.
		if _, err := Authorize(ctx, q, "todo.steer"); err != nil {
			return err
		}
		person, err := q.GetUserByID(ctx, auth.UserID)
		if err != nil {
			return err
		}
		for range 3 {
			item, err := q.GetMythicalItemByNumber(ctx, repository, number)
			if errors.Is(err, pgx.ErrNoRows) {
				return &TodoControlError{http.StatusNotFound, "todo_not_found", "user", "TODO not found"}
			}
			if err != nil {
				return err
			}
			if err := todoBranchForbids(ctx, item); err != nil {
				return err
			}
			if !mythicalTodo(item) {
				return todoControlUnavailable()
			}
			now := s.now().UTC()
			next, feedback, _, replay, err := prepareTodoSteer(ctx, item, input, todoActor(ctx, person), todoActorRef(ctx, person), now)
			if err != nil {
				return err
			}
			receipt = TodoControlReceipt{State: "accepted", Attempt: feedback.Attempt}
			if replay {
				return nil
			}
			saved, err := q.SaveMythicalItem(ctx, next)
			if errors.Is(err, pgx.ErrNoRows) {
				continue
			}
			if err != nil {
				return err
			}
			id := uuidString(saved.ID)
			fact, err := json.Marshal(map[string]any{"item": id, "n": number, "input": feedback.ID,
				"text": feedback.Text, "by": todoActorRef(ctx, person), "attempt": feedback.Attempt,
				"from": todoState(item), "to": todoState(saved)})
			if err != nil {
				return err
			}
			if _, err := jobs.RecordFactInTx(ctx, tx, todoOperationScope(saved), feedback.ID, "todo.steer_received", todoState(saved), fact); err != nil {
				return err
			}
			stack, err := q.GetMythicalStack(ctx, repository)
			if err != nil {
				return err
			}
			// A paused/fenced/attaching run already has a stable destination.
			// Its worker holds this same intent until release is permitted.
			// A queued next attempt has no destination yet; its first-input
			// handoff belongs to the composition's ordered admission boundary.
			_, pinned := mythicalPinOf(saved)
			if pinned && feedback.Attempt == saved.Attempt && saved.RequestRunID != "" && saved.WorkspaceID != "" && mythicalChecksOf(saved).RunLaunched {
				if !stack.ActorUserID.Valid {
					return todoControlUnavailable()
				}
				scope := jobs.Scope{TenantID: "repository:" + strconv.FormatInt(repository, 10), PrincipalID: "user:" + strconv.FormatInt(stack.ActorUserID.Int64, 10)}
				authority, _ := json.Marshal(map[string]any{"repositoryId": repository, "userId": person.ID, "itemId": id, "input": feedback.ID, "by": todoActorRef(ctx, person)})
				projection, _ := json.Marshal(map[string]any{"kind": "mythical-steer", "itemId": id, "input": feedback.ID})
				_, err = steerer.SteerInTx(ctx, tx, flowdispatch.SteerRequest{
					Scope: scope, RequestID: "todo-steer:" + feedback.ID,
					Target: flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, WorkspaceID: saved.WorkspaceID, BindingKind: mythicalBindingKind, BindingID: id},
					FlowID: "todo", RunID: saved.RequestRunID, MessageID: feedback.ID, CreatedAt: float64(now.UnixMilli()), Body: feedback.Text,
					Attribution:          feedback.Attribution,
					AuthorizationContext: authority, Projection: projection,
				})
				if err != nil {
					return err
				}
			}
			s.itemChanged(ctx, q, stack, saved.ID)
			return nil
		}
		return todoControlConflict("TODO is busy; try again")
	})
	return receipt, err
}

// prepareTodoSteer preserves historical Retry feedback and open questions.
// Appending the input never marks it consumed; consumption belongs to the
// pinned flow's ordered input boundary. A merge fence holds it without changing
// the candidate or the approval protected by that fence.
func prepareTodoSteer(ctx context.Context, item db.MythicalItem, input TodoControlInput, by json.RawMessage, attribution map[string]string, now time.Time) (db.MythicalItem, todoSteer, bool, bool, error) {
	if err := input.validate(); err != nil {
		return item, todoSteer{}, false, false, err
	}
	if input.Op != "" || input.Steer == nil || input.Actor <= 0 || input.Request == "" {
		return item, todoSteer{}, false, false, &TodoControlError{http.StatusBadRequest, "invalid_steer", "user", "Invalid steer"}
	}
	checks := mythicalChecksOf(item)
	for _, feedback := range checks.Steers {
		if feedback.Request == input.Request && feedback.Author == input.Actor {
			if feedback.Text != *input.Steer {
				return item, todoSteer{}, false, false, todoControlConflict("Request already used for another steer")
			}
			return item, feedback, false, true, nil
		}
	}
	state := todoState(item)
	if state == "merged" || state == "dropped" {
		return item, todoSteer{}, false, false, &TodoControlError{http.StatusConflict, "todo_closed", "conflict", "TODO is closed"}
	}
	next, attempt := item, item.Attempt
	fenced := mythicalMergeFenced(item)
	deliver := todoSteerReady(item)
	if deliver {
		if _, pinned := mythicalPinOf(item); !pinned || item.RequestRunID == "" || item.WorkspaceID == "" {
			return item, todoSteer{}, false, false, todoControlUnavailable()
		}
	}
	if (item.State == "queued" || item.State == "retrying" || item.State == "skipped") && !(checks.RunLaunched && !checks.RunAttached) {
		attempt++
	}
	if item.State == "blocked" && !fenced {
		var err error
		next, err = mythicalRetried(ctx, item)
		if err != nil {
			return item, todoSteer{}, false, false, err
		}
		attempt++
		checks = mythicalChecksOf(next)
	}
	if !fenced {
		next.CandidateVerified = false
		checks.Land = nil
		if deliver && item.State == "proposed" {
			next.State, next.NextAttemptAt = "running", pgtype.Timestamptz{}
		}
	}
	feedback := todoSteer{ID: uuid.NewString(), Request: input.Request, Author: input.Actor, Text: *input.Steer, By: by, Attribution: maps.Clone(attribution), At: now, Attempt: attempt,
		ReleasePending: !deliver}
	checks.Steers = append(checks.Steers, feedback)
	next.Checks = checks.encode()
	return next, feedback, deliver, false, nil
}

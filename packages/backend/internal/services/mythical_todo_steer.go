package services

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
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
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
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
		request.RequestID != todoSteerRequestID(request.MessageID, request.InputVersion) || request.Scope.TenantID != "repository:"+strconv.FormatInt(authority.RepositoryID, 10) ||
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
				feedback.InputVersion == request.InputVersion && todoSteerDeliveryText(feedback) == request.Body && float64(feedback.At.UnixMilli()) == request.CreatedAt && maps.Equal(feedback.Attribution, request.Attribution) {
				matched = index
				break
			}
		}
		if matched >= 0 && checks.Steers[matched].GitHubAuthor > 0 {
			active, err := currentGitHubFeedbackAuthor(ctx, tx, item.RepositoryID, checks.Steers[matched])
			if err != nil {
				return mythicalFlowFailure{code: "steer_authorization_unavailable", retryable: true}
			}
			if !active {
				return mythicalFlowFailure{code: "steer_author_revoked"}
			}
		}
		if matched < 0 {
			return refused
		}
		if checks.Steers[matched].GitHubAuthor == 0 {
			active, err := currentTodoSteerCredential(ctx, tx, checks.Steers[matched])
			if err != nil {
				return mythicalFlowFailure{code: "steer_authorization_unavailable", retryable: true}
			}
			if !active {
				return mythicalFlowFailure{code: "steer_author_revoked"}
			}
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
		if todoReopenedAttempt(item) {
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

// Resolve the admitting credential again, rather than treating continued
// membership as permission to use a revoked session or delegated token.
// Credential is the existing durable replay identity, not caller attribution.
func currentTodoSteerCredential(ctx context.Context, tx pgx.Tx, feedback todoSteer) (bool, error) {
	credential := middleware.Credential{SessionHash: feedback.Credential}
	if len(feedback.Credential) > 0 && feedback.Credential[0] == '[' {
		var identity []json.RawMessage
		var kind string
		var token, actor int64
		if json.Unmarshal([]byte(feedback.Credential), &identity) != nil || len(identity) < 3 ||
			json.Unmarshal(identity[0], &kind) != nil || kind != "delegated" ||
			json.Unmarshal(identity[1], &token) != nil || token <= 0 ||
			json.Unmarshal(identity[2], &actor) != nil || actor != feedback.Author {
			return false, nil
		}
		credential = middleware.Credential{}
		if err := tx.QueryRow(ctx, `SELECT token_hash FROM access_tokens WHERE id=$1 FOR SHARE`, token).Scan(&credential.TokenHash); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return false, nil
			}
			return false, err
		}
	} else if _, err := tx.Exec(ctx, `SELECT 1 FROM auth_sessions WHERE session_key=$1 FOR SHARE`, feedback.Credential); err != nil {
		return false, err
	}
	fresh, err := middleware.ReloadCredential(ctx, db.New(tx), credential, time.Now())
	if errors.Is(err, middleware.ErrCredentialGone) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !middleware.BindInstallCredential(fresh) || fresh.User.ID != feedback.Author {
		return false, nil
	}
	identity, err := todoRequestCredential(middleware.ContextWithAuthInfo(ctx, fresh), feedback.Author)
	if err != nil || identity != feedback.Credential {
		return false, nil
	}
	role, err := InstallRoleOf(ctx, db.New(tx), feedback.Author)
	return role != "", err
}

// todoSteerReady reads lifecycle facts, not the card's state: an open question
// can mask a paused, queued, or failed attempt as needs_you. The question
// itself remains open and does not hold feedback for an otherwise live run.
func todoSteerReady(item db.MythicalItem) bool {
	if item.PausedAt.Valid || mythicalMergeFenced(item) || todoReopenedAttempt(item) {
		return false
	}
	checks := mythicalChecksOf(item)
	if !checks.RunLaunched || !checks.RunAttached || checks.Pause != nil && checks.Pause.Requested {
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
// the existing product transaction. The install composition selects steering;
// absent pinned-run providers continue to refuse effective admission.
func (s *MythicalService) steerTodo(ctx context.Context, number int64, input TodoControlInput) (TodoControlReceipt, error) {
	return s.admitTodoFeedback(ctx, number, input, nil)
}

// admitTodoFeedback shares authority, storage and delivery for Steer and Amend.
// An amendment adds its revision inside this same transaction.
func (s *MythicalService) admitTodoFeedback(ctx context.Context, number int64, input TodoControlInput, amendment *TodoAmendInput) (TodoControlReceipt, error) {
	if s == nil || !s.todoSteering || s.todoFlow == nil || s.store == nil {
		return TodoControlReceipt{}, todoControlUnavailable()
	}
	_, ok := s.launcher.(mythicalSteerer)
	if !ok {
		return TodoControlReceipt{}, todoControlUnavailable()
	}
	if input.Request == "" || len(input.Request) > 256 {
		return TodoControlReceipt{}, &TodoControlError{http.StatusBadRequest, "invalid_idempotency_key", "user", "Idempotency-Key must contain 1 to 256 bytes"}
	}
	command := "todo.steer"
	if amendment != nil {
		command = "todo.amend"
	}
	var receipt TodoControlReceipt
	err := pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		// Match Answer and the stack worker: lock the stack before credentials
		// or the item, so simultaneous inputs commit without a lock inversion.
		if _, err := tx.Exec(ctx, `SELECT 1 FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, input.Repository); err != nil {
			return err
		}
		q := db.New(tx)
		person, credential, err := lockTodoRequest(ctx, tx, q, command, input)
		if err != nil {
			return err
		}
		repository := input.Repository
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
			if prior, err := q.GetMythicalRequest(ctx, repository, credential, input.Request); err == nil {
				if prior.ID != item.ID || !slices.ContainsFunc(mythicalChecksOf(prior).Steers, func(feedback todoSteer) bool {
					return feedback.Credential == credential && feedback.Request == input.Request && feedback.Author == person.ID
				}) {
					return todoRequestMismatch()
				}
			} else if !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			now := s.now().UTC()
			var next db.MythicalItem
			var feedback todoSteer
			var replay bool
			if amendment == nil {
				next, feedback, _, replay, err = prepareTodoSteer(ctx, item, input, todoActor(ctx, person), todoActorRef(ctx, person), now)
			} else {
				next, feedback, replay, err = prepareTodoAmend(ctx, item, input, *amendment, todoActor(ctx, person), todoActorRef(ctx, person), now)
			}
			if err != nil {
				return err
			}
			receipt = TodoControlReceipt{State: "accepted", Attempt: feedback.Attempt}
			if amendment != nil {
				receipt.Number, receipt.Revision = number, feedback.Revision
			}
			if replay {
				return nil
			}
			var order []db.MythicalItem
			if amendment != nil {
				order, err = q.LockMythicalStackOrder(ctx, repository)
				if err != nil {
					return err
				}
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
			if _, err := s.recordTodoFact(ctx, tx, saved, feedback.ID, "todo.steer_received", todoState(saved), fact); err != nil {
				return err
			}
			if err := recordBranchActivity(ctx, tx, saved, "steer:"+feedback.ID, "steer", feedback.By, feedback.Text); err != nil {
				return err
			}
			stack, err := q.GetMythicalStack(ctx, repository)
			if err != nil {
				return err
			}
			if amendment != nil {
				amended, err := json.Marshal(map[string]any{"item": id, "n": number, "rev": feedback.Revision, "input": feedback.ID,
					"by": feedback.Attribution, "from": todoState(item), "to": todoState(saved)})
				if err != nil {
					return err
				}
				if _, err := s.recordTodoFact(ctx, tx, saved, uuid.NewString(), "todo.amended", todoState(saved), amended); err != nil {
					return err
				}
				after := slices.Clone(order)
				for index := range after {
					if after[index].ID == saved.ID {
						after[index] = saved
					}
				}
				rebased, err := reorderPrefixes(ctx, q, stack, order, after, now)
				if err != nil {
					return err
				}
				for _, changed := range rebased {
					s.itemChanged(ctx, q, stack, changed.ID)
				}
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
				err = s.admitTodoSteerIntent(ctx, tx, stack, saved, feedback)
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
	credential, err := todoRequestCredential(ctx, input.Actor)
	if err != nil {
		return item, todoSteer{}, false, false, err
	}
	checks := mythicalChecksOf(item)
	for _, feedback := range checks.Steers {
		if feedback.Request == input.Request && feedback.Author == input.Actor {
			if feedback.Credential == "" {
				return item, todoSteer{}, false, false, todoControlUnavailable()
			}
			if feedback.Credential != credential {
				continue
			}
			if feedback.Revision != 0 || feedback.Text != *input.Steer {
				return item, todoSteer{}, false, false, todoRequestMismatch()
			}
			return item, feedback, false, true, nil
		}
	}
	state := todoState(item)
	if state == "merged" || state == "dropped" {
		return item, todoSteer{}, false, false, &TodoControlError{http.StatusConflict, "todo_closed", "conflict", "TODO is closed"}
	}
	// Only a recognized reopen can queue fresh work without a live destination.
	// Unknown retained proposals must not consume input or lose their verified head.
	if item.State == "proposed" && !checks.RunLaunched && item.RequestRunID == "" && len(checks.Attempts) > 0 && !todoReopenedAttempt(item) {
		return item, todoSteer{}, false, false, todoControlUnavailable()
	}
	next, attempt := item, item.Attempt
	fenced := mythicalMergeFenced(item)
	awaits := todoReviewAwaitsAttempt(item)
	deliver := todoSteerReady(item) && !awaits
	if awaits {
		if _, pinned := mythicalPinOf(item); !pinned {
			return item, todoSteer{}, false, false, todoControlUnavailable()
		}
		if !fenced {
			next = queueReopenedTodo(item)
			checks = mythicalChecksOf(next)
		}
		attempt++
	}
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
		// Steer on a failed TODO is Retry with this input. Retain the same
		// pending-attempt receipt as Retry so the old launch cannot project
		// Starting or accept runtime callbacks before the new admission.
		checks.Retries = append(checks.Retries, todoRetry{Request: input.Request, Credential: credential,
			By: attribution["person"], At: now.UTC(), Attempt: attempt})
	}
	if !fenced {
		next.CandidateVerified = false
		checks.Land = nil
		if deliver && item.State == "proposed" {
			next.State, next.NextAttemptAt = "running", pgtype.Timestamptz{}
		}
	}
	feedback := todoSteer{ID: uuid.NewString(), Request: input.Request, Credential: credential, Author: input.Actor, Text: *input.Steer, By: by, Attribution: maps.Clone(attribution), At: now.UTC(), Attempt: attempt,
		ReleasePending: !deliver, AfterProposal: item.State == "proposed"}
	checks.Steers = append(checks.Steers, feedback)
	next.Checks = checks.encode()
	return next, feedback, deliver, false, nil
}

// All feedback sources share the same bound runtime intent and authority.
func (s *MythicalService) admitTodoSteerIntent(ctx context.Context, tx pgx.Tx, stack db.MythicalStack, item db.MythicalItem, feedback todoSteer) error {
	steerer, ok := s.launcher.(mythicalSteerer)
	if !ok || !stack.ActorUserID.Valid {
		return todoControlUnavailable()
	}
	id := uuidString(item.ID)
	scope := jobs.Scope{TenantID: "repository:" + strconv.FormatInt(item.RepositoryID, 10), PrincipalID: "user:" + strconv.FormatInt(stack.ActorUserID.Int64, 10)}
	authority, _ := json.Marshal(map[string]any{"repositoryId": item.RepositoryID, "userId": feedback.Author, "itemId": id, "input": feedback.ID, "by": feedback.Attribution})
	projection, _ := json.Marshal(map[string]any{"kind": "mythical-steer", "itemId": id, "input": feedback.ID, "inputVersion": feedback.InputVersion, "runId": item.RequestRunID, "attempt": item.Attempt})
	_, err := steerer.SteerInTx(ctx, tx, flowdispatch.SteerRequest{Scope: scope, RequestID: todoSteerRequestID(feedback.ID, feedback.InputVersion), InputVersion: feedback.InputVersion, Target: flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, WorkspaceID: item.WorkspaceID, BindingKind: mythicalBindingKind, BindingID: id}, FlowID: flowdispatch.TodoFlow, RunID: item.RequestRunID, MessageID: feedback.ID, CreatedAt: float64(feedback.At.UnixMilli()), Body: todoSteerDeliveryText(feedback), Attribution: feedback.Attribution, AuthorizationContext: authority, Projection: projection})
	return err
}

func todoSteerRequestID(id string, version int64) string {
	if version > 1 {
		return "todo-steer:" + id + ":" + strconv.FormatInt(version, 10)
	}
	return "todo-steer:" + id
}

func todoSteerDeliveryText(feedback todoSteer) string {
	if feedback.EditText != "" {
		return feedback.EditText
	}
	return feedback.Text
}

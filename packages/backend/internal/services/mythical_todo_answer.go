package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// todoAnswerBytes bounds an answer as HumanTask bounds an `ask` answer
// (JsonSchemaSubset.maxJsonStringBytes).
const todoAnswerBytes = 128 << 10

// TodoWaitSignal is where an answer to a question goes: the durable signal
// that completes the wait point the run parked on, sent to that run under
// its launch's scope and target.
type TodoWaitSignal struct {
	Scope  jobs.Scope         `json:"scope"`
	Target flowruntime.Target `json:"target"`
	Flow   string             `json:"flow"`
	Run    string             `json:"run"`
	Name   string             `json:"name"`
}

// mythicalProjectWaits keeps the item's questions in step with the human
// waits its bound todo run reports (the run summary's pendingWaits). Each
// HumanTask `ask` the run parks on opens one question (Needs you), kept
// with the wait point an answer signals. A question the run no longer
// reports, and every question of a run that ended, is withdrawn
// unanswered. Only AnswerTodo settles a question with an answer; nothing
// here does, and a steer never reaches this projection.
func mythicalProjectWaits(next *db.MythicalItem, projection mythicalProjection, update flowdispatch.ProjectionUpdate, runID string, now time.Time) {
	if (projection.Phase != "todo" && projection.Phase != "request") || runID == "" || next.RequestRunID != runID {
		return
	}
	run := update.Checkpoint.Run
	if run == nil || run.RunID != runID {
		return
	}
	var asked []TodoWait
	pending := map[string]bool{}
	if !update.State.Terminal() {
		for _, wait := range run.PendingWaits {
			if question, ok := todoQuestionWait(wait, update, runID, now); ok && !pending[question.ID] {
				asked = append(asked, question)
				pending[question.ID] = true
			}
		}
	}
	checks := mythicalChecksOf(*next)
	changed, known := false, map[string]bool{}
	for i := range checks.Waits {
		wait := &checks.Waits[i]
		known[wait.ID] = true
		if wait.Kind != "question" || wait.SettledAt != nil || wait.Signal == nil || wait.Signal.Run != runID || pending[wait.ID] {
			continue
		}
		withdrawn := now
		wait.SettledAt, changed = &withdrawn, true
	}
	for _, question := range asked {
		if !known[question.ID] {
			checks.Waits, changed = append(checks.Waits, question), true
		}
	}
	if changed {
		next.Checks = checks.encode()
	}
}

// todoQuestionWait reads one pending wait as a question: a named HumanTask
// `ask` with a prompt. Its id is stable for that park (the holding
// execution and its durable token), so a re-ask is a new question.
func todoQuestionWait(wait flowruntime.PendingWait, update flowdispatch.ProjectionUpdate, runID string, now time.Time) (TodoWait, bool) {
	var request struct {
		Kind   string `json:"kind"`
		Name   string `json:"name"`
		Prompt string `json:"prompt"`
	}
	raw := wait.Request
	var text string
	if json.Unmarshal(raw, &text) == nil {
		raw = json.RawMessage(text)
	}
	if json.Unmarshal(raw, &request) != nil || request.Kind != "ask" || strings.TrimSpace(request.Prompt) == "" || wait.Token == "" {
		return TodoWait{}, false
	}
	name := wait.Name
	if name == "" {
		name = request.Name
	}
	if name == "" {
		return TodoWait{}, false
	}
	sum := sha256.Sum256([]byte(wait.RunID + "\x00" + wait.Token))
	return TodoWait{ID: "q-" + hex.EncodeToString(sum[:8]), Kind: "question", Prompt: request.Prompt, Since: now,
		Signal: &TodoWaitSignal{Scope: update.Scope, Target: update.Checkpoint.Target, Flow: update.Checkpoint.FlowID, Run: runID, Name: name}}, true
}

// todoFirstAnswer is the card's first_answer: the latest answered question,
// with the person who settled it.
func todoFirstAnswer(item db.MythicalItem) map[string]any {
	var latest *TodoWait
	waits := mythicalChecksOf(item).Waits
	for i := range waits {
		wait := &waits[i]
		if wait.Kind != "question" || wait.SettledAt == nil || wait.AnsweredBy == "" || len(wait.By) == 0 {
			continue
		}
		if latest == nil || !wait.SettledAt.Before(*latest.SettledAt) {
			latest = wait
		}
	}
	if latest == nil {
		return nil
	}
	return map[string]any{"by": latest.By, "text": latest.Answer, "at": latest.SettledAt.UTC().Format(time.RFC3339Nano)}
}

// The answers an attempt carries (flows/coding/schema.ts CarriedAnswer): at
// most todoCarriedAnswers, the latest kept whole within todoCarriedBytes, and
// each field clipped to its own bound. Bytes bound UTF-16 units from above.
const (
	todoCarriedAnswers       = 16
	todoCarriedBytes         = 64 << 10
	todoCarriedQuestionBytes = 16 << 10
	todoCarriedAnswerBytes   = 32 << 10
	todoCarriedByBytes       = 256
)

// todoCarriedAnswer is one answered question as a later attempt receives it.
type todoCarriedAnswer struct {
	Question string `json:"question"`
	Answer   string `json:"answer"`
	By       string `json:"by"`
}

// todoAnswers is every question a person answered on the TODO, in the order
// asked, with the answer and who gave it. Each later attempt receives them
// next to its steers (todoFeedback), so a question answered once stays
// answered; a question its run withdrew unanswered carries nothing.
func todoAnswers(item db.MythicalItem) []todoCarriedAnswer {
	var answered []todoCarriedAnswer
	for _, wait := range mythicalChecksOf(item).Waits {
		if wait.Kind != "question" || wait.SettledAt == nil || wait.AnsweredBy == "" || strings.TrimSpace(wait.Answer) == "" {
			continue
		}
		answered = append(answered, todoCarriedAnswer{
			Question: todoClip(wait.Prompt, todoCarriedQuestionBytes),
			Answer:   todoClip(wait.Answer, todoCarriedAnswerBytes),
			By:       todoClip(wait.AnsweredBy, todoCarriedByBytes),
		})
	}
	first, size := len(answered), 0
	for first > 0 && len(answered)-first < todoCarriedAnswers {
		next := size + len(answered[first-1].Question) + len(answered[first-1].Answer)
		if next > todoCarriedBytes {
			break
		}
		first, size = first-1, next
	}
	return answered[first:]
}

// todoClip is text's first max bytes, cut on a rune boundary.
func todoClip(text string, max int) string {
	if len(text) <= max {
		return text
	}
	cut := max
	for cut > 0 && !utf8.RuneStart(text[cut]) {
		cut--
	}
	return text[:cut]
}

// TodoAnswerInput is POST /api/todos/{n}/answer: the open question the
// person's card showed (its wait id) and their answer.
type TodoAnswerInput struct {
	Wait   string `json:"wait"`
	Answer string `json:"answer"`
}

// TodoAnsweredError is an answer to a question someone already settled: the
// first answer wins, and a later one learns who gave it (409).
type TodoAnsweredError struct {
	AnsweredBy string
}

func (e *TodoAnsweredError) Error() string { return e.AnsweredBy + " answered" }

// MarshalJSON is the §6.2.3 error envelope plus answered_by.
func (e *TodoAnsweredError) MarshalJSON() ([]byte, error) {
	return json.Marshal(map[string]string{"code": "answered", "class": "conflict", "message": e.Error(), "answered_by": e.AnsweredBy})
}

// mythicalSignaler admits a durable Flow signal in the caller's transaction
// (flowdispatch.Service.SignalInTx); the stack's launcher provides it.
type mythicalSignaler interface {
	SignalInTx(context.Context, pgx.Tx, flowdispatch.SignalRequest) (jobs.RequestReceipt, error)
}

// AnswerTodo settles one open question of TODO n with a person's answer and
// resumes the run that asked: the answer is the payload of the signal that
// completes its wait point, so the agent continues in the same run on the
// same working copy. The first answer wins: under the stack's row lock a
// question already settled refuses with who answered it. The settling, its
// todo.answered fact and the signal's admission commit in one transaction.
// The same person sending the same answer again is that answer, not a
// second one. A person answers from their browser; a stage-1 terminal's
// credential answers for its member only on its own branch's TODO, and the
// answer is by that terminal or the agent working in it (todoActor).
func (s *MythicalService) AnswerTodo(ctx context.Context, repositoryID, userID, number int64, input TodoAnswerInput) error {
	if _, terminal := middleware.AuthInfoFromContext(ctx).TerminalDelegation(); !terminal {
		if err := middleware.RequirePerson(ctx, "answer a TODO"); err != nil {
			return err
		}
	}
	if number <= 0 {
		return &TodoControlError{http.StatusBadRequest, "invalid_todo", "user", "Invalid TODO number"}
	}
	input.Wait = strings.TrimSpace(input.Wait)
	if input.Wait == "" || len(input.Wait) > 128 || strings.TrimSpace(input.Answer) == "" || !utf8.ValidString(input.Answer) || len(input.Answer) > todoAnswerBytes {
		return &TodoControlError{http.StatusBadRequest, "invalid_answer", "user", "An answer and its question are required"}
	}
	var signaler mythicalSignaler
	if s != nil {
		signaler, _ = s.launcher.(mythicalSignaler)
	}
	if s == nil || s.store == nil || signaler == nil {
		return &TodoControlError{http.StatusServiceUnavailable, "todo_unavailable", "infra", "Answers are unavailable"}
	}
	person, err := s.queries().GetUserByID(ctx, userID)
	if err != nil {
		return err
	}
	by := todoActor(ctx, person)
	return pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT 1 FROM mythical_stacks WHERE repository_id = $1 FOR UPDATE`, repositoryID); err != nil {
			return err
		}
		q := db.New(tx)
		for range 3 {
			item, err := q.GetMythicalItemByNumber(ctx, repositoryID, number)
			if errors.Is(err, pgx.ErrNoRows) {
				return &TodoControlError{http.StatusNotFound, "todo_not_found", "user", "TODO not found"}
			}
			if err != nil {
				return err
			}
			if err := todoBranchForbids(ctx, item); err != nil {
				return err
			}
			checks := mythicalChecksOf(item)
			index := -1
			for i, wait := range checks.Waits {
				if wait.ID == input.Wait && (wait.Kind == "question" || wait.Kind == "conflict") {
					index = i
				}
			}
			if index < 0 {
				return &TodoControlError{http.StatusNotFound, "wait_not_found", "user", "Question not found"}
			}
			wait := &checks.Waits[index]
			switch {
			case wait.SettledAt != nil && wait.AnsweredBy == person.Username && wait.Answer == input.Answer:
				return nil
			case wait.SettledAt != nil && wait.AnsweredBy != "":
				return &TodoAnsweredError{AnsweredBy: wait.AnsweredBy}
			case wait.SettledAt != nil:
				return todoControlConflict("The agent no longer asks this question")
			case len(todoOpenWaits(item)) == 0 || (wait.Kind == "question" && wait.Signal == nil):
				return todoControlConflict("TODO is settled")
			}
			if wait.Kind == "conflict" {
				if input.Answer != "Done" || checks.Conflict == nil {
					return &TodoControlError{409, "still_conflicted", "conflict", "Resolve the conflicts first"}
				}
				head, err := s.checkConflictDone(ctx, q, item)
				if err != nil {
					return err
				}
				now := s.now().UTC()
				wait.SettledAt, wait.AnsweredBy, wait.Answer, wait.By = &now, person.Username, input.Answer, by
				checks.Conflict.DoneHead = head
				next := item
				next.Checks = checks.encode()
				saved, err := q.SaveMythicalItem(ctx, next)
				if errors.Is(err, pgx.ErrNoRows) {
					continue
				}
				if err != nil {
					return err
				}
				fact, _ := json.Marshal(map[string]any{"item": uuidString(saved.ID), "n": saved.Number.Int64, "wait": input.Wait, "head": head, "paths": wait.Paths, "by": todoActorRef(ctx, person)})
				if _, err := jobs.RecordFactInTx(ctx, tx, todoOperationScope(saved), uuid.NewString(), "todo.conflict_resolved", todoState(saved), fact); err != nil {
					return err
				}
				stack, err := q.GetMythicalStack(ctx, repositoryID)
				if err != nil {
					return err
				}
				s.itemChanged(ctx, q, stack, saved.ID)
				return nil
			}
			now := s.now().UTC()
			wait.SettledAt, wait.AnsweredBy, wait.Answer, wait.By = &now, person.Username, input.Answer, by
			signal := *wait.Signal
			next := item
			next.Checks = checks.encode()
			saved, err := q.SaveMythicalItem(ctx, next)
			if errors.Is(err, pgx.ErrNoRows) {
				continue
			}
			if err != nil {
				return err
			}
			id := uuidString(saved.ID)
			fact, _ := json.Marshal(map[string]any{"item": id, "n": saved.Number.Int64, "wait": input.Wait, "run": signal.Run,
				"actor": map[string]any{"kind": "person", "id": userID, "login": person.Username}, "by": todoActorRef(ctx, person), "from": todoState(item), "to": todoState(saved)})
			if _, err := jobs.RecordFactInTx(ctx, tx, todoOperationScope(saved), uuid.NewString(), "todo.answered", todoState(saved), fact); err != nil {
				return err
			}
			payload, _ := json.Marshal(input.Answer)
			authorization, _ := json.Marshal(map[string]any{"repositoryId": repositoryID, "userId": userID, "itemId": id, "wait": input.Wait})
			projection, _ := json.Marshal(map[string]any{"kind": "mythical-answer", "itemId": id, "wait": input.Wait})
			_, err = signaler.SignalInTx(ctx, tx, flowdispatch.SignalRequest{Scope: signal.Scope, RequestID: "todo-answer:" + id + ":" + input.Wait,
				Target: signal.Target, FlowID: signal.Flow, RunID: signal.Run, Name: signal.Name, Payload: payload,
				AuthorizationContext: authorization, Projection: projection})
			return err
		}
		return &TodoControlError{http.StatusConflict, "conflict", "conflict", "TODO is busy; answer again"}
	})
}

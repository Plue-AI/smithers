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

// mythicalProjectWaits keeps the item's run waits in step with the human
// waits its bound todo run reports (the run summary's pendingWaits). Each
// HumanTask ask or confirm opens one question or approval (Needs you), kept
// with the wait point an answer signals. A question the run no longer
// reports, and every question of a run that ended, is withdrawn
// unanswered. Only AnswerTodo settles a question with an answer; nothing
// here does, and a steer never reaches this projection.
func mythicalProjectWaits(next *db.MythicalItem, projection mythicalProjection, update flowdispatch.ProjectionUpdate, runID string, now time.Time) {
	if runID == "" {
		return
	}
	if projection.Phase == "conflict" {
		reservation := mythicalChecksOf(*next).ConflictReservation
		if reservation == nil || reservation.ResolutionRun != runID {
			return
		}
	} else if (projection.Phase != "todo" && projection.Phase != "request") || next.RequestRunID != runID {
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
			if question, ok := todoQuestionWait(wait, update, runID, now); projection.Phase != "conflict" && ok && !pending[question.ID] {
				asked = append(asked, question)
				pending[question.ID] = true
			}
			if conflict, ok := todoConflictWait(*next, wait, update, now); ok && !pending[conflict.ID] {
				asked = append(asked, conflict)
				pending[conflict.ID] = true
			}
		}
	}
	checks := mythicalChecksOf(*next)
	changed, known := false, map[string]bool{}
	for i := range checks.Waits {
		wait := &checks.Waits[i]
		known[wait.ID] = true
		if (wait.Kind != "question" && wait.Kind != "approval") || wait.SettledAt != nil || wait.Signal == nil || wait.Signal.Run != runID || pending[wait.ID] {
			continue
		}
		withdrawn := now
		wait.SettledAt, changed = &withdrawn, true
	}
	// Only a working run opens a new run wait (§4.1). A reported existing
	// question stays open while another wait masks it; a late checkpoint of
	// a paused or proposed run cannot invent a new question. Withdrawal and
	// terminal settlement above still apply independently.
	canAsk := false
	if !next.PausedAt.Valid {
		switch next.State {
		case "running", "delivering", "integrating", "verifying", "proposing", "waiting", "retrying":
			canAsk = true
		}
	}
	for _, question := range asked {
		canOpen := canAsk
		// A retained conflict is a branch wait. It remains visible beneath
		// pause or failure and can arrive before or after coding execution.
		if question.Kind == "conflict" {
			switch todoState(*next) {
			case "queued", "starting", "working", "needs_you", "paused", "failed", "in_review":
				canOpen = true
			default:
				canOpen = false
			}
		}
		if canOpen && !known[question.ID] {
			checks.Waits, changed = append(checks.Waits, question), true
		}
	}
	if changed {
		next.Checks = checks.encode()
	}
}

// todoQuestionWait reads a named HumanTask ask or confirm with a prompt.
// Confirm projects an approval and keeps its boolean answer protocol. Its id is stable for that park (the holding
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
	if json.Unmarshal(raw, &request) != nil || (request.Kind != "ask" && request.Kind != "confirm") || strings.TrimSpace(request.Prompt) == "" || wait.Token == "" {
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
	kind, prefix := "question", "q-"
	if request.Kind == "confirm" {
		kind, prefix = "approval", "a-"
	}
	return TodoWait{ID: prefix + hex.EncodeToString(sum[:8]), Kind: kind, Prompt: request.Prompt, Since: now,
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
	return s.answerTodo(ctx, repositoryID, userID, number, input, "todo.answer")
}

func (s *MythicalService) answerTodo(ctx context.Context, repositoryID, userID, number int64, input TodoAnswerInput, command string) error {
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
	decision, err := Authorize(ctx, s.queries(), command)
	if err != nil {
		return err
	}
	if decision.UserID != userID {
		return &AccessError{Status: 403, Class: "permission", Code: "permission", Message: "Invalid TODO authority"}
	}
	ctx = WithInstallAuthorization(ctx, command, decision)
	person, err := s.queries().GetUserByID(ctx, userID)
	if err != nil {
		return err
	}
	by := todoActor(ctx, person)
	if prepare, ok := s.conflictValidator.(interface {
		PrepareConflictValidation(context.Context, ConflictValidation) error
	}); ok && input.Answer == "done" {
		if err := pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
			return guardInstallTodoWrite(ctx, tx, repositoryID, userID)
		}); err != nil {
			return err
		}
		if err := AuthorizeTodoBranch(ctx, s.queries(), repositoryID, number); err != nil {
			return err
		}
		item, err := s.queries().GetMythicalItemByNumber(ctx, repositoryID, number)
		if err != nil {
			return err
		}
		for _, wait := range todoOpenWaits(item) {
			if wait.ID == input.Wait && wait.Kind == "conflict" {
				if err := s.validateConflictDoneTarget(ctx, s.queries(), item, wait, input.Answer); err != nil {
					return err
				}
				if err := prepare.PrepareConflictValidation(ctx, ConflictValidation{Workspace: item.WorkspaceID, Change: wait.ConflictChange, Onto: wait.OntoRevision, Run: item.RequestRunID, Digest: item.FlowDigest.String}); err != nil {
					return &TodoControlError{503, "conflict_validation_unavailable", "infra", "Conflict validation unavailable"}
				}
				break
			}
		}
	}
	return pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT 1 FROM mythical_stacks WHERE repository_id = $1 FOR UPDATE`, repositoryID); err != nil {
			return err
		}
		if err := guardInstallTodoWrite(ctx, tx, repositoryID, userID); err != nil {
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
			if mythicalMergeFenced(item) {
				return &TodoControlError{409, "merging", "conflict", "TODO is merging"}
			}
			checks := mythicalChecksOf(item)
			index := -1
			for i, wait := range checks.Waits {
				if wait.ID == input.Wait && wait.Kind != "question" && wait.Kind != "conflict" {
					if _, terminal := middleware.AuthInfoFromContext(ctx).TerminalDelegation(); terminal {
						return &AccessError{Status: http.StatusForbidden, Class: "permission", Code: "permission", Message: "A terminal's credential cannot do this"}
					}
				}
				if wait.ID == input.Wait && (wait.Kind == "question" || wait.Kind == "approval" || wait.Kind == "conflict") {
					index = i
				}
			}
			if index < 0 {
				return &TodoControlError{http.StatusNotFound, "wait_not_found", "user", "Question not found"}
			}
			wait := &checks.Waits[index]
			// Questions and conflicts are answerable through the terminal skill.
			// Only an approval wait requires a person's decision; the shared
			// authorizer already binds question answers to the delegated branch.
			if wait.Kind == "approval" {
				if err := middleware.RequirePerson(ctx, "answer a human wait"); err != nil {
					return err
				}
			}
			switch {
			case wait.SettledAt != nil && wait.AnsweredBy == person.Username && wait.Answer == input.Answer:
				return nil
			case wait.SettledAt != nil && wait.AnsweredBy != "":
				return &TodoAnsweredError{AnsweredBy: wait.AnsweredBy}
			case wait.SettledAt != nil:
				return todoControlConflict("The agent no longer asks this question")
			case len(todoOpenWaits(item)) == 0 || (wait.Signal == nil && wait.Kind != "conflict"):
				return todoControlConflict("TODO is settled")
			}
			if wait.Kind == "conflict" {
				if err := s.validateConflictDone(ctx, q, item, *wait, input.Answer); err != nil {
					return err
				}
			}
			if wait.Kind == "approval" && input.Answer != "true" && input.Answer != "false" {
				return &TodoControlError{400, "invalid_answer", "user", "Approval requires true or false"}
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
			if _, err := s.recordTodoFact(ctx, tx, saved, uuid.NewString(), "todo.answered", todoState(saved), fact); err != nil {
				return err
			}
			if err := recordBranchActivity(ctx, tx, saved, "answer:"+input.Wait, "answer", by, input.Answer); err != nil {
				return err
			}
			payload, _ := json.Marshal(input.Answer)
			if wait.Kind == "approval" {
				payload = json.RawMessage(input.Answer)
			}
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

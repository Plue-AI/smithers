package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// TodoStore is the database the TODO service writes through.
type TodoStore interface {
	db.DBTX
	Begin(ctx context.Context) (pgx.Tx, error)
}

// TodoService is the only writer of TODOs (spec §10.1). Every state change
// runs Transition, saves the TODO conditionally on its version, appends one
// todo_events row per transition and publishes the todo:<n> and home
// projections, all in one transaction (§3.1, §3.2).
type TodoService struct {
	store TodoStore
	now   func() time.Time
	// endRun cancels the run an item had in flight when its TODO merges or
	// drops, in the same transaction (MythicalService.cancelRunIn).
	endRun func(ctx context.Context, tx pgx.Tx, item db.MythicalItem) error
}

// NewTodoService writes TODOs through store.
func NewTodoService(store TodoStore) *TodoService {
	return &TodoService{store: store, now: time.Now}
}

// Bounds on a TODO made in Smithers: GitHub's title limit (the PR carries
// it), and the prompt a run reads (mythicalPromptBytes).
const (
	todoTitleRunes     = 256
	todoPromptBytes    = mythicalPromptBytes
	todoAcceptBytes    = 8 << 10
	todoListLimit      = 500
	todoPositionDigits = 12
)

// todoIdempotencyKey is the shape of an Idempotency-Key the TODO routes accept.
var todoIdempotencyKey = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

// errTodoStale reports that another writer changed the TODO since it was
// read. It wraps pgx.ErrNoRows, so the stack engine's optimistic loops
// reread the item and decide again, exactly as for a stale item version.
var errTodoStale = fmt.Errorf("the TODO changed concurrently: %w", pgx.ErrNoRows)

// CreateTodoInput is POST /api/todos (spec §6.3). Only place "append" is
// served here; before and amend arrive with T-STK-02.
type CreateTodoInput struct {
	Title      string `json:"title"`
	Prompt     string `json:"prompt"`
	Acceptance string `json:"acceptance,omitempty"`
	Place      string `json:"place,omitempty"`
}

// TodoView is the TODO card model (spec §14.3) as the routes and the
// todo:<n> and home projections carry it. Revisions are present on the
// TODO card (GET /api/todos/{n}, todo:<n>) and absent from list rows.
type TodoView struct {
	N           int64              `json:"n"`
	Title       string             `json:"title"`
	State       TodoState          `json:"state"`
	StateReason string             `json:"state_reason,omitempty"`
	Owner       *int64             `json:"owner,omitempty"`
	Place       int64              `json:"place,omitempty"`
	Queue       json.RawMessage    `json:"queue,omitempty"`
	Step        string             `json:"step,omitempty"`
	NeedsYou    json.RawMessage    `json:"needs_you,omitempty"`
	Failure     json.RawMessage    `json:"failure,omitempty"`
	PR          *TodoPRView        `json:"pr,omitempty"`
	Amendments  int64              `json:"amendments"`
	Lessons     int32              `json:"lessons"`
	Branch      TodoBranchView     `json:"branch"`
	Issue       *TodoIssueView     `json:"issue,omitempty"`
	CreatedBy   json.RawMessage    `json:"created_by"`
	Seq         int64              `json:"seq"`
	Revisions   []TodoRevisionView `json:"revisions,omitempty"`
	CreatedAt   time.Time          `json:"created_at"`
	UpdatedAt   time.Time          `json:"updated_at"`
}

// TodoPRView is the TODO's pull request on GitHub.
type TodoPRView struct {
	Number int64 `json:"number"`
}

// TodoBranchView is the TODO's item branch.
type TodoBranchView struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// TodoIssueView is the GitHub issue a TODO links (#n) and whether merging
// the TODO fixes it.
type TodoIssueView struct {
	Number int64 `json:"number"`
	Fixes  bool  `json:"fixes"`
}

// TodoRevisionView is one prompt revision; revision 1 is the original.
type TodoRevisionView struct {
	Rev        int32           `json:"rev"`
	Prompt     string          `json:"prompt"`
	Acceptance string          `json:"acceptance,omitempty"`
	Reason     string          `json:"reason"`
	Author     json.RawMessage `json:"author"`
	At         time.Time       `json:"at"`
}

// TodoHomeDelta is one home topic delta: an item of the stack changed.
type TodoHomeDelta struct {
	Type string   `json:"type"`
	Item TodoView `json:"item"`
}

// TodoDelta is one todo:<n> topic delta: the card model after the change
// and the events that made it.
type TodoDelta struct {
	Type   string          `json:"type"`
	Todo   TodoView        `json:"todo"`
	Events []TodoEventView `json:"events,omitempty"`
}

// TodoEventView is a committed todo_events row.
type TodoEventView struct {
	Seq   int64           `json:"seq"`
	Kind  string          `json:"kind"`
	From  string          `json:"from,omitempty"`
	To    string          `json:"to"`
	Actor json.RawMessage `json:"actor"`
	At    time.Time       `json:"at"`
}

// Create places a TODO made in Smithers at the end of the repository's
// stack and queues its work record for the stack engine, in one
// transaction with its revision 1, its item branch, its place event and its
// projections. The same key from the same person answers the TODO it made
// (created false); the key reused for another TODO is refused.
func (s *TodoService) Create(ctx context.Context, repositoryID int64, actor TodoActor, key string, input CreateTodoInput) (TodoView, bool, error) {
	title, prompt, acceptance := strings.TrimSpace(input.Title), strings.TrimSpace(input.Prompt), strings.TrimSpace(input.Acceptance)
	if prompt == "" {
		prompt = title
	}
	switch {
	case actor.Person == nil:
		return TodoView{}, false, pkgerrors.Forbidden("a TODO is made for a member")
	case !todoIdempotencyKey.MatchString(key):
		return TodoView{}, false, pkgerrors.New(pkgerrors.CodeIdempotencyKeyRequired, "send an Idempotency-Key of 1 to 128 letters, digits or . _ : -")
	case title == "":
		return TodoView{}, false, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Todo", Field: "title", Code: "missing_field"})
	case utf8.RuneCountInString(title) > todoTitleRunes || strings.ContainsAny(title, "\r\n") || !utf8.ValidString(title):
		return TodoView{}, false, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Todo", Field: "title", Code: "invalid"})
	case len(prompt) > todoPromptBytes || !utf8.ValidString(prompt):
		return TodoView{}, false, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Todo", Field: "prompt", Code: "invalid"})
	case len(acceptance) > todoAcceptBytes || !utf8.ValidString(acceptance):
		return TodoView{}, false, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Todo", Field: "acceptance", Code: "invalid"})
	case input.Place != "" && input.Place != "append":
		return TodoView{}, false, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Todo", Field: "place", Code: "invalid"})
	}
	digest := todoCreateDigest(title, prompt, acceptance)
	person := strconv.FormatInt(*actor.Person, 10)
	var view TodoView
	created := false
	err := pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		q := db.New(tx)
		if err := q.LockTodoCreation(ctx, repositoryID); err != nil {
			return err
		}
		existing, err := q.GetTodoByCreateKey(ctx, db.GetTodoByCreateKeyParams{RepositoryID: repositoryID, Person: person, CreateKey: key})
		switch {
		case err == nil:
			if existing.CreateDigest.String != digest {
				return pkgerrors.New(pkgerrors.CodeIdempotencyConflict, "this Idempotency-Key already made another TODO")
			}
			view, err = s.view(ctx, q, existing, true)
			return err
		case !errors.Is(err, pgx.ErrNoRows):
			return err
		}
		if _, err := q.GetMythicalStack(ctx, repositoryID); errors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("this repository has no stack yet")
		} else if err != nil {
			return err
		}
		todo, err := s.insert(ctx, q, todoInsert{
			repositoryID: repositoryID, title: title, prompt: prompt, acceptance: acceptance, reason: "create",
			actor: actor, owner: actor.Person, key: key, digest: digest,
		})
		if err != nil {
			return err
		}
		item, err := q.InsertMythicalTodoItem(ctx, repositoryID, title, pgUUIDFromString(todo.ID))
		if err != nil {
			return err
		}
		if _, err := q.RequestMythicalStack(ctx, repositoryID); err != nil {
			return err
		}
		hint, _ := json.Marshal(map[string]string{"kind": "item", "itemId": uuidString(item.ID)})
		if err := q.NotifyMythical(ctx, repositoryID, string(hint)); err != nil {
			return err
		}
		events, err := q.ListTodoEvents(ctx, todo.ID)
		if err != nil {
			return err
		}
		if view, err = s.publish(ctx, tx, todo, events); err != nil {
			return err
		}
		created = true
		return nil
	})
	if err != nil {
		return TodoView{}, false, err
	}
	return view, created, nil
}

func todoCreateDigest(title, prompt, acceptance string) string {
	sum := sha256.Sum256([]byte(title + "\x00" + prompt + "\x00" + acceptance))
	return hex.EncodeToString(sum[:])
}

// todoInsert is a new TODO: its first revision, its author and, for a TODO
// made in Smithers, its creation key.
type todoInsert struct {
	repositoryID int64
	title        string
	prompt       string
	acceptance   string
	reason       string
	issueNumber  pgtype.Int8
	issueDigest  string
	fixesIssue   bool
	actor        TodoActor
	owner        *int64
	key          string
	digest       string
	payload      map[string]any
}

// insert creates a placed TODO: the next number, an append position, its
// item branch, revision 1 and the place event. The caller holds the
// repository's LockTodoCreation.
func (s *TodoService) insert(ctx context.Context, q *db.Queries, in todoInsert) (db.Todo, error) {
	event, err := Transition(TodoDraft, TodoPlace, TodoGuard{Actor: in.actor, Now: s.now()})
	if err != nil {
		return db.Todo{}, err
	}
	number, err := q.NextTodoNumber(ctx, in.repositoryID)
	if err != nil {
		return db.Todo{}, err
	}
	last, err := q.LastTodoStackPosition(ctx, in.repositoryID)
	if err != nil {
		return db.Todo{}, err
	}
	name, err := q.TodoBranchName(ctx, db.TodoBranchNameParams{RepositoryID: in.repositoryID, Title: in.title})
	if err != nil {
		return db.Todo{}, err
	}
	todoID, branchID := uuid.NewString(), uuid.NewString()
	params := db.InsertTodoParams{
		ID: todoID, RepositoryID: in.repositoryID, Number: number, Title: in.title, State: string(event.To),
		IssueNumber: in.issueNumber, FixesIssue: in.fixesIssue, StackPosition: todoAppendPosition(last),
		BranchID: pgUUIDFromString(branchID), BranchName: name, GithubBranch: pgtype.Text{String: name, Valid: true}, CreatedByActor: in.actor.encode(), FlowName: "todo",
	}
	if in.owner != nil {
		params.OwnerID = pgtype.Int8{Int64: *in.owner, Valid: true}
	}
	if in.key != "" {
		params.CreateKey, params.CreateDigest = pgtype.Text{String: in.key, Valid: true}, pgtype.Text{String: in.digest, Valid: true}
	}
	todo, err := q.InsertTodo(ctx, params)
	if err != nil {
		return db.Todo{}, err
	}
	revision := db.InsertTodoRevisionParams{TodoID: todoID, Rev: 1, Prompt: in.prompt, Acceptance: in.acceptance,
		AuthorActor: in.actor.encode(), Reason: in.reason}
	if in.issueDigest != "" {
		revision.IssueDigest = pgtype.Text{String: in.issueDigest, Valid: true}
	}
	if _, err := q.InsertTodoRevision(ctx, revision); err != nil {
		return db.Todo{}, err
	}
	if err := s.appendEvents(ctx, q, todo.ID, []TodoEvent{event}, in.payload); err != nil {
		return db.Todo{}, err
	}
	return todo, nil
}

// todoAppendPosition is a key after last: twelve zero-padded digits, one
// more than last's leading twelve; a key T-STK-02 made between two others is
// followed by its own successor.
func todoAppendPosition(last string) string {
	if last == "" {
		return fmt.Sprintf("%0*d", todoPositionDigits, 1)
	}
	if len(last) >= todoPositionDigits {
		if n, err := strconv.ParseInt(last[:todoPositionDigits], 10, 64); err == nil && n >= 0 {
			return fmt.Sprintf("%0*d", todoPositionDigits, n+1)
		}
	}
	return last + "1"
}

// appendEvents appends one todo_events row per event, numbered after the
// TODO's last. The caller holds the TODO's row (its insert or its
// conditional update), so seq is gap-free per TODO.
func (s *TodoService) appendEvents(ctx context.Context, q *db.Queries, todoID string, events []TodoEvent, payload map[string]any) error {
	if len(events) == 0 {
		return nil
	}
	seq, err := q.NextTodoEventSeq(ctx, todoID)
	if err != nil {
		return err
	}
	for i, event := range events {
		body := map[string]any{}
		for key, value := range payload {
			body[key] = value
		}
		if event.Cause != "" {
			body["cause"] = event.Cause
		}
		if event.Failure != nil {
			body["failure"] = event.Failure
		}
		if event.VoidApprovals {
			body["void_approvals"] = true
		}
		if event.Lessons != 0 {
			body["lessons"] = event.Lessons
		}
		if event.EndsWork {
			body["ends_work"] = true
		}
		if event.SteerHeld {
			body["steer_held"] = true
		}
		encoded, _ := json.Marshal(body)
		from := pgtype.Text{String: string(event.From), Valid: true}
		if _, err := q.InsertTodoEvent(ctx, db.InsertTodoEventParams{TodoID: todoID, Seq: seq + int64(i), Actor: event.Actor.encode(),
			Kind: string(event.Kind), FromState: from, ToState: string(event.To), Payload: encoded}); err != nil {
			return err
		}
	}
	return nil
}

// publish writes the TODO's todo:<n> delta and its home delta, with the
// events this transaction appended (none for a change of fields alone), and
// answers the card model.
func (s *TodoService) publish(ctx context.Context, tx pgx.Tx, todo db.Todo, events []db.TodoEvent) (TodoView, error) {
	view, err := s.view(ctx, db.New(tx), todo, true)
	if err != nil {
		return TodoView{}, err
	}
	home := view
	home.Revisions = nil
	_, err = Publish(ctx, tx,
		Projection{RepositoryID: todo.RepositoryID, Topic: ProjectionTopicTodo(todo.Number), Payload: TodoDelta{Type: "todo", Todo: view, Events: todoEventViews(events)}},
		Projection{RepositoryID: todo.RepositoryID, Topic: ProjectionTopicHome, Payload: TodoHomeDelta{Type: "item", Item: home}})
	return view, err
}

func todoEventViews(rows []db.TodoEvent) []TodoEventView {
	out := make([]TodoEventView, 0, len(rows))
	for _, row := range rows {
		out = append(out, TodoEventView{Seq: row.Seq, Kind: row.Kind, From: row.FromState.String, To: row.ToState, Actor: todoActorRef(row.Actor), At: row.At})
	}
	return out
}

// view builds the card model of one TODO; withRevisions adds its prompt
// revisions (the TODO card), which list rows leave out.
func (s *TodoService) view(ctx context.Context, q *db.Queries, todo db.Todo, withRevisions bool) (TodoView, error) {
	view := todoBaseView(todo)
	if todo.BranchID.Valid {
		branch, err := q.GetBranch(ctx, uuidString(todo.BranchID))
		if err != nil {
			return TodoView{}, err
		}
		view.Branch = TodoBranchView{ID: branch.ID, Name: branch.Name}
	}
	revisions, err := q.ListTodoRevisions(ctx, todo.ID)
	if err != nil {
		return TodoView{}, err
	}
	view.Amendments = max(int64(len(revisions))-1, 0)
	if withRevisions {
		view.Revisions = make([]TodoRevisionView, 0, len(revisions))
		for _, revision := range revisions {
			view.Revisions = append(view.Revisions, TodoRevisionView{Rev: revision.Rev, Prompt: revision.Prompt, Acceptance: revision.Acceptance,
				Reason: revision.Reason, Author: todoActorRef(revision.AuthorActor), At: revision.CreatedAt})
		}
	}
	if TodoState(todo.State).unmerged() {
		place, err := q.UnmergedTodoPlace(ctx, db.UnmergedTodoPlaceParams{RepositoryID: todo.RepositoryID, StackPosition: todo.StackPosition})
		if err != nil {
			return TodoView{}, err
		}
		view.Place = place
	}
	seq, err := q.NextTodoEventSeq(ctx, todo.ID)
	if err != nil {
		return TodoView{}, err
	}
	view.Seq = seq - 1
	return view, nil
}

// todoBaseView is the part of the card model the todos row holds.
func todoBaseView(todo db.Todo) TodoView {
	view := TodoView{N: todo.Number, Title: todo.Title, State: TodoState(todo.State), StateReason: todo.StateReason,
		Queue: todo.Queue, NeedsYou: todo.NeedsYou, Failure: todo.Failure, Lessons: todo.Lessons, CreatedBy: todoActorRef(todo.CreatedByActor),
		CreatedAt: todo.CreatedAt, UpdatedAt: todo.UpdatedAt}
	if todo.OwnerID.Valid {
		owner := todo.OwnerID.Int64
		view.Owner = &owner
	}
	if todo.CurrentStep.Valid {
		view.Step = todo.CurrentStep.String
	}
	if todo.PRNumber.Valid {
		view.PR = &TodoPRView{Number: todo.PRNumber.Int64}
	}
	if todo.IssueNumber.Valid {
		view.Issue = &TodoIssueView{Number: todo.IssueNumber.Int64, Fixes: todo.FixesIssue}
	}
	return view
}

// Get answers a repository's TODO card T<number> (GET /api/todos/{n}, the
// todo:<n> snapshot).
func (s *TodoService) Get(ctx context.Context, repositoryID, number int64) (TodoView, error) {
	var view TodoView
	err := pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		// Multiple reads form one snapshot, including event seq and revisions.
		if _, err := tx.Exec(ctx, "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"); err != nil {
			return err
		}
		q := db.New(tx)
		todo, err := q.GetTodoByNumber(ctx, db.GetTodoByNumberParams{RepositoryID: repositoryID, Number: number})
		if errors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("no TODO T" + strconv.FormatInt(number, 10))
		}
		if err != nil {
			return err
		}
		view, err = s.view(ctx, q, todo, true)
		return err
	})
	return view, err
}

// todoRef reads T12 (or t12) as TODO number 12.
func todoRef(ref string) (int64, bool) {
	if len(ref) < 2 || (ref[0] != 'T' && ref[0] != 't') || ref[1] == '0' {
		return 0, false
	}
	number, err := strconv.ParseInt(ref[1:], 10, 64)
	return number, err == nil && number > 0 && strconv.FormatInt(number, 10) == ref[1:]
}

// List answers a repository's TODOs in stack order (GET /api/todos): the
// unmerged ones first-to-last with their place, then the merged and dropped.
func (s *TodoService) List(ctx context.Context, repositoryID int64) ([]TodoView, error) {
	rows, err := db.New(s.store).ListTodos(ctx, db.ListTodosParams{RepositoryID: repositoryID, Limit: todoListLimit})
	if err != nil {
		return nil, err
	}
	out := make([]TodoView, 0, len(rows))
	for _, row := range rows {
		view := todoBaseView(row.Todo)
		view.Branch = TodoBranchView{ID: uuidString(row.Todo.BranchID), Name: row.BranchName}
		if view.State.unmerged() {
			view.Place = row.Place
		}
		view.Amendments = max(row.Revisions-1, 0)
		view.Seq = row.Seq
		out = append(out, view)
	}
	return out, nil
}

// StackRepositories answers up to two repositories that have a stack: the
// TODO routes default to the only one (one install serves one repository).
func (s *TodoService) StackRepositories(ctx context.Context) ([]int64, error) {
	return db.New(s.store).ListMythicalStackRepositories(ctx)
}

// projectItem is the engine's half of spec §4.1.0, run inside the
// transaction of every mythical_items write (MythicalService.saveItemIn):
// the item's TODO moves to the state the item stands for, through allowed
// transitions only, each with its event, and its projections are published.
// An admitted item with no TODO gets one. A linked TODO keeps its identity;
// unsupported restarts refuse instead of silently adopting another TODO. It
// answers the item as linked. A projection §4.1 does not allow refuses the
// whole write, so todos.state never drifts from its item.
func (s *TodoService) projectItem(ctx context.Context, tx pgx.Tx, before *db.MythicalItem, item db.MythicalItem) (db.MythicalItem, error) {
	q := db.New(tx)
	var todo db.Todo
	if item.TodoID.Valid {
		var err error
		if todo, err = q.GetTodo(ctx, uuidString(item.TodoID)); err != nil {
			return db.MythicalItem{}, err
		}
	}
	// §12.3.6: re-admitting an ended or withdrawn issue creates a new
	// TODO. Keep the prior TODO and all of its events as history.
	if before != nil && item.Source == "issue" && item.State == "queued" && item.TodoID.Valid &&
		(before.State == "declined" || before.State == "cancelled" || before.State == "rejected" || before.State == "skipped") {
		if TodoState(todo.State).unmerged() && todo.State != string(TodoDropped) {
			ended := *before
			ended.State = "cancelled"
			if _, err := s.projectItem(ctx, tx, nil, ended); err != nil {
				return db.MythicalItem{}, err
			}
		}
		item.TodoID = pgtype.UUID{}
		todo = db.Todo{}
	}
	plan, err := planItemProjection(todo, item, s.now())
	if err != nil {
		return db.MythicalItem{}, err
	}
	adopted := false
	if plan.adopt {
		if !mythicalItemIsTodo(item) {
			return item, nil
		}
		created, err := s.adopt(ctx, q, item)
		if err != nil {
			return db.MythicalItem{}, err
		}
		adopted = true
		item.TodoID, todo = pgUUIDFromString(created.ID), created
		if plan, err = planItemProjection(todo, item, s.now()); err != nil {
			return db.MythicalItem{}, err
		}
	}
	target, events := plan.target, plan.events
	next := todoItemFields(todo, item, target, s.now())
	if len(events) > 0 && events[len(events)-1].EndsWork {
		// A merge or a drop ends the work: the attempt's run is cancelled,
		// every open wait settled, needs_you and paused_at cleared (§4.1).
		if before != nil && s.endRun != nil {
			if err := s.endRun(ctx, tx, *before); err != nil {
				return db.MythicalItem{}, err
			}
		}
		if err := q.SettleTodoWaits(ctx, db.SettleTodoWaitsParams{TodoID: todo.ID, Actor: todoStackActor.encode(), Outcome: string(target)}); err != nil {
			return db.MythicalItem{}, err
		}
		if item.PausedAt.Valid {
			if err := q.ClearMythicalItemPause(ctx, item.ID); err != nil {
				return db.MythicalItem{}, err
			}
			item.PausedAt = pgtype.Timestamptz{}
		}
	}
	if len(events) == 0 && sameTodoFields(todo, next) {
		if adopted {
			written, err := q.ListTodoEvents(ctx, todo.ID)
			if err != nil {
				return db.MythicalItem{}, err
			}
			if _, err := s.publish(ctx, tx, todo, written); err != nil {
				return db.MythicalItem{}, err
			}
		}
		return item, nil
	}
	saved, err := q.UpdateTodo(ctx, next)
	if errors.Is(err, pgx.ErrNoRows) {
		return db.MythicalItem{}, errTodoStale
	}
	if err != nil {
		return db.MythicalItem{}, err
	}
	if err := s.appendEvents(ctx, q, saved.ID, events, map[string]any{"item_state": item.State}); err != nil {
		return db.MythicalItem{}, err
	}
	for _, event := range events {
		if event.Kind == TodoRetry {
			if err := q.InsertTodoRetryAttempt(ctx, saved.ID); err != nil {
				return db.MythicalItem{}, err
			}
		}
	}
	written, err := q.ListTodoEvents(ctx, saved.ID)
	if err != nil {
		return db.MythicalItem{}, err
	}
	publication := written[len(written)-len(events):]
	if adopted {
		publication = written
	}
	if _, err := s.publish(ctx, tx, saved, publication); err != nil {
		return db.MythicalItem{}, err
	}
	return item, nil
}

// mythicalItemIsTodo reports whether an item without a TODO is one: every
// item that passed admission. A skipped item, or a cancelled one that never
// started, is an issue no member made a TODO (M-16).
func mythicalItemIsTodo(item db.MythicalItem) bool {
	switch item.State {
	case "skipped", "cancelled":
		return false
	}
	return true
}

// adopt makes the TODO an admitted item stands for and links it: its title
// and text (the pinned issue, or a chat result's summary) are revision 1.
func (s *TodoService) adopt(ctx context.Context, q *db.Queries, item db.MythicalItem) (db.Todo, error) {
	if err := q.LockTodoCreation(ctx, item.RepositoryID); err != nil {
		return db.Todo{}, err
	}
	title := strings.TrimSpace(strings.SplitN(item.IssueTitle, "\n", 2)[0])
	if utf8.RuneCountInString(title) > todoTitleRunes {
		title = string([]rune(title)[:todoTitleRunes])
	}
	if title == "" {
		title = "Untitled TODO"
	}
	in := todoInsert{repositoryID: item.RepositoryID, title: title, prompt: item.Summary, reason: "create", actor: todoStackActor,
		payload: map[string]any{"item": uuidString(item.ID)}}
	if item.Source == "issue" {
		in.prompt, in.reason, in.issueNumber, in.issueDigest, in.fixesIssue = item.IssueBody, "from-issue", item.IssueNumber, item.IssueDigest, true
		in.payload["issue"] = item.IssueNumber.Int64
	}
	todo, err := s.insert(ctx, q, in)
	if err != nil {
		return db.Todo{}, err
	}
	if err := q.LinkMythicalItemTodo(ctx, item.ID, pgUUIDFromString(todo.ID)); err != nil {
		return db.Todo{}, err
	}
	return todo, nil
}

// itemProjection is what one item write does to its TODO (spec §4.1.0): the
// state it reaches and the events of the §4.1 edges it crosses, or adopt
// when the item has no TODO yet. A linked TODO is never adopted again.
type itemProjection struct {
	target TodoState
	events []TodoEvent
	adopt  bool
}

// planItemProjection is the pure core of projectItem: from the TODO as it
// stands and the item as written, the projected state and the transitions
// that reach it, each through Transition with the guard the item supplies.
// A projection §4.1 does not allow is TodoTransitionRefused.
func planItemProjection(todo db.Todo, item db.MythicalItem, now time.Time) (itemProjection, error) {
	// Ended work has no active overlays. Clear the projection inputs before
	// deriving its terminal state; persisted cleanup follows only after the
	// same pure Transition guard approves the write.
	switch item.State {
	case "landed", "cancelled", "rejected", "declined":
		todo.NeedsYou = nil
		item.PausedAt = pgtype.Timestamptz{}
	}
	target := ProjectItemState(item, todo)
	from := TodoState(todo.State)
	// Lead ruling 2026-10-03: Retry is failed -> queued. The current open
	// PR projects in_review, but cannot manufacture lifecycle grant/run events.
	if item.State == "queued" && (from == TodoFailed || from == TodoQueued) {
		target = TodoQueued
	}
	if from == "" {
		return itemProjection{adopt: true}, nil
	}
	// Projection preserves terminal facts, but an item write must not
	// restart ended work behind a terminal TODO. Late runtime updates keep
	// the terminal item state; only a dropped PR may reopen through its guard.
	if from == TodoMerged && item.State != "landed" ||
		from == TodoDropped && item.State != "cancelled" && item.State != "rejected" && item.State != "declined" && item.State != "proposed" {
		return itemProjection{}, &TodoTransitionRefused{From: from, Trigger: TodoTrigger("item:" + item.State),
			Reason: "ended work cannot restart"}
	}
	plan := itemProjection{target: target}
	if target == from {
		return plan, nil
	}
	path := todoItemPath(from, target, item)
	if path == nil {
		return itemProjection{}, &TodoTransitionRefused{From: from, Trigger: TodoTrigger("item:" + item.State),
			Reason: "no transition reaches " + string(target)}
	}
	state := from
	for _, trigger := range path {
		event, err := Transition(state, trigger, todoItemGuard(todo, item, trigger, now))
		if err != nil {
			return itemProjection{}, err
		}
		plan.events = append(plan.events, event)
		state = event.To
	}
	return plan, nil
}

// todoItemGuard is the guard of one engine trigger, read from the item and
// its TODO: the engine admitted the item onto a lane (its machine in S1),
// the PR carries the verified candidate, GitHub reported the merge commit, a
// reopened PR's head is pinned in the repo store, and a block is typed by
// its fault.
func todoItemGuard(todo db.Todo, item db.MythicalItem, trigger TodoTrigger, now time.Time) TodoGuard {
	guard := TodoGuard{Actor: todoStackActor, Cause: item.Reason, Now: now, MachineGranted: item.Lane.Valid || item.WorkspaceID != "",
		PRHeadVerified: item.CandidateVerified, HasPR: item.PRNumber.Valid, OnMain: item.PRMergeCommit != "",
		DroppedAt: todo.DroppedAt.Time, HeadCaptured: item.PRHead != ""}
	switch trigger {
	case TodoStartFailed:
		guard.Failure = todoItemFailure(item, "start")
	case TodoRunFailed:
		guard.Failure = todoItemFailure(item, "")
	}
	return guard
}

// todoItemFailure types a blocked item's failure: the step it stopped at
// (step, else the failure's kind), its fault class and its sentence.
func todoItemFailure(item db.MythicalItem, step string) *TodoFailure {
	failure := &TodoFailure{Step: step, Class: "factory", Message: mythicalSentence(item.Reason), Retryable: true}
	if view, sentence := mythicalFailureOf(item); view != nil {
		failure.Class, failure.Message = view.Fault, sentence
		if failure.Step == "" {
			failure.Step = view.Kind
		}
	}
	if failure.Step == "" {
		failure.Step = "run"
	}
	return failure
}

// todoItemFields is the TODO row after a projection to target: the phase as
// its current step while working, the PR, the typed failure while the item
// is blocked, and the time it merged or dropped.
func todoItemFields(todo db.Todo, item db.MythicalItem, target TodoState, now time.Time) db.UpdateTodoParams {
	next := db.UpdateTodoParams{ID: todo.ID, Version: todo.Version, State: string(target), StateReason: "",
		PRNumber: item.PRNumber, NeedsYou: todo.NeedsYou, Queue: todo.Queue, Lessons: todo.Lessons,
		MergedAt: todo.MergedAt, DroppedAt: todo.DroppedAt}
	if !next.PRNumber.Valid {
		next.PRNumber = todo.PRNumber
	}
	if target == TodoWorking {
		next.CurrentStep = pgtype.Text{String: item.State, Valid: true}
	}
	if item.State == "blocked" {
		switch from := TodoState(todo.State); {
		case len(todo.Failure) > 0 && from == target:
			// The failure was typed when the TODO stopped; a later write of the
			// still-blocked item keeps it.
			next.Failure = todo.Failure
		case from == TodoQueued || from == TodoStarting:
			next.Failure, _ = json.Marshal(todoItemFailure(item, "start"))
		default:
			next.Failure, _ = json.Marshal(todoItemFailure(item, ""))
		}
	}
	switch target {
	case TodoMerged, TodoDropped:
		// An open wait ends with the work.
		next.NeedsYou = nil
	}
	switch target {
	case TodoDropped:
		next.StateReason = item.State
		if !next.DroppedAt.Valid {
			next.DroppedAt = pgtype.Timestamptz{Time: now, Valid: true}
		}
	case TodoMerged:
		if !next.MergedAt.Valid {
			next.MergedAt = pgtype.Timestamptz{Time: now, Valid: true}
		}
	}
	if target != TodoDropped {
		// A reopened PR restores the TODO: its drop is behind it.
		next.DroppedAt = pgtype.Timestamptz{}
	}
	return next
}

// sameTodoFields reports whether a projection changes nothing on the row.
func sameTodoFields(todo db.Todo, next db.UpdateTodoParams) bool {
	return todo.State == next.State && todo.StateReason == next.StateReason && todo.PRNumber == next.PRNumber &&
		string(todo.NeedsYou) == string(next.NeedsYou) &&
		todo.CurrentStep == next.CurrentStep && string(todo.Failure) == string(next.Failure) &&
		todo.MergedAt == next.MergedAt && todo.DroppedAt == next.DroppedAt
}

// MemberOf answers the member a signed-in user is; a user who is no member
// (or was removed or suspended) makes no TODO.
func (s *TodoService) MemberOf(ctx context.Context, userID int64) (int64, error) {
	member, err := db.New(s.store).MemberOfUser(ctx, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, pkgerrors.Forbidden("only a member of this install makes a TODO")
	}
	return member, err
}

// RepositorySlug answers a repository's owner and name, the route segments
// its permission is checked by.
func (s *TodoService) RepositorySlug(ctx context.Context, repositoryID int64) (string, string, error) {
	q := db.New(s.store)
	repository, err := q.GetRepoByID(ctx, repositoryID)
	if err != nil {
		return "", "", err
	}
	owner, err := mythicalRepositoryOwner(ctx, q, repository)
	return owner, repository.Name, err
}

// todoActorRef is the REST identity reference. Stored event actors retain
// spec §2's notation; cards resolve these references to display identities.
func todoActorRef(raw json.RawMessage) json.RawMessage {
	var a TodoActor
	if err := json.Unmarshal(raw, &a); err != nil {
		return raw
	}
	ref := map[string]any{}
	switch {
	case a.Person != nil:
		ref["kind"], ref["id"] = "person", *a.Person
		if a.Via != "" {
			ref["via"] = a.Via
		}
		if a.Session != "" {
			ref["session"] = a.Session
		}
	case a.Agent != "":
		ref["kind"], ref["agent"], ref["run"] = "agent", a.Agent, a.Run
		if a.Todo != 0 {
			ref["todo"] = a.Todo
		}
	case a.System != "":
		ref["kind"], ref["name"] = "system", a.System
	default:
		return raw
	}
	out, _ := json.Marshal(ref)
	return out
}

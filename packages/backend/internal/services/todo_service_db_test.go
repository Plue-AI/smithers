package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// todoFixture is a repository with a stack and a member, on real
// PostgreSQL, with the stack service whose item writes project TODOs.
type todoFixture struct {
	t       *testing.T
	pool    *pgxpool.Pool
	service *MythicalService
	todos   *TodoService
	userID  int64
	// memberID is the user's members row: TODOs are owned by members.
	memberID int64
	repoID   int64
}

func newTodoFixture(t *testing.T) *todoFixture {
	t.Helper()
	pool := newProductTestPool(t)
	f := &todoFixture{t: t, pool: pool, service: NewMythicalService(pool, nil)}
	f.todos = f.service.Todos()
	f.repoID = f.repository("smithers")
	return f
}

// repository adds a repository with a stack, owned by the fixture's member.
func (f *todoFixture) repository(name string) int64 {
	f.t.Helper()
	ctx := context.Background()
	if f.userID == 0 {
		require.NoError(f.t, f.pool.QueryRow(ctx, `INSERT INTO users(username, lower_username) VALUES ('ben', 'ben') RETURNING id`).Scan(&f.userID))
		require.NoError(f.t, f.pool.QueryRow(ctx, `INSERT INTO members(user_id, login, role) VALUES ($1, 'ben', 'owner') RETURNING id`, f.userID).Scan(&f.memberID))
	}
	var repoID int64
	require.NoError(f.t, f.pool.QueryRow(ctx, `INSERT INTO repositories(user_id, name, lower_name, default_bookmark) VALUES ($1, $2, $2, 'main') RETURNING id`,
		f.userID, name).Scan(&repoID))
	_, err := f.pool.Exec(ctx, `INSERT INTO mythical_stacks(repository_id, actor_user_id, state) VALUES ($1, $2, 'active')`, repoID, f.userID)
	require.NoError(f.t, err)
	return repoID
}

func (f *todoFixture) create(key, title string) TodoView {
	f.t.Helper()
	view, created, err := f.todos.Create(context.Background(), f.repoID, TodoPerson(f.memberID, ""), key, CreateTodoInput{Title: title, Prompt: "Do " + title})
	require.NoError(f.t, err)
	require.True(f.t, created)
	return view
}

func (f *todoFixture) count(table string) int {
	f.t.Helper()
	var n int
	require.NoError(f.t, f.pool.QueryRow(context.Background(), "SELECT count(*) FROM "+table).Scan(&n))
	return n
}

// item is the work record of TODO n.
func (f *todoFixture) item(n int64) db.MythicalItem {
	f.t.Helper()
	q := db.New(f.pool)
	todo, err := q.GetTodoByNumber(context.Background(), db.GetTodoByNumberParams{RepositoryID: f.repoID, Number: n})
	require.NoError(f.t, err)
	var id string
	require.NoError(f.t, f.pool.QueryRow(context.Background(), `SELECT id::text FROM mythical_items WHERE todo_id = $1`, todo.ID).Scan(&id))
	item, err := q.GetMythicalItem(context.Background(), pgUUIDFromString(id))
	require.NoError(f.t, err)
	return item
}

func (f *todoFixture) todo(n int64) db.Todo {
	f.t.Helper()
	todo, err := db.New(f.pool).GetTodoByNumber(context.Background(), db.GetTodoByNumberParams{RepositoryID: f.repoID, Number: n})
	require.NoError(f.t, err)
	return todo
}

func (f *todoFixture) events(n int64) []db.TodoEvent {
	f.t.Helper()
	events, err := db.New(f.pool).ListTodoEvents(context.Background(), f.todo(n).ID)
	require.NoError(f.t, err)
	return events
}

func (f *todoFixture) projections(topic string) []db.ProjectionEvent {
	f.t.Helper()
	rows, err := db.New(f.pool).ListProjectionEvents(context.Background(), db.ListProjectionEventsParams{RepositoryID: f.repoID, Topic: topic, AfterSeq: 0, RowLimit: 1000})
	require.NoError(f.t, err)
	return rows
}

func TestTodoCreatePlacesATodoWithItsRevisionBranchItemEventAndProjections(t *testing.T) {
	f := newTodoFixture(t)
	view := f.create("k-1", "Add the footer link")

	assert.Equal(t, int64(1), view.N)
	assert.Equal(t, TodoQueued, view.State)
	assert.Equal(t, int64(1), view.Place)
	assert.Equal(t, "smithers/add-the-footer-link", view.Branch.Name)
	assert.Equal(t, int64(1), view.Seq)
	require.Len(t, view.Revisions, 1)
	assert.Equal(t, "Do Add the footer link", view.Revisions[0].Prompt)
	assert.Equal(t, "create", view.Revisions[0].Reason)
	require.NotNil(t, view.Owner)
	assert.Equal(t, f.memberID, *view.Owner, "the owner is the member, not the user")

	todo := f.todo(1)
	assert.Equal(t, "000000000001", todo.StackPosition)
	events := f.events(1)
	require.Len(t, events, 1)
	assert.Equal(t, "place", events[0].Kind)
	assert.Equal(t, "draft", events[0].FromState.String)
	assert.Equal(t, "queued", events[0].ToState)
	assert.JSONEq(t, fmt.Sprintf(`{"person":%d}`, f.memberID), string(events[0].Actor))

	item := f.item(1)
	assert.Equal(t, "todo", item.Source)
	assert.Equal(t, "queued", item.State)
	assert.False(t, item.IssueNumber.Valid, "a chat TODO has no issue")
	assert.Equal(t, "Add the footer link", item.IssueTitle)

	branch, err := db.New(f.pool).GetBranch(context.Background(), view.Branch.ID)
	require.NoError(t, err)
	assert.Equal(t, "item", branch.Kind)
	assert.Equal(t, "smithers/add-the-footer-link", branch.GithubBranch.String, "the GitHub branch is recorded once, at creation")

	for _, topic := range []string{"todo:1", "home"} {
		rows := f.projections(topic)
		require.Len(t, rows, 1, topic)
		assert.Equal(t, int64(1), rows[0].Seq)
	}
	var home TodoHomeDelta
	require.NoError(t, json.Unmarshal(f.projections("home")[0].Payload, &home))
	assert.Equal(t, "item", home.Type)
	assert.Equal(t, TodoQueued, home.Item.State)
	assert.Empty(t, home.Item.Revisions, "the home card lists items, not their prompts")
	var delta TodoDelta
	require.NoError(t, json.Unmarshal(f.projections("todo:1")[0].Payload, &delta))
	require.Len(t, delta.Events, 1)
	assert.Equal(t, "place", delta.Events[0].Kind)
}

func TestTodoCreateIsIdempotentPerKeyAndRefusesAReusedKey(t *testing.T) {
	f := newTodoFixture(t)
	ctx := context.Background()
	first := f.create("same", "Fix the login")
	again, created, err := f.todos.Create(ctx, f.repoID, TodoPerson(f.memberID, ""), "same", CreateTodoInput{Title: "Fix the login", Prompt: "Do Fix the login"})
	require.NoError(t, err)
	assert.False(t, created)
	assert.Equal(t, first.N, again.N)
	assert.Equal(t, 1, f.count("todos"))
	assert.Equal(t, 1, f.count("mythical_items"))
	assert.Equal(t, 1, f.count("todo_events"))
	assert.Len(t, f.projections("home"), 1, "a repeat publishes nothing")

	_, _, err = f.todos.Create(ctx, f.repoID, TodoPerson(f.memberID, ""), "same", CreateTodoInput{Title: "Something else"})
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, pkgerrors.CodeIdempotencyConflict, apiErr.Code)
	assert.Equal(t, 1, f.count("todos"))

	// Another member's same key is their own request.
	var otherUser, other int64
	require.NoError(t, f.pool.QueryRow(ctx, `INSERT INTO users(username, lower_username) VALUES ('maya', 'maya') RETURNING id`).Scan(&otherUser))
	require.NoError(t, f.pool.QueryRow(ctx, `INSERT INTO members(user_id, login, role) VALUES ($1, 'maya', 'member') RETURNING id`, otherUser).Scan(&other))
	theirs, created, err := f.todos.Create(ctx, f.repoID, TodoPerson(other, ""), "same", CreateTodoInput{Title: "Fix the login"})
	require.NoError(t, err)
	assert.True(t, created)
	assert.Equal(t, int64(2), theirs.N)
}

func TestTodoCreateRefusals(t *testing.T) {
	f := newTodoFixture(t)
	ctx := context.Background()
	person := TodoPerson(f.memberID, "")
	cases := []struct {
		name  string
		actor TodoActor
		key   string
		input CreateTodoInput
		code  pkgerrors.Code
	}{
		{"no member", TodoActor{System: "stack"}, "k", CreateTodoInput{Title: "t"}, pkgerrors.CodeForbidden},
		{"no key", person, "", CreateTodoInput{Title: "t"}, pkgerrors.CodeIdempotencyKeyRequired},
		{"a key with spaces", person, "a b", CreateTodoInput{Title: "t"}, pkgerrors.CodeIdempotencyKeyRequired},
		{"a key too long", person, strings.Repeat("k", 129), CreateTodoInput{Title: "t"}, pkgerrors.CodeIdempotencyKeyRequired},
		{"no title", person, "k", CreateTodoInput{Title: "  "}, pkgerrors.CodeValidationFailed},
		{"a two-line title", person, "k", CreateTodoInput{Title: "a\nb"}, pkgerrors.CodeValidationFailed},
		{"a title too long", person, "k", CreateTodoInput{Title: strings.Repeat("é", 257)}, pkgerrors.CodeValidationFailed},
		{"a prompt too long", person, "k", CreateTodoInput{Title: "t", Prompt: strings.Repeat("x", todoPromptBytes+1)}, pkgerrors.CodeValidationFailed},
		{"acceptance too long", person, "k", CreateTodoInput{Title: "t", Acceptance: strings.Repeat("x", todoAcceptBytes+1)}, pkgerrors.CodeValidationFailed},
		{"placed before another", person, "k", CreateTodoInput{Title: "t", Place: "before T1"}, pkgerrors.CodeValidationFailed},
	}
	for _, c := range cases {
		_, _, err := f.todos.Create(ctx, f.repoID, c.actor, c.key, c.input)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr, c.name)
		assert.Equal(t, c.code, apiErr.Code, c.name)
	}
	// A title of exactly 256 characters is accepted.
	_, created, err := f.todos.Create(ctx, f.repoID, person, "edge", CreateTodoInput{Title: strings.Repeat("é", 256)})
	require.NoError(t, err)
	assert.True(t, created)

	var bare int64
	require.NoError(t, f.pool.QueryRow(ctx, `INSERT INTO repositories(user_id, name, lower_name) VALUES ($1, 'bare', 'bare') RETURNING id`, f.userID).Scan(&bare))
	_, _, err = f.todos.Create(ctx, bare, person, "k2", CreateTodoInput{Title: "t"})
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, pkgerrors.CodeNotFound, apiErr.Code, "a repository without a stack has nowhere to place a TODO")
	assert.Equal(t, 1, f.count("todos"))
}

func TestTodoNumbersBranchesAndPositions(t *testing.T) {
	f := newTodoFixture(t)
	other := f.repository("other")
	ctx := context.Background()
	f.create("a", "Fix the login")
	f.create("b", "Fix the login")
	f.create("c", "Ünïcødé ✨ only")
	long := f.create("d", strings.Repeat("abcdefghij ", 8))
	theirs, _, err := f.todos.Create(ctx, other, TodoPerson(f.memberID, ""), "a", CreateTodoInput{Title: "Fix the login"})
	require.NoError(t, err)

	// Numbers count per repository (tech lead ruling 2026-10-02): each
	// repository's first TODO is T1.
	assert.Equal(t, int64(1), theirs.N)
	theirView, err := f.todos.Get(ctx, other, 1)
	require.NoError(t, err)
	assert.Equal(t, "Fix the login", theirView.Title)
	// Slugs are unique per repository and at most 48 characters.
	assert.Equal(t, "smithers/fix-the-login", f.todos.mustView(t, f.repoID, 1).Branch.Name)
	assert.Equal(t, "smithers/fix-the-login-2", f.todos.mustView(t, f.repoID, 2).Branch.Name)
	assert.Equal(t, "smithers/n-c-d-only", f.todos.mustView(t, f.repoID, 3).Branch.Name)
	slug := strings.TrimPrefix(long.Branch.Name, "smithers/")
	assert.LessOrEqual(t, len(slug), 48)
	assert.False(t, strings.HasSuffix(slug, "-"))
	assert.Equal(t, "smithers/fix-the-login", theirs.Branch.Name, "another repository has its own names")
	// Positions append in order, and place counts the unmerged.
	views, err := f.todos.List(ctx, f.repoID)
	require.NoError(t, err)
	require.Len(t, views, 4)
	for i, view := range views {
		assert.Equal(t, int64(i+1), view.N)
		assert.Equal(t, int64(i+1), view.Place)
	}
	assert.Equal(t, "000000000004", f.todo(4).StackPosition)

	var name string
	q := db.New(f.pool)
	for _, c := range []struct{ title, want string }{
		{"", "smithers/todo"}, {"---", "smithers/todo"}, {"A  B", "smithers/a-b"},
		{strings.Repeat("x", 47) + " y", "smithers/" + strings.Repeat("x", 47)},
	} {
		name, err = q.TodoBranchName(ctx, db.TodoBranchNameParams{RepositoryID: f.repoID, Title: c.title})
		require.NoError(t, err)
		assert.Equal(t, c.want, name, c.title)
	}
}

func (s *TodoService) mustView(t *testing.T, repositoryID, n int64) TodoView {
	t.Helper()
	view, err := s.Get(context.Background(), repositoryID, n)
	require.NoError(t, err)
	return view
}

func TestTodoAppendPositionFollowsTheLastKey(t *testing.T) {
	assert.Equal(t, "000000000001", todoAppendPosition(""))
	assert.Equal(t, "000000000010", todoAppendPosition("000000000009"))
	assert.Equal(t, "000000000006", todoAppendPosition("000000000005V"), "a key placed between two keys")
	assert.Equal(t, "a0x1", todoAppendPosition("a0x"), "a key of another shape gets a successor")
	for _, last := range []string{"000000000009", "000000000005V", "a0x"} {
		assert.Greater(t, todoAppendPosition(last), last)
	}
}

// An allowed transition writes the TODO, its event and both projections in
// the item write's transaction; a refused one writes none of them.
func TestTodoProjectionWritesAllOrNothing(t *testing.T) {
	f := newTodoFixture(t)
	ctx := context.Background()
	f.create("k", "Ship it")
	item := f.item(1)

	// Allowed: the engine launches the item; the TODO is starting.
	launched := item
	launched.State, launched.WorkspaceID = "running", "ws-1"
	saved, err := f.service.saveItem(ctx, launched)
	require.NoError(t, err)
	assert.Equal(t, "running", saved.State)
	todo := f.todo(1)
	assert.Equal(t, string(TodoStarting), todo.State)
	assert.Equal(t, int64(1), todo.Version)
	events := f.events(1)
	require.Len(t, events, 2)
	assert.Equal(t, "admit", events[1].Kind)
	assert.JSONEq(t, `{"system":"stack"}`, string(events[1].Actor))
	require.Len(t, f.projections("todo:1"), 2)
	require.Len(t, f.projections("home"), 2)
	var home TodoHomeDelta
	require.NoError(t, json.Unmarshal(f.projections("home")[1].Payload, &home))
	assert.Equal(t, TodoStarting, home.Item.State)

	// Refused: a merged TODO's item cannot restart. Nothing is written: not
	// the item, the TODO, an event or a projection.
	_, err = f.pool.Exec(ctx, `UPDATE todos SET state = 'merged' WHERE number = 1`)
	require.NoError(t, err)
	before := f.todo(1)
	requeued := f.item(1)
	requeued.State = "queued"
	_, err = f.service.saveItem(ctx, requeued)
	var refused *TodoTransitionRefused
	require.ErrorAs(t, err, &refused)
	assert.Equal(t, TodoMerged, refused.From)
	assert.Equal(t, "running", f.item(1).State, "the item write rolled back")
	assert.Equal(t, before, f.todo(1))
	assert.Len(t, f.events(1), 2)
	assert.Len(t, f.projections("todo:1"), 2)
	assert.Len(t, f.projections("home"), 2)
}

// Pure projection keeps terminal facts, while the transactional writer
// refuses every attempt to restart ended work. Late landed receipts and
// the guarded dropped-PR reopen remain valid writes to the same TODO.
func TestTodoTerminalItemWriteGuardBoundaries(t *testing.T) {
	f := newTodoFixture(t)
	ctx := context.Background()
	states := []string{"queued", "skipped", "running", "delivering", "integrating", "verifying", "proposing",
		"waiting", "retrying", "proposed", "landed", "blocked", "cancelled", "rejected", "declined"}
	for _, terminal := range []struct {
		item string
		todo TodoState
	}{{"landed", TodoMerged}, {"cancelled", TodoDropped}} {
		view := f.create(terminal.item, "Ended "+terminal.item)
		ended := f.item(view.N)
		ended.State = terminal.item
		ended.PRNumber = pgtype.Int8{Int64: view.N, Valid: true}
		ended.PRHead = strings.Repeat("a", 40)
		if terminal.todo == TodoMerged {
			ended.PRMergeCommit = strings.Repeat("b", 40)
		}
		_, err := f.service.saveItem(ctx, ended)
		require.NoError(t, err)
		for _, state := range states {
			if state == terminal.item || terminal.todo == TodoDropped && (state == "proposed" || state == "rejected" || state == "declined") {
				continue
			}
			t.Run(string(terminal.todo)+" refuses "+state, func(t *testing.T) {
				beforeItem, beforeTodo := f.item(view.N), f.todo(view.N)
				beforeEvents := f.events(view.N)
				topic := fmt.Sprintf("todo:%d", view.N)
				beforeProjection, beforeHome := f.projections(topic), f.projections("home")
				restart := beforeItem
				restart.State, restart.RequestRunID = state, "must-not-start"
				_, err := f.service.saveItem(ctx, restart)
				var refused *TodoTransitionRefused
				require.ErrorAs(t, err, &refused)
				assert.Equal(t, terminal.todo, refused.From)
				assert.Equal(t, beforeItem, f.item(view.N))
				assert.Equal(t, beforeTodo, f.todo(view.N))
				assert.Equal(t, beforeEvents, f.events(view.N))
				assert.Equal(t, beforeProjection, f.projections(topic))
				assert.Equal(t, beforeHome, f.projections("home"))
			})
		}
		beforeTodo := f.todo(view.N)
		beforeEvents := f.events(view.N)
		beforeHome := f.projections("home")
		late := f.item(view.N)
		late.RequestRunID = "late-receipt"
		saved, err := f.service.saveItem(ctx, late)
		require.NoError(t, err, "a late receipt that keeps the terminal item state is valid")
		assert.Equal(t, "late-receipt", saved.RequestRunID)
		assert.Equal(t, beforeTodo, f.todo(view.N))
		assert.Equal(t, beforeEvents, f.events(view.N))
		assert.Equal(t, beforeHome, f.projections("home"))
		if terminal.todo == TodoDropped {
			reopened := f.item(view.N)
			reopened.State = "proposed"
			saved, err := f.service.saveItem(ctx, reopened)
			require.NoError(t, err)
			assert.Equal(t, late.TodoID, saved.TodoID)
			assert.Equal(t, string(TodoInReview), f.todo(view.N).State)
			assert.Equal(t, "late-receipt", saved.RequestRunID, "reopening does not launch another run")
			events := f.events(view.N)
			require.Len(t, events, len(beforeEvents)+1)
			assert.Equal(t, "pr_reopened", events[len(events)-1].Kind)
		}
	}
	assert.Equal(t, 2, f.count("todos"), "terminal writes preserve TODO identity")
}

// A transaction that fails after the projection leaves no TODO change, no
// event and no projection row.
func TestTodoProjectionRollsBackWithItsTransaction(t *testing.T) {
	f := newTodoFixture(t)
	ctx := context.Background()
	f.create("k", "Ship it")
	launched := f.item(1)
	launched.State, launched.WorkspaceID = "running", "ws-1"
	failure := errors.New("the launch's admission failed")
	err := pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
		if _, err := f.service.saveItemIn(ctx, tx, launched); err != nil {
			return err
		}
		return failure
	})
	require.ErrorIs(t, err, failure)
	assert.Equal(t, "queued", f.item(1).State)
	assert.Empty(t, f.item(1).WorkspaceID)
	assert.Equal(t, string(TodoQueued), f.todo(1).State)
	assert.Len(t, f.events(1), 1)
	assert.Len(t, f.projections("todo:1"), 1)
	assert.Len(t, f.projections("home"), 1)
}

// A writer that read an older version loses: its conditional update
// matches no row and it reports the TODO stale.
func TestTodoStaleVersionLoses(t *testing.T) {
	f := newTodoFixture(t)
	ctx := context.Background()
	f.create("k", "Ship it")
	stale := f.todo(1)

	launched := f.item(1)
	launched.State, launched.WorkspaceID = "running", "ws-1"
	_, err := f.service.saveItem(ctx, launched)
	require.NoError(t, err)

	_, err = db.New(f.pool).UpdateTodo(ctx, todoItemFields(stale, launched, TodoStarting, f.service.now()))
	require.ErrorIs(t, err, pgx.ErrNoRows)

	// Through the projection: another writer holds the TODO and commits a
	// change while the engine's item write projects; the engine's update
	// waits, finds the version moved, and the whole item write loses.
	tx, err := f.pool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = tx.Rollback(ctx) }()
	current := f.todo(1)
	other := todoItemFields(current, f.item(1), TodoStarting, f.service.now())
	other.StateReason = "another writer"
	_, err = db.New(tx).UpdateTodo(ctx, other)
	require.NoError(t, err)
	reported := f.item(1)
	reported.RequestRunID = "run-1"
	checks := mythicalChecksOf(reported)
	checks.FirstStep = &mythicalFirstStep{Generation: reported.Generation, Run: "run-1", Sequence: 1}
	reported.Checks = checks.encode()
	done := make(chan error, 1)
	go func() {
		_, err := f.service.saveItem(ctx, reported)
		done <- err
	}()
	require.Eventually(t, func() bool {
		var waiting int
		require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM pg_locks WHERE NOT granted`).Scan(&waiting))
		return waiting > 0
	}, 10*time.Second, 10*time.Millisecond, "the engine's write waits on the other writer")
	require.NoError(t, tx.Commit(ctx))
	err = <-done
	require.ErrorIs(t, err, pgx.ErrNoRows)
	assert.Equal(t, string(TodoStarting), f.todo(1).State)
	assert.Equal(t, "another writer", f.todo(1).StateReason)
	assert.Equal(t, "", f.item(1).RequestRunID, "the item write rolled back with its projection")
}

// Concurrent engine writes of one item: exactly one commits its
// transition, the rest lose on the item's or the TODO's version.
func TestTodoConcurrentItemWritesCommitOneTransition(t *testing.T) {
	f := newTodoFixture(t)
	ctx := context.Background()
	f.create("k", "Ship it")
	launched := f.item(1)
	launched.State, launched.WorkspaceID = "running", "ws-1"
	var wg sync.WaitGroup
	results := make([]error, 12)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, results[i] = f.service.saveItem(ctx, launched)
		}(i)
	}
	wg.Wait()
	won := 0
	for _, err := range results {
		if err == nil {
			won++
			continue
		}
		require.ErrorIs(t, err, pgx.ErrNoRows)
	}
	assert.Equal(t, 1, won)
	assert.Len(t, f.events(1), 2)
	assert.Equal(t, []int64{1, 2}, seqs(f.projections("home")))
}

func seqs(rows []db.ProjectionEvent) []int64 {
	out := make([]int64, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.Seq)
	}
	return out
}

// The engine's projection walks a TODO through §4.1 with one event per
// edge: a launch that never starts fails at start, a retry requeues, a run
// reports, a PR opens and merges.
func TestTodoProjectionFollowsTheEngine(t *testing.T) {
	f := newTodoFixture(t)
	ctx := context.Background()
	f.create("k", "Ship it")
	step := func(change func(*db.MythicalItem)) db.Todo {
		t.Helper()
		item := f.item(1)
		change(&item)
		_, err := f.service.saveItem(ctx, item)
		require.NoError(t, err)
		requireTodosProjected(t, f.pool, f.repoID)
		return f.todo(1)
	}
	// §4.1: observe a machine grant before the launch can fail at start.
	starting := step(func(item *db.MythicalItem) { item.State, item.WorkspaceID = "running", "ws-first" })
	assert.Equal(t, string(TodoStarting), starting.State)
	failed := step(func(item *db.MythicalItem) {
		item.State, item.Reason = "blocked", "it launched 12 runs, the bound for one TODO"
		item.Checks = (mythicalChecks{Fault: &mythicalFault{Class: "policy", Tag: "launch_bound", Kind: mythicalFailStopped}}).encode()
	})
	assert.Equal(t, string(TodoFailed), failed.State)
	var failure TodoFailure
	require.NoError(t, json.Unmarshal(failed.Failure, &failure))
	assert.Equal(t, "start", failure.Step)
	assert.Equal(t, "policy", failure.Class)
	assert.True(t, failure.Retryable)

	retried := step(func(item *db.MythicalItem) { item.State, item.Reason, item.Checks = "queued", "", nil })
	assert.Equal(t, string(TodoQueued), retried.State)
	assert.Nil(t, retried.Failure)

	step(func(item *db.MythicalItem) { item.State, item.WorkspaceID = "running", "ws-1" })
	working := step(func(item *db.MythicalItem) {
		item.RequestRunID = "run-1"
		checks := mythicalChecksOf(*item)
		checks.FirstStep = &mythicalFirstStep{Generation: item.Generation, Run: "run-1", Sequence: 1}
		item.Checks = checks.encode()
	})
	assert.Equal(t, string(TodoWorking), working.State)
	assert.Equal(t, "running", working.CurrentStep.String)
	delivering := step(func(item *db.MythicalItem) { item.State = "delivering" })
	assert.Equal(t, string(TodoWorking), delivering.State)
	assert.Equal(t, "delivering", delivering.CurrentStep.String, "the phase changes with no event")
	review := step(func(item *db.MythicalItem) {
		item.State, item.CandidateVerified, item.PRState = "proposed", true, "open"
		item.PRNumber.Int64, item.PRNumber.Valid = 41, true
	})
	assert.Equal(t, string(TodoInReview), review.State)
	assert.Equal(t, int64(41), review.PRNumber.Int64)
	rebuilding := step(func(item *db.MythicalItem) { item.State = "integrating" })
	// §4.1.0: integrating remains working even while its PR is open.
	assert.Equal(t, string(TodoWorking), rebuilding.State, "the current integration phase is working")
	step(func(item *db.MythicalItem) { item.State = "proposed" })
	merged := step(func(item *db.MythicalItem) { item.State, item.PRMergeCommit = "landed", strings.Repeat("a", 40) })
	assert.Equal(t, string(TodoMerged), merged.State)
	assert.True(t, merged.MergedAt.Valid)

	var kinds []string
	for _, event := range f.events(1) {
		kinds = append(kinds, event.Kind+":"+event.ToState)
	}
	assert.Equal(t, []string{"place:queued", "admit:starting", "start_failed:failed", "retry:queued", "admit:starting",
		"run_started:working", "pr_opened:in_review", "steer:working", "pr_opened:in_review", "pr_merged:merged"}, kinds)
	// Every delta's state has its event, in event order (C-UI-05).
	var states []string
	for _, row := range f.projections("todo:1") {
		var delta TodoDelta
		require.NoError(t, json.Unmarshal(row.Payload, &delta))
		if len(delta.Events) > 0 {
			assert.Equal(t, string(delta.Todo.State), delta.Events[len(delta.Events)-1].To)
			assert.Equal(t, delta.Todo.Seq, delta.Events[len(delta.Events)-1].Seq)
		}
		states = append(states, string(delta.Todo.State))
	}
	// §4.1.0: integration and the accepted proposal each have committed state receipts.
	assert.Equal(t, []string{"queued", "starting", "failed", "queued", "starting", "working", "working", "in_review", "working", "in_review", "merged"}, states)
}

// An issue item gets its TODO when it is admitted, never while skipped; a
// cancelled issue that never passed admission gets none.
func TestTodoProjectionAdoptsAdmittedIssues(t *testing.T) {
	f := newTodoFixture(t)
	ctx := context.Background()
	insert := func(number int64, state string) db.MythicalItem {
		t.Helper()
		item, inserted, err := f.service.insertIssueItem(ctx, db.MythicalItem{RepositoryID: f.repoID,
			IssueNumber: pgtype.Int8{Int64: number, Valid: true}, IssueTitle: fmt.Sprintf("Issue %d", number), IssueBody: "body", IssueDigest: "d", State: state})
		require.NoError(t, err)
		require.True(t, inserted)
		return item
	}
	skipped := insert(5, "skipped")
	assert.False(t, skipped.TodoID.Valid)
	cancelled := insert(6, "cancelled")
	assert.False(t, cancelled.TodoID.Valid)
	assert.Equal(t, 0, f.count("todos"))

	admitted := skipped
	admitted.State, admitted.ApprovedDigest = "queued", "d"
	saved, err := f.service.saveItem(ctx, admitted)
	require.NoError(t, err)
	require.True(t, saved.TodoID.Valid)
	todo, err := db.New(f.pool).GetTodo(ctx, uuidString(saved.TodoID))
	require.NoError(t, err)
	assert.Equal(t, string(TodoQueued), todo.State)
	assert.Len(t, f.projections("todo:1"), 1)
	assert.Len(t, f.projections("home"), 1)
	assert.Equal(t, int64(5), todo.IssueNumber.Int64)
	assert.True(t, todo.FixesIssue)
	revisions, err := db.New(f.pool).ListTodoRevisions(ctx, todo.ID)
	require.NoError(t, err)
	require.Len(t, revisions, 1)
	assert.Equal(t, "from-issue", revisions[0].Reason)
	assert.Equal(t, "body", revisions[0].Prompt)
	assert.Equal(t, "d", revisions[0].IssueDigest.String)

	// The issue closed while queued: the TODO drops. Re-opened and
	// re-admitted, §12.3.6 requires a new TODO, preserving the old history.
	closed := f.itemByID(saved.ID)
	closed.State = "cancelled"
	_, err = f.service.saveItem(ctx, closed)
	require.NoError(t, err)
	dropped, err := db.New(f.pool).GetTodo(ctx, todo.ID)
	require.NoError(t, err)
	assert.Equal(t, string(TodoDropped), dropped.State)
	assert.Equal(t, "cancelled", dropped.StateReason)
	reopened := f.itemByID(saved.ID)
	reopened.State = "queued"
	readmitted, err := f.service.saveItem(ctx, reopened)
	require.NoError(t, err)
	require.NotEqual(t, saved.TodoID, readmitted.TodoID)
	assert.Equal(t, 2, f.count("todos"), "re-admission makes a new TODO")
	require.Equal(t, string(TodoQueued), f.todo(2).State)
	require.Len(t, f.events(2), 1)
	require.Len(t, f.projections("todo:2"), 1)
	requireTodosProjected(t, f.pool, f.repoID)
	still, err := db.New(f.pool).GetTodo(ctx, todo.ID)
	require.NoError(t, err)
	assert.Equal(t, dropped, still, "re-admission preserves the prior terminal TODO")
	priorRevisions, err := db.New(f.pool).ListTodoRevisions(ctx, todo.ID)
	require.NoError(t, err)
	assert.Equal(t, revisions, priorRevisions, "re-admission preserves its prompt history")
	// A new already-admitted issue needs its creation projection even with no phase change.
	direct := insert(7, "queued")
	require.True(t, direct.TodoID.Valid)
	require.Len(t, f.projections("todo:3"), 1)
	require.Len(t, f.projections("home"), 4) // T1 creation, drop, T2 re-admission, T3 creation.
	require.Len(t, f.events(3), 1)
}

func (f *todoFixture) itemByID(id pgtype.UUID) db.MythicalItem {
	f.t.Helper()
	item, err := db.New(f.pool).GetMythicalItem(context.Background(), id)
	require.NoError(f.t, err)
	return item
}

// Tech lead rulings 2026-10-02 (§4.1, §4.1.0, C-STK-01): a merge on GitHub
// counts from every unmerged state; a drop from every
// unmerged state. Each ends the work in the same transaction: the open wait
// is settled (needs_you null), paused_at is cleared and the attempt's run in
// flight is cancelled. Terminal item states win over both.
func TestTodoMergeAndDropEndTheWorkFromEverySourceState(t *testing.T) {
	// Cases share a migrated database but each has its own repository and
	// service. This preserves row isolation without copying the full schema
	// 32 times to check one transition table.
	base := newTodoFixture(t)
	open := json.RawMessage(`{"kind":"question","prompt":"Which one?","run_wait_id":"w1"}`)
	type source struct {
		state    TodoState
		needsYou bool
		paused   bool
	}
	sources := []source{{state: TodoQueued}, {state: TodoStarting}, {state: TodoWorking}, {state: TodoNeedsYou, needsYou: true},
		{state: TodoPaused, paused: true}, {state: TodoFailed}, {state: TodoInReview}, {state: TodoNeedsYou, needsYou: true, paused: true}}
	for _, end := range []struct {
		item string
		want TodoState
	}{{"landed", TodoMerged}, {"cancelled", TodoDropped}, {"rejected", TodoDropped}, {"declined", TodoDropped}} {
		for _, from := range sources {
			t.Run(fmt.Sprintf("%s from %s needs_you=%v paused=%v", end.item, from.state, from.needsYou, from.paused), func(t *testing.T) {
				f := &todoFixture{t: t, pool: base.pool, service: NewMythicalService(base.pool, nil), userID: base.userID, memberID: base.memberID}
				f.todos = f.service.Todos()
				f.repoID = f.repository(fmt.Sprintf("terminal-%s-%s-%v", end.item, from.state, from.paused))
				ctx := context.Background()
				f.create("k", "Ship it")
				item := f.item(1)
				// The item stands where its TODO does: a review of its open PR in flight.
				item.State, item.WorkspaceID, item.CandidateVerified = "proposed", "ws-1", true
				item.PRNumber, item.PRHead = pgtype.Int8{Int64: 9, Valid: true}, strings.Repeat("b", 40)
				item.Checks = (mythicalChecks{Review: &mythicalReview{Head: item.PRHead}}).encode()
				item.Attempt, item.Generation = 1, 3
				_, err := db.New(f.pool).SaveMythicalItem(ctx, item)
				require.NoError(t, err)
				store, scope, receipt := todoStorageDispatchPhase(t, f, f.item(1), "review")
				needsYou := any(nil)
				if from.needsYou {
					needsYou = []byte(open)
				}
				_, err = f.pool.Exec(ctx, `UPDATE todos SET state = $1, needs_you = $2, merging = '{"head":"fenced"}' WHERE number = 1 AND repository_id = $3`, string(from.state), needsYou, f.repoID)
				require.NoError(t, err)
				if from.paused {
					_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET paused_at = now() WHERE todo_id = (SELECT id FROM todos WHERE number = 1 AND repository_id = $1)`, f.repoID)
					require.NoError(t, err)
				}
				events := len(f.events(1))

				ended := f.item(1)
				ended.State = end.item
				if end.item == "landed" {
					ended.PRMergeCommit = strings.Repeat("c", 40)
				}
				_, err = f.service.saveItem(ctx, ended)
				require.NoError(t, err)
				todo := f.todo(1)
				assert.Equal(t, string(end.want), todo.State)
				assert.Nil(t, todo.NeedsYou, "the open wait is settled")
				assert.Nil(t, todo.Merging, "the merge fence is cleared")
				assert.False(t, f.item(1).PausedAt.Valid, "paused_at is cleared")
				written := f.events(1)
				require.Len(t, written, events+1)
				last := written[len(written)-1]
				assert.Equal(t, string(from.state), last.FromState.String)
				assert.Equal(t, string(end.want), last.ToState)
				var payload map[string]any
				require.NoError(t, json.Unmarshal(last.Payload, &payload))
				assert.Equal(t, true, payload["ends_work"])
				operation, err := store.Get(ctx, scope, receipt.OperationID)
				require.NoError(t, err)
				assert.True(t, operation.CancellationRequested, "the review in flight is cancelled in the same transaction")
			})
		}
	}
}

// Concurrent creates in one repository take T1..Tn with no gap and no
// repeat, while another repository counts its own.
func TestTodoConcurrentCreatesNumberWithoutGaps(t *testing.T) {
	f := newTodoFixture(t)
	other := f.repository("other")
	ctx := context.Background()
	var wg sync.WaitGroup
	numbers := make(chan int64, 24)
	errs := make(chan error, 24)
	for i := range 24 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			repository := f.repoID
			if i%6 == 0 {
				repository = other
			}
			view, _, err := f.todos.Create(ctx, repository, TodoPerson(f.memberID, ""), fmt.Sprintf("k-%d", i), CreateTodoInput{Title: fmt.Sprintf("Task %d", i)})
			if err != nil {
				errs <- err
				return
			}
			if repository == f.repoID {
				numbers <- view.N
			}
		}(i)
	}
	wg.Wait()
	close(numbers)
	close(errs)
	for err := range errs {
		require.NoError(t, err)
	}
	seen := map[int64]bool{}
	for n := range numbers {
		assert.False(t, seen[n], "T%d twice", n)
		seen[n] = true
	}
	require.Len(t, seen, 20)
	for n := int64(1); n <= 20; n++ {
		assert.True(t, seen[n], "T%d is missing", n)
	}
	views, err := f.todos.List(ctx, other)
	require.NoError(t, err)
	require.Len(t, views, 4)
	for i, view := range views {
		assert.Equal(t, int64(i+1), view.N, "the other repository counts T1..T4")
	}
}

// The create key is unique per creator, and a creator with no person (the
// stack itself) shares one key space: a repeated key never makes a second
// TODO, for any actor kind.
func TestTodoCreateKeyIsUniqueForEveryActorKind(t *testing.T) {
	f := newTodoFixture(t)
	ctx := context.Background()
	for _, actor := range []TodoActor{{System: "stack"}, {Agent: "coding", Run: "r1"}} {
		_, _, err := f.todos.Create(ctx, f.repoID, actor, "k", CreateTodoInput{Title: "t"})
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr, "%+v makes no TODO: only a member does", actor)
		assert.Equal(t, pkgerrors.CodeForbidden, apiErr.Code)
	}
	agentFor := TodoPerson(f.memberID, "claude-code")
	view, created, err := f.todos.Create(ctx, f.repoID, agentFor, "via", CreateTodoInput{Title: "t"})
	require.NoError(t, err)
	assert.True(t, created)
	again, created, err := f.todos.Create(ctx, f.repoID, TodoPerson(f.memberID, ""), "via", CreateTodoInput{Title: "t"})
	require.NoError(t, err)
	assert.False(t, created, "the person's key, whatever agent sent it")
	assert.Equal(t, view.N, again.N)

	// NULLS NOT DISTINCT applies to every actor without a person, including
	// different system and agent names sharing the same repository/key.
	other := f.repository("actor-keys")
	for i, actors := range [][]TodoActor{
		{TodoPerson(f.memberID, ""), TodoPerson(f.memberID, "codex")},
		{{System: "stack"}, {System: "sync"}},
		{{Agent: "coding", Run: "r1"}, {Agent: "review", Run: "r2"}},
		{{System: "stack"}, {Agent: "coding", Run: "r3"}},
	} {
		key := fmt.Sprintf("schema-key-%d", i)
		insert := func(repository, number int64, actor TodoActor) error {
			_, err := f.pool.Exec(ctx, `INSERT INTO todos (repository_id, number, title, state, stack_position, created_by_actor, create_key, create_digest)
				VALUES ($1, $2, 't', 'queued', $3, $4, $5, 'd')`, repository, number, fmt.Sprintf("x%d", number), actor.encode(), key)
			return err
		}
		require.NoError(t, insert(f.repoID, int64(100+i*2), actors[0]))
		require.ErrorContains(t, insert(f.repoID, int64(101+i*2), actors[1]), "todos_create_key_idx")
		require.NoError(t, insert(other, int64(i+1), actors[1]), "keys are scoped to a repository")
	}

}

// A TODO's owner and an approval's approver are members (spec §2), never
// users: a users.id that is no members.id is refused by the schema, and a
// user who is no member (or was removed) makes no TODO.
func TestTodoOwnersAndApproversAreMembers(t *testing.T) {
	f := newTodoFixture(t)
	ctx := context.Background()
	// Push the user ids past the member ids, so a user id names no member.
	var stranger int64
	for range 3 {
		require.NoError(t, f.pool.QueryRow(ctx, `INSERT INTO users(username, lower_username) VALUES ($1, $1) RETURNING id`,
			fmt.Sprintf("u%d", stranger+1)).Scan(&stranger))
	}
	var isMember bool
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM members WHERE id = $1)`, stranger).Scan(&isMember))
	require.False(t, isMember)

	_, err := f.pool.Exec(ctx, `INSERT INTO todos (repository_id, number, title, state, stack_position, created_by_actor, owner_id)
		VALUES ($1, 50, 't', 'queued', 'z', '{}', $2)`, f.repoID, stranger)
	require.ErrorContains(t, err, "todos_owner_id_fkey", "a users.id is not a member")
	_, err = f.pool.Exec(ctx, `INSERT INTO todos (repository_id, number, title, state, stack_position, created_by_actor, owner_id)
		VALUES ($1, 51, 't', 'queued', 'y', '{}', $2)`, f.repoID, f.memberID)
	require.NoError(t, err)

	view := f.create("k", "Ship it")
	todo := f.todo(view.N)
	_, err = f.pool.Exec(ctx, `INSERT INTO todo_approvals (todo_id, member_id, pr_head_sha, credential_id) VALUES ($1, $2, 'abc', 'c1')`, todo.ID, stranger)
	require.ErrorContains(t, err, "todo_approvals_member_id_fkey")
	_, err = f.pool.Exec(ctx, `INSERT INTO todo_approvals (todo_id, member_id, pr_head_sha, credential_id) VALUES ($1, $2, 'abc', 'c1')`, todo.ID, f.memberID)
	require.NoError(t, err)

	member, err := f.todos.MemberOf(ctx, f.userID)
	require.NoError(t, err)
	assert.Equal(t, f.memberID, member)
	_, err = f.todos.MemberOf(ctx, stranger)
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, pkgerrors.CodeForbidden, apiErr.Code)
	_, err = f.pool.Exec(ctx, `UPDATE members SET removed_at = now() WHERE id = $1`, f.memberID)
	require.NoError(t, err)
	_, err = f.todos.MemberOf(ctx, f.userID)
	require.ErrorAs(t, err, &apiErr, "a removed member makes no TODO")
}

// Spec §3: two repositories may both own T1, but never share a topic sequence.
func TestTodoProjectionStreamsAreRepositoryScoped(t *testing.T) {
	f := newTodoFixture(t)
	ctx := context.Background()
	a := f.create("a", "Private prompt A")
	other := f.repository("other")
	b, _, err := f.todos.Create(ctx, other, TodoPerson(f.memberID, ""), "b", CreateTodoInput{Title: "Private prompt B"})
	require.NoError(t, err)
	require.Equal(t, a.N, b.N)
	for _, topic := range []string{"todo:1", "home"} {
		for _, repo := range []int64{f.repoID, other} {
			rows, err := db.New(f.pool).ListProjectionEvents(ctx, db.ListProjectionEventsParams{RepositoryID: repo, Topic: topic, RowLimit: 100})
			require.NoError(t, err)
			require.Len(t, rows, 1)
			require.Equal(t, int64(1), rows[0].Seq)
			expected := "Private prompt A"
			foreign := "Private prompt B"
			if repo == other {
				expected, foreign = foreign, expected
			}
			require.Contains(t, string(rows[0].Payload), expected)
			require.NotContains(t, string(rows[0].Payload), foreign)
		}
	}
}

// The real database reads are paused after reading the TODO row, while a
// real writer commits the next state. This wrapper only schedules the race.
type todoSnapshotStore struct {
	*pgxpool.Pool
	read, resume chan struct{}
}
type todoSnapshotTx struct {
	pgx.Tx
	read, resume chan struct{}
}
type todoSnapshotRow struct {
	pgx.Row
	read, resume chan struct{}
}

func (s todoSnapshotStore) Begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return todoSnapshotTx{tx, s.read, s.resume}, nil
}
func (tx todoSnapshotTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	row := tx.Tx.QueryRow(ctx, sql, args...)
	if strings.Contains(sql, "-- name: GetTodoByNumber") {
		return todoSnapshotRow{row, tx.read, tx.resume}
	}
	return row
}
func (r todoSnapshotRow) Scan(dest ...any) error {
	err := r.Row.Scan(dest...)
	close(r.read)
	<-r.resume
	return err
}
func TestTodoGetUsesOneConsistentSnapshot(t *testing.T) {
	f := newTodoFixture(t)
	f.create("snapshot", "Snapshot")
	ctx := context.Background()
	read, resume := make(chan struct{}), make(chan struct{})
	service := NewTodoService(todoSnapshotStore{f.pool, read, resume})
	type result struct {
		view TodoView
		err  error
	}
	done := make(chan result, 1)
	go func() { v, e := service.Get(ctx, f.repoID, 1); done <- result{v, e} }()
	select {
	case <-read:
	case <-time.After(5 * time.Second):
		t.Fatal("snapshot read never started")
	}
	// Always release the reader, including when a writer assertion fails.
	func() {
		defer close(resume)
		item := f.item(1)
		item.State, item.WorkspaceID = "running", "ws-snapshot"
		_, err := f.service.saveItem(ctx, item)
		require.NoError(t, err)
	}()
	r := <-done
	require.NoError(t, r.err)
	require.Equal(t, TodoQueued, r.view.State)
	require.Equal(t, int64(1), r.view.Seq)
	latest, err := f.todos.Get(ctx, f.repoID, 1)
	require.NoError(t, err)
	require.Equal(t, TodoStarting, latest.State)
	require.Equal(t, int64(2), latest.Seq)
	rows, err := f.todos.List(ctx, f.repoID)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, latest.Seq, rows[0].Seq)
	require.Equal(t, latest.State, rows[0].State)
}

// §3.1: admission sees saved engine facts before any card projection exists.
func TestTodoProjectionPublishesAfterAdmission(t *testing.T) {
	f := newTodoFixture(t)
	ctx := context.Background()
	f.create("k", "Ship it")
	launcher := &fakeMythicalLauncher{onAdmit: func(ctx context.Context, tx pgx.Tx) {
		var state string
		require.NoError(t, tx.QueryRow(ctx, "SELECT state FROM mythical_items WHERE todo_id = $1", f.todo(1).ID).Scan(&state))
		require.Equal(t, "running", state)
		var count int
		require.NoError(t, tx.QueryRow(ctx, "SELECT count(*) FROM projection_events WHERE topic = 'todo:1'").Scan(&count))
		require.Equal(t, 1, count)
	}}
	f.service.launcher = launcher
	item := f.item(1)
	item.State = "running"
	item.WorkspaceID = "ws-1"
	step := mythicalItemStep{s: f.service, r: &mythicalRun{row: db.MythicalStack{RepositoryID: f.repoID}}, inFlight: make(map[[16]byte]bool)}
	_, err := step.commit(ctx, item, "request", "coding/request", json.RawMessage(`{}`))
	require.NoError(t, err)
	require.Len(t, f.projections("todo:1"), 2)
}

package services

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// fileTodoAt files the owner's TODO title at place (zero: append).
func (o *mythicalOrchestration) fileTodoAt(session context.Context, title string, place MythicalTodoPlace) (MythicalItemView, error) {
	return o.service.FileTodo(session, o.repoID, o.userID, MythicalTodoInput{Title: title, Prompt: "Add " + title + " to JOURNEY.md",
		Place: place, Request: "file-" + title})
}

// stackOrder is the TODO numbers still on the stack, in place order.
func (o *mythicalOrchestration) stackOrder() []int64 {
	o.t.Helper()
	rows, err := o.pool.Query(context.Background(), `SELECT number FROM mythical_items WHERE repository_id = $1
		AND state NOT IN ('landed', 'cancelled', 'rejected', 'declined') ORDER BY stack_position`, o.repoID)
	require.NoError(o.t, err)
	defer rows.Close()
	var order []int64
	for rows.Next() {
		var n int64
		require.NoError(o.t, rows.Scan(&n))
		order = append(order, n)
	}
	require.NoError(o.t, rows.Err())
	return order
}

func (o *mythicalOrchestration) move(session context.Context, n int64, direction, request string) (TodoControlReceipt, error) {
	return o.service.ControlTodo(session, n, TodoControlInput{Op: "move", Direction: direction, Repository: o.repoID, Actor: o.userID, Request: request})
}

func requireTodoRefusal(t *testing.T, err error, status int, code, message string) {
	t.Helper()
	var refusal *TodoControlError
	require.ErrorAs(t, err, &refusal)
	require.Equal(t, status, refusal.Status, refusal.Message)
	require.Equal(t, code, refusal.Code, refusal.Message)
	if message != "" {
		require.Equal(t, message, refusal.Message)
	}
}

// J4.2c, C-J4-02: Move up and Move down swap a TODO with the nearest item
// still on the stack, past a failed one too; the card's place follows. The
// same press again is the same move; the first item cannot move up or the
// last down; a merged TODO and a run's credential cannot move; each move is
// one todo.moved fact.
func TestTodoMoveSwapsWithTheNearestItemOnTheStack(t *testing.T) {
	o, session := newTodoAdmission(t)
	var n [5]int64
	for i, title := range []string{"one", "two", "three", "four"} {
		view, err := o.fileTodoAt(session, title, MythicalTodoPlace{})
		require.NoError(t, err)
		n[i+1] = view.Number
	}
	require.Equal(t, []int64{n[1], n[2], n[3], n[4]}, o.stackOrder())
	// T3 failed; T1 merged.
	_, err := o.pool.Exec(context.Background(), `UPDATE mythical_items SET state = CASE number WHEN $2 THEN 'blocked' ELSE 'landed' END
		WHERE repository_id = $1 AND number IN ($2, $3)`, o.repoID, n[3], n[1])
	require.NoError(t, err)
	require.Equal(t, []int64{n[2], n[3], n[4]}, o.stackOrder())

	receipt, err := o.move(session, n[4], "up", "move-1")
	require.NoError(t, err)
	require.Equal(t, TodoControlReceipt{State: "accepted", Place: 3}, receipt)
	require.Equal(t, []int64{n[2], n[4], n[3]}, o.stackOrder())
	require.EqualValues(t, 3, o.todoCard(n[4])["place"])
	require.EqualValues(t, 4, o.todoCard(n[3])["place"])
	again, err := o.move(session, n[4], "up", "move-1")
	require.NoError(t, err)
	require.Equal(t, receipt, again, "the same press again is the same move")
	require.Equal(t, []int64{n[2], n[4], n[3]}, o.stackOrder())
	_, err = o.move(session, n[4], "down", "move-1")
	requireTodoRefusal(t, err, http.StatusConflict, "idempotency_mismatch", "")

	_, err = o.move(session, n[4], "up", "move-2")
	require.NoError(t, err)
	require.Equal(t, []int64{n[4], n[2], n[3]}, o.stackOrder())
	_, err = o.move(session, n[4], "up", "move-3")
	requireTodoRefusal(t, err, http.StatusConflict, "conflict", "T4 is already first")
	_, err = o.move(session, n[3], "down", "move-4")
	requireTodoRefusal(t, err, http.StatusConflict, "conflict", "T3 is already last")
	_, err = o.move(session, n[1], "down", "move-5")
	requireTodoRefusal(t, err, http.StatusConflict, "conflict", "TODO is settled")
	_, err = o.move(session, 99, "down", "move-6")
	requireTodoRefusal(t, err, http.StatusNotFound, "todo_not_found", "")
	_, err = o.service.ControlTodo(mythicalRunContext(context.Background(), o.userID), n[2], TodoControlInput{Op: "move", Direction: "down",
		Repository: o.repoID, Actor: o.userID, Request: "move-7"})
	requireTodoRefusal(t, err, http.StatusForbidden, "permission", "Only a person moves a TODO")
	require.Equal(t, []int64{n[4], n[2], n[3]}, o.stackOrder(), "no refused move changed the order")

	// A TODO moves down past a failed one too.
	_, err = o.move(session, n[2], "down", "move-8")
	require.NoError(t, err)
	require.Equal(t, []int64{n[4], n[3], n[2]}, o.stackOrder())

	owner, err := o.service.queries().GetUserByID(context.Background(), o.userID)
	require.NoError(t, err)
	facts := o.facts(mustItemByNumber(t, o, n[4]), "todo.moved")
	require.Len(t, facts, 2, "one fact per move, none for the repeated press")
	require.Equal(t, "up", facts[0]["direction"])
	require.EqualValues(t, 4, facts[0]["from"])
	require.EqualValues(t, 3, facts[0]["to"])
	require.EqualValues(t, n[3], facts[0]["past"])
	require.Equal(t, owner.Username, facts[0]["actor"].(map[string]any)["login"])
	require.EqualValues(t, n[2], facts[1]["past"])
}

func mustItemByNumber(t *testing.T, o *mythicalOrchestration, n int64) db.MythicalItem {
	t.Helper()
	item, err := o.service.queries().GetMythicalItemByNumber(context.Background(), o.repoID, n)
	require.NoError(t, err)
	return item
}

// A merging TODO, or a merging neighbor, does not move (spec §10.6.2b): the
// order and every version stay as they were.
func TestTodoMoveRefusesAMergingNeighbor(t *testing.T) {
	o, session := newTodoAdmission(t)
	first, err := o.fileTodoAt(session, "first", MythicalTodoPlace{})
	require.NoError(t, err)
	second, err := o.fileTodoAt(session, "second", MythicalTodoPlace{})
	require.NoError(t, err)
	_, err = o.pool.Exec(context.Background(), `UPDATE mythical_items SET pending_op = $2 WHERE repository_id = $1 AND number = $3`, o.repoID,
		`{"kind":"merge","target":"1","desired":"`+strings.Repeat("a", 40)+`","state":"intended"}`, first.Number)
	require.NoError(t, err)
	before := mustItemByNumber(t, o, second.Number)
	_, err = o.move(session, second.Number, "up", "up")
	requireTodoRefusal(t, err, http.StatusConflict, "merging", "T1 is merging")
	_, err = o.move(session, first.Number, "down", "down")
	requireTodoRefusal(t, err, http.StatusConflict, "merging", "TODO is merging")
	require.Equal(t, []int64{first.Number, second.Number}, o.stackOrder())
	require.Equal(t, before.Version, mustItemByNumber(t, o, second.Number).Version)
	require.Empty(t, o.facts(before, "todo.moved"))
}

// A move swaps verified candidates' prefixes: T2, verified on T1's head,
// moved above T1 loses its verification and waits for its rebase onto main,
// keeping its candidate; T1, still on main, keeps its verification.
func TestTodoMoveInvalidatesACandidateBuiltOnItsOldPrefix(t *testing.T) {
	o, session := newTodoAdmission(t)
	main := o.landedMain()
	one, err := o.fileTodoAt(session, "one", MythicalTodoPlace{})
	require.NoError(t, err)
	two, err := o.fileTodoAt(session, "two", MythicalTodoPlace{})
	require.NoError(t, err)
	headOne, headTwo := strings.Repeat("1", 40), strings.Repeat("2", 40)
	_, err = o.pool.Exec(context.Background(), `UPDATE mythical_items SET state = 'proposing', candidate_verified = true,
		candidate_base = CASE number WHEN $2 THEN $4 ELSE $5 END, candidate_head = CASE number WHEN $2 THEN $5 ELSE $6 END
		WHERE repository_id = $1 AND number IN ($2, $3)`, o.repoID, one.Number, two.Number, main, headOne, headTwo)
	require.NoError(t, err)

	_, err = o.move(session, two.Number, "up", "up")
	require.NoError(t, err)
	require.Equal(t, []int64{two.Number, one.Number}, o.stackOrder())
	moved := mustItemByNumber(t, o, two.Number)
	require.Equal(t, "integrating", moved.State)
	require.Equal(t, "rebase_pending", moved.Reason)
	require.False(t, moved.CandidateVerified)
	require.Equal(t, headTwo, moved.CandidateHead, "the candidate's bytes stay for the rebase")
	rebase := mythicalChecksOf(moved).Rebase
	require.NotNil(t, rebase)
	require.Equal(t, main, rebase.Onto, "T2 rebases onto main, its new prefix")
	require.Equal(t, "main", rebase.Name)
	require.False(t, rebase.Since.IsZero())
	kept := mustItemByNumber(t, o, one.Number)
	require.Equal(t, "proposing", kept.State)
	require.True(t, kept.CandidateVerified, "T1 is still built on main")
	facts := o.facts(moved, "todo.moved")
	require.Len(t, facts, 1)
	require.EqualValues(t, 1, facts[0]["rebase"])

	// Moving it back: T2 is unverified, so T1's prefix is main either way.
	_, err = o.move(session, two.Number, "down", "down")
	require.NoError(t, err)
	require.True(t, mustItemByNumber(t, o, one.Number).CandidateVerified)
}

// J7.1a, C-J7-01: Before T3 takes T3's place; T3 and every later item move
// one place later; the stack admits the new TODO before T3. Before names a
// TODO still on the stack and not merging; amend waits for T-STK-06.
func TestFileTodoBeforeTakesThePlaceAndIsAdmittedFirst(t *testing.T) {
	o, session := newTodoAdmission(t)
	o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
	_, err := o.pool.Exec(context.Background(), `UPDATE mythical_stacks SET max_parallel = 1 WHERE repository_id = $1`, o.repoID)
	require.NoError(t, err)
	var n []int64
	for _, title := range []string{"one", "two", "three", "four"} {
		view, err := o.fileTodoAt(session, title, MythicalTodoPlace{})
		require.NoError(t, err)
		n = append(n, view.Number)
	}
	_, err = o.pool.Exec(context.Background(), `UPDATE mythical_items SET state = 'landed' WHERE repository_id = $1 AND number = $2`, o.repoID, n[0])
	require.NoError(t, err)
	before := n[2]
	inserted, err := o.fileTodoAt(session, "inserted", MythicalTodoPlace{Mode: "before", N: &before})
	require.NoError(t, err)
	require.Equal(t, []int64{n[1], inserted.Number, n[2], n[3]}, o.stackOrder())
	require.EqualValues(t, 3, o.todoCard(inserted.Number)["place"])
	require.EqualValues(t, 4, o.todoCard(n[2])["place"])
	replay, err := o.fileTodoAt(session, "inserted", MythicalTodoPlace{Mode: "before", N: &before})
	require.NoError(t, err)
	require.Equal(t, inserted.Number, replay.Number, "the same request files the same TODO")
	require.Equal(t, []int64{n[1], inserted.Number, n[2], n[3]}, o.stackOrder())
	facts := o.facts(o.byID(inserted.ID), "todo.created")
	require.Len(t, facts, 1)
	require.EqualValues(t, before, facts[0]["before"])
	require.EqualValues(t, 3, facts[0]["place"])

	// T2 holds the only slot; the inserted TODO is admitted before T3.
	o.wake()
	launches := o.launcher.byFlow("todo")
	require.Len(t, launches, 1)
	require.Contains(t, launches[0].RequestID, uuidString(mustItemByNumber(t, o, n[1]).ID))
	_, err = o.pool.Exec(context.Background(), `UPDATE mythical_items SET state = 'landed', workspace_id = '' WHERE repository_id = $1 AND number = $2`, o.repoID, n[1])
	require.NoError(t, err)
	o.wake()
	launches = o.launcher.byFlow("todo")
	require.Len(t, launches, 2)
	require.Contains(t, launches[1].RequestID, uuidString(mustItemByNumber(t, o, inserted.Number).ID), "the inserted TODO is admitted before T3")
	require.Equal(t, "queued", todoState(mustItemByNumber(t, o, n[2])))

	missing, merged := int64(99), n[0]
	for _, place := range []MythicalTodoPlace{{Mode: "before", N: &missing}, {Mode: "before", N: &merged}, {Mode: "before"}, {Mode: "amend", N: &before}, {Mode: "after", N: &before}} {
		_, err = o.fileTodoAt(session, "refused-"+place.Mode, place)
		requireTodoRefusal(t, err, http.StatusBadRequest, "invalid_place", "")
	}
	_, err = o.pool.Exec(context.Background(), `UPDATE mythical_items SET pending_op = $2 WHERE repository_id = $1 AND number = $3`, o.repoID,
		`{"kind":"merge","target":"1","desired":"`+strings.Repeat("a", 40)+`","state":"intended"}`, n[3])
	require.NoError(t, err)
	fenced := n[3]
	_, err = o.fileTodoAt(session, "fenced", MythicalTodoPlace{Mode: "before", N: &fenced})
	requireTodoRefusal(t, err, http.StatusConflict, "merging", "T4 is merging")
}

// Move reorders admission too: with one slot, the TODO moved up starts first.
func TestTodoMoveReordersAdmission(t *testing.T) {
	o, session := newTodoAdmission(t)
	o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
	_, err := o.pool.Exec(context.Background(), `UPDATE mythical_stacks SET max_parallel = 1 WHERE repository_id = $1`, o.repoID)
	require.NoError(t, err)
	_, err = o.fileTodoAt(session, "first", MythicalTodoPlace{})
	require.NoError(t, err)
	second, err := o.fileTodoAt(session, "second", MythicalTodoPlace{})
	require.NoError(t, err)
	_, err = o.move(session, second.Number, "up", "up")
	require.NoError(t, err)
	o.wake()
	launches := o.launcher.byFlow("todo")
	require.Len(t, launches, 1)
	require.Contains(t, launches[0].RequestID, second.ID)
}

// Concurrent presses: one press made twice at once moves once; two different
// presses on the same pair serialize, each a whole swap.
func TestTodoMoveConcurrentPressesSerialize(t *testing.T) {
	o, session := newTodoAdmission(t)
	var n []int64
	for _, title := range []string{"one", "two", "three"} {
		view, err := o.fileTodoAt(session, title, MythicalTodoPlace{})
		require.NoError(t, err)
		n = append(n, view.Number)
	}
	var wg sync.WaitGroup
	receipts, errs := make(chan TodoControlReceipt, 4), make(chan error, 4)
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			receipt, err := o.move(session, n[2], "up", "same")
			receipts <- receipt
			errs <- err
		}()
	}
	wg.Wait()
	close(receipts)
	close(errs)
	for err := range errs {
		require.NoError(t, err)
	}
	for receipt := range receipts {
		require.Equal(t, TodoControlReceipt{State: "accepted", Place: 2}, receipt)
	}
	require.Equal(t, []int64{n[0], n[2], n[1]}, o.stackOrder())
	errs = make(chan error, 2)
	for _, request := range []string{"a", "b"} {
		go func() {
			_, err := o.move(session, n[1], "up", request)
			errs <- err
		}()
	}
	for range 2 {
		require.NoError(t, <-errs)
	}
	require.Equal(t, []int64{n[1], n[0], n[2]}, o.stackOrder(), "two whole swaps, one after the other")
}

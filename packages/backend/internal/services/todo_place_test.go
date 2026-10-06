package services

import (
	"context"
	"fmt"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestTodoPlacementThousandInserts(t *testing.T) {
	o, session := newTodoAdmission(t)
	first, err := o.fileTodoAt(session, "first", MythicalTodoPlace{})
	require.NoError(t, err)
	last, err := o.fileTodoAt(session, "last", MythicalTodoPlace{})
	require.NoError(t, err)
	for i := 0; i < 1000; i++ {
		_, err = o.fileTodoAt(session, fmt.Sprintf("insert-%d", i), MythicalTodoPlace{Mode: "before", N: &last.Number})
		require.NoError(t, err)
	}
	var count, distinct, min, max int64
	require.NoError(t, o.pool.QueryRow(context.Background(), `SELECT count(*),count(DISTINCT stack_position),min(stack_position),max(stack_position) FROM mythical_items WHERE repository_id=$1`, o.repoID).Scan(&count, &distinct, &min, &max))
	require.EqualValues(t, 1002, count)
	require.Equal(t, count, distinct)
	require.EqualValues(t, 1, min)
	require.Equal(t, count, max)
	order := o.stackOrder()
	require.Equal(t, first.Number, order[0])
	require.Equal(t, last.Number, order[1001])
	require.EqualValues(t, 3, order[1])
	require.EqualValues(t, 1002, order[1000])
	beforeFirst, err := o.fileTodoAt(session, "before-first", MythicalTodoPlace{Mode: "before", N: &first.Number})
	require.NoError(t, err)
	order = o.stackOrder()
	require.Equal(t, beforeFirst.Number, order[0])
	require.Equal(t, first.Number, order[1])
	require.Equal(t, last.Number, order[1002])
	require.NoError(t, o.pool.QueryRow(session, `SELECT count(*),count(DISTINCT stack_position),min(stack_position),max(stack_position) FROM mythical_items WHERE repository_id=$1`, o.repoID).Scan(&count, &distinct, &min, &max))
	require.EqualValues(t, 1003, count)
	require.Equal(t, count, distinct)
	require.EqualValues(t, 1, min)
	require.Equal(t, count, max)

}

func TestTodoDropInvalidatesSuccessorAndDependencies(t *testing.T) {
	o, session := newTodoAdmission(t)
	one, err := o.fileTodoAt(session, "one", MythicalTodoPlace{})
	require.NoError(t, err)
	two, err := o.fileTodoAt(session, "two", MythicalTodoPlace{})
	require.NoError(t, err)
	_, err = o.pool.Exec(session, `UPDATE mythical_stacks SET landed_main='main-tip' WHERE repository_id=$1`, o.repoID)
	require.NoError(t, err)
	_, err = o.pool.Exec(session, `UPDATE mythical_items SET candidate_verified=true,candidate_base=CASE number WHEN 1 THEN 'main-tip' ELSE 'one-head' END,candidate_head=CASE number WHEN 1 THEN 'one-head' ELSE 'two-head' END,state='proposing' WHERE repository_id=$1`, o.repoID)
	require.NoError(t, err)
	view, err := o.service.Item(session, o.repoID, two.ID)
	require.NoError(t, err)
	require.Equal(t, []string{one.ID}, view.DependsOn)
	_, err = o.service.ControlTodo(session, one.Number, TodoControlInput{Op: "drop", Repository: o.repoID, Actor: o.userID, Request: "drop"})
	require.NoError(t, err)
	successor, err := db.New(o.pool).GetMythicalItemByNumber(session, o.repoID, two.Number)
	require.NoError(t, err)
	require.False(t, successor.CandidateVerified)
	require.Equal(t, "rebase_pending", successor.Reason)
	require.Equal(t, "two-head", successor.CandidateHead)
	require.EqualValues(t, 1, successor.StackPosition.Int64)
	view, err = o.service.Item(session, o.repoID, two.ID)
	require.NoError(t, err)
	require.Empty(t, view.DependsOn)
}

// Moving T3 above T2 changes its prefix to T1. Replant preserves only T3's
// own commits; T2's inherited bytes must disappear from T3's candidate.
func TestTodoMovedCandidateReplantsOwnCommits(t *testing.T) {
	f := newMythicalFixture(t)
	ctx := context.Background()
	f.commit("base", map[string]string{"base.txt": "base\n"})
	main := f.run("rev-parse", "HEAD")
	one := f.laneCommit(main, "One", map[string]string{"one.txt": "one\n"}, mythicalChangeIDFor("one"))
	two := f.laneCommit(one, "Two", map[string]string{"two.txt": "two\n"}, mythicalChangeIDFor("two"))
	three := f.laneCommit(two, "Three", map[string]string{"three.txt": "three\n"}, mythicalChangeIDFor("three"))
	head, err := f.git.rebaseCandidate(ctx, one, mythicalCandidate{Base: two, Head: three, ItemID: "three"}, 100)
	require.NoError(t, err)
	require.Equal(t, "one", f.file(head, "one.txt"))
	require.Equal(t, "three", f.file(head, "three.txt"))
	files, err := f.git.git(ctx, "ls-tree", "--name-only", head)
	require.NoError(t, err)
	require.NotContains(t, files, "two.txt")
	commit, err := f.git.readCommit(ctx, head)
	require.NoError(t, err)
	require.Equal(t, one, commit.Parent())
}

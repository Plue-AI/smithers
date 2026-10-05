package services

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// C-J2-01, backend half: Make TODO commits the member's Draft through
// FileTodo, the service POST /api/todos calls, with real PostgreSQL and the
// GitHub fake. The TODO is the issue's: source issue, its number, the digest
// of the text the Draft was made from and fixes_issue, with the Draft's own
// text as revision 1.
func TestTodoFromIssueCommitsTheDraftAsTheIssueTodo(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	var userID, repoID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username,display_name) VALUES('will','will','Will') RETURNING id`).Scan(&userID))
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(singleton,user_id) VALUES(true,$1)`, userID)
	require.NoError(t, err)
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'app','app') RETURNING id`, userID).Scan(&repoID))
	q := db.New(pool)
	_, err = q.RequestMythicalBootstrap(ctx, repoID, userID, 1, false)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state='active' WHERE repository_id=$1`, repoID)
	require.NoError(t, err)
	gh := &fakeMythicalGitHub{issues: []mythicalIssue{
		{Number: 7, Title: "Webhooks fail on 502", Body: "Webhooks fail on 502", URL: "https://github.com/acme/app/issues/7", State: "open", TextByMaintainer: true},
		{Number: 8, Title: "Crash on start", Body: "It crashes.", URL: "https://github.com/acme/app/issues/8", State: "open"},
		{Number: 9, Title: "Old", Body: "Done already", URL: "https://github.com/acme/app/issues/9", State: "closed", TextByMaintainer: true},
		{Number: 10, Title: "A pull request", Body: "", URL: "https://github.com/acme/app/pull/10", State: "open", TextByMaintainer: true, PullRequest: true},
	}}
	s := NewMythicalService(pool, nil)
	s.github = gh
	ctx = middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &db.User{ID: userID}, SessionHash: "will-session"})
	refused := func(t *testing.T, input MythicalTodoInput, status int, code string) {
		t.Helper()
		_, err := s.FileTodo(ctx, repoID, userID, input)
		var typed *TodoControlError
		require.ErrorAs(t, err, &typed)
		require.Equal(t, status, typed.Status, typed.Message)
		require.Equal(t, code, typed.Code)
	}
	count := func() int {
		var n int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE repository_id=$1`, repoID).Scan(&n))
		return n
	}
	seven, eight := int64(7), int64(8)
	read := mythicalIssueDigest(gh.issues[0])
	// The app computes the same digest (TodoSeam.test.ts pins this literal).
	require.Equal(t, "4babb1e1dd0eee80b2bc65f0117d7ac639a2914627f7a0569119d42379ce3d37", read)
	prompt := "Webhooks fail on 502\n\n@alice:\n> retry at most 5 times with jittered backoff\n\nLog each retry."
	draft := MythicalTodoInput{Title: "Retry webhooks", Prompt: prompt, Acceptance: []string{"a 502 is retried 5 times"},
		Issue: &seven, IssueDigest: read, Request: "draft-7"}

	// Half an issue reference is refused before any read.
	refused(t, MythicalTodoInput{Title: "x", Prompt: "y", IssueDigest: read, Request: "half-1"}, 400, "invalid_todo")
	refused(t, MythicalTodoInput{Title: "x", Prompt: "y", Issue: &seven, Request: "half-2"}, 400, "invalid_todo")
	refused(t, MythicalTodoInput{Title: "x", Prompt: "y", Issue: &seven, IssueDigest: "ABC", Request: "half-3"}, 400, "invalid_todo")

	first, err := s.FileTodo(ctx, repoID, userID, draft)
	require.NoError(t, err)
	require.EqualValues(t, 1, first.Number)
	require.Equal(t, "queued", first.TodoState)
	item, err := q.GetMythicalItemByNumber(ctx, repoID, 1)
	require.NoError(t, err)
	require.Equal(t, "issue", item.Source)
	require.Equal(t, "queued", item.State)
	require.EqualValues(t, 7, item.IssueNumber.Int64)
	require.Equal(t, read, item.IssueDigest)
	require.Equal(t, read, item.ApprovedDigest)
	require.True(t, item.FixesIssue)
	require.False(t, item.Outsider)
	require.Equal(t, "Retry webhooks", item.Title.String)
	require.Equal(t, "Webhooks fail on 502", item.IssueTitle)
	require.Equal(t, "Webhooks fail on 502", item.IssueBody)
	require.Equal(t, "https://github.com/acme/app/issues/7", item.IssueURL)
	require.Equal(t, userID, item.CreatedBy.Int64)
	require.Equal(t, userID, item.OwnerID.Int64)
	var revisions []map[string]any
	require.NoError(t, json.Unmarshal(item.Revisions, &revisions))
	require.Len(t, revisions, 1)
	require.Equal(t, prompt, revisions[0]["text"])
	require.Equal(t, []any{"a 502 is retried 5 times"}, revisions[0]["acceptance"])
	require.Equal(t, "from-issue", revisions[0]["reason"])
	require.Equal(t, read, revisions[0]["issue_digest"])
	by := revisions[0]["by"].(map[string]any)
	require.Equal(t, "person", by["kind"])
	require.Equal(t, "will", by["login"])
	card, err := s.Todo(ctx, repoID, 1)
	require.NoError(t, err)
	require.Equal(t, map[string]any{"number": int64(7), "url": "https://github.com/acme/app/issues/7", "fixes": true}, card["issue"])
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	events, err := store.Replay(ctx, todoOperationScope(item), 0, 100)
	require.NoError(t, err)
	require.Len(t, events.Events, 1)
	require.Equal(t, "todo.created", events.Events[0].Type)

	// The TODO owes issue #7 the App's todo label and one comment, keyed by
	// the TODO. The stack's pass posts them; a failed comment stays owed, and
	// the retry puts the label on again (GitHub keeps one) and edits rather
	// than repeats the comment.
	require.Equal(t, &mythicalNotice{Key: "todo-committed:1", Body: "Committed as T1 ↗", Label: "todo"}, mythicalChecksOf(item).Notice)
	run := &mythicalRun{row: db.MythicalStack{RepositoryID: repoID, ActorUserID: pgtype.Int8{Int64: userID, Valid: true}}}
	gh.mu.Lock()
	gh.commentErr = errors.New("GitHub is down")
	gh.mu.Unlock()
	owed := s.deliverNotice(ctx, run, item)
	require.Equal(t, item.Version, owed.Version, "a failed post records nothing")
	require.NotNil(t, mythicalChecksOf(owed).Notice)
	gh.mu.Lock()
	gh.commentErr = nil
	gh.mu.Unlock()
	posted := s.deliverNotice(ctx, run, owed)
	require.Nil(t, mythicalChecksOf(posted).Notice)
	require.Equal(t, []string{"todo-committed:1"}, mythicalChecksOf(posted).Noticed)
	require.Equal(t, posted, s.deliverNotice(ctx, run, posted), "a posted notice is said once")
	require.Equal(t, []string{"#7 todo", "#7 todo"}, gh.added)
	require.Equal(t, []string{"#7 todo-committed:1"}, gh.commentKeys)
	require.Equal(t, []string{"#7 Committed as T1 ↗"}, gh.comments, "a commit comment names no run")
	item = posted

	// The issue changes on GitHub after the commit. The same press again
	// answers T1 and writes nothing; revision 1 stays the Draft.
	gh.mu.Lock()
	gh.issues[0].Body = "Webhooks fail on 502 and 503"
	gh.mu.Unlock()
	again, err := s.FileTodo(ctx, repoID, userID, draft)
	require.NoError(t, err)
	require.Equal(t, first.ID, again.ID)
	kept, err := q.GetMythicalItemByNumber(ctx, repoID, 1)
	require.NoError(t, err)
	require.JSONEq(t, string(item.Revisions), string(kept.Revisions))
	require.Equal(t, read, kept.IssueDigest)

	// A new Draft holding the old digest names text GitHub no longer has.
	stale := draft
	stale.Request = "draft-7-stale"
	refused(t, stale, 409, "issue_changed")
	// A digest nobody read is refused the same way.
	unknown := draft
	unknown.Request, unknown.IssueDigest = "draft-7-unknown", mythicalIssueDigest(mythicalIssue{Title: "made up", Body: "text"})
	refused(t, unknown, 409, "issue_changed")
	// A fresh read while T1 is unmerged: one unmerged TODO per issue.
	fresh := draft
	fresh.Request, fresh.IssueDigest = "draft-7-fresh", mythicalIssueDigest(gh.issues[0])
	refused(t, fresh, 409, "issue_has_todo")

	// Closed issues, pull requests and issues GitHub does not answer admit nothing.
	nine, ten, eleven := int64(9), int64(10), int64(11)
	refused(t, MythicalTodoInput{Title: "x", Prompt: "y", Issue: &nine, IssueDigest: mythicalIssueDigest(gh.issues[2]), Request: "nine"}, 409, "issue_closed")
	refused(t, MythicalTodoInput{Title: "x", Prompt: "y", Issue: &ten, IssueDigest: mythicalIssueDigest(gh.issues[3]), Request: "ten"}, 400, "invalid_todo")
	refused(t, MythicalTodoInput{Title: "x", Prompt: "y", Issue: &eleven, IssueDigest: read, Request: "eleven"}, 503, "github_unavailable")
	require.Equal(t, 1, count())

	// The owner may make a TODO from an outsider's text; it is marked
	// outsider, and fixes off is kept.
	off := false
	outsider, err := s.FileTodo(ctx, repoID, userID, MythicalTodoInput{Title: "Fix the crash", Prompt: "It crashes.", Issue: &eight,
		IssueDigest: mythicalIssueDigest(gh.issues[1]), Fixes: &off, Request: "draft-8"})
	require.NoError(t, err)
	require.EqualValues(t, 2, outsider.Number)
	second, err := q.GetMythicalItemByNumber(ctx, repoID, 2)
	require.NoError(t, err)
	require.True(t, second.Outsider)
	require.False(t, second.FixesIssue)
	require.Equal(t, "todo-committed:2", mythicalChecksOf(second).Notice.Key)
	require.EqualValues(t, 8, second.IssueNumber.Int64)
	require.Equal(t, 2, count())

	// Without GitHub, Make TODO is unavailable and a plain TODO still files.
	s.github = nil
	refused(t, MythicalTodoInput{Title: "x", Prompt: "y", Issue: &eight, IssueDigest: read, Request: "no-github"}, 503, "github_unavailable")
	plain, err := s.FileTodo(ctx, repoID, userID, MythicalTodoInput{Title: "Plain", Prompt: "No issue", Request: "plain"})
	require.NoError(t, err)
	stored, err := q.GetMythicalItemByNumber(ctx, repoID, plain.Number)
	require.NoError(t, err)
	require.Equal(t, "todo", stored.Source)
	require.Nil(t, mythicalChecksOf(stored).Notice, "a TODO with no issue owes no issue a notice")
	require.False(t, stored.IssueNumber.Valid)
	require.False(t, stored.FixesIssue)
	require.Equal(t, "No issue", stored.IssueBody)
}

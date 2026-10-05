// C-J2-02: the label door freezes revision 1. This suite uses product
// migrations and PostgreSQL, recordedGitHub's real REST boundary and the
// production ObserveIssue entry point.
package services

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

type journeyLabelUnavailable struct{ Code, Class, Message string }

func (e journeyLabelUnavailable) Error() string { b, _ := json.Marshal(e); return string(b) }

func TestJourneyTodoLabelFrozenSnapshot(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	var will, repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username, lower_username) VALUES ('Will','will') RETURNING id`).Scan(&will))
	for _, actor := range []string{"Ben", "Alice"} {
		_, err := pool.Exec(ctx, `INSERT INTO users(username, lower_username) VALUES ($1::text,lower($1::text))`, actor)
		require.NoError(t, err)
	}
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES ($1,'canary','canary') RETURNING id`, will).Scan(&repo))
	_, err := db.New(pool).RequestMythicalBootstrap(ctx, repo, will, 100, false)
	require.NoError(t, err)
	service := NewMythicalService(pool, nil)
	var mu sync.Mutex
	title, body, body6 := "Retry webhooks", "B1", "B6"
	github := &recordedGitHub{routes: map[string]func(http.ResponseWriter){}}
	github.routes["GET /repos/o/r/issues?direction=asc&page=1&per_page=100&sort=created&state=open"] = func(w http.ResponseWriter) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("ETag", `"issue-snapshot-1"`)
		answer(200, []map[string]any{
			{"number": 5, "title": title, "body": body, "state": "open", "user": map[string]any{"login": "Alice"}, "labels": []map[string]string{{"name": "todo"}}},
			{"number": 6, "title": "Issue six", "body": body6, "state": "open", "user": map[string]any{"login": "Ben"}, "labels": []map[string]string{{"name": "todo"}}},
		})(w)
	}
	for _, number := range []int{5, 6} {
		github.routes[fmt.Sprintf("GET /repos/o/r/issues/%d/events?per_page=100&page=1", number)] = answer(200, []map[string]any{{"id": 101 + number, "event": "labeled", "actor": map[string]any{"login": "Ben", "type": "User"}, "label": map[string]string{"name": "todo"}}})
		github.routes[fmt.Sprintf("GET /repos/o/r/issues/%d", number)] = answer(200, map[string]any{"labels": []map[string]string{{"name": "todo"}}})
		github.routes[fmt.Sprintf("GET /repos/o/r/collaborators/%s/permission", "Ben")] = answer(200, map[string]string{"permission": "write"})
	}
	api := github.api(t)
	// #6 changes before the first post-label read: the first read, not the
	// webhook's stale body, is the admitted snapshot.
	mu.Lock()
	body6 = "B6′"
	mu.Unlock()
	consume := func() {
		issues, err := api.OpenIssues(ctx, stackRepo)
		require.NoError(t, err)
		for _, issue := range issues {
			applier, err := api.LabelApplier(ctx, stackRepo, issue.Number, "todo")
			require.NoError(t, err)
			require.NotNil(t, applier)
			require.Equal(t, "Ben", applier.Actor.Login)
			member, err := api.Maintainer(ctx, stackRepo, applier.Actor)
			require.NoError(t, err)
			require.True(t, member)
			issue.TextByMaintainer = true
			require.NoError(t, service.ObserveIssue(ctx, repo, issue, gitHubLabelApplication{Label: "todo", ByMaintainer: member, By: applier.Actor.Login, EventID: applier.EventID}))
		}
	}
	consume()
	first, err := db.New(pool).GetMythicalItemByIssue(ctx, repo, 5)
	require.NoError(t, err)
	sixth, err := db.New(pool).GetMythicalItemByIssue(ctx, repo, 6)
	require.NoError(t, err)
	require.Equal(t, "Retry webhooks", first.IssueTitle)
	require.Equal(t, "B1", first.IssueBody)
	require.Equal(t, "B6′", sixth.IssueBody)
	require.Equal(t, "queued", first.State)
	require.NotEmpty(t, first.IssueDigest)
	var revision json.RawMessage
	err = pool.QueryRow(ctx, `SELECT revisions FROM mythical_items WHERE id=$1`, first.ID).Scan(&revision)
	if err != nil {
		t.Fatal(journeyLabelUnavailable{"journey_contract_missing", "factory", "T-STK-09 must supply mythical_items.revisions: " + err.Error()})
	}
	var revisions []map[string]any
	require.NoError(t, json.Unmarshal(revision, &revisions))
	require.Len(t, revisions, 1)
	// FileTodo's revision shape (text, acceptance, by, at) plus the issue door's
	// reason and issue_digest: one revision model, never a second prompt/actor one.
	require.Equal(t, "from-issue", revisions[0]["reason"])
	require.Equal(t, map[string]any{"kind": "person", "login": "Ben"}, revisions[0]["by"])
	require.Equal(t, first.IssueDigest, revisions[0]["issue_digest"])
	require.Equal(t, "Retry webhooks\n\nB1", revisions[0]["text"])
	require.Equal(t, []any{}, revisions[0]["acceptance"])
	require.Equal(t, "Retry webhooks", first.Title.String)
	var fixes bool
	require.NoError(t, pool.QueryRow(ctx, `SELECT fixes_issue FROM mythical_items WHERE id=$1`, first.ID).Scan(&fixes))
	require.True(t, fixes)
	mu.Lock()
	title, body = "Retry webhooks v2", "B2"
	mu.Unlock()
	consume()
	// Three redeliveries and ten queued observations must all preserve rev 1.
	for range 13 {
		consume()
	}
	after, err := db.New(pool).GetMythicalItemByIssue(ctx, repo, 5)
	require.NoError(t, err)
	require.Equal(t, "Retry webhooks", after.IssueTitle)
	require.Equal(t, "B1", after.IssueBody)
	require.Equal(t, first.IssueDigest, after.IssueDigest)
	var afterRevision json.RawMessage
	require.NoError(t, pool.QueryRow(ctx, `SELECT revisions FROM mythical_items WHERE id=$1`, first.ID).Scan(&afterRevision))
	require.JSONEq(t, string(revision), string(afterRevision))
	require.NotContains(t, string(afterRevision), "B2")
	// Independent SQL counts, never production's own aggregate or test fake.
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE repository_id=$1 AND issue_number=5`, repo).Scan(&count))
	require.Equal(t, 1, count)
	// The item is the TODO (§3.2): its placement fact is todo.created on its
	// own todo:<id> stream.
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events
 WHERE principal_id = (SELECT 'todo:' || id::text FROM mythical_items WHERE id=$1) AND event_type='todo.created'`, first.ID).Scan(&count))
	require.Equal(t, 1, count)
	// A distinct label event while unmerged still admits nothing.
	require.NoError(t, service.ObserveIssue(ctx, repo, mythicalIssue{Number: 5, Title: "Retry webhooks v2", Body: "B2", State: "open", Labels: []string{"todo"}, TextByMaintainer: true}, gitHubLabelApplication{Label: "todo", ByMaintainer: true, By: "Ben", EventID: 205}))
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE repository_id=$1 AND issue_number=5`, repo).Scan(&count))
	require.Equal(t, 1, count)
	github.mu.Lock()
	calls := append([]string(nil), github.calls...)
	github.mu.Unlock()
	encoded, _ := json.Marshal(calls)
	t.Logf("GitHub requests: %s", encoded)
}

// Only a maintainer's live todo label on open issue text it approves is a
// door. A dropped TODO's issue can be labeled into a new TODO; the old stays.
func TestTodoLabelDoorAdmitsOnlyAuthorizedLabels(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	q := db.New(pool)
	var will, repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username, lower_username) VALUES ('Will','will') RETURNING id`).Scan(&will))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES ($1,'canary','canary') RETURNING id`, will).Scan(&repo))
	service := NewMythicalService(pool, nil)
	count := func() (n int) {
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE repository_id=$1`, repo).Scan(&n))
		return n
	}
	ben := gitHubLabelApplication{Label: "todo", ByMaintainer: true, By: "Ben", EventID: 301}
	open := mythicalIssue{Number: 7, Title: "Retry", Body: "B7", State: "open", Labels: []string{"todo"}, TextByMaintainer: true}
	require.NoError(t, service.ObserveIssue(ctx, repo, open, ben), "no stack: nothing to append to")
	require.Zero(t, count())
	_, err := q.RequestMythicalBootstrap(ctx, repo, will, 100, false)
	require.NoError(t, err)
	outsider, closed, pull := open, open, open
	outsider.TextByMaintainer, outsider.Labels = false, nil
	closed.State, pull.PullRequest = "closed", true
	for name, c := range map[string]struct {
		issue   mythicalIssue
		applied gitHubLabelApplication
	}{
		"label without write":            {open, gitHubLabelApplication{Label: "todo", By: "Carol", EventID: 302}},
		"label removed":                  {open, gitHubLabelApplication{Label: "todo", ByMaintainer: true, By: "Ben", EventID: 303, Removed: true}},
		"no live label event":            {open, gitHubLabelApplication{Label: "todo", ByMaintainer: true, By: "Ben"}},
		"another label":                  {open, gitHubLabelApplication{Label: "bug", ByMaintainer: true, By: "Ben", EventID: 304}},
		"policy, not a label":            {open, gitHubLabelApplication{AutoTodo: "owner policy", EventID: 305}},
		"outsider text, label taken off": {outsider, ben},
		"closed issue":                   {closed, ben},
		"pull request":                   {pull, ben},
	} {
		require.NoError(t, service.ObserveIssue(ctx, repo, c.issue, c.applied), name)
		require.Zero(t, count(), name)
	}
	// A maintainer's label approves outsider text while it stays on the issue.
	outsider.Labels = []string{"todo"}
	require.NoError(t, service.ObserveIssue(ctx, repo, outsider, ben))
	first, err := q.GetActiveMythicalItemByIssue(ctx, repo, 7)
	require.NoError(t, err)
	require.True(t, first.Outsider)
	require.True(t, first.FixesIssue)
	require.Equal(t, "issue", first.Source)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='cancelled' WHERE id=$1`, first.ID)
	require.NoError(t, err)
	require.NoError(t, service.ObserveIssue(ctx, repo, open, gitHubLabelApplication{Label: "todo", ByMaintainer: true, By: "Ben", EventID: 306}))
	second, err := q.GetActiveMythicalItemByIssue(ctx, repo, 7)
	require.NoError(t, err)
	require.NotEqual(t, first.ID, second.ID)
	require.False(t, second.Outsider)
	require.Equal(t, 2, count())
	kept, err := q.GetMythicalItem(ctx, first.ID)
	require.NoError(t, err)
	require.Equal(t, "cancelled", kept.State)
}

package githubfake

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// An issue a person opens is read, labeled, commented on and closed through
// the same installation-token boundary the stack's writes use; the App's
// own label and comments carry its identity, a person's do not.
func TestOpenedIssuesAnswerTextEventsCommentsAndClose(t *testing.T) {
	server, cfg, key := fixture(t)
	server.SetCollaborator(8, "ben", "write")
	number := server.OpenIssue("acme/app", "ben", "Retry webhooks", "Webhooks fail on 502")
	require.Equal(t, int64(1), number)
	status, body := request(t, server, "POST", "/app/installations/91/access_tokens", jwt(t, key, cfg.AppID, time.Now().Add(time.Minute)), nil)
	require.Equal(t, 201, status)
	var access struct {
		Token string `json:"token"`
	}
	require.NoError(t, json.Unmarshal(body, &access))

	status, body = request(t, server, "GET", "/repos/acme/app/issues/1", access.Token, nil)
	require.Equal(t, 200, status)
	var read struct {
		Number int64  `json:"number"`
		Title  string `json:"title"`
		Body   string `json:"body"`
		State  string `json:"state"`
		URL    string `json:"html_url"`
		User   struct {
			Login, Type string
		} `json:"user"`
		ViaApp *json.RawMessage `json:"performed_via_github_app"`
	}
	require.NoError(t, json.Unmarshal(body, &read))
	require.Equal(t, int64(1), read.Number)
	require.Equal(t, "Retry webhooks", read.Title)
	require.Equal(t, "Webhooks fail on 502", read.Body)
	require.Equal(t, "open", read.State)
	require.Equal(t, "https://github.com/acme/app/issues/1", read.URL)
	require.Equal(t, "ben", read.User.Login)
	require.Equal(t, "User", read.User.Type)
	require.Nil(t, read.ViaApp)
	status, _ = request(t, server, "GET", "/repos/acme/app/issues/9", access.Token, nil)
	require.Equal(t, 404, status)
	status, _ = request(t, server, "GET", "/repos/acme/app/issues/1", "", nil)
	require.Equal(t, 401, status, "an issue is read with a token")

	// Its text is the author's: GraphQL names the author and no later writer.
	status, body = request(t, server, "POST", "/graphql", access.Token, []byte(`{"query":"query{repository{issueOrPullRequest(number:1){title}}}","variables":{"owner":"acme","name":"app","number":1}}`))
	require.Equal(t, 200, status)
	require.JSONEq(t, `{"data":{"repository":{"issueOrPullRequest":{"title":"Retry webhooks","body":"Webhooks fail on 502","author":{"__typename":"User","login":"ben"},"userContentEdits":{"nodes":[]},"timelineItems":{"nodes":[]}}}}}`, string(body))

	// A person's label and the App's label are told apart by their events.
	event := server.LabelIssue("acme/app", 1, "ben", "todo")
	require.Positive(t, event)
	require.Zero(t, server.LabelIssue("acme/app", 9, "ben", "todo"))
	status, _ = request(t, server, "POST", "/repos/acme/app/issues/1/labels", access.Token, []byte(`{"labels":["todo","smithers"]}`))
	require.Equal(t, 200, status)
	status, body = request(t, server, "GET", "/repos/acme/app/issues/1/events?per_page=100&page=1", access.Token, nil)
	require.Equal(t, 200, status)
	var events []struct {
		ID     int64  `json:"id"`
		Event  string `json:"event"`
		Actor  struct{ Login, Type string }
		ViaApp *json.RawMessage `json:"performed_via_github_app"`
		Label  struct{ Name string }
	}
	require.NoError(t, json.Unmarshal(body, &events))
	require.Len(t, events, 2, "the App applying a present label is no new event")
	require.Equal(t, event, events[0].ID)
	require.Equal(t, "ben", events[0].Actor.Login)
	require.Nil(t, events[0].ViaApp)
	require.Equal(t, "smithers", events[1].Label.Name)
	require.Equal(t, "Bot", events[1].Actor.Type)
	require.NotNil(t, events[1].ViaApp)
	status, body = request(t, server, "GET", "/repos/acme/app/issues/1/events?per_page=100&page=2", access.Token, nil)
	require.Equal(t, 200, status)
	require.JSONEq(t, `[]`, string(body))

	// The App's comment is listed as the App's and may be edited in place.
	status, body = request(t, server, "POST", "/repos/acme/app/issues/1/comments", access.Token, []byte(`{"body":"Committed as T1"}`))
	require.Equal(t, 201, status)
	var comment struct {
		ID int64 `json:"id"`
	}
	require.NoError(t, json.Unmarshal(body, &comment))
	status, _ = request(t, server, "PATCH", "/repos/acme/app/issues/comments/"+itoa(comment.ID), access.Token, []byte(`{"body":"Committed as T1 again"}`))
	require.Equal(t, 200, status)
	status, _ = request(t, server, "PATCH", "/repos/acme/app/issues/comments/999", access.Token, []byte(`{"body":"x"}`))
	require.Equal(t, 404, status)
	status, body = request(t, server, "GET", "/repos/acme/app/issues/1/comments?per_page=100&page=1", access.Token, nil)
	require.Equal(t, 200, status)
	var listed []map[string]any
	require.NoError(t, json.Unmarshal(body, &listed))
	require.Len(t, listed, 1)
	require.NotEmpty(t, listed[0]["created_at"])
	delete(listed[0], "created_at")
	require.Equal(t, map[string]any{"id": float64(comment.ID), "body": "Committed as T1 again", "user": map[string]any{"login": "smithers-test[bot]", "type": "Bot"},
		"performed_via_github_app": map[string]any{"id": float64(42)}}, listed[0])

	// Closing is an App write: it needs issues write, records a closed event
	// and keeps the reason; closing again changes nothing.
	server.SetInstallationPermission("issues", "read")
	status, body = request(t, server, "POST", "/app/installations/91/access_tokens", jwt(t, key, cfg.AppID, time.Now().Add(time.Minute)), nil)
	require.Equal(t, 201, status)
	var reader struct {
		Token string `json:"token"`
	}
	require.NoError(t, json.Unmarshal(body, &reader))
	status, _ = request(t, server, "PATCH", "/repos/acme/app/issues/1", reader.Token, []byte(`{"state":"closed","state_reason":"completed"}`))
	require.Equal(t, 403, status)
	view, ok := server.Issue("acme/app", 1)
	require.True(t, ok)
	require.Equal(t, "open", view.State)
	server.SetInstallationPermission("issues", "write")
	for range 2 {
		status, _ = request(t, server, "PATCH", "/repos/acme/app/issues/1", access.Token, []byte(`{"state":"closed","state_reason":"completed"}`))
		require.Equal(t, 200, status)
	}
	view, ok = server.Issue("acme/app", 1)
	require.True(t, ok)
	require.Equal(t, "closed", view.State)
	require.Equal(t, "completed", view.StateReason)
	require.Equal(t, []string{"todo", "smithers"}, view.Labels)
	require.Len(t, view.Comments, 1)
	kinds := []string{}
	for _, e := range view.Events {
		kinds = append(kinds, e.Event)
	}
	require.Equal(t, []string{"labeled", "labeled", "closed"}, kinds)
	_, ok = server.Issue("acme/app", 2)
	require.False(t, ok)

	// A pull request takes the next number after the opened issue.
	status, body = request(t, server, "POST", "/repos/acme/app/pulls", access.Token, []byte(`{"title":"Fix","head":"smithers/fix","base":"main"}`))
	require.Equal(t, 201, status)
	var pull Pull
	require.NoError(t, json.Unmarshal(body, &pull))
	require.Equal(t, int64(2), pull.Number)
	require.Equal(t, int64(3), server.OpenIssue("acme/app", "", "Next", ""))
}

func itoa(n int64) string { b, _ := json.Marshal(n); return string(b) }

// The repository's issue list, which an install's issue list card reads,
// holds the issues people opened and the pull requests (marked), newest
// first, by state; a person's comment lists as theirs with its time.
func TestRepositoryIssuesListByStateWithPeoplesComments(t *testing.T) {
	server, cfg, key := fixture(t)
	first := server.OpenIssue("acme/app", "ben", "Retry webhooks", "Webhooks fail on 502")
	second := server.OpenIssue("acme/app", "carol", "Crash on start", "It crashes.")
	require.Positive(t, server.CommentIssue("acme/app", first, "carol", "Seen it too."))
	require.Zero(t, server.CommentIssue("acme/app", 99, "carol", "No such issue."))
	status, body := request(t, server, "POST", "/app/installations/91/access_tokens", jwt(t, key, cfg.AppID, time.Now().Add(time.Minute)), nil)
	require.Equal(t, 201, status)
	var access struct {
		Token string `json:"token"`
	}
	require.NoError(t, json.Unmarshal(body, &access))
	status, body = request(t, server, "POST", "/repos/acme/app/pulls", access.Token, []byte(`{"title":"Fix","head":"smithers/fix","base":"main"}`))
	require.Equal(t, 201, status, string(body))
	status, _ = request(t, server, "PATCH", "/repos/acme/app/issues/"+itoa(second), access.Token, []byte(`{"state":"closed"}`))
	require.Equal(t, 200, status)
	type listed struct {
		Number      int64  `json:"number"`
		Title       string `json:"title"`
		State       string `json:"state"`
		Comments    int    `json:"comments"`
		User        struct{ Login string }
		PullRequest *json.RawMessage `json:"pull_request"`
	}
	list := func(query string) []listed {
		t.Helper()
		status, body := request(t, server, "GET", "/repos/acme/app/issues"+query, access.Token, nil)
		require.Equal(t, 200, status, string(body))
		var rows []listed
		require.NoError(t, json.Unmarshal(body, &rows))
		return rows
	}
	open := list("")
	require.Len(t, open, 2, "open by default: the open issue and the pull request")
	require.Equal(t, int64(3), open[0].Number, "newest first")
	require.NotNil(t, open[0].PullRequest)
	require.Equal(t, first, open[1].Number)
	require.Equal(t, "ben", open[1].User.Login)
	require.Equal(t, 1, open[1].Comments)
	require.Nil(t, open[1].PullRequest)
	closed := list("?state=closed")
	require.Len(t, closed, 1)
	require.Equal(t, second, closed[0].Number)
	require.Equal(t, "closed", closed[0].State)
	require.Len(t, list("?state=all"), 3)
	require.Len(t, list("?state=all&per_page=2&page=2"), 1)
	status, _ = request(t, server, "GET", "/repos/acme/app/issues", "", nil)
	require.Equal(t, 401, status, "the list is read with a token")

	status, body = request(t, server, "GET", "/repos/acme/app/issues/"+itoa(first)+"/comments", access.Token, nil)
	require.Equal(t, 200, status)
	var comments []struct {
		Body      string `json:"body"`
		User      struct{ Login, Type string }
		ViaApp    *json.RawMessage `json:"performed_via_github_app"`
		CreatedAt time.Time        `json:"created_at"`
	}
	require.NoError(t, json.Unmarshal(body, &comments))
	require.Len(t, comments, 1)
	require.Equal(t, "Seen it too.", comments[0].Body)
	require.Equal(t, "carol", comments[0].User.Login)
	require.Equal(t, "User", comments[0].User.Type)
	require.Nil(t, comments[0].ViaApp)
	require.False(t, comments[0].CreatedAt.IsZero())
}

// The repository's issue-events list, which an install's label door reads,
// holds every issue's events newest first, each with its issue, in pages.
func TestRepositoryIssueEventsListNewestFirstWithTheirIssues(t *testing.T) {
	server, cfg, key := fixture(t)
	first := server.OpenIssue("acme/app", "ben", "One", "B1")
	second := server.OpenIssue("acme/app", "ben", "Two", "B2")
	todo := server.LabelIssue("acme/app", first, "ben", "todo")
	bug := server.LabelIssue("acme/app", second, "ben", "bug")
	later := server.LabelIssue("acme/app", first, "ben", "later")
	status, body := request(t, server, "POST", "/app/installations/91/access_tokens", jwt(t, key, cfg.AppID, time.Now().Add(time.Minute)), nil)
	require.Equal(t, 201, status)
	var access struct {
		Token string `json:"token"`
	}
	require.NoError(t, json.Unmarshal(body, &access))
	type listed struct {
		ID     int64  `json:"id"`
		Event  string `json:"event"`
		Actor  struct{ Login, Type string }
		ViaApp *json.RawMessage `json:"performed_via_github_app"`
		Label  struct{ Name string }
		Issue  struct {
			Number      int64            `json:"number"`
			Title       string           `json:"title"`
			Body        string           `json:"body"`
			PullRequest *json.RawMessage `json:"pull_request"`
		} `json:"issue"`
	}
	read := func(query string) []listed {
		t.Helper()
		status, body := request(t, server, "GET", "/repos/acme/app/issues/events"+query, access.Token, nil)
		require.Equal(t, 200, status, string(body))
		var events []listed
		require.NoError(t, json.Unmarshal(body, &events))
		return events
	}
	events := read("?per_page=100")
	require.Len(t, events, 3)
	require.Equal(t, []int64{later, bug, todo}, []int64{events[0].ID, events[1].ID, events[2].ID}, "newest first")
	require.Equal(t, "labeled", events[2].Event)
	require.Equal(t, "todo", events[2].Label.Name)
	require.Equal(t, "ben", events[2].Actor.Login)
	require.Equal(t, "User", events[2].Actor.Type)
	require.Nil(t, events[2].ViaApp)
	require.Equal(t, first, events[2].Issue.Number)
	require.Equal(t, "One", events[2].Issue.Title)
	require.Equal(t, "B1", events[2].Issue.Body)
	require.Nil(t, events[2].Issue.PullRequest, "an issue's event names no pull request")
	require.Equal(t, second, events[1].Issue.Number)
	// Pages of per_page, newest first; past the end is empty.
	page := read("?per_page=2&page=2")
	require.Len(t, page, 1)
	require.Equal(t, todo, page[0].ID)
	require.Empty(t, read("?per_page=2&page=3"))
	require.Len(t, read(""), 3, "30 per page by default")
	status, _ = request(t, server, "GET", "/repos/acme/app/issues/events", "", nil)
	require.Equal(t, 401, status, "the list is read with a token")
}

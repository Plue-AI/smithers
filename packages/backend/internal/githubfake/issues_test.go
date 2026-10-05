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
	require.JSONEq(t, `[{"id":`+itoa(comment.ID)+`,"body":"Committed as T1 again","user":{"login":"smithers-test[bot]","type":"Bot"},"performed_via_github_app":{"id":42}}]`, string(body))

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

package services

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// fakeIssueTextGitHub answers the two reads the writer rule makes: an issue's
// current text with its last title and body writers, and a user's permission.
type fakeIssueTextGitHub struct {
	mu                      sync.Mutex
	title, body, author     string
	titleWriter, bodyWriter *gitHubGraphQLActor // nil: never changed
	permissions             map[string]string
	status                  int
	reads                   int
}

type fakeIssueTextTokens struct{}

func (fakeIssueTextTokens) CreateGitHubInstallationTokenForInternalInstallation(context.Context, int64) (GitHubInstallationToken, error) {
	return GitHubInstallationToken{Token: "installation-token"}, nil
}

// authorNode answers the author as GitHub would: __typename only when the
// query asks for it.
func (f *fakeIssueTextGitHub) authorNode(r *http.Request) map[string]string {
	var request struct {
		Query string `json:"query"`
	}
	_ = json.NewDecoder(r.Body).Decode(&request)
	node := map[string]string{"login": f.author}
	if strings.Contains(request.Query, "author{__typename login}") {
		node["__typename"] = "User"
	}
	return node
}

func newFakeIssueTextGitHub(t *testing.T) (*fakeIssueTextGitHub, *GitHubIssueTextStamper) {
	t.Helper()
	fake := &fakeIssueTextGitHub{title: "Empty config crashes", body: "Steps: use []", author: "contributor",
		permissions: map[string]string{}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fake.mu.Lock()
		defer fake.mu.Unlock()
		fake.reads++
		if fake.status != 0 {
			w.WriteHeader(fake.status)
			return
		}
		if r.Method == http.MethodPost && r.URL.Path == "/graphql" {
			edits, renames := []any{}, []any{}
			if fake.bodyWriter != nil {
				edits = append(edits, map[string]any{"editor": fake.bodyWriter})
			}
			if fake.titleWriter != nil {
				renames = append(renames, map[string]any{"actor": fake.titleWriter})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"repository": map[string]any{"issueOrPullRequest": map[string]any{
				"title": fake.title, "body": fake.body, "author": fake.authorNode(r),
				"userContentEdits": map[string]any{"nodes": edits}, "timelineItems": map[string]any{"nodes": renames},
			}}}})
			return
		}
		if login, ok := strings.CutSuffix(strings.TrimPrefix(r.URL.Path, "/repos/Acme/demo/collaborators/"), "/permission"); ok {
			permission, known := fake.permissions[login]
			if !known {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"permission": permission})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(server.Close)
	return fake, &GitHubIssueTextStamper{tokens: fakeIssueTextTokens{},
		api: &gitHubIssueTextAPI{api: &landingGitHubAPI{client: server.Client(), baseURL: func() string { return server.URL }}}}
}

// issueTextEvent is a maintainer's (OWNER) issue event: sender writes it, and
// changes names the parts an edited event changed.
func issueTextEvent(t *testing.T, action string, sender map[string]any, changes ...string) []byte {
	t.Helper()
	changed := map[string]any{}
	for _, part := range changes {
		changed[part] = map[string]string{"from": "earlier " + part}
	}
	payload, err := json.Marshal(map[string]any{
		"action": action, "installation": map[string]any{"id": 777}, "changes": changed, "sender": sender,
		"repository": map[string]any{"id": 9001, "name": "demo", "owner": map[string]string{"login": "Acme"}},
		"issue": map[string]any{"number": 24, "title": "Empty config crashes", "body": "Steps: use []", "author_association": "OWNER",
			"user": map[string]any{"id": 922, "login": "contributor"}, "labels": []map[string]string{{"name": "smithers"}}},
	})
	require.NoError(t, err)
	return payload
}

var (
	issueAuthor  = map[string]any{"id": 922, "login": "contributor", "type": "User"}
	issueBot     = map[string]any{"id": 5, "login": "some-app[bot]", "type": "Bot"}
	issueTriager = map[string]any{"id": 6, "login": "triager", "type": "User"}
	issueEditor  = map[string]any{"id": 7, "login": "maintainer", "type": "User"}
)

func stampIssueText(t *testing.T, stamper *GitHubIssueTextStamper, action string, payload []byte) []byte {
	t.Helper()
	stamped, err := stamper.stampGitHubIssueText(context.Background(), "issues", action, payload)
	require.NoError(t, err)
	return stamped
}

// GitHub's edited event names the author's standing, not the editor's: an
// app's or a triage user's edit of a maintainer's issue is not the
// maintainer's text, so no job, workflow or trigger starts from it until a
// maintainer re-applies the trigger label.
func TestGitHubIssueTextEditedByAnAppOrTriageUserIsNotApproved(t *testing.T) {
	t.Parallel()
	job := repositoryJobTestInput()
	job.Events = []RepositoryJobEventRule{{Type: "issues"}}
	for name, sender := range map[string]map[string]any{"app": issueBot, "triage user": issueTriager} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			fake, stamper := newFakeIssueTextGitHub(t)
			fake.permissions["triager"] = "read"
			edited := stampIssueText(t, stamper, "edited", issueTextEvent(t, "edited", sender, "body"))
			assert.False(t, gitHubIssueEventApproves("issues", "edited", edited, issueApprovalLabel))
			assert.False(t, gitHubIssueEventApproves("issues", "edited", edited, ""))
			assert.True(t, gitHubEventByOutsider(edited))
			assert.False(t, repositoryJobMatches(job, db.RepositoryJobEvent{Source: "github", EventType: "issues", EventAction: "edited", IssueNumber: 24, Payload: edited}))

			// A later event reads the body's writer from GitHub's history.
			fake.bodyWriter = &gitHubGraphQLActor{Typename: sender["type"].(string), Login: sender["login"].(string)}
			assigned := stampIssueText(t, stamper, "assigned", issueTextEvent(t, "assigned", issueEditor))
			assert.False(t, gitHubIssueEventApproves("issues", "assigned", assigned, issueApprovalLabel))

			// The maintainer's own title-only edit does not approve the body.
			retitled := stampIssueText(t, stamper, "edited", issueTextEvent(t, "edited", issueAuthor, "title"))
			assert.False(t, gitHubIssueEventApproves("issues", "edited", retitled, issueApprovalLabel))

			// The author's own label does not approve it; another
			// maintainer re-applying the trigger label does, as outsider
			// text: it never changes a protected path.
			byAuthor := issueTextEvent(t, "labeled", issueAuthor)
			var own map[string]any
			require.NoError(t, json.Unmarshal(byAuthor, &own))
			own["label"] = map[string]string{"name": "smithers"}
			byAuthor, _ = json.Marshal(own)
			assert.False(t, gitHubIssueEventApproves("issues", "labeled", stampIssueText(t, stamper, "labeled", byAuthor), issueApprovalLabel))
			labeled := issueTextEvent(t, "labeled", issueEditor)
			var raw map[string]any
			require.NoError(t, json.Unmarshal(labeled, &raw))
			raw["label"] = map[string]string{"name": "smithers"}
			labeled, _ = json.Marshal(raw)
			labeled = stampIssueText(t, stamper, "labeled", labeled)
			assert.True(t, gitHubIssueEventApproves("issues", "labeled", labeled, issueApprovalLabel))
			assert.True(t, gitHubEventByOutsider(labeled))
		})
	}
}

// A maintainer's own edit, or another maintainer's, is still approved as
// written.
func TestGitHubIssueTextEditedByAMaintainerIsApproved(t *testing.T) {
	t.Parallel()
	fake, stamper := newFakeIssueTextGitHub(t)
	edited := stampIssueText(t, stamper, "edited", issueTextEvent(t, "edited", issueAuthor, "title", "body"))
	assert.True(t, gitHubIssueEventApproves("issues", "edited", edited, issueApprovalLabel))
	assert.False(t, gitHubEventByOutsider(edited))
	assert.Zero(t, fake.reads, "the author's own edit of both parts needs no lookup")

	opened := stampIssueText(t, stamper, "opened", issueTextEvent(t, "opened", issueAuthor))
	assert.True(t, gitHubIssueEventApproves("issues", "opened", opened, ""))

	fake.permissions["maintainer"] = "write"
	byOther := stampIssueText(t, stamper, "edited", issueTextEvent(t, "edited", issueEditor, "body"))
	assert.True(t, gitHubIssueEventApproves("issues", "edited", byOther, ""), "another maintainer's body edit, author's title")

	fake.bodyWriter = &gitHubGraphQLActor{Typename: "User", Login: "maintainer"}
	commented, err := stamper.stampGitHubIssueText(context.Background(), "issue_comment", "created", issueTextEvent(t, "created", issueAuthor))
	require.NoError(t, err)
	var raw map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(commented, &raw))
	assert.Contains(t, string(raw["issue"]), `"smithers_text_by_maintainer":true`)
}

// Text GitHub no longer shows, a writer GitHub cannot name, and an event with
// no reader are not a maintainer's; only a transient failure is retried.
func TestGitHubIssueTextFailsClosed(t *testing.T) {
	t.Parallel()
	fake, stamper := newFakeIssueTextGitHub(t)
	fake.body = "rewritten since the event"
	stale := stampIssueText(t, stamper, "labeled", issueTextEvent(t, "labeled", issueAuthor))
	assert.False(t, gitHubIssueEventApproves("issues", "labeled", stale, ""))

	fake.body = "Steps: use []"
	fake.bodyWriter = &gitHubGraphQLActor{} // a deleted account
	ghost := stampIssueText(t, stamper, "labeled", issueTextEvent(t, "labeled", issueAuthor))
	assert.False(t, gitHubIssueEventApproves("issues", "labeled", ghost, ""))

	var none *GitHubIssueTextStamper
	unread, err := none.stampGitHubIssueText(context.Background(), "issues", "opened", issueTextEvent(t, "opened", issueAuthor))
	require.NoError(t, err)
	assert.False(t, gitHubIssueEventApproves("issues", "opened", unread, ""))

	fake.status = http.StatusBadGateway
	_, err = stamper.stampGitHubIssueText(context.Background(), "issues", "labeled", issueTextEvent(t, "labeled", issueAuthor))
	require.ErrorIs(t, err, errGitHubIssueTextUnavailable)
}

// A title a bot renamed, or an issue GitHub answers with errors, is not a
// maintainer's text; a rate limit is retried.
func TestGitHubIssueTextReadsTheTitleWriterAndGitHubErrors(t *testing.T) {
	t.Parallel()
	fake, stamper := newFakeIssueTextGitHub(t)
	approved := stampIssueText(t, stamper, "reopened", issueTextEvent(t, "reopened", issueAuthor))
	assert.True(t, gitHubIssueEventApproves("issues", "reopened", approved, ""), "never edited: the author wrote it")
	fake.titleWriter = &gitHubGraphQLActor{Typename: "Bot", Login: "some-app[bot]"}
	renamed := stampIssueText(t, stamper, "reopened", issueTextEvent(t, "reopened", issueAuthor))
	assert.False(t, gitHubIssueEventApproves("issues", "reopened", renamed, ""))
	edited := stampIssueText(t, stamper, "edited", issueTextEvent(t, "edited", issueAuthor, "body"))
	assert.False(t, gitHubIssueEventApproves("issues", "edited", edited, ""), "the author's body edit keeps the bot's title")

	fake.status = http.StatusForbidden
	_, err := stamper.stampGitHubIssueText(context.Background(), "issues", "reopened", issueTextEvent(t, "reopened", issueAuthor))
	require.ErrorIs(t, err, errGitHubIssueTextUnavailable, "a secondary rate limit is retried")
}

// The webhook worker reads the writer before the stack, repository jobs and
// workflow triggers see the event.
func TestGitHubWebhookWorkerStampsIssueTextBeforeEveryConsumer(t *testing.T) {
	t.Parallel()
	fake, stamper := newFakeIssueTextGitHub(t)
	fake.bodyWriter = &gitHubGraphQLActor{Typename: "Bot", Login: "some-app[bot]"}
	job := gitHubIssueEventJob("issues", "edited")
	job.Payload = issueTextEvent(t, "edited", issueBot, "body")
	queries := pushJobQuerier(job)
	queries.listWorkflowTriggersByRepositoryFn = func(context.Context, int64) ([]db.WorkflowTrigger, error) {
		return []db.WorkflowTrigger{{WorkflowDefinitionID: 10, EventType: "issues", Enabled: true}}, nil
	}
	dispatcher := &mockGitHubWebhookEventRunDispatcher{}
	stack := &recordingMythicalObserver{}
	worker := NewGitHubWebhookEventWorker(queries, dispatcher)
	worker.SetIssueText(stamper)
	worker.SetMythical(stack)
	require.NoError(t, worker.PollOnce(context.Background()))
	assert.Empty(t, dispatcher.calls, "an app's edit of a maintainer's issue starts no workflow")
	require.Len(t, stack.payloads, 1)
	assert.Contains(t, string(stack.payloads[0]), `"smithers_text_by_maintainer":false`)
	assert.Equal(t, []int64{job.ID}, queries.markDoneIDs)
}

// authorWroteIssueText is a stamper for fixtures whose issue text its author
// wrote.
func authorWroteIssueText(t *testing.T) *GitHubIssueTextStamper {
	t.Helper()
	_, stamper := newFakeIssueTextGitHub(t)
	return stamper
}

package services

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

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
	permissionReads         map[string]int
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

func newFakeIssueTextGitHub(t *testing.T) (*fakeIssueTextGitHub, *GitHubTextStamper) {
	t.Helper()
	fake := &fakeIssueTextGitHub{title: "Empty config crashes", body: "Steps: use []", author: "contributor",
		permissions: map[string]string{"contributor": "admin"}, permissionReads: map[string]int{}}
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
			fake.permissionReads[login]++
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
	return fake, &GitHubTextStamper{tokens: fakeIssueTextTokens{},
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
			"user": map[string]any{"id": 922, "login": "contributor", "type": "User"}, "labels": []map[string]string{{"name": "smithers"}}},
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

func stampIssueText(t *testing.T, stamper *GitHubTextStamper, action string, payload []byte) []byte {
	t.Helper()
	stamped, err := stamper.stampGitHubText(context.Background(), "issues", action, payload)
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

			// The maintainer author re-applying the trigger label approves
			// it, and so does another maintainer, as outsider text: it
			// never changes a protected path.
			fake.permissions["maintainer"] = "write"
			for _, sender := range []map[string]any{issueAuthor, issueEditor} {
				labeled := stampIssueText(t, stamper, "labeled", labeledEvent(t, sender))
				assert.True(t, gitHubIssueEventApproves("issues", "labeled", labeled, issueApprovalLabel))
			}
			labeled := stampIssueText(t, stamper, "labeled", labeledEvent(t, issueEditor))
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
	assert.Equal(t, 1, fake.reads, "the author's own edit of both parts reads only the author's standing")

	opened := stampIssueText(t, stamper, "opened", issueTextEvent(t, "opened", issueAuthor))
	assert.True(t, gitHubIssueEventApproves("issues", "opened", opened, ""))

	fake.permissions["maintainer"] = "write"
	byOther := stampIssueText(t, stamper, "edited", issueTextEvent(t, "edited", issueEditor, "body"))
	assert.True(t, gitHubIssueEventApproves("issues", "edited", byOther, ""), "another maintainer's body edit, author's title")

	fake.bodyWriter = &gitHubGraphQLActor{Typename: "User", Login: "maintainer"}
	commented, err := stamper.stampGitHubText(context.Background(), "issue_comment", "created", issueTextEvent(t, "created", issueAuthor))
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

	var none *GitHubTextStamper
	unread, err := none.stampGitHubText(context.Background(), "issues", "opened", issueTextEvent(t, "opened", issueAuthor))
	require.NoError(t, err)
	assert.False(t, gitHubIssueEventApproves("issues", "opened", unread, ""))

	fake.status = http.StatusBadGateway
	_, err = stamper.stampGitHubText(context.Background(), "issues", "labeled", issueTextEvent(t, "labeled", issueAuthor))
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
	_, err := stamper.stampGitHubText(context.Background(), "issues", "reopened", issueTextEvent(t, "reopened", issueAuthor))
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
	worker.SetTextStamper(stamper)
	worker.SetMythical(stack)
	require.NoError(t, worker.PollOnce(context.Background()))
	assert.Empty(t, dispatcher.calls, "an app's edit of a maintainer's issue starts no workflow")
	require.Len(t, stack.payloads, 1)
	assert.Contains(t, string(stack.payloads[0]), `"smithers_text_by_maintainer":false`)
	assert.Equal(t, []int64{job.ID}, queries.markDoneIDs)
}

// authorWroteIssueText is a stamper for fixtures whose issue text its author
// wrote.
func authorWroteIssueText(t *testing.T) *GitHubTextStamper {
	t.Helper()
	_, stamper := newFakeIssueTextGitHub(t)
	return stamper
}

// textEvent is an event of kind whose own object (a comment, a pull request
// or a review, beside the issue or pull request it belongs to)
// its OWNER author "contributor" wrote; sender sent it and changes names the
// parts an edited event changed.
func textEvent(t *testing.T, kind, action string, sender map[string]any, changes ...string) []byte {
	t.Helper()
	var event map[string]any
	require.NoError(t, json.Unmarshal(issueTextEvent(t, action, sender, changes...), &event))
	authored := func(fields map[string]any) map[string]any {
		fields["author_association"], fields["user"] = "OWNER", map[string]any{"id": 922, "login": "contributor", "type": "User"}
		return fields
	}
	pull := authored(map[string]any{"number": 24, "title": "Empty config crashes", "body": "Steps: use []"})
	switch kind {
	case "issue_comment":
		event["comment"] = authored(map[string]any{"id": 51, "body": "Please also cover YAML."})
	case "pull_request":
		delete(event, "issue")
		event["pull_request"] = pull
	case "pull_request_review":
		delete(event, "issue")
		event["pull_request"] = pull
		event["review"] = authored(map[string]any{"id": 61, "body": "Looks right; add a test."})
	}
	payload, err := json.Marshal(event)
	require.NoError(t, err)
	return payload
}

func stampText(t *testing.T, stamper *GitHubTextStamper, kind, action string, payload []byte) []byte {
	t.Helper()
	stamped, err := stamper.stampGitHubText(context.Background(), kind, action, payload)
	require.NoError(t, err)
	return stamped
}

// A comment, pull request or review is a maintainer's own only while a
// maintainer last wrote it. GitHub's edited events name the author's
// standing, not the editor's, so an app's or a triage user's edit of a
// maintainer's comment starts no job and marks work as an outsider's.
func TestGitHubCommentPullAndReviewTextIsReadByItsLastWriter(t *testing.T) {
	t.Parallel()
	job := repositoryJobTestInput()
	job.Events = []RepositoryJobEventRule{{Type: "issue_comment"}}
	for name, sender := range map[string]map[string]any{"app": issueBot, "triage user": issueTriager} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			fake, stamper := newFakeIssueTextGitHub(t)
			fake.permissions["triager"] = "read"

			comment := stampText(t, stamper, "issue_comment", "edited", textEvent(t, "issue_comment", "edited", sender, "body"))
			assert.False(t, gitHubIssueEventApproves("issue_comment", "edited", comment, issueApprovalLabel))
			assert.True(t, gitHubEventByOutsider(comment))
			assert.False(t, repositoryJobMatches(job, db.RepositoryJobEvent{Source: "github", EventType: "issue_comment", EventAction: "edited", IssueNumber: 24, Payload: comment}))

			for _, kind := range []string{"pull_request", "pull_request_review"} {
				edited := stampText(t, stamper, kind, "edited", textEvent(t, kind, "edited", sender, "body"))
				assert.True(t, gitHubEventByOutsider(edited), kind)
			}
			created := stampText(t, stamper, "issue_comment", "created", textEvent(t, "issue_comment", "created", sender))
			assert.False(t, gitHubIssueEventApproves("issue_comment", "created", created, ""), "an app posting as the author's comment is not the author")
		})
	}
}

func TestGitHubCommentPullAndReviewTextByAMaintainerIsTrusted(t *testing.T) {
	t.Parallel()
	fake, stamper := newFakeIssueTextGitHub(t)
	created := stampText(t, stamper, "issue_comment", "created", textEvent(t, "issue_comment", "created", issueAuthor))
	assert.True(t, gitHubIssueEventApproves("issue_comment", "created", created, issueApprovalLabel))
	assert.False(t, gitHubEventByOutsider(created))

	fake.permissions["maintainer"] = "write"
	edited := stampText(t, stamper, "issue_comment", "edited", textEvent(t, "issue_comment", "edited", issueEditor, "body"))
	assert.True(t, gitHubIssueEventApproves("issue_comment", "edited", edited, ""), "another maintainer's edit")

	for kind, action := range map[string]string{"pull_request": "opened", "pull_request_review": "submitted"} {
		assert.False(t, gitHubEventByOutsider(stampText(t, stamper, kind, action, textEvent(t, kind, action, issueAuthor))), kind)
	}

	// A review event reads the pull request's own writers from GitHub: a
	// body an app last wrote is not the maintainer's.
	fake.bodyWriter = &gitHubGraphQLActor{Typename: "Bot", Login: "some-app[bot]"}
	reviewed := stampText(t, stamper, "pull_request_review", "submitted", textEvent(t, "pull_request_review", "submitted", issueAuthor))
	assert.True(t, gitHubEventByOutsider(reviewed))
	// A review dismissed by someone else did not write its body, and its
	// history is not read.
	fake.bodyWriter = nil
	dismissed := stampText(t, stamper, "pull_request_review", "dismissed", textEvent(t, "pull_request_review", "dismissed", issueEditor))
	assert.True(t, gitHubEventByOutsider(dismissed))
}

// labeledEvent is issueTextEvent applying the smithers label.
func labeledEvent(t *testing.T, sender map[string]any) []byte {
	t.Helper()
	var event map[string]any
	require.NoError(t, json.Unmarshal(issueTextEvent(t, "labeled", sender), &event))
	event["label"] = map[string]string{"name": "smithers"}
	payload, err := json.Marshal(event)
	require.NoError(t, err)
	return payload
}

// GitHub's MEMBER and COLLABORATOR associations include accounts that can
// only read or triage. An author, writer or label sender counts as a
// maintainer only while GitHub answers write, maintain or admin; the answer
// is reused for a minute and a failure is retried, never trusted.
func TestGitHubAuthorStandingIsReadLive(t *testing.T) {
	t.Parallel()
	fake, stamper := newFakeIssueTextGitHub(t)
	now := time.Unix(1_800_000_000, 0)
	stamper.api.now = func() time.Time { return now }
	fake.permissions["contributor"] = "read" // a triage member: GitHub reports triage as read

	opened := stampIssueText(t, stamper, "opened", issueTextEvent(t, "opened", issueAuthor))
	assert.False(t, gitHubIssueEventApproves("issues", "opened", opened, issueApprovalLabel), "a read or triage member's issue")
	comment := stampText(t, stamper, "issue_comment", "created", textEvent(t, "issue_comment", "created", issueAuthor))
	assert.False(t, gitHubIssueEventApproves("issue_comment", "created", comment, ""))
	pull := stampText(t, stamper, "pull_request", "opened", textEvent(t, "pull_request", "opened", issueAuthor))
	assert.True(t, gitHubEventByOutsider(pull))
	assert.Equal(t, 1, fake.permissionReads["contributor"], "one answer serves every object for a minute")

	fake.permissions["contributor"] = "write"
	cached := stampIssueText(t, stamper, "opened", issueTextEvent(t, "opened", issueAuthor))
	assert.False(t, gitHubIssueEventApproves("issues", "opened", cached, ""), "the cached answer stands within the minute")
	now = now.Add(gitHubMaintainerTTL)
	granted := stampIssueText(t, stamper, "opened", issueTextEvent(t, "opened", issueAuthor))
	assert.True(t, gitHubIssueEventApproves("issues", "opened", granted, ""), "a maintainer (maintain reads as write)")

	fake.status = http.StatusBadGateway
	now = now.Add(gitHubMaintainerTTL)
	_, err := stamper.stampGitHubText(context.Background(), "issues", "opened", issueTextEvent(t, "opened", issueAuthor))
	require.ErrorIs(t, err, errGitHubIssueTextUnavailable, "an unanswered lookup is retried, never trusted")
}

// Only a maintainer person applies the trigger label: a triage user or an
// app does not, and a maintainer may approve their own issue after someone
// else edited it.
func TestGitHubTriggerLabelNeedsAMaintainerPerson(t *testing.T) {
	t.Parallel()
	fake, stamper := newFakeIssueTextGitHub(t)
	fake.permissions["triager"], fake.permissions["maintainer"] = "read", "write"
	fake.bodyWriter = &gitHubGraphQLActor{Typename: "Bot", Login: "some-app[bot]"}
	for name, sender := range map[string]map[string]any{"triage user": issueTriager, "app": issueBot} {
		labeled := stampIssueText(t, stamper, "labeled", labeledEvent(t, sender))
		assert.False(t, gitHubIssueEventApproves("issues", "labeled", labeled, issueApprovalLabel), name)
	}
	for name, sender := range map[string]map[string]any{"another maintainer": issueEditor, "the maintainer author": issueAuthor} {
		labeled := stampIssueText(t, stamper, "labeled", labeledEvent(t, sender))
		assert.True(t, gitHubIssueEventApproves("issues", "labeled", labeled, issueApprovalLabel), name)
		assert.True(t, gitHubEventByOutsider(labeled), "approved by label: never a protected path")
	}
	outsider, fresh := newFakeIssueTextGitHub(t)
	outsider.permissions["contributor"] = "read"
	own := stampIssueText(t, fresh, "labeled", labeledEvent(t, issueAuthor))
	assert.False(t, gitHubIssueEventApproves("issues", "labeled", own, issueApprovalLabel), "an outsider author's own label")
}

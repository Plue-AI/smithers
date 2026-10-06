package services

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// The install's issue cards (J2 steps 1 and 2) through the production
// MythicalService, its App reader and the GitHub fake, with real
// PostgreSQL. The list holds the repository's issues by state, newest
// first, without its pull requests; an issue reads with its comments in
// order; a pull request's number or a missing one is not found; GitHub
// down, or a repository with no stack, is unavailable.
func TestInstallIssuesReadThroughTheApp(t *testing.T) {
	f := newPublicationFixture(t, false)
	ctx := context.Background()
	const repo = "rehearsal-owner/app"
	team := f.fake.OpenIssue(repo, "ben", "Say goodbye", "JOURNEY.md should end with a farewell.")
	outsider := f.fake.OpenIssue(repo, "carol", "Crash on start", "It crashes.")
	require.Positive(t, f.fake.CommentIssue(repo, team, "carol", "Seen it too."))
	require.Positive(t, f.fake.CommentIssue(repo, team, "ben", "Keep it short."))
	gh, err := f.service.stackGitHub(ctx, f.repoID)
	require.NoError(t, err)
	f.git(f.work, "push", "-q", f.github, "HEAD:refs/heads/feature")
	pull, err := f.service.github.CreatePull(ctx, gh, "Feature", "feature", "main", "", false)
	require.NoError(t, err)

	open, err := f.service.InstallIssues(ctx, f.repoID, "open", 1)
	require.NoError(t, err)
	numbers := []int64{}
	for _, issue := range open {
		numbers = append(numbers, issue.Number)
	}
	require.Equal(t, []int64{outsider, team}, numbers, "newest first, without pull request #%d", pull.Number)
	require.Equal(t, "Say goodbye", open[1].Title)
	require.Equal(t, "JOURNEY.md should end with a farewell.", open[1].Body)
	require.Equal(t, "open", open[1].State)
	require.Equal(t, "ben", open[1].User.Login)
	require.EqualValues(t, 2, open[1].Comments)
	require.Equal(t, fmt.Sprintf("https://github.com/%s/issues/%d", repo, team), open[1].HTMLURL)
	require.Equal(t, []InstallIssueLabel{}, open[1].Labels)
	require.Equal(t, []InstallIssuePerson{}, open[1].Assignees)
	closed, err := f.service.InstallIssues(ctx, f.repoID, "closed", 1)
	require.NoError(t, err)
	require.Empty(t, closed)
	for _, bad := range []struct {
		state string
		page  int
	}{{"merged", 1}, {"open", 0}, {"all", 1001}} {
		_, err = f.service.InstallIssues(ctx, f.repoID, bad.state, bad.page)
		requireTodoControl(t, err, http.StatusBadRequest, "invalid_issue_query")
	}

	thread, err := f.service.InstallIssue(ctx, f.repoID, team)
	require.NoError(t, err)
	require.Equal(t, team, thread.Issue.Number)
	require.Equal(t, "ben", thread.Issue.User.Login)
	require.Len(t, thread.Comments, 2)
	require.Equal(t, "Seen it too.", thread.Comments[0].Body)
	require.Equal(t, "carol", thread.Comments[0].User.Login)
	require.NotNil(t, thread.Comments[0].CreatedAt)
	require.Equal(t, "Keep it short.", thread.Comments[1].Body)
	for _, missing := range []int64{pull.Number, 99} {
		_, err = f.service.InstallIssue(ctx, f.repoID, missing)
		requireTodoControl(t, err, http.StatusNotFound, "not_found")
	}
	_, err = f.service.InstallIssue(ctx, f.repoID, 0)
	requireTodoControl(t, err, http.StatusBadRequest, "invalid_issue_query")
	f.fake.FailNextReads(fmt.Sprintf("/repos/%s/issues", repo), 1)
	_, err = f.service.InstallIssues(ctx, f.repoID, "open", 1)
	requireTodoControl(t, err, http.StatusServiceUnavailable, "github_unavailable")
	f.fake.FailNextReads(fmt.Sprintf("/repos/%s/issues/%d/comments", repo, team), 1)
	_, err = f.service.InstallIssue(ctx, f.repoID, team)
	requireTodoControl(t, err, http.StatusServiceUnavailable, "github_unavailable")
	_, err = f.service.InstallIssues(ctx, f.repoID+1000, "open", 1)
	requireTodoControl(t, err, http.StatusServiceUnavailable, "github_unavailable")
}

func requireTodoControl(t *testing.T, err error, status int, code string) {
	t.Helper()
	var typed *TodoControlError
	require.ErrorAs(t, err, &typed)
	require.Equal(t, status, typed.Status, typed.Message)
	require.Equal(t, code, typed.Code)
}

func TestTodoIssueBarredAndSuspendedWritersAreOutsiders(t *testing.T) {
	f := newPublicationFixture(t, false)
	ctx := context.Background()
	_, err := f.pool.Exec(ctx, `INSERT INTO install_settings(key,value) VALUES('github.repository',jsonb_build_object('repository_id',$1::bigint)) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, f.repoID)
	require.NoError(t, err)
	var writerID int64
	err = f.pool.QueryRow(ctx, `INSERT INTO users(username,lower_username,email,lower_email) VALUES('writer','writer','writer@example.test','writer@example.test') RETURNING id`).Scan(&writerID)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,github_id,permission) VALUES($1,$2,8,'write')`, f.repoID, writerID)
	require.NoError(t, err)
	f.fake.SetCollaborator(8, "writer", "write")
	number := f.fake.OpenIssue("rehearsal-owner/app", "writer", "Team text", "Body")
	gh, err := f.service.stackGitHub(ctx, f.repoID)
	require.NoError(t, err)
	issue := mythicalIssue{Number: number, Title: "Team text", Body: "Body"}
	team, err := f.service.todoIssueTeamText(ctx, f.repoID, gh, issue)
	require.NoError(t, err)
	require.True(t, team)
	for _, state := range []string{"UPDATE users SET prohibit_login=true WHERE id=$1", "UPDATE collaborators SET suspended_at=now() WHERE user_id=$1"} {
		_, err = f.pool.Exec(ctx, state, writerID)
		require.NoError(t, err)
		team, err = f.service.todoIssueTeamText(ctx, f.repoID, gh, issue)
		require.NoError(t, err)
		require.False(t, team, state)
		_, err = f.pool.Exec(ctx, `UPDATE users SET prohibit_login=false WHERE id=$1`, writerID)
		require.NoError(t, err)
	}
	// The owner path must use the same active-membership authority.
	_, err = f.pool.Exec(ctx, `UPDATE users SET prohibit_login=true WHERE id=$1`, f.userID)
	require.NoError(t, err)
	role, err := f.service.todoLabelMember(ctx, f.repoID, gh, gitHubActor{ID: 7, Login: "rehearsal-owner", Type: "User"})
	require.NoError(t, err)
	require.Empty(t, role)
}

func TestTodoIssueAppProvenanceRefusesMemberText(t *testing.T) {
	f := newPublicationFixture(t, false)
	ctx := context.Background()
	f.fake.SetCollaborator(8, "writer", "write")
	_, err := f.pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,github_id,permission) VALUES($1,$2,8,'write')`, f.repoID, f.userID)
	require.NoError(t, err)
	number := f.fake.OpenIssue("rehearsal-owner/app", "writer", "App text", "Body")
	gh, err := f.service.stackGitHub(ctx, f.repoID)
	require.NoError(t, err)
	issue := mythicalIssue{Number: number, Title: "App text", Body: "Body"}
	team, err := f.service.todoIssueTeamText(ctx, f.repoID, gh, issue)
	require.NoError(t, err)
	require.True(t, team, "the attributed person has active membership and push permission")
	issue.ViaApp = true
	team, err = f.service.todoIssueTeamText(ctx, f.repoID, gh, issue)
	require.NoError(t, err)
	require.False(t, team, "an App acting on behalf of the owner is outsider text")
	api := f.service.github.(*mythicalGitHubAPI)
	original := api.api.client.Transport
	if original == nil {
		original = http.DefaultTransport
	}
	client := *api.api.client
	client.Transport = todoIssueProvenanceTransport{base: original, path: fmt.Sprintf("/repos/rehearsal-owner/app/issues/%d", number)}
	api.api.client = &client
	ctx = middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &db.User{ID: f.userID}, SessionHash: "owner-session"})
	thread, err := f.service.InstallIssue(ctx, f.repoID, number)
	require.NoError(t, err)
	raw, err := json.Marshal(thread.Issue)
	require.NoError(t, err)
	var decoded map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(raw, &decoded))
	require.JSONEq(t, `{"id":999,"slug":"third-party"}`, string(decoded["performed_via_github_app"]))
	var outsider bool
	err = f.pool.QueryRow(ctx, `SELECT (data->>'outsider')::boolean FROM product_job_events WHERE event_type='issue.read' ORDER BY recorded_at DESC LIMIT 1`).Scan(&outsider)
	require.NoError(t, err)
	require.True(t, outsider, "REST provenance survives the read receipt classifier")

}

// Only the REST provenance field is injected; all identity, text-history and
// permission reads still use the real provider fixture.
type todoIssueProvenanceTransport struct {
	base http.RoundTripper
	path string
}

func (r todoIssueProvenanceTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	response, err := r.base.RoundTrip(req)
	if err != nil || req.URL.Path != r.path || req.Method != http.MethodGet {
		return response, err
	}
	var body map[string]any
	err = json.NewDecoder(response.Body).Decode(&body)
	response.Body.Close()
	if err != nil {
		return nil, err
	}
	body["performed_via_github_app"] = map[string]any{"id": 999, "slug": "third-party"}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	response.Body = io.NopCloser(strings.NewReader(string(raw)))
	response.ContentLength = int64(len(raw))
	return response, nil
}

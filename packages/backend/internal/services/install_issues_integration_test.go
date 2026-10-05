package services

import (
	"context"
	"fmt"
	"net/http"
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

package services

import (
	"context"
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// Account answers the account the test registered under id.
func (g *fakeMythicalGitHub) Account(_ context.Context, _ mythicalGitHubRepo, id int64) (gitHubActor, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	account, ok := g.accounts[id]
	if !ok {
		return gitHubActor{}, fmt.Errorf("no GitHub account %d", id)
	}
	return account, nil
}

// CreateIssue opens an open issue the App wrote, as GitHub answers it.
func (g *fakeMythicalGitHub) CreateIssue(_ context.Context, _ mythicalGitHubRepo, title, body string) (mythicalIssue, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	number := int64(700 + len(g.issues))
	issue := mythicalIssue{Number: number, Title: title, Body: body, State: "open", ViaApp: true,
		URL: fmt.Sprintf("https://github.com/smithersai/smithers/issues/%d", number), Author: gitHubActor{Login: "smithers[bot]", Type: "Bot"}}
	g.issues = append(g.issues, issue)
	return issue, nil
}

// filingTodos is an orchestration whose person signed in with GitHub
// account 42, today the login roninjin10 the policy names.
func filingTodos(t *testing.T) *mythicalOrchestration {
	t.Helper()
	o := newMythicalOrchestration(t)
	_, err := o.pool.Exec(context.Background(), `INSERT INTO oauth_accounts(id, user_id, provider, provider_user_id, profile_data)
		VALUES (1, $1, 'github', '42', '{"login":"someone-else"}')`, o.userID)
	require.NoError(t, err)
	o.github.accounts = map[int64]gitHubActor{42: {ID: 42, Login: "roninjin10", Type: "User"}}
	return o
}

func apiCode(t *testing.T, err error) (int, string) {
	t.Helper()
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	return apiErr.Status, apiErr.Message
}

func TestMythicalGitHubCreateIssueAndAccount(t *testing.T) {
	t.Parallel()
	github := &recordedGitHub{routes: map[string]func(http.ResponseWriter){
		"POST /repos/o/r/issues": answer(http.StatusCreated, map[string]any{"number": 9, "title": "T", "body": "B", "html_url": "https://github.com/o/r/issues/9",
			"state": "open", "user": map[string]any{"login": "app[bot]", "type": "Bot"}, "performed_via_github_app": map[string]any{"id": 1},
			"smithers_text_by_maintainer": true}),
		"GET /user/42": answer(http.StatusOK, map[string]any{"id": 42, "login": "roninjin10", "type": "User"}),
	}}
	api := github.api(t)
	issue, err := api.CreateIssue(context.Background(), stackRepo, "T", "B")
	require.NoError(t, err)
	assert.Equal(t, mythicalIssue{Number: 9, Title: "T", Body: "B", URL: "https://github.com/o/r/issues/9", State: "open",
		Author: gitHubActor{Login: "app[bot]", Type: "Bot"}, ViaApp: true}, issue, "an answer never vouches for its own text")
	account, err := api.Account(context.Background(), stackRepo, 42)
	require.NoError(t, err)
	assert.Equal(t, gitHubActor{ID: 42, Login: "roninjin10", Type: "User"}, account)
	assert.Equal(t, []string{
		`POST /repos/o/r/issues issues=write {"body":"B","title":"T"}`,
		`GET /user/42 read-token `,
	}, github.calls)

	failing := (&recordedGitHub{routes: map[string]func(http.ResponseWriter){
		"POST /repos/o/r/issues": answer(http.StatusGone, map[string]any{}),
		"GET /user/43":           answer(http.StatusNotFound, map[string]any{}),
	}}).api(t)
	_, err = failing.CreateIssue(context.Background(), stackRepo, "T", "B")
	require.Error(t, err)
	_, err = failing.Account(context.Background(), stackRepo, 43)
	require.Error(t, err)
}

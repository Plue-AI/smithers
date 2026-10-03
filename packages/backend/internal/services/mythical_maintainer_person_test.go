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

// signedInMaintainer is an orchestration whose person signed in with GitHub
// account 42, today the login roninjin10 the policy names.
func signedInMaintainer(t *testing.T) *mythicalOrchestration {
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

// The account is read by id with the stack's read token.
func TestMythicalGitHubAccount(t *testing.T) {
	t.Parallel()
	github := &recordedGitHub{routes: map[string]func(http.ResponseWriter){
		"GET /user/42": answer(http.StatusOK, map[string]any{"id": 42, "login": "roninjin10", "type": "User"}),
	}}
	account, err := github.api(t).Account(context.Background(), stackRepo, 42)
	require.NoError(t, err)
	assert.Equal(t, gitHubActor{ID: 42, Login: "roninjin10", Type: "User"}, account)
	assert.Equal(t, []string{`GET /user/42 read-token `}, github.calls)

	failing := (&recordedGitHub{routes: map[string]func(http.ResponseWriter){
		"GET /user/43": answer(http.StatusNotFound, map[string]any{}),
	}}).api(t)
	_, err = failing.Account(context.Background(), stackRepo, 43)
	require.Error(t, err)
}

// GitHub sign-in stores its account under the historical "workos" row; a
// "github" row, when both exist, is the one read. A person with neither is
// told to connect GitHub.
func TestMythicalPersonGitHubIDReadsTheGitHubSignIn(t *testing.T) {
	o := signedInMaintainer(t)
	ctx := context.Background()
	id, err := o.service.personGitHubID(ctx, o.userID, "land a TODO")
	require.NoError(t, err)
	assert.Equal(t, int64(42), id)

	_, err = o.pool.Exec(ctx, `UPDATE oauth_accounts SET provider = 'workos', provider_user_id = '99'`)
	require.NoError(t, err)
	id, err = o.service.personGitHubID(ctx, o.userID, "land a TODO")
	require.NoError(t, err)
	assert.Equal(t, int64(99), id, "the GitHub sign-in's workos row")

	_, err = o.pool.Exec(ctx, `INSERT INTO oauth_accounts(id, user_id, provider, provider_user_id) VALUES (2, $1, 'github', '42')`, o.userID)
	require.NoError(t, err)
	id, err = o.service.personGitHubID(ctx, o.userID, "land a TODO")
	require.NoError(t, err)
	assert.Equal(t, int64(42), id, "the github row wins")

	_, err = o.pool.Exec(ctx, `DELETE FROM oauth_accounts`)
	require.NoError(t, err)
	_, err = o.service.personGitHubID(ctx, o.userID, "land a TODO")
	code, message := apiCode(t, err)
	assert.Equal(t, http.StatusForbidden, code)
	assert.Equal(t, "connect your GitHub account to land a TODO", message)
}

package compose

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// Only the reviewer agents main's factory projection names count toward
// require_agent_lgtm (D-22). Another agent's LGTM stays a review, but the
// landing still waits for a named reviewer's.
func TestOnlyNamedReviewerAgentsSatisfyRequireAgentLGTMPostgres(t *testing.T) {
	const changeID, commitID = "lgtmchangeaaaaaa", "4444444444444444444444444444444444444444"
	f := newLandingGateFixtureWithFactory(t, map[string]string{changeID: commitID},
		`{"github":{"mirror":"pull","issues":"two-way","changes":"send-upstream","reviewerAgents":["Named-Reviewer"]}}`)
	_, err := f.q.UpsertProtectedBookmark(f.ctx, db.UpsertProtectedBookmarkParams{
		RepositoryID: f.repoID, Pattern: "main", RequireAgentLgtm: true,
		RequiredChecks: []string{}, RequiredStatusContexts: []string{}, RestrictPushTeams: []string{},
	})
	require.NoError(t, err)
	write := string(middleware.ScopeWriteRepository)
	agent := func(login string) string {
		user, err := f.q.CreateUser(f.ctx, db.CreateUserParams{Username: login, LowerUsername: login, DisplayName: login})
		require.NoError(t, err)
		_, err = f.pool.Exec(f.ctx, `UPDATE users SET user_type = 'bot' WHERE id = $1`, user.ID)
		require.NoError(t, err)
		_, err = f.pool.Exec(f.ctx, `INSERT INTO collaborators (repository_id, user_id, permission) VALUES ($1, $2, 'write')`, f.repoID, user.ID)
		require.NoError(t, err)
		return f.token(user, login+"-token", write, false)
	}
	named, unnamed := agent("named-reviewer"), agent("other-reviewer")
	person := f.token(f.owner, "lgtm-person", write, false)
	landing := f.landing("A person's change", f.other.ID, changeID)
	path := fmt.Sprintf("/landings/%d", landing.Number)
	lgtm := `{"verdict":"lgtm","confidence_bucket":"high","summary":"ok","commit_id":"` + commitID + `"}`
	land := `{"commit_id":"` + commitID + `"}`

	rec := f.serve(unnamed, http.MethodPost, path+"/reviews", lgtm)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	rec = f.serve(person, http.MethodPut, path+"/land", land)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, "an unnamed agent's LGTM satisfied require_agent_lgtm: %s", rec.Body.String())
	assert.Contains(t, rec.Body.String(), "agent_lgtm")

	rec = f.serve(named, http.MethodPost, path+"/reviews", lgtm)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	rec = f.serve(person, http.MethodPut, path+"/land", land)
	assert.Equal(t, http.StatusAccepted, rec.Code, "the named reviewer's LGTM did not count: %s", rec.Body.String())
}

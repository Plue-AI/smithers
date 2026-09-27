package compose

import (
	"encoding/json"
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

// An agent's landing onto the default bookmark needs a person's current
// approval (D-23), whether the agent lands it, sets it to auto-land, or it
// waits in the landing list; the agent's person may give it. An agent cannot
// land a person's landing onto main in its place, and its landing onto
// another bookmark needs none.
func TestAgentLandingOntoMainNeedsAPersonsApprovalPostgres(t *testing.T) {
	commits := map[string]string{
		"agentchangeaaaaa": "5555555555555555555555555555555555555555",
		"branchchangebbbb": "6666666666666666666666666666666666666666",
		"personchangecccc": "7777777777777777777777777777777777777777",
	}
	f := newLandingGateFixture(t, commits)
	write := string(middleware.ScopeWriteRepository)
	run := f.token(f.owner, "approval-run", write, true)
	person := f.token(f.owner, "approval-person", write, false)
	open := func(bearer, target, change string) string {
		rec := f.serve(bearer, http.MethodPost, "/landings", `{"title":"agent work","target_bookmark":"`+target+`","change_ids":["`+change+`"]}`)
		require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
		var created struct {
			Number        int64 `json:"number"`
			AgentAuthored bool  `json:"agent_authored"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &created))
		require.True(t, created.AgentAuthored)
		return fmt.Sprintf("/landings/%d", created.Number)
	}
	land := func(change string) string { return `{"commit_id":"` + commits[change] + `"}` }

	agentPath := open(run, "main", "agentchangeaaaaa")
	rec := f.serve(run, http.MethodPut, agentPath+"/land", land("agentchangeaaaaa"))
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, "an agent landed onto main unapproved: %s", rec.Body.String())
	assert.Contains(t, rec.Body.String(), "person_approval")
	assert.Contains(t, rec.Body.String(), "an agent's landing onto the default bookmark needs a person's approval")
	rec = f.serve(run, http.MethodPut, agentPath+"/land/append", `{"commit_id":"`+commits["agentchangeaaaaa"]+`","expected_commit_id":"9999999999999999999999999999999999999999","source_base_commit_id":"9999999999999999999999999999999999999999","description":"append"}`)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, "an agent queued an unapproved append onto main: %s", rec.Body.String())
	assert.Contains(t, rec.Body.String(), "person_approval")
	rec = f.serve(run, http.MethodPost, agentPath+"/auto-land", `{"enabled":true}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), "person_approval", "auto-land does not wait for a person")
	rec = f.serve(person, http.MethodGet, agentPath, ``)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), "person_approval", "readiness does not show the missing approval")

	// An agent's approval is not a person's; the person approves their
	// agent's landing.
	rec = f.serve(run, http.MethodPost, agentPath+"/reviews", `{"type":"approve","commit_id":"`+commits["agentchangeaaaaa"]+`"}`)
	assert.NotEqual(t, http.StatusCreated, rec.Code, rec.Body.String())
	rec = f.serve(person, http.MethodPost, agentPath+"/reviews", `{"type":"approve","commit_id":"`+commits["agentchangeaaaaa"]+`"}`)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	rec = f.serve(run, http.MethodPut, agentPath+"/land", land("agentchangeaaaaa"))
	assert.Equal(t, http.StatusAccepted, rec.Code, rec.Body.String())

	branchPath := open(run, "release", "branchchangebbbb")
	rec = f.serve(run, http.MethodPut, branchPath+"/land", land("branchchangebbbb"))
	assert.Equal(t, http.StatusAccepted, rec.Code, "an agent's landing onto a branch waited: %s", rec.Body.String())

	personLanding := f.landing("A person's change", f.owner.ID, "personchangecccc")
	personPath := fmt.Sprintf("/landings/%d", personLanding.Number)
	_, err := f.pool.Exec(f.ctx, `UPDATE landing_requests SET target_bookmark = 'release' WHERE id = $1`, personLanding.ID)
	require.NoError(t, err)
	// An agent neither sets a person's landing to land (it could be
	// retargeted onto main later) nor retargets it onto main.
	for _, attempt := range []struct{ method, path, body string }{
		{http.MethodPost, personPath + "/auto-land", `{"enabled":true}`},
		{http.MethodPatch, personPath, `{"target_bookmark":"main"}`},
	} {
		rec = f.serve(run, attempt.method, attempt.path, attempt.body)
		assert.Equal(t, http.StatusForbidden, rec.Code, "%s %s: %s", attempt.method, attempt.path, rec.Body.String())
	}
	rec = f.serve(person, http.MethodPatch, personPath, `{"target_bookmark":"main"}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	// Nor does it close or reopen one there (reopening re-arms auto-land).
	rec = f.serve(person, http.MethodPatch, personPath, `{"state":"closed"}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	rec = f.serve(run, http.MethodPatch, personPath, `{"state":"open"}`)
	assert.Equal(t, http.StatusForbidden, rec.Code, "an agent reopened a person's landing onto main: %s", rec.Body.String())
	rec = f.serve(person, http.MethodPatch, personPath, `{"state":"open"}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	for _, attempt := range []struct{ method, path, body string }{
		{http.MethodPut, personPath + "/land", land("personchangecccc")},
		{http.MethodPost, personPath + "/auto-land", `{"enabled":true}`},
	} {
		rec = f.serve(run, attempt.method, attempt.path, attempt.body)
		assert.Equal(t, http.StatusForbidden, rec.Code, "%s %s: %s", attempt.method, attempt.path, rec.Body.String())
	}
	rec = f.serve(person, http.MethodPut, personPath+"/land", land("personchangecccc"))
	assert.Equal(t, http.StatusAccepted, rec.Code, rec.Body.String())
}

// An agent account's own token is an agent's (D-23): its landing is
// agent-authored and waits for a person's approval, and it cannot land a
// person's landing onto main.
func TestAgentAccountLandingOntoMainNeedsAPersonsApprovalPostgres(t *testing.T) {
	commits := map[string]string{"botchangeaaaaaaa": "4444444444444444444444444444444444444444", "ownerchangebbbbb": "3333333333333333333333333333333333333333"}
	f := newLandingGateFixture(t, commits)
	bot, err := f.q.CreateUser(f.ctx, db.CreateUserParams{Username: "gate-bot", LowerUsername: "gate-bot", DisplayName: "gate-bot"})
	require.NoError(t, err)
	_, err = f.pool.Exec(f.ctx, `UPDATE users SET user_type = 'bot' WHERE id = $1`, bot.ID)
	require.NoError(t, err)
	_, err = f.pool.Exec(f.ctx, `INSERT INTO collaborators (repository_id, user_id, permission) VALUES ($1, $2, 'admin')`, f.repoID, bot.ID)
	require.NoError(t, err)
	botToken := f.token(bot, "gate-bot-pat", string(middleware.ScopeWriteRepository), false)

	rec := f.serve(botToken, http.MethodPost, "/landings", `{"title":"bot work","target_bookmark":"main","change_ids":["botchangeaaaaaaa"]}`)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), `"agent_authored":true`)
	rec = f.serve(botToken, http.MethodPut, "/landings/1/land", `{"commit_id":"`+commits["botchangeaaaaaaa"]+`"}`)
	assert.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	ownerLanding := f.landing("owner change", f.owner.ID, "ownerchangebbbbb")
	rec = f.serve(botToken, http.MethodPut, fmt.Sprintf("/landings/%d/land", ownerLanding.Number), `{"commit_id":"`+commits["ownerchangebbbbb"]+`"}`)
	assert.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	// Its approval is an agent's, and it takes no person's decision: an
	// admin agent account cannot approve as a person or report a status.
	rec = f.serve(botToken, http.MethodPost, fmt.Sprintf("/landings/%d/reviews", ownerLanding.Number), `{"type":"approve","commit_id":"`+commits["ownerchangebbbbb"]+`"}`)
	assert.NotEqual(t, http.StatusCreated, rec.Code, rec.Body.String())
	rec = f.serve(botToken, http.MethodPost, "/statuses/"+commits["ownerchangebbbbb"], `{"context":"ci/test","status":"success"}`)
	assert.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
}

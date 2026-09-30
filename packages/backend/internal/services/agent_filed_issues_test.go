package services

import (
	"context"
	"strconv"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// policyTestHost serves the default bookmark's factory projection.
type policyTestHost struct{ factory string }

// unreadablePolicyHost cannot list bookmarks.
type unreadablePolicyHost struct{ policyTestHost }

func (unreadablePolicyHost) ListBookmarks(context.Context, string, string, string, int) ([]repohost.Bookmark, string, error) {
	return nil, "", &repohost.StatusError{StatusCode: 503}
}

func (policyTestHost) ListBookmarks(context.Context, string, string, string, int) ([]repohost.Bookmark, string, error) {
	return []repohost.Bookmark{{Name: "main", TargetChangeID: "main", TargetCommitID: strings.Repeat("a", 40)}}, "", nil
}

func (h policyTestHost) GetFileAtChange(_ context.Context, _, _, _, path string) (repohost.FileContent, error) {
	if h.factory == "" || path != factoryProjectionPath {
		return repohost.FileContent{}, &repohost.StatusError{StatusCode: 404}
	}
	return repohost.FileContent{Content: h.factory}, nil
}

// Issues agents file (D-25) never start credentialed work on their own: an
// agent run's credential and an unwitnessed live trial file them under a
// person's account, and their text is never a maintainer's, even after a
// maintainer rewrites all of it. A maintainer
// person's trigger label approves one, and so does an agentIssueSources
// rule on the default bookmark naming its source, while the source alone
// wrote its text. A trial a person pressed is that person's own issue.
func TestAgentFiledIssuesNeedALabelOrAnAllowedSourcePostgres(t *testing.T) {
	pool, q, s, g, input := repositoryJobFixture(t)
	ctx := context.Background()
	repo := g.target.RepositoryID
	owner, err := q.GetUserByID(ctx, g.target.UserID)
	require.NoError(t, err)
	var repoName string
	require.NoError(t, pool.QueryRow(ctx, `SELECT name FROM repositories WHERE id=$1`, repo).Scan(&repoName))
	issues := NewIssueService(q)
	session := middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &owner, Scopes: middleware.ScopeSet{}})
	run := middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &owner, IsTokenAuth: true, TokenSystemIssued: true,
		RawScopes: "write:repository,repo:" + strconv.FormatInt(repo, 10), Scopes: middleware.ParseTokenScopes("write:repository")})
	provenance := func(number int64) (string, string) {
		var filedBy string
		var source *string
		require.NoError(t, pool.QueryRow(ctx, `SELECT filed_by, text_source FROM issues WHERE repository_id=$1 AND number=$2`, repo, number).Scan(&filedBy, &source))
		if source == nil {
			return filedBy, ""
		}
		return filedBy, *source
	}
	approves := func(number int64, action string, allowed ...string) bool {
		t.Helper()
		var payload []byte
		require.NoError(t, pool.QueryRow(ctx, `SELECT payload FROM repository_job_events WHERE repository_id=$1 AND issue_number=$2 AND event_action=$3
			ORDER BY id DESC LIMIT 1`, repo, number, action).Scan(&payload))
		return gitHubIssueEventApproves("issues", action, payload, issueApprovalLabel, allowed)
	}
	text := func(value string) *string { return &value }

	// A run files an issue as the owner: provenance "run", text by "run".
	byRun, err := issues.CreateIssue(run, &owner, owner.Username, repoName, CreateIssueInput{Title: "Agent", Body: "restated outsider text"})
	require.NoError(t, err)
	filedBy, source := provenance(byRun.Number)
	assert.Equal(t, []string{"run", "run"}, []string{filedBy, source})
	assert.False(t, approves(byRun.Number, "opened"), "an agent's issue started work on its own")
	assert.False(t, approves(byRun.Number, "opened", "linear", "trial"), "another source's rule approved it")
	assert.True(t, approves(byRun.Number, "opened", "run"), "the owner's rule naming runs")

	// The owner rewriting all of it does not make an agent's issue theirs;
	// the source's rule no longer covers text it did not write.
	_, err = issues.UpdateIssue(session, &owner, owner.Username, repoName, byRun.Number, UpdateIssueInput{Title: text("Owner's"), Body: text("owner's words")})
	require.NoError(t, err)
	filedBy, source = provenance(byRun.Number)
	assert.Equal(t, []string{"run", ""}, []string{filedBy, source})
	assert.False(t, approves(byRun.Number, "edited", "run"), "a rewritten agent issue started work without a label")

	// A maintainer person's trigger label approves it.
	_, err = q.CreateLabel(ctx, db.CreateLabelParams{RepositoryID: repo, Name: issueApprovalLabel, Color: "ffffff"})
	require.NoError(t, err)
	_, err = NewLabelService(q).AddLabelsToIssue(session, &owner, owner.Username, repoName, byRun.Number, []string{issueApprovalLabel})
	require.NoError(t, err)
	assert.True(t, approves(byRun.Number, "labeled"), "a maintainer's label")

	// A person's own issue is theirs.
	byPerson, err := issues.CreateIssue(session, &owner, owner.Username, repoName, CreateIssueInput{Title: "Mine", Body: "my words"})
	require.NoError(t, err)
	filedBy, _ = provenance(byPerson.Number)
	assert.Equal(t, "account", filedBy)
	assert.True(t, approves(byPerson.Number, "opened"))

	// An agent account's own issue is not a maintainer's text either.
	login := "bot" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	var botID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username,email,lower_email,user_type) VALUES($1,$1,$2,$2,'bot') RETURNING id`,
		login, login+"@example.invalid").Scan(&botID))
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, repo, botID)
	require.NoError(t, err)
	bot, err := q.GetUserByID(ctx, botID)
	require.NoError(t, err)
	byBot, err := issues.CreateIssue(middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &bot, IsTokenAuth: true, Scopes: middleware.ParseTokenScopes("write:repository")}),
		&bot, owner.Username, repoName, CreateIssueInput{Title: "Bot", Body: "bot text"})
	require.NoError(t, err)
	assert.False(t, approves(byBot.Number, "opened"), "an agent account's issue")

	// A person's press counts only for its own setup request: another
	// request with the same text, or a request from before presses were
	// checked, files as "trial".
	pressed := RepositoryJobTrialInput{Repo: input.Repo, WorkspaceID: input.WorkspaceID, Revision: input.Revision, Digest: input.Digest, Title: "Pressed trial"}
	pressTrial(t, pool, g.target, "issues", "pressed", pressed)
	replayed, err := s.CreateTrial(ctx, "gateway", "token", "issues", "another-request", pressed)
	require.NoError(t, err)
	filedBy, _ = provenance(replayed.Number)
	assert.Equal(t, "trial", filedBy, "a press lent to another request")
	legacy := RepositoryJobTrialInput{Repo: input.Repo, WorkspaceID: input.WorkspaceID, Revision: input.Revision, Digest: input.Digest, Title: "Legacy trial"}
	pressTrial(t, pool, g.target, "issues", "legacy", legacy)
	_, err = pool.Exec(ctx, `UPDATE repository_setup_requests SET person_trial_press = false WHERE request_id = 'legacy'`)
	require.NoError(t, err)
	unchecked, err := s.CreateTrial(ctx, "gateway", "token", "issues", "legacy", legacy)
	require.NoError(t, err)
	filedBy, _ = provenance(unchecked.Number)
	assert.Equal(t, "trial", filedBy, "an unchecked press")
	own, err := s.CreateTrial(ctx, "gateway", "token", "issues", "pressed", pressed)
	require.NoError(t, err)
	filedBy, _ = provenance(own.Number)
	assert.Equal(t, "account", filedBy, "the person's own press")

	// An unwitnessed trial files as "trial" and its registration no longer
	// approves it; the owner's rule naming trials does. An unreadable rule
	// approves nothing and holds nothing back.
	trial, err := s.CreateTrial(ctx, "gateway", "token", "issues", "unpressed", RepositoryJobTrialInput{Repo: input.Repo, WorkspaceID: input.WorkspaceID,
		Revision: input.Revision, Digest: input.Digest, Title: "Unpressed trial"})
	require.NoError(t, err)
	filedBy, source = provenance(trial.Number)
	assert.Equal(t, []string{"trial", "trial"}, []string{filedBy, source})
	registration := input
	registration.Mode, registration.TrialSource, registration.TrialIssueNumber = "trial", "smithers-cloud", trial.Number
	_, err = s.Register(ctx, "gateway", "token", "issues", registration)
	require.NoError(t, err)
	s.SetRepositoryPolicyReader(unreadablePolicyHost{})
	repositoryJobPoll(t, s, g)
	assert.Empty(t, g.runs, "an unwitnessed trial issue started work")
	var undecided int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM repository_job_dispatches d JOIN repository_job_registrations r ON r.id = d.registration_id
		WHERE r.repository_id = $1 AND d.issue_number = $2 AND d.status = 'skipped'`, repo, trial.Number).Scan(&undecided))
	assert.Positive(t, undecided, "an unreadable rule left the event pending")
	s.SetRepositoryPolicyReader(policyTestHost{factory: `{"github":{"agentIssueSources":["trial"]}}`})
	_, err = pool.Exec(ctx, `DELETE FROM repository_job_dispatches WHERE registration_id IN (SELECT id FROM repository_job_registrations WHERE repository_id=$1)`, repo)
	require.NoError(t, err)
	repositoryJobPoll(t, s, g)
	assert.Len(t, g.runs, 1, "the owner's rule naming trials")
}

// Deleting a writer's account clears that writer and keeps who filed it.
func TestIssueFiledByOutlivesItsWritersAccountPostgres(t *testing.T) {
	pool, q, _, g, _ := repositoryJobFixture(t)
	ctx := context.Background()
	owner, err := q.GetUserByID(ctx, g.target.UserID)
	require.NoError(t, err)
	var repoName string
	require.NoError(t, pool.QueryRow(ctx, `SELECT name FROM repositories WHERE id=$1`, g.target.RepositoryID).Scan(&repoName))
	login := "gone" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	var writerID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username,email,lower_email) VALUES($1,$1,$2,$2) RETURNING id`,
		login, login+"@example.invalid").Scan(&writerID))
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, g.target.RepositoryID, writerID)
	require.NoError(t, err)
	writer, err := q.GetUserByID(ctx, writerID)
	require.NoError(t, err)
	created, err := NewIssueService(q).CreateIssue(middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &writer, Scopes: middleware.ScopeSet{}}),
		&writer, owner.Username, repoName, CreateIssueInput{Title: "Theirs", Body: "their words"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `DELETE FROM collaborators WHERE user_id=$1`, writerID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE issues SET author_id=$1 WHERE repository_id=$2 AND number=$3`, owner.ID, g.target.RepositoryID, created.Number)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, writerID)
	require.NoError(t, err)
	var filedBy string
	var titleEditor *int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT filed_by, title_editor_id FROM issues WHERE repository_id=$1 AND number=$2`, g.target.RepositoryID, created.Number).Scan(&filedBy, &titleEditor))
	assert.Equal(t, "account", filedBy)
	assert.Nil(t, titleEditor)
}

package services

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func factoryFixture(t *testing.T) FactoryProjection {
	t.Helper()
	var projection FactoryProjection
	require.NoError(t, json.Unmarshal([]byte(`{"flows":[{"id":"assistant","kind":"mdx","capabilities":["memory:read:global-team"],"flows":[],"budget":{"tokens":2400000,"milliseconds":21600000}}],"on":[{"event":"issue_comment","flow":"assistant"},{"event":"schedule:0 9 * * 1-5","flow":"assistant"},{"event":"issue.opened","flow":"not-discovered"}]}`), &projection))
	return projection
}

func TestFactoryRules(t *testing.T) {
	projection := factoryFixture(t)
	rules, err := factoryRegistrations(projection, strings.Repeat("a", 40))
	require.NoError(t, err)
	require.Len(t, rules, 2)
	require.Equal(t, "issue_comment", rules[0].input.Events[0].Type)
	require.Equal(t, "0 9 * * 1-5", rules[1].input.Schedule)
	require.NotEqual(t, rules[0].job, rules[1].job)
	input := rules[0].input
	input.WorkspaceID = repositoryJobTestInput().WorkspaceID
	input.Revision = 1
	_, err = validateRepositoryJob(rules[0].job, input, time.Now())
	require.NoError(t, err)
	again, err := factoryRegistrations(projection, strings.Repeat("a", 40))
	require.NoError(t, err)
	require.Equal(t, rules, again)
	projection.On = append(projection.On, projection.On[0])
	_, err = factoryRegistrations(projection, strings.Repeat("a", 40))
	require.ErrorContains(t, err, "duplicate")
	projection = factoryFixture(t)
	projection.Flows[0].Budget = nil
	rules, err = factoryRegistrations(projection, strings.Repeat("a", 40))
	require.NoError(t, err)
	require.Empty(t, rules)
}

func TestFactoryReconcileRestartAndRetirement(t *testing.T) {
	pool, q, service, gateway, _ := repositoryJobFixture(t)
	ctx := context.Background()
	repo := gateway.target.RepositoryID
	revision := strings.Repeat("a", 40)
	projection := factoryFixture(t)
	projection.Github.Maintainers = []string{"someone-else"}
	require.NoError(t, service.ReconcileFactoryRules(ctx, repo, revision, projection))
	first, err := q.ListRepositoryJobRegistrations(ctx, repo)
	require.NoError(t, err)
	require.Len(t, first, 2)
	require.Equal(t, gateway.target.UserID, first[0].UserID, "a user's repository runs its rules as its owner")
	// A fresh service sees the same rows; unchanged main cannot reenable a pause.
	_, err = q.PauseRepositoryJob(ctx, db.PauseRepositoryJobParams{RepositoryID: repo, Job: first[0].Job})
	require.NoError(t, err)
	restarted := NewRepositoryJobService(q, gateway, pool)
	require.NoError(t, restarted.ReconcileFactoryRules(ctx, repo, revision, projection))
	second, err := q.ListRepositoryJobRegistrations(ctx, repo)
	require.NoError(t, err)
	require.Equal(t, first[0].Revision, second[0].Revision)
	require.False(t, second[0].Enabled)
	require.NoError(t, restarted.ReconcileFactoryRules(ctx, repo, strings.Repeat("b", 40), projection))
	third, err := q.ListRepositoryJobRegistrations(ctx, repo)
	require.NoError(t, err)
	require.Equal(t, first[0].Revision+1, third[0].Revision)
	require.NoError(t, restarted.ReconcileFactoryRules(ctx, repo, strings.Repeat("c", 40), FactoryProjection{}))
	retired, err := q.ListRepositoryJobRegistrations(ctx, repo)
	require.NoError(t, err)
	for _, row := range retired {
		require.False(t, row.Enabled)
	}
}

func TestLocalFactoryRemovalAndMalformedProjection(t *testing.T) {
	f := newMythicalFixture(t)
	ctx := context.Background()
	calls := 0
	service := &MythicalService{reconcileFactory: func(_ context.Context, _ int64, _ string, projection FactoryProjection) error {
		calls++
		require.Empty(t, projection.Flows)
		return nil
	}}
	absent := f.commit("empty main", map[string]string{"README.md": "hello"})
	require.NoError(t, service.reconcileLocalFactory(ctx, &mythicalRun{g: f.git, mainTip: absent}))
	require.Equal(t, 1, calls, "removing factory rules must retire their registrations")
	malformed := f.commit("invalid factory", map[string]string{gitHubMainPullFactoryPath: "not JSON"})
	require.ErrorContains(t, service.reconcileLocalFactory(ctx, &mythicalRun{g: f.git, mainTip: malformed}), "invalid factory projection")
	require.Equal(t, 1, calls, "a broken projection cannot silently retire registrations")
}

// An organization repository's rules run as the first committed maintainer
// whose GitHub account, the one holding the login now, is linked to a Cloud
// user with write access and a workspace (#2801). Until one resolves, main
// still syncs: the pull is synced, its receipt names the missing link, every
// factory rule is paused, and the next poll retries.
func TestFactoryOrgRepositoryRulesRunAsALinkedMaintainer(t *testing.T) {
	pool, q, service, _, _ := repositoryJobFixture(t)
	ctx := context.Background()
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	exec := func(statement string, args ...any) {
		_, err := pool.Exec(ctx, statement, args...)
		require.NoError(t, err)
	}
	var orgID, repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO organizations(name,lower_name,description) VALUES($1,$1,'') RETURNING id`, "org"+suffix).Scan(&orgID))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(org_id,name,lower_name,description,is_public,default_bookmark,next_issue_number)
		VALUES($1,'r','r','',TRUE,'main',1) RETURNING id`, orgID).Scan(&repo))
	// GitHub's accounts now: login -> account ID. "ghost" has none.
	accounts := map[string]string{}
	for i, login := range []string{"nobody", "reader", "idle", "maint", "second"} {
		accounts[login+suffix] = suffix[:6] + string(rune('1'+i))
	}
	// person is a Cloud user signed in through GitHub (auth.go stores that
	// identity under "workos") as account, whose profile says login.
	person := func(login, account string, write, workspace bool) int64 {
		var id int64
		name := strings.ToLower(login) + uuid.NewString()[:8]
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username,email,lower_email) VALUES($1,$1,$2,$2) RETURNING id`,
			name, name+"@example.invalid").Scan(&id))
		exec(`INSERT INTO oauth_accounts(user_id,provider,provider_user_id,profile_data) VALUES($1,'workos',$2,jsonb_build_object('login',$3::text))`,
			id, account, login+suffix)
		if write {
			exec(`INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, repo, id)
		}
		if workspace {
			exec(`INSERT INTO workspaces(id,repository_id,user_id,status) VALUES($1,$2,$3,'running')`, uuid.NewString(), repo, id)
		}
		return id
	}
	person("reader", accounts["reader"+suffix], false, true)
	person("idle", accounts["idle"+suffix], true, false)
	// A writer whose account once held "maint" and was renamed away.
	person("maint", "999"+suffix[:6], true, true)
	projection := factoryFixture(t)
	projection.gitHubAccount = func(login string) (string, error) { return accounts[strings.ToLower(login)], nil }
	revision := strings.Repeat("a", 40)
	for maintainer, reason := range map[string]string{
		"":       ".smithers/factory.json names no maintainers",
		"Ghost":  "Ghost" + suffix + ": no GitHub account holds this login",
		"Nobody": "Nobody" + suffix + ": no Cloud user is linked to this GitHub account",
		"maint":  "maint" + suffix + ": no Cloud user is linked to this GitHub account",
		"READER": "READER" + suffix + ": the linked Cloud user has no write access",
		"idle":   "idle" + suffix + ": the linked Cloud user has no workspace for this repository",
	} {
		projection.Github.Maintainers = nil
		if maintainer != "" {
			projection.Github.Maintainers = []string{maintainer + suffix}
		}
		var unapproved *FactoryRulesUnapprovedError
		require.True(t, errors.As(service.ReconcileFactoryRules(ctx, repo, revision, projection), &unapproved), maintainer)
		require.Contains(t, unapproved.Error(), reason)
	}
	none, err := q.ListRepositoryJobRegistrations(ctx, repo)
	require.NoError(t, err)
	require.Empty(t, none, "an unapproved projection registers nothing")

	// The pull of GitHub main resolves each login and reconciles.
	h := newPullHarness(t)
	h.store.repos[19] = db.Repository{ID: 19, Name: "smithers", LowerName: "smithers", DefaultBookmark: "main", OrgID: pgtype.Int8{Int64: orgID, Valid: true}}
	maintainers := []string{"Ghost" + suffix, "maint" + suffix}
	h.service.readFactory = func(context.Context, string, string, string, string) ([]byte, error) {
		projection.Github.Maintainers = maintainers
		return json.Marshal(projection)
	}
	var outage error
	var looked []string
	h.service.readGitHubAccount = func(_ context.Context, _, login string) (string, error) {
		looked = append(looked, login)
		return accounts[strings.ToLower(login)], outage
	}
	h.service.SetFactoryReconciler(func(ctx context.Context, _ int64, revision string, projection FactoryProjection) error {
		return service.ReconcileFactoryRules(ctx, repo, revision, projection)
	})
	pull := func() db.GithubMainPull {
		require.NoError(t, h.service.RequestForGitHub(ctx, "SmithersAI", "smithers"))
		require.NoError(t, h.service.PollOnce(ctx))
		return h.row(t)
	}
	row := pull()
	require.Equal(t, "synced", row.State, "a synced main is not a failed pull")
	require.Equal(t, pullNew, row.SmithersHead)
	require.Contains(t, row.LastError, "reconcile factory: factory rules not registered")
	require.Contains(t, row.LastError, "maint"+suffix+": no Cloud user is linked")
	status, err := h.service.Status(ctx, 19)
	require.NoError(t, err)
	require.True(t, status.Fresh)

	maintainer := person("maint", accounts["maint"+suffix], true, true)
	row = pull()
	require.Equal(t, "synced", row.State)
	require.Empty(t, row.LastError)
	registered, err := q.ListRepositoryJobRegistrations(ctx, repo)
	require.NoError(t, err)
	require.Len(t, registered, 2)
	for _, registration := range registered {
		require.Equal(t, maintainer, registration.UserID)
		require.True(t, registration.Enabled)
	}

	jobs := func() map[string]db.RepositoryJobRegistration {
		rows, err := q.ListRepositoryJobRegistrations(ctx, repo)
		require.NoError(t, err)
		byJob := map[string]db.RepositoryJobRegistration{}
		for _, row := range rows {
			byJob[row.Job] = row
		}
		return byJob
	}
	paused, running := registered[0].Job, registered[1].Job

	// The approver changes at the same main: an enabled rule moves to the
	// next maintainer; a rule a person paused stays paused as it was.
	second := person("second", accounts["second"+suffix], true, true)
	exec(`UPDATE oauth_accounts SET provider='auth0' WHERE user_id=$1`, second) // Auth0's GitHub sign-in
	maintainers = []string{"maint" + suffix, "second" + suffix}
	_, err = q.PauseRepositoryJob(ctx, db.PauseRepositoryJobParams{RepositoryID: repo, Job: paused})
	require.NoError(t, err)
	exec(`DELETE FROM collaborators WHERE repository_id=$1 AND user_id=$2`, repo, maintainer)
	require.Empty(t, pull().LastError)
	byJob := jobs()
	require.True(t, byJob[running].Enabled)
	require.Equal(t, second, byJob[running].UserID)
	require.False(t, byJob[paused].Enabled)
	require.Equal(t, maintainer, byJob[paused].UserID)

	// A GitHub outage approves nothing, so it revokes every rule, visibly;
	// when a maintainer resolves again, only the refusal's pause ends.
	outage = errors.New("GitHub answered HTTP 502")
	row = pull()
	require.Equal(t, "synced", row.State)
	require.Contains(t, row.LastError, "second"+suffix+": GitHub lookup failed: GitHub answered HTTP 502")
	for _, registration := range jobs() {
		require.False(t, registration.Enabled)
	}
	outage = nil
	require.Empty(t, pull().LastError)
	byJob = jobs()
	require.True(t, byJob[running].Enabled)
	require.Equal(t, second, byJob[running].UserID)
	require.False(t, byJob[paused].Enabled, "a person's pause outlives a refusal")

	// A person who pauses a rule during an outage keeps it paused after.
	outage = errors.New("GitHub answered HTTP 502")
	require.NotEmpty(t, pull().LastError)
	_, err = q.PauseRepositoryJob(ctx, db.PauseRepositoryJobParams{RepositoryID: repo, Job: running})
	require.NoError(t, err)
	outage = nil
	require.Empty(t, pull().LastError)
	require.False(t, jobs()[running].Enabled, "a person's pause during an outage outlives it")

	// Logins resolve lazily: the first approver ends the lookups.
	maintainers = []string{"second" + suffix, "Ghost" + suffix}
	looked = nil
	require.Empty(t, pull().LastError)
	require.Equal(t, []string{"second" + suffix}, looked)

	// A person who pauses while recovery looks a maintainer up keeps the pause.
	moved := strings.Repeat("b", 40)
	require.NoError(t, service.ReconcileFactoryRules(ctx, repo, moved, projection))
	projection.gitHubAccount = func(string) (string, error) { return "", errors.New("GitHub did not answer") }
	require.Error(t, service.ReconcileFactoryRules(ctx, repo, moved, projection))
	lookups := 0
	projection.gitHubAccount = func(login string) (string, error) {
		lookups++
		var free bool
		require.NoError(t, pool.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock($1)`, repo).Scan(&free))
		require.True(t, free, "no lock waits on GitHub")
		_, err := q.PauseRepositoryJob(ctx, db.PauseRepositoryJobParams{RepositoryID: repo, Job: running})
		require.NoError(t, err)
		return accounts[strings.ToLower(login)], nil
	}
	require.NoError(t, service.ReconcileFactoryRules(ctx, repo, moved, projection))
	require.Equal(t, 1, lookups, "the locked pass reuses the answer")
	byJob = jobs()
	require.False(t, byJob[running].Enabled, "a pause during recovery's lookup outlives it")
	require.True(t, byJob[paused].Enabled)

	// Only a GitHub main pull resolves logins; elsewhere the reason says so.
	projection.gitHubAccount = nil
	projection.Github.Maintainers = []string{"second" + suffix}
	require.ErrorContains(t, service.ReconcileFactoryRules(ctx, repo, revision, projection), "only a GitHub main pull resolves maintainers")
}

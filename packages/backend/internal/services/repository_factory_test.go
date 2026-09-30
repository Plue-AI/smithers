package services

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
	"os"
	"slices"
	"strings"
	"testing"
	"time"
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
	require.NoError(t, service.ReconcileFactoryRules(ctx, repo, revision, projection))
	first, err := q.ListRepositoryJobRegistrations(ctx, repo)
	require.NoError(t, err)
	require.Len(t, first, 2)
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
	_, err := service.reconcileLocalFactory(ctx, &mythicalRun{g: f.git, mainTip: absent})
	require.NoError(t, err)
	require.Equal(t, 1, calls, "removing factory rules must retire their registrations")
	malformed := f.commit("invalid factory", map[string]string{gitHubMainPullFactoryPath: "not JSON"})
	_, err = service.reconcileLocalFactory(ctx, &mythicalRun{g: f.git, mainTip: malformed})
	require.ErrorContains(t, err, "invalid factory projection")
	require.Equal(t, 1, calls, "a broken projection cannot silently retire registrations")
}

func TestLocalFactoryOutcomeClassifiesReconcilerResults(t *testing.T) {
	f := newMythicalFixture(t)
	ctx := context.Background()
	main := f.commit("empty factory", map[string]string{"README.md": "hello"})
	bridge, err := startMythicalBridge(ctx, &fakeMainPullHost{}, "owner", "repo", nil)
	require.NoError(t, err)
	defer bridge.Close()
	r := &mythicalRun{row: db.MythicalStack{RepositoryID: 42}, g: f.git, mainTip: main, bridge: bridge}
	for _, tc := range []struct {
		name, wantState, wantError string
		failure                    error
		panics                     bool
	}{
		{name: "success", wantState: "reconciled"},
		{name: "owner absent", failure: ErrFactoryNeedsOwner, wantState: "skipped", wantError: ErrFactoryNeedsOwner.Error()},
		{name: "workspace absent", failure: ErrFactoryNeedsWorkspace, wantState: "failed", wantError: ErrFactoryNeedsWorkspace.Error()},
		{name: "other failure", failure: errors.New("factory unavailable"), wantState: "failed", wantError: "factory unavailable"},
		{name: "panic", panics: true, wantState: "failed", wantError: "internal factory error"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := NewMythicalService(nil, nil)
			s.SetFactoryReconciler(func(context.Context, int64, string, FactoryProjection) error {
				if tc.panics {
					panic("secret from factory")
				}
				return tc.failure
			})
			state, message := s.localFactoryOutcome(ctx, r)
			require.Equal(t, tc.wantState, state)
			require.Equal(t, tc.wantError, message)
		})
	}
}

// An organization's repository has no owner workspace to run factory rules in
// (#2801). One that moved from a user keeps no live rule from that owner, and
// a declared rule set is reported rather than silently dropped.
func TestFactoryReconcileRetiresRulesWhenAnOrganizationOwnsTheRepository(t *testing.T) {
	pool, q, service, gateway, _ := repositoryJobFixture(t)
	ctx := context.Background()
	repo := gateway.target.RepositoryID
	projection := factoryFixture(t)
	require.NoError(t, service.ReconcileFactoryRules(ctx, repo, strings.Repeat("a", 40), projection))
	live, err := q.ListRepositoryJobRegistrations(ctx, repo)
	require.NoError(t, err)
	require.NotEmpty(t, live)

	var org int64
	name := "factory-org-" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO organizations (name, lower_name, description) VALUES ($1, $1, '') RETURNING id`, name).Scan(&org))
	var owner int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT user_id FROM repositories WHERE id=$1`, repo).Scan(&owner))
	moveRepositoryForTest(t, pool, repo, nil, &org)
	t.Cleanup(func() {
		moveRepositoryForTest(t, pool, repo, &owner, nil)
		_, _ = pool.Exec(context.Background(), `DELETE FROM organizations WHERE id=$1`, org)
	})

	err = service.ReconcileFactoryRules(ctx, repo, strings.Repeat("b", 40), projection)
	require.ErrorIs(t, err, ErrFactoryNeedsOwner)
	retired, err := q.ListRepositoryJobRegistrations(ctx, repo)
	require.NoError(t, err)
	for _, row := range retired {
		require.False(t, row.Enabled, row.Job)
	}
	require.NoError(t, service.ReconcileFactoryRules(ctx, repo, strings.Repeat("c", 40), FactoryProjection{}), "no declared rules is nothing to report")
}

func TestFactoryReconcileUsesConfiguredOrganizationOwner(t *testing.T) {
	pool, q, service, gateway, input := repositoryJobFixture(t)
	ctx := context.Background()
	repo := gateway.target.RepositoryID
	owner := gateway.target.UserID
	var org int64
	name := "factory-org-" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO organizations (name, lower_name, description, factory_owner_id) VALUES ($1, $1, '', $2) RETURNING id`, name, owner).Scan(&org))
	_, err := pool.Exec(ctx, `INSERT INTO org_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')`, org, owner)
	require.NoError(t, err)
	moveRepositoryForTest(t, pool, repo, nil, &org)
	t.Cleanup(func() {
		moveRepositoryForTest(t, pool, repo, &owner, nil)
		_, _ = pool.Exec(context.Background(), `DELETE FROM organizations WHERE id=$1`, org)
	})

	require.NoError(t, service.ReconcileFactoryRules(ctx, repo, strings.Repeat("d", 40), factoryFixture(t)))
	rows, err := q.ListRepositoryJobRegistrations(ctx, repo)
	require.NoError(t, err)
	require.Len(t, rows, 2)
	for _, row := range rows {
		require.True(t, row.Enabled, row.Job)
		require.Equal(t, owner, row.UserID, row.Job)
		require.Equal(t, input.WorkspaceID, row.WorkspaceID, row.Job)
		resolved, err := service.repositoryName(ctx, row)
		require.NoError(t, err)
		require.Equal(t, name+"/"+strings.SplitN(input.Repo, "/", 2)[1], resolved)
	}
	_, err = pool.Exec(ctx, `UPDATE organizations SET factory_owner_id=NULL WHERE id=$1`, org)
	require.NoError(t, err)
	_, err = service.repositoryName(ctx, rows[0])
	require.ErrorContains(t, err, "factory owner changed")
	_, err = pool.Exec(ctx, `UPDATE organizations SET factory_owner_id=$2 WHERE id=$1`, org, owner)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE org_members SET role='member' WHERE organization_id=$1 AND user_id=$2`, org, owner)
	require.NoError(t, err)
	var team int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO teams (organization_id, name, lower_name, permission) VALUES ($1, 'factory-write', 'factory-write', 'write') RETURNING id`, org).Scan(&team))
	_, err = pool.Exec(ctx, `INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`, team, owner)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO team_repos (team_id, repository_id) VALUES ($1, $2)`, team, repo)
	require.NoError(t, err)
	_, err = service.repositoryName(ctx, rows[0])
	require.ErrorContains(t, err, "no longer an organization owner")

	// A new configured owner uses their own workspace even when the rule names
	// and source revision already existed under the former owner.
	login := "factory-owner-" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	var nextOwner int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users (username, lower_username, email, lower_email) VALUES ($1, $1, $2, $2) RETURNING id`, login, login+"@example.invalid").Scan(&nextOwner))
	nextWorkspace := uuid.NewString()
	t.Cleanup(func() {
		cleanup := context.Background()
		_, err := pool.Exec(cleanup, `DELETE FROM repository_job_registrations WHERE repository_id=$1`, repo)
		require.NoError(t, err)
		_, err = pool.Exec(cleanup, `DELETE FROM workspaces WHERE id=$1`, nextWorkspace)
		require.NoError(t, err)
		_, err = pool.Exec(cleanup, `DELETE FROM org_members WHERE organization_id=$1 AND user_id=$2`, org, nextOwner)
		require.NoError(t, err)
		_, err = pool.Exec(cleanup, `DELETE FROM users WHERE id=$1`, nextOwner)
		require.NoError(t, err)
	})
	_, err = pool.Exec(ctx, `INSERT INTO org_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')`, org, nextOwner)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO workspaces (id, repository_id, user_id, status) VALUES ($1, $2, $3, 'running')`, nextWorkspace, repo, nextOwner)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE organizations SET factory_owner_id=$2 WHERE id=$1`, org, nextOwner)
	require.NoError(t, err)
	require.NoError(t, service.ReconcileFactoryRules(ctx, repo, strings.Repeat("f", 40), factoryFixture(t)))
	rows, err = q.ListRepositoryJobRegistrations(ctx, repo)
	require.NoError(t, err)
	require.Len(t, rows, 2)
	for _, row := range rows {
		require.True(t, row.Enabled, row.Job)
		require.Equal(t, nextOwner, row.UserID, row.Job)
		require.Equal(t, nextWorkspace, row.WorkspaceID, row.Job)
	}

	for _, unavailable := range []struct {
		name   string
		change string
	}{
		{name: "inactive", change: `UPDATE users SET is_active=FALSE WHERE id=$1`},
		{name: "login prohibited", change: `UPDATE users SET prohibit_login=TRUE WHERE id=$1`},
		{name: "deleted", change: `UPDATE users SET deleted_at=NOW() WHERE id=$1`},
	} {
		t.Run(unavailable.name, func(t *testing.T) {
			_, err := pool.Exec(ctx, `UPDATE users SET is_active=TRUE, prohibit_login=FALSE, deleted_at=NULL WHERE id=$1`, nextOwner)
			require.NoError(t, err)
			require.NoError(t, service.ReconcileFactoryRules(ctx, repo, strings.Repeat("1", 40), factoryFixture(t)))
			_, err = pool.Exec(ctx, unavailable.change, nextOwner)
			require.NoError(t, err)
			err = service.ReconcileFactoryRules(ctx, repo, strings.Repeat("2", 40), factoryFixture(t))
			require.ErrorIs(t, err, ErrFactoryNeedsOwner)
			retired, err := q.ListRepositoryJobRegistrations(ctx, repo)
			require.NoError(t, err)
			for _, row := range retired {
				require.False(t, row.Enabled, row.Job)
			}
		})
	}
}

func TestFactoryReconcileUserRepositoryKeepsItsOwner(t *testing.T) {
	_, q, service, gateway, input := repositoryJobFixture(t)
	repo := gateway.target.RepositoryID
	require.NoError(t, service.ReconcileFactoryRules(context.Background(), repo, strings.Repeat("e", 40), factoryFixture(t)))
	rows, err := q.ListRepositoryJobRegistrations(context.Background(), repo)
	require.NoError(t, err)
	require.Len(t, rows, 2)
	for _, row := range rows {
		require.True(t, row.Enabled, row.Job)
		require.Equal(t, gateway.target.UserID, row.UserID, row.Job)
		require.Equal(t, input.WorkspaceID, row.WorkspaceID, row.Job)
	}
}

func TestFactoryOwnerChangeWaitsForWorkspaceWithoutRunningPreviousOwnersWork(t *testing.T) {
	pool, q, service, gateway, input := repositoryJobFixture(t)
	ctx := context.Background()
	repo, formerOwner := gateway.target.RepositoryID, gateway.target.UserID
	orgName := "factory-org-" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	var org, nextOwner int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO organizations (name, lower_name, description, factory_owner_id) VALUES ($1, $1, '', $2) RETURNING id`, orgName, formerOwner).Scan(&org))
	_, err := pool.Exec(ctx, `INSERT INTO org_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')`, org, formerOwner)
	require.NoError(t, err)
	moveRepositoryForTest(t, pool, repo, nil, &org)
	t.Cleanup(func() {
		moveRepositoryForTest(t, pool, repo, &formerOwner, nil)
		_, _ = pool.Exec(context.Background(), `DELETE FROM repository_job_registrations WHERE repository_id=$1`, repo)
		_, _ = pool.Exec(context.Background(), `DELETE FROM org_members WHERE organization_id=$1`, org)
		_, _ = pool.Exec(context.Background(), `DELETE FROM organizations WHERE id=$1`, org)
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, nextOwner)
	})

	revision := strings.Repeat("a", 40)
	projection := factoryFixture(t)
	require.NoError(t, service.ReconcileFactoryRules(ctx, repo, revision, projection))
	before, err := q.ListRepositoryJobRegistrations(ctx, repo)
	require.NoError(t, err)
	require.Len(t, before, 2)
	var queued, paused db.RepositoryJobRegistration
	for _, row := range before {
		if row.Schedule != "" {
			queued = row
		} else {
			paused = row
		}
	}
	require.NotEmpty(t, queued.Job)
	require.NotEmpty(t, paused.Job)
	_, err = pool.Exec(ctx, `UPDATE repository_job_registrations SET next_fire_at=$2 WHERE id=$1`, queued.ID, time.Date(2020, 1, 1, 9, 0, 0, 0, time.UTC))
	require.NoError(t, err)
	require.NoError(t, q.EnqueueRepositoryJobDispatch(ctx, db.EnqueueRepositoryJobDispatchParams{
		ID: queued.ID, Revision: queued.Revision, DeliveryKey: "prior-owner-work", Source: "schedule", EventType: "schedule", Payload: json.RawMessage(`{}`), Status: "queued",
	}))
	_, err = q.PauseRepositoryJob(ctx, db.PauseRepositoryJobParams{RepositoryID: repo, Job: paused.Job})
	require.NoError(t, err)

	// A normal registration must survive factory ownership changes.
	manual := input
	manual.Repo = orgName + "/" + strings.SplitN(input.Repo, "/", 2)[1]
	_, err = service.Register(ctx, "gateway", "token", "issues", manual)
	require.NoError(t, err)

	login := "factory-owner-" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users (username, lower_username, email, lower_email) VALUES ($1, $1, $2, $2) RETURNING id`, login, login+"@example.invalid").Scan(&nextOwner))
	_, err = pool.Exec(ctx, `INSERT INTO org_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')`, org, nextOwner)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE organizations SET factory_owner_id=$2 WHERE id=$1`, org, nextOwner)
	require.NoError(t, err)

	err = service.ReconcileFactoryRules(ctx, repo, revision, projection)
	require.ErrorIs(t, err, ErrFactoryNeedsWorkspace)
	noWorkspace, err := q.ListRepositoryJobRegistrations(ctx, repo)
	require.NoError(t, err)
	require.Len(t, noWorkspace, 3)
	for _, row := range noWorkspace {
		if row.Job == "issues" {
			require.True(t, row.Enabled)
			continue
		}
		require.False(t, row.Enabled, row.Job)
		require.Equal(t, formerOwner, row.UserID)
	}
	claims, err := q.ClaimRepositoryJobDispatches(ctx, 10)
	require.NoError(t, err)
	require.Empty(t, claims, "queued work from the former owner must not start")
	require.NoError(t, service.enqueueSchedules(ctx))
	dispatches, err := q.ListRepositoryJobDispatches(ctx, db.ListRepositoryJobDispatchesParams{RepositoryID: repo, Job: queued.Job})
	require.NoError(t, err)
	require.Len(t, dispatches, 1, "paused schedule must not enqueue another occurrence")
	require.ErrorIs(t, service.ReconcileFactoryRules(ctx, repo, revision, projection), ErrFactoryNeedsWorkspace,
		"the same missing workspace stays visible and retryable")
	again, err := q.ListRepositoryJobRegistrations(ctx, repo)
	require.NoError(t, err)
	require.Equal(t, noWorkspace, again, "retry must not disturb manual or intentionally paused registrations")

	workspace := uuid.NewString()
	_, err = pool.Exec(ctx, `INSERT INTO workspaces (id, repository_id, user_id, status) VALUES ($1, $2, $3, 'running')`, workspace, repo, nextOwner)
	require.NoError(t, err)
	require.NoError(t, service.ReconcileFactoryRules(ctx, repo, revision, projection), "the same revision must retry after workspace creation")
	recovered, err := q.ListRepositoryJobRegistrations(ctx, repo)
	require.NoError(t, err)
	require.Len(t, recovered, 3)
	var recoveredSchedule db.RepositoryJobRegistration
	for _, row := range recovered {
		switch row.Job {
		case "issues":
			require.True(t, row.Enabled)
			require.Equal(t, formerOwner, row.UserID)
		case paused.Job:
			require.False(t, row.Enabled, "an intentional pause survives an owner change")
		case queued.Job:
			require.True(t, row.Enabled)
			require.Equal(t, nextOwner, row.UserID)
			require.Equal(t, workspace, row.WorkspaceID)
			recoveredSchedule = row
		default:
			t.Fatalf("unexpected registration %q", row.Job)
		}
	}
	claims, err = q.ClaimRepositoryJobDispatches(ctx, 10)
	require.NoError(t, err)
	require.Empty(t, claims, "the old revision's queued work cannot run under the new owner")
	_, err = pool.Exec(ctx, `UPDATE repository_job_registrations SET next_fire_at=$2 WHERE id=$1`, recoveredSchedule.ID, time.Date(2020, 1, 2, 9, 0, 0, 0, time.UTC))
	require.NoError(t, err)
	require.NoError(t, service.enqueueSchedules(ctx))
	claims, err = q.ClaimRepositoryJobDispatches(ctx, 10)
	require.NoError(t, err)
	require.Len(t, claims, 1, "the new owner's schedule must dispatch after recovery")
	require.Equal(t, recoveredSchedule.ID, claims[0].RegistrationID)
	require.Equal(t, recoveredSchedule.Revision, claims[0].Revision)

	// A person's pause during an automatic suspension is authoritative too.
	thirdLogin := "factory-owner-" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	var thirdOwner int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users (username, lower_username, email, lower_email) VALUES ($1, $1, $2, $2) RETURNING id`, thirdLogin, thirdLogin+"@example.invalid").Scan(&thirdOwner))
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM org_members WHERE organization_id=$1 AND user_id=$2`, org, thirdOwner)
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, thirdOwner)
	})
	_, err = pool.Exec(ctx, `INSERT INTO org_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')`, org, thirdOwner)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE organizations SET factory_owner_id=$2 WHERE id=$1`, org, thirdOwner)
	require.NoError(t, err)
	require.ErrorIs(t, service.ReconcileFactoryRules(ctx, repo, revision, projection), ErrFactoryNeedsWorkspace)
	_, err = q.PauseRepositoryJob(ctx, db.PauseRepositoryJobParams{RepositoryID: repo, Job: queued.Job})
	require.NoError(t, err)
	thirdWorkspace := uuid.NewString()
	_, err = pool.Exec(ctx, `INSERT INTO workspaces (id, repository_id, user_id, status) VALUES ($1, $2, $3, 'running')`, thirdWorkspace, repo, thirdOwner)
	require.NoError(t, err)
	require.NoError(t, service.ReconcileFactoryRules(ctx, repo, revision, projection))
	afterPause, err := q.ListRepositoryJobRegistrations(ctx, repo)
	require.NoError(t, err)
	for _, row := range afterPause {
		if row.Job == queued.Job {
			require.False(t, row.Enabled, "a user pause during suspension must survive workspace recovery")
		}
	}
}

// moveRepositoryForTest changes a repository's owner through the storage
// journal the repository_storage_fence trigger requires.
func moveRepositoryForTest(t *testing.T, pool *pgxpool.Pool, repo int64, user, org *int64) {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = tx.Rollback(ctx) }()
	token := strings.ReplaceAll(uuid.NewString()+uuid.NewString(), "-", "")
	_, err = tx.Exec(ctx, `
		INSERT INTO repository_storage_operations (repository_id, operation_type, token, storage_route_key,
			source_owner, source_repo, source_user_id, source_org_id, target_owner, target_repo, target_user_id, target_org_id)
		SELECT r.id, 'move', $2, 'static', 'source', r.name, r.user_id, r.org_id, 'target', r.name, $3, $4
		FROM repositories r WHERE r.id = $1`, repo, token, user, org)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `SELECT set_config('smithers.repository_storage_operation_token', $1, TRUE)`, token)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `UPDATE repositories SET user_id=$2, org_id=$3 WHERE id=$1`, repo, user, org)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `DELETE FROM repository_storage_operations WHERE repository_id=$1`, repo)
	require.NoError(t, err)
	require.NoError(t, tx.Commit(ctx))
}

// The committed factory promises no issue-opened triage: its old
// issue.opened -> issue rule named no discovered flow, so it could never be a
// live registration (#2915). Every issue-event rule it declares names a
// discovered flow, issue-triage stays a manual flow no rule starts, and no
// registration the projection yields reacts to an opened issue.
func TestCheckedInFactoryDeclaresNoUndiscoveredIssueRule(t *testing.T) {
	t.Parallel()
	raw, err := os.ReadFile("../../../../.smithers/factory.json")
	require.NoError(t, err)
	var projection FactoryProjection
	require.NoError(t, json.Unmarshal(raw, &projection))
	discovered := map[string]bool{}
	for _, flow := range projection.Flows {
		discovered[flow.ID] = true
	}
	require.True(t, discovered["issue-triage"], "triage is still offered as a manual flow")
	for _, rule := range projection.On {
		require.NotEqual(t, "issue.opened", rule.Event, "no rule promises triage of every new issue")
		if !strings.HasPrefix(rule.Event, "issue.") {
			continue
		}
		var names []string
		var name string
		if json.Unmarshal(rule.Flow, &name) == nil {
			names = []string{name}
		} else {
			require.NoError(t, json.Unmarshal(rule.Flow, &names))
		}
		for _, name := range names {
			require.True(t, discovered[name], "%s names the undiscovered flow %s", rule.Event, name)
			require.NotEqual(t, "issue-triage", name, "triage never runs from an issue event")
		}
	}
	registrations, err := factoryRegistrations(projection, strings.Repeat("a", 40))
	require.NoError(t, err)
	for _, registration := range registrations {
		for _, event := range registration.input.Events {
			require.False(t, event.Type == "issue" && slices.Contains(event.Actions, "opened"), registration.input.FlowID)
		}
	}
	source, err := os.ReadFile("../../../../.smithers/FACTORY.ts")
	require.NoError(t, err)
	require.NotContains(t, string(source), `"issue.opened":`, "the declaration and its projection agree")
}

func TestFactoryWarnsForEveryRuleItDoesNotRegister(t *testing.T) {
	var projection FactoryProjection
	require.NoError(t, json.Unmarshal([]byte(`{"flows":[
		{"id":"prompt","kind":"mdx","capabilities":[],"flows":[],"budget":{"tokens":1,"milliseconds":1}},
		{"id":"coding","kind":"ts","capabilities":["*"],"flows":[]},
		{"id":"bare","kind":"mdx"}],
	"on":[{"event":"issue.labeled:todo","flow":"coding"},
		{"event":"issue.labeled:todo","flow":"bare"},
		{"event":"issue.opened","flow":"gone"},
		{"event":"deploy.created","flow":"prompt"},
		{"event":"issue.opened","flow":"prompt"}]}`), &projection))

	require.Equal(t, []FactoryWarning{
		{"issue.labeled:todo", "coding", "a ts flow has no declarative envelope"},
		{"issue.labeled:todo", "bare", "the flow declares no budget, capabilities or child flows"},
		{"issue.opened", "gone", "the flow is not declared"},
		{"deploy.created", "prompt", "the event is not a repository trigger"},
	}, factoryWarnings(projection), "only the registered rule is not warned about")
	require.Equal(t, "unregistered issue.labeled:todo -> coding: a ts flow has no declarative envelope; "+
		"unregistered issue.labeled:todo -> bare: the flow declares no budget, capabilities or child flows; "+
		"unregistered issue.opened -> gone: the flow is not declared; "+
		"unregistered deploy.created -> prompt: the event is not a repository trigger", factoryWarningsMessage(factoryWarnings(projection)))

	registered := FactoryProjection{Flows: projection.Flows[:1], On: projection.On[4:]}
	require.Empty(t, factoryWarnings(registered))
	require.Empty(t, factoryWarningsMessage(factoryWarnings(registered)))
}

func TestLocalFactoryOutcomeReportsUnregisteredRules(t *testing.T) {
	f := newMythicalFixture(t)
	ctx := context.Background()
	service := &MythicalService{reconcileFactory: func(context.Context, int64, string, FactoryProjection) error { return nil }}
	warned := f.commit("unregistered rule", map[string]string{gitHubMainPullFactoryPath: `{"flows":[{"id":"coding","kind":"ts","capabilities":["*"],"flows":[]}],"on":[{"event":"issue.labeled:todo","flow":"coding"}]}`})
	state, message := service.localFactoryOutcome(ctx, &mythicalRun{g: f.git, mainTip: warned})
	require.Equal(t, "reconciled", state)
	require.Equal(t, "unregistered issue.labeled:todo -> coding: a ts flow has no declarative envelope", message)
	clean := f.commit("registered rule", map[string]string{gitHubMainPullFactoryPath: `{"flows":[{"id":"assistant","kind":"mdx","capabilities":[],"flows":[],"budget":{"tokens":1,"milliseconds":1}}],"on":[{"event":"issue.opened","flow":"assistant"}]}`})
	state, message = service.localFactoryOutcome(ctx, &mythicalRun{g: f.git, mainTip: clean})
	require.Equal(t, "reconciled", state)
	require.Empty(t, message)
}

func factoryPayloadProjection(t *testing.T, rules string) FactoryProjection {
	t.Helper()
	var projection FactoryProjection
	require.NoError(t, json.Unmarshal([]byte(`{"flows":[{"id":"assistant","kind":"mdx","capabilities":["memory:read:global-team"],"flows":[],"budget":{"tokens":2400000,"milliseconds":21600000}}],"on":[`+rules+`]}`), &projection))
	return projection
}

func TestFactorySchedulePayloadRegistration(t *testing.T) {
	revision := strings.Repeat("a", 40)
	with, err := factoryRegistrations(factoryPayloadProjection(t, `{"event":"schedule:0 6 * * *","flow":"assistant","payload":{ "args": "the last day",  "n": [1, 2] }}`), revision)
	require.NoError(t, err)
	require.Len(t, with, 1)
	require.Equal(t, "0 6 * * *", with[0].input.Schedule)
	require.JSONEq(t, `{"args":"the last day","n":[1,2]}`, string(with[0].input.SchedulePayload))
	require.Equal(t, `{"args":"the last day","n":[1,2]}`, string(with[0].input.SchedulePayload), "the stored payload is compact so its digest is stable")

	// The payload is part of the registration's identity: changing it re-registers.
	changed, err := factoryRegistrations(factoryPayloadProjection(t, `{"event":"schedule:0 6 * * *","flow":"assistant","payload":{"args":"another"}}`), revision)
	require.NoError(t, err)
	require.Equal(t, with[0].job, changed[0].job)
	require.NotEqual(t, with[0].input.Digest, changed[0].input.Digest)
	same, err := factoryRegistrations(factoryPayloadProjection(t, `{"event":"schedule:0 6 * * *","flow":"assistant","payload":{"args":"the last day","n":[1,2]}}`), revision)
	require.NoError(t, err)
	require.Equal(t, with[0].input.Digest, same[0].input.Digest)

	// An empty object is a payload; a rule without one keeps the schedule's own event.
	empty, err := factoryRegistrations(factoryPayloadProjection(t, `{"event":"schedule:0 6 * * *","flow":"assistant","payload":{}}`), revision)
	require.NoError(t, err)
	require.JSONEq(t, `{}`, string(empty[0].input.SchedulePayload))
	none, err := factoryRegistrations(factoryPayloadProjection(t, `{"event":"schedule:0 6 * * *","flow":"assistant"}`), revision)
	require.NoError(t, err)
	require.Empty(t, none[0].input.SchedulePayload)

	for name, rule := range map[string]string{
		"an event rule":  `{"event":"issue.opened","flow":"assistant","payload":{"a":1}}`,
		"a string":       `{"event":"schedule:0 6 * * *","flow":"assistant","payload":"x"}`,
		"an array":       `{"event":"schedule:0 6 * * *","flow":"assistant","payload":[1]}`,
		"a number":       `{"event":"schedule:0 6 * * *","flow":"assistant","payload":3}`,
		"null":           `{"event":"schedule:0 6 * * *","flow":"assistant","payload":null}`,
		"an event named": `{"event":"manual","flow":"assistant","payload":{}}`,
	} {
		_, err := factoryRegistrations(factoryPayloadProjection(t, rule), revision)
		require.Error(t, err, name)
		require.ErrorContains(t, err, "payload", name)
	}
}

func TestRepositoryJobLaunchPayloadCarriesTheSchedulePayload(t *testing.T) {
	registration := db.RepositoryJobRegistration{ID: "reg", Job: "flow:factory-abc", Revision: 3, Digest: strings.Repeat("d", 64)}
	scheduled := db.RepositoryJobDispatch{ID: "dispatch", Source: "schedule", EventType: "schedule", Payload: json.RawMessage(`{"scheduledAt":"2026-09-30T06:00:00Z"}`)}
	config := RegisterRepositoryJobInput{FactoryRevision: strings.Repeat("a", 40), FlowID: "notes/traction", Input: json.RawMessage(`{}`)}

	// Without a declared payload the run starts with the schedule's own event.
	launch, err := repositoryJobLaunchPayload(registration, scheduled, config, "owner/repo")
	require.NoError(t, err)
	var legacy struct {
		Args  string
		Event struct{ Type string }
	}
	require.NoError(t, json.Unmarshal(launch, &legacy))
	require.JSONEq(t, string(scheduled.Payload), legacy.Args)
	require.Equal(t, "schedule", legacy.Event.Type)

	// With one, the flow's payload is exactly that object: nothing wrapped, nothing added.
	config.SchedulePayload = json.RawMessage(`{"note":"Traction.md","npmPackage":"@smthrs/cli"}`)
	launch, err = repositoryJobLaunchPayload(registration, scheduled, config, "owner/repo")
	require.NoError(t, err)
	require.JSONEq(t, `{"note":"Traction.md","npmPackage":"@smthrs/cli"}`, string(launch))

	// Only a schedule dispatch takes it: an event that reaches the same registration keeps its event.
	event := db.RepositoryJobDispatch{ID: "other", Source: "github", EventType: "issues", EventAction: "opened", Payload: json.RawMessage(`{}`)}
	launch, err = repositoryJobLaunchPayload(registration, event, config, "owner/repo")
	require.NoError(t, err)
	require.Contains(t, string(launch), `"event"`)
}

func TestFactorySchedulePayloadArrivesAtTheFlowPostgres(t *testing.T) {
	pool, q, service, gateway, _ := repositoryJobFixture(t)
	ctx := context.Background()
	repo := gateway.target.RepositoryID
	revision := strings.Repeat("a", 40)
	payload := `{"args":"summarize the last day"}`
	projection := factoryPayloadProjection(t, `{"event":"schedule:0 6 * * *","flow":"assistant","payload":`+payload+`}`)
	require.NoError(t, service.ReconcileFactoryRules(ctx, repo, revision, projection))
	registrations, err := q.ListRepositoryJobRegistrations(ctx, repo)
	require.NoError(t, err)
	require.Len(t, registrations, 1)
	_, err = pool.Exec(ctx, `UPDATE repository_job_registrations SET next_fire_at=$2 WHERE id=$1`, registrations[0].ID, time.Date(2020, 1, 1, 6, 0, 0, 0, time.UTC))
	require.NoError(t, err)

	// The schedule fires and the flow is admitted with the declared payload as its input.
	require.NoError(t, service.enqueueSchedules(ctx))
	repositoryJobPoll(t, service, gateway)
	require.Len(t, gateway.inputs, 1)
	require.JSONEq(t, payload, string(gateway.inputs[0]))
	dispatches, err := q.ListRepositoryJobDispatches(ctx, db.ListRepositoryJobDispatchesParams{RepositoryID: repo, Job: registrations[0].Job})
	require.NoError(t, err)
	require.Len(t, dispatches, 1)
	require.Equal(t, "schedule", dispatches[0].Source)

	// Editing the payload on main re-registers the rule, and the next firing carries the new one.
	next := factoryPayloadProjection(t, `{"event":"schedule:0 6 * * *","flow":"assistant","payload":{"args":"the last week"}}`)
	require.NoError(t, service.ReconcileFactoryRules(ctx, repo, strings.Repeat("b", 40), next))
	_, err = pool.Exec(ctx, `UPDATE repository_job_registrations SET next_fire_at=$2 WHERE id=$1`, registrations[0].ID, time.Date(2020, 1, 2, 6, 0, 0, 0, time.UTC))
	require.NoError(t, err)
	require.NoError(t, service.enqueueSchedules(ctx))
	repositoryJobPoll(t, service, gateway)
	require.Len(t, gateway.inputs, 2)
	require.JSONEq(t, `{"args":"the last week"}`, string(gateway.inputs[1]))
}

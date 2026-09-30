package services

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// A write reloads exactly the sandboxes created from the repository's
// policy whose proxy may be running: running workspaces and the VMs of its
// agent sessions' live tasks. Suspended, deleted, and other repositories'
// workspaces, CI tasks, and finished agent tasks are left alone; a resumed
// workspace reads the stored list instead.
func TestRepositoryEgressPolicyReloadsOnlyTheRepositorysLiveSandboxesPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "owner", LowerUsername: "owner", DisplayName: "Owner"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	other, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "other", LowerName: "other", DefaultBookmark: "main"})
	require.NoError(t, err)

	workspace := func(repositoryID int64, status, vmID string, deleted bool) {
		t.Helper()
		id := uuid.NewString()
		_, err := pool.Exec(ctx, `INSERT INTO workspaces (id, name, repository_id, user_id, status, vm_id, deleted_at)
			VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7 THEN now() END)`, id, "w-"+id, repositoryID, owner.ID, status, vmID, deleted)
		require.NoError(t, err)
	}
	workspace(repo.ID, "running", "vm-workspace", false)
	workspace(repo.ID, "running", "", false)
	workspace(repo.ID, "suspended", "vm-suspended", false)
	workspace(repo.ID, "running", "vm-deleted", true)
	workspace(other.ID, "running", "vm-other-repo", false)

	var definitionID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workflow_definitions (repository_id, name, path, config) VALUES ($1, 'agent', '.smithers/agent.ts', '{}') RETURNING id`, repo.ID).Scan(&definitionID))
	task := func(agent bool, status, vmID string) {
		t.Helper()
		var runID, stepID int64
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workflow_runs (repository_id, workflow_definition_id, status, trigger_event) VALUES ($1, $2, 'running', 'agent') RETURNING id`, repo.ID, definitionID).Scan(&runID))
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workflow_steps (workflow_run_id, repository_id, name, position, status) VALUES ($1, $2, 'agent', 0, 'running') RETURNING id`, runID, repo.ID).Scan(&stepID))
		_, err := pool.Exec(ctx, `INSERT INTO workflow_tasks (workflow_run_id, workflow_step_id, repository_id, status, payload, vm_id) VALUES ($1, $2, $3, $4, '{}', NULLIF($5, ''))`, runID, stepID, repo.ID, status, vmID)
		require.NoError(t, err)
		if agent {
			_, err = pool.Exec(ctx, `INSERT INTO agent_sessions (id, repository_id, user_id, workflow_run_id, status) VALUES ($1, $2, $3, $4, 'active')`, uuid.NewString(), repo.ID, owner.ID, runID)
			require.NoError(t, err)
		}
	}
	task(true, "running", "vm-agent")
	task(true, "assigned", "vm-agent-assigned")
	task(true, "done", "vm-agent-done")
	task(true, "running", "")
	task(false, "running", "vm-ci")

	live, err := q.ListRepositoryLiveSandboxIDs(ctx, repo.ID)
	require.NoError(t, err)
	assert.Equal(t, []string{"vm-agent", "vm-agent-assigned", "vm-workspace"}, live)

	reloader := &egressReloaderFake{calls: map[string][]string{}}
	service := NewRepositoryEgressPolicyService(q, reloader)
	update, err := service.Put(ctx, &owner, repo.ID, []string{"registry.example.com"})
	require.NoError(t, err)
	assert.Equal(t, []RepositoryEgressReload{
		{SandboxID: "vm-agent", Reloaded: true},
		{SandboxID: "vm-agent-assigned", Reloaded: true},
		{SandboxID: "vm-workspace", Reloaded: true},
	}, update.Reloads)
	assert.Len(t, reloader.calls, 3)

	// The stored list is what a created or resumed sandbox renders.
	domains, err := service.AllowDomains(ctx, repo.ID)
	require.NoError(t, err)
	assert.Equal(t, []string{"registry.example.com"}, domains)
	domains, err = service.AllowDomains(ctx, other.ID)
	require.NoError(t, err)
	assert.Nil(t, domains)

	// A second write replaces the list and its author.
	update, err = service.Put(ctx, nil, repo.ID, []string{"b.example", "a.example"})
	require.NoError(t, err)
	stored, err := q.GetRepositoryEgressPolicy(ctx, repo.ID)
	require.NoError(t, err)
	assert.Equal(t, []string{"a.example", "b.example"}, stored.AllowDomains)
	assert.False(t, stored.UpdatedBy.Valid)
	assert.Equal(t, stored.UpdatedAt, *update.UpdatedAt)

	// The policy goes with its repository.
	_, err = pool.Exec(ctx, `DELETE FROM repository_egress_policies WHERE repository_id = $1`, repo.ID)
	require.NoError(t, err)
	policy, err := service.Get(ctx, repo.ID)
	require.NoError(t, err)
	assert.Equal(t, []string{}, policy.AllowDomains)
}

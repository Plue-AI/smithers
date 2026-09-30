package services

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
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
	service := NewRepositoryEgressPolicyService(NewPostgresRepositoryEgressPolicyStore(pool), reloader)
	update, err := service.Patch(ctx, &owner, repo.ID, []string{"registry.example.com"}, nil)
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

	// A second write adds to the list, removes from it, and records its author.
	update, err = service.Patch(ctx, nil, repo.ID, []string{"b.example", "a.example", "B.example"}, []string{"registry.example.com"})
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

// Overlapping writers never lose each other's change (#3263): an allow and a
// deny that race both apply, many concurrent allows all land, and every
// running sandbox's last reload carries the final stored list because the
// write lock orders the reloads with the writes.
func TestRepositoryEgressPolicyOverlappingWritersKeepEveryChangePostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "owner", LowerUsername: "owner", DisplayName: "Owner"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO workspaces (id, name, repository_id, user_id, status, vm_id) VALUES ($1, 'w', $2, $3, 'running', 'vm-live')`, uuid.NewString(), repo.ID, owner.ID)
	require.NoError(t, err)
	reloader := &egressReloadRecorder{}
	service := NewRepositoryEgressPolicyService(NewPostgresRepositoryEgressPolicyStore(pool), reloader)
	_, err = service.Patch(ctx, &owner, repo.ID, []string{"b.example"}, nil)
	require.NoError(t, err)

	// The allow reads-and-writes while the deny is mid-flight: with a
	// read-modify-write client one of them would undo the other.
	for round := 0; round < 20; round++ {
		start := make(chan struct{})
		var wg sync.WaitGroup
		errs := make([]error, 2)
		for index, patch := range [][2][]string{{{"a.example"}, nil}, {nil, {"b.example"}}} {
			wg.Add(1)
			go func(index int, add, remove []string) {
				defer wg.Done()
				<-start
				_, errs[index] = service.Patch(ctx, &owner, repo.ID, add, remove)
			}(index, patch[0], patch[1])
		}
		close(start)
		wg.Wait()
		require.NoError(t, errs[0])
		require.NoError(t, errs[1])
		stored, err := q.GetRepositoryEgressPolicy(ctx, repo.ID)
		require.NoError(t, err)
		require.Equal(t, []string{"a.example"}, stored.AllowDomains, "round %d lost a change", round)
		require.Equal(t, stored.AllowDomains, reloader.last("vm-live"), "round %d left the running proxy on a stale list", round)
		// Reset for the next round.
		_, err = service.Patch(ctx, &owner, repo.ID, []string{"b.example"}, []string{"a.example"})
		require.NoError(t, err)
	}

	// Many writers at once: every allow lands, every deny of its own host holds.
	hosts := make([]string, 16)
	var wg sync.WaitGroup
	for i := range hosts {
		hosts[i] = fmt.Sprintf("h%02d.example", i)
		wg.Add(1)
		go func(host string) {
			defer wg.Done()
			_, err := service.Patch(ctx, &owner, repo.ID, []string{host}, nil)
			assert.NoError(t, err)
		}(hosts[i])
	}
	wg.Wait()
	for i := 0; i < len(hosts); i += 2 {
		wg.Add(1)
		go func(host string) {
			defer wg.Done()
			_, err := service.Patch(ctx, &owner, repo.ID, nil, []string{host})
			assert.NoError(t, err)
		}(hosts[i])
	}
	wg.Wait()
	want := []string{"b.example"}
	for i := 1; i < len(hosts); i += 2 {
		want = append(want, hosts[i])
	}
	sort.Strings(want)
	stored, err := q.GetRepositoryEgressPolicy(ctx, repo.ID)
	require.NoError(t, err)
	assert.Equal(t, want, stored.AllowDomains)
	assert.Equal(t, want, reloader.last("vm-live"))

	// A write that would pass the limit writes nothing.
	fill := make([]string, 0, maxRepositoryEgressDomains-len(want))
	for i := 0; len(want)+len(fill) < maxRepositoryEgressDomains; i++ {
		fill = append(fill, fmt.Sprintf("fill%03d.example", i))
	}
	_, err = service.Patch(ctx, &owner, repo.ID, fill, nil)
	require.NoError(t, err)
	_, err = service.Patch(ctx, &owner, repo.ID, []string{"one-more.example"}, nil)
	require.ErrorContains(t, err, "too many egress domains")
	stored, err = q.GetRepositoryEgressPolicy(ctx, repo.ID)
	require.NoError(t, err)
	assert.Len(t, stored.AllowDomains, maxRepositoryEgressDomains)
	assert.NotContains(t, stored.AllowDomains, "one-more.example")

	// The lock is released after every write, including a refused one: a
	// fresh connection can take it at once.
	lockCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var locked bool
	require.NoError(t, pool.QueryRow(lockCtx, "SELECT pg_try_advisory_lock("+repositoryEgressWriteLockKey+")", repo.ID).Scan(&locked))
	assert.True(t, locked)
}

// egressReloadRecorder records every reload in arrival order, holding each
// one briefly so overlapping writers would interleave their reloads.
type egressReloadRecorder struct {
	mu    sync.Mutex
	calls map[string][][]string
}

func (r *egressReloadRecorder) ReloadEgress(_ context.Context, sandboxID string, req sandbox.EgressReloadRequest) (sandbox.EgressReloadResult, error) {
	time.Sleep(2 * time.Millisecond)
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.calls == nil {
		r.calls = map[string][][]string{}
	}
	r.calls[sandboxID] = append(r.calls[sandboxID], req.ExtraAllowDomains)
	return sandbox.EgressReloadResult{SandboxID: sandboxID, AllowDomains: req.ExtraAllowDomains}, nil
}

func (r *egressReloadRecorder) last(sandboxID string) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	calls := r.calls[sandboxID]
	if len(calls) == 0 {
		return nil
	}
	return calls[len(calls)-1]
}

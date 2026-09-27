package flowhost

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

type testCodec struct{}

func (testCodec) EncryptString(value string) (string, error) { return "encrypted:" + value, nil }
func (testCodec) DecryptString(value string) (string, error) {
	if !strings.HasPrefix(value, "encrypted:") {
		return "", errors.New("invalid ciphertext")
	}
	return strings.TrimPrefix(value, "encrypted:"), nil
}

type stopFunc func(context.Context, Binding) error

func (f stopFunc) StopFlowHost(ctx context.Context, b Binding) error { return f(ctx, b) }

func hostTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, _ := postgresfixture.NewProductDatabase(t)
	return pool
}
func hostFixture(t *testing.T, pool *pgxpool.Pool) (Authority, Catalog) {
	t.Helper()
	ctx := context.Background()
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")
	var user, repo int64
	err := pool.QueryRow(ctx, `INSERT INTO users(username,lower_username,email,lower_email) VALUES($1,$1,$2,$2) RETURNING id`, "u"+suffix, suffix+"@example.invalid").Scan(&user)
	require.NoError(t, err)
	err = pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,$2,$2) RETURNING id`, user, "r"+suffix).Scan(&repo)
	require.NoError(t, err)
	workspace := uuid.NewString()
	_, err = pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id) VALUES($1,$2,$3)`, workspace, repo, user)
	require.NoError(t, err)
	return Authority{Target: flowruntime.Target{TenantID: "repo:" + suffix, PrincipalID: "user:" + suffix, BindingKind: "agent-session", BindingID: uuid.NewString()}, RepositoryID: repo, UserID: user, WorkspaceID: workspace, CatalogKey: CatalogCoding, SourceRevision: strings.Repeat("a", 40)}, Catalog{Key: CatalogCoding, Family: CatalogCoding, Executable: "/opt/smithers/coding", ArtifactDigest: strings.Repeat("b", 64), ServiceName: "coding"}
}

func TestPostgresReadLeaseNeverCreatesBindingOrCredential(t *testing.T) {
	pool := hostTestPool(t)
	ctx := context.Background()
	authority, catalog := hostFixture(t, pool)
	store, err := NewStore(pool, testCodec{})
	require.NoError(t, err)
	created := 0
	store.newCredential = func() (string, error) { created++; return "private-test-credential", nil }
	_, err = store.AcquireExisting(ctx, authority, catalog)
	require.ErrorIs(t, err, ErrHostNotRunning)
	require.Zero(t, created)
	var rows int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM flow_runtime_host_bindings`).Scan(&rows))
	require.Zero(t, rows)
	written, err := store.Acquire(ctx, authority, catalog)
	require.NoError(t, err)
	before := written.Binding()
	require.NoError(t, written.Close())
	read, err := store.AcquireExisting(ctx, authority, catalog)
	require.NoError(t, err)
	require.Equal(t, before, read.Binding())
	require.NoError(t, read.Close())
	require.Equal(t, 1, created)
}

func TestPostgresHostBindingConcurrencyAuthorityAndRestart(t *testing.T) {
	pool := hostTestPool(t)
	ctx := context.Background()
	authority, catalog := hostFixture(t, pool)
	store, err := NewStore(pool, testCodec{})
	require.NoError(t, err)
	first, err := store.Acquire(ctx, authority, catalog)
	require.NoError(t, err)
	require.NotEmpty(t, first.Credential())
	id, bearer := first.Binding().ID, first.Credential()
	// A second session must wait for the same host lease, not a different lock.
	another := authority
	another.Target.BindingID = uuid.NewString()
	blocked, cancel := context.WithTimeout(ctx, 70*time.Millisecond)
	_, err = store.Acquire(blocked, another, catalog)
	cancel()
	require.ErrorIs(t, err, context.DeadlineExceeded)
	_, err = first.PrepareStart(ctx, false)
	require.NoError(t, err)
	require.NoError(t, first.MarkRunning(ctx))
	require.NoError(t, first.Close())
	restarted, err := NewStore(pool, testCodec{})
	require.NoError(t, err)
	another.SourceRevision = "" // reconnect uses the pinned revision, not a new HEAD.
	var wg sync.WaitGroup
	failures := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			held, err := restarted.Acquire(ctx, another, catalog)
			if err != nil {
				failures <- err
				return
			}
			defer held.Close()
			if held.Binding().ID != id || held.Credential() != bearer || held.Binding().SourceRevision != authority.SourceRevision {
				failures <- errors.New("host identity changed across session/restart")
			}
		}()
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		require.NoError(t, err)
	}
	held, err := restarted.Acquire(ctx, another, catalog)
	require.NoError(t, err)
	replacement, err := held.PrepareStart(ctx, true)
	require.NoError(t, err)
	require.EqualValues(t, 2, replacement.OwnerGeneration)
	require.NoError(t, held.Close())
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM flow_runtime_host_bindings`).Scan(&count))
	require.Equal(t, 1, count)
	foreign := another
	foreign.Target.PrincipalID = "other-principal"
	_, err = store.Acquire(ctx, foreign, catalog)
	require.Error(t, err)
	foreign = another
	foreign.UserID++
	_, err = store.Acquire(ctx, foreign, catalog)
	require.Error(t, err)
	// A new source revision is a planned owner replacement, not a conflict.
	changed := another
	changed.SourceRevision = strings.Repeat("c", 40)
	drifted, err := store.Acquire(ctx, changed, catalog)
	require.NoError(t, err)
	_, superseded := drifted.Supersedes()
	require.True(t, superseded)
	require.NoError(t, drifted.Close())
}

func TestPostgresHostBindingRebindsOnIdentityDrift(t *testing.T) {
	pool := hostTestPool(t)
	ctx := context.Background()
	authority, catalog := hostFixture(t, pool)
	store, err := NewStore(pool, testCodec{})
	require.NoError(t, err)
	first, err := store.Acquire(ctx, authority, catalog)
	require.NoError(t, err)
	_, superseded := first.Supersedes()
	require.False(t, superseded)
	_, err = first.PrepareStart(ctx, false)
	require.NoError(t, err)
	require.NoError(t, first.MarkRunning(ctx))
	original, bearer := first.Binding(), first.Credential()
	require.NoError(t, first.Close())

	// A host-bundle upgrade: the catalog digest changes; reconnect omits the revision.
	reconnect := authority
	reconnect.SourceRevision = ""
	upgraded := catalog
	upgraded.ArtifactDigest = strings.Repeat("c", 64)
	held, err := store.Acquire(ctx, reconnect, upgraded)
	require.NoError(t, err)
	old, superseded := held.Supersedes()
	require.True(t, superseded)
	require.Equal(t, original, old)
	require.Equal(t, original, held.Binding(), "the lease hands out the old owner until Rebind")
	rebound, err := held.Rebind(ctx)
	require.NoError(t, err)
	require.Equal(t, original.ID, rebound.ID)
	require.EqualValues(t, 2, rebound.OwnerGeneration)
	require.Equal(t, "pending", rebound.State)
	require.Equal(t, upgraded.ArtifactDigest, rebound.RuntimeArtifactDigest)
	require.Equal(t, authority.SourceRevision, rebound.SourceRevision, "an empty authority revision keeps the pinned one")
	require.Equal(t, bearer, held.Credential())
	_, superseded = held.Supersedes()
	require.False(t, superseded)
	require.NoError(t, held.Close())

	reloaded, err := store.Acquire(ctx, reconnect, upgraded)
	require.NoError(t, err)
	_, superseded = reloaded.Supersedes()
	require.False(t, superseded)
	require.Equal(t, rebound, reloaded.Binding())
	require.Equal(t, bearer, reloaded.Credential())
	require.NoError(t, reloaded.Close())

	// A repository job re-registered on a new revision plus a renamed service.
	job := authority
	job.SourceRevision = strings.Repeat("d", 40)
	renamed := upgraded
	renamed.ServiceName = "coding-v2"
	held, err = store.Acquire(ctx, job, renamed)
	require.NoError(t, err)
	rebound, err = held.Rebind(ctx)
	require.NoError(t, err)
	require.EqualValues(t, 3, rebound.OwnerGeneration)
	require.Equal(t, job.SourceRevision, rebound.SourceRevision)
	require.Equal(t, "coding-v2", rebound.ServiceName)
	require.NoError(t, held.Close())

	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM flow_runtime_host_bindings`).Scan(&count))
	require.Equal(t, 1, count)

	// Authority is still immutable: another user never rebinds the row.
	foreign := job
	foreign.UserID++
	_, err = store.Acquire(ctx, foreign, renamed)
	require.Error(t, err)
}

func TestPostgresHostRebindFencesSupersededOwner(t *testing.T) {
	pool := hostTestPool(t)
	ctx := context.Background()
	authority, catalog := hostFixture(t, pool)
	store, err := NewStore(pool, testCodec{})
	require.NoError(t, err)
	first, err := store.Acquire(ctx, authority, catalog)
	require.NoError(t, err)
	_, err = first.PrepareStart(ctx, false)
	require.NoError(t, err)
	require.NoError(t, first.MarkRunning(ctx))
	require.NoError(t, first.Close())

	upgraded := catalog
	upgraded.ArtifactDigest = strings.Repeat("c", 64)
	held, err := store.Acquire(ctx, authority, upgraded)
	require.NoError(t, err)
	superseded := held.(*lease)
	// Another replica rebinds first (simulated by a direct generation bump).
	_, err = pool.Exec(ctx, `UPDATE flow_runtime_host_bindings SET owner_generation=owner_generation+1 WHERE id=$1`, superseded.binding.ID)
	require.NoError(t, err)
	_, err = held.Rebind(ctx)
	require.Error(t, err, "a rebind from a stale generation must lose its fence")
	require.Error(t, held.MarkRunning(ctx), "the superseded generation can no longer checkpoint")
	require.NoError(t, held.Close())
}

func TestPostgresHostRetirementSurvivesDeleteAndStopFailure(t *testing.T) {
	pool := hostTestPool(t)
	ctx := context.Background()
	store, err := NewStore(pool, testCodec{})
	require.NoError(t, err)
	for _, mode := range []string{"soft", "hard", "repository", "user"} {
		t.Run(mode, func(t *testing.T) {
			authority, catalog := hostFixture(t, pool)
			if mode == "user" {
				name := "member" + strings.ReplaceAll(uuid.NewString(), "-", "")
				require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username,email,lower_email) VALUES($1,$1,$2,$2) RETURNING id`, name, name+"@example.invalid").Scan(&authority.UserID))
				_, err = pool.Exec(ctx, `UPDATE workspaces SET user_id=$2 WHERE id=$1`, authority.WorkspaceID, authority.UserID)
				require.NoError(t, err)
			}
			held, err := store.Acquire(ctx, authority, catalog)
			require.NoError(t, err)
			defer held.Close()
			binding := held.Binding()
			_, err = held.PrepareStart(ctx, false)
			require.NoError(t, err)
			// Leave the launch lease active while deletion commits. No resurrection is allowed.
			switch mode {
			case "soft":
				_, err = pool.Exec(ctx, `UPDATE workspaces SET deleted_at=clock_timestamp() WHERE id=$1`, authority.WorkspaceID)
			case "hard":
				_, err = pool.Exec(ctx, `DELETE FROM workspaces WHERE id=$1`, authority.WorkspaceID)
			case "repository":
				err = deleteHostTestRepository(ctx, pool, authority.RepositoryID)
			case "user":
				_, err = pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, authority.UserID)
			}
			require.NoError(t, err)
			require.Error(t, held.MarkRunning(ctx))
			require.NoError(t, held.Close())
			_, err = store.Acquire(ctx, authority, catalog)
			require.Error(t, err)
			var state string
			require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM flow_runtime_host_bindings WHERE id=$1`, binding.ID).Scan(&state))
			require.Equal(t, "retired", state)
			expected := errors.New("runtime unavailable")
			require.ErrorIs(t, store.ReconcileRetired(ctx, stopFunc(func(context.Context, Binding) error { return expected }), 10), expected)
			require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM flow_runtime_host_bindings WHERE id=$1`, binding.ID).Scan(&state))
			restarted, err := NewStore(pool, testCodec{})
			require.NoError(t, err)
			stopped := 0
			require.NoError(t, restarted.ReconcileRetired(ctx, stopFunc(func(_ context.Context, got Binding) error {
				require.Equal(t, binding.ID, got.ID)
				require.Equal(t, authority.WorkspaceID, got.WorkspaceID)
				require.Equal(t, authority.UserID, got.UserID)
				stopped++
				return nil
			}), 10))
			require.Equal(t, 1, stopped)
			require.ErrorIs(t, pool.QueryRow(ctx, `SELECT state FROM flow_runtime_host_bindings WHERE id=$1`, binding.ID).Scan(&state), pgx.ErrNoRows)
		})
	}
}

func TestPostgresHostRetirementFailureDoesNotStarveLaterBindings(t *testing.T) {
	pool := hostTestPool(t)
	ctx := context.Background()
	store, err := NewStore(pool, testCodec{})
	require.NoError(t, err)
	var bindings []Binding
	for i := 0; i < 2; i++ {
		authority, catalog := hostFixture(t, pool)
		held, err := store.Acquire(ctx, authority, catalog)
		require.NoError(t, err)
		bindings = append(bindings, held.Binding())
		require.NoError(t, held.Close())
		_, err = pool.Exec(ctx, `UPDATE workspaces SET deleted_at=clock_timestamp() WHERE id=$1`, authority.WorkspaceID)
		require.NoError(t, err)
		// Make the retry order deterministic without sleeps or clock precision assumptions.
		_, err = pool.Exec(ctx, `UPDATE flow_runtime_host_bindings SET updated_at=$2 WHERE id=$1`, bindings[i].ID,
			time.Date(2020, 1, i+1, 0, 0, 0, 0, time.UTC))
		require.NoError(t, err)
	}

	stopFailure := errors.New("old workspace unavailable")
	var attempts []string
	stopper := stopFunc(func(_ context.Context, binding Binding) error {
		attempts = append(attempts, binding.ID)
		if binding.ID == bindings[0].ID {
			return stopFailure
		}
		return nil
	})
	require.ErrorIs(t, store.ReconcileRetired(ctx, stopper, 1), stopFailure)
	var state string
	require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM flow_runtime_host_bindings WHERE id=$1`, bindings[0].ID).Scan(&state))
	require.Equal(t, "retired", state, "a failed stop must retain its cleanup record")

	require.NoError(t, store.ReconcileRetired(ctx, stopper, 1), "a failed oldest row must not monopolize the bounded pass")
	require.Equal(t, []string{bindings[0].ID, bindings[1].ID}, attempts)
	require.ErrorIs(t, pool.QueryRow(ctx, `SELECT state FROM flow_runtime_host_bindings WHERE id=$1`, bindings[1].ID).Scan(&state), pgx.ErrNoRows)
	require.NoError(t, store.ReconcileRetired(ctx, stopFunc(func(_ context.Context, binding Binding) error {
		require.Equal(t, bindings[0].ID, binding.ID, "the failed stop remains retryable")
		return nil
	}), 1))
	require.ErrorIs(t, pool.QueryRow(ctx, `SELECT state FROM flow_runtime_host_bindings WHERE id=$1`, bindings[0].ID).Scan(&state), pgx.ErrNoRows)
}

func deleteHostTestRepository(ctx context.Context, pool *pgxpool.Pool, repo int64) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	token := strings.ReplaceAll(uuid.NewString(), "-", "") + strings.ReplaceAll(uuid.NewString(), "-", "")
	_, err = tx.Exec(ctx, `INSERT INTO repository_storage_operations(repository_id,operation_type,token,storage_route_key,source_owner,source_repo,source_user_id)
 SELECT r.id,'delete',$2,'static',u.username,r.name,r.user_id FROM repositories r JOIN users u ON u.id=r.user_id WHERE r.id=$1`, repo, token)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `SELECT set_config('smithers.repository_storage_operation_token',$1,true)`, token); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM repositories WHERE id=$1`, repo); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// A read never waits out a host start: the start holds the owner lock for as
// long as the host takes to become ready (#2198).
func TestPostgresReadDuringAStartIsBusyNotBlocked(t *testing.T) {
	pool := hostTestPool(t)
	ctx := context.Background()
	authority, catalog := hostFixture(t, pool)
	store, err := NewStore(pool, testCodec{})
	require.NoError(t, err)
	starting, err := store.Acquire(ctx, authority, catalog)
	require.NoError(t, err)
	began := time.Now()
	_, err = store.AcquireExisting(ctx, authority, catalog)
	require.ErrorIs(t, err, ErrHostBusy)
	require.Less(t, time.Since(began), existingLockWait+time.Second)
	require.NoError(t, starting.Close())
	read, err := store.AcquireExisting(ctx, authority, catalog)
	require.NoError(t, err)
	require.NoError(t, read.Close())
}

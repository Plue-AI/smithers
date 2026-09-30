package services

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	productdb "github.com/smithersai/smithers/packages/backend/db/product"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/runtimebridge"
	"github.com/stretchr/testify/require"
)

type setupBlockedRuntime struct {
	flowruntime.Runtime
	entered  chan struct{}
	release  chan struct{}
	once     sync.Once
	complete atomic.Bool
	launches atomic.Int32
	input    SetupInput
}

func (r *setupBlockedRuntime) Identity(context.Context) (flowruntime.Identity, error) {
	return flowruntime.Identity{Protocol: flowruntime.Protocol, RuntimeArtifactDigest: strings.Repeat("a", 64), SourceRevision: strings.Repeat("b", 40), OwnerGeneration: 1}, nil
}
func (r *setupBlockedRuntime) Launch(ctx context.Context, input flowruntime.Launch) (flowruntime.LaunchResult, error) {
	r.launches.Add(1)
	r.once.Do(func() { close(r.entered) })
	select {
	case <-r.release:
	case <-ctx.Done():
		return flowruntime.LaunchResult{}, ctx.Err()
	}
	return flowruntime.LaunchResult{ApplicationRequestID: input.ApplicationRequestID, OwnerGeneration: input.OwnerGeneration, RuntimeArtifactDigest: input.RuntimeArtifactDigest, SourceRevision: input.SourceRevision, PlanID: "plan-setup", Receipt: flowruntime.Receipt{Tag: "Accepted", ReceiptID: "receipt-setup", RunID: "run-setup"}}, nil
}
func (r *setupBlockedRuntime) Observe(_ context.Context, runID, cursor string, _ int) (flowruntime.Observation, error) {
	status := "running"
	var output *string
	if r.complete.Load() {
		status = "completed"
		response := setupInitial(r.input)
		response.Receipt.Phase = "completed"
		response.Receipt.RunID = runID
		raw, _ := json.Marshal(response)
		text := string(raw)
		output = &text
	}
	return flowruntime.Observation{Run: flowruntime.Run{RunID: runID, FlowID: "repository/setup", Status: status, FinalOutput: output}, NextCursor: cursor, Terminal: status == "completed"}, nil
}

func TestRepositorySetupDurableAdmissionAndRuntimeCompletion(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	userID, repoID := setupTestUserAndRepo(t, pool)
	var repo string
	require.NoError(t, pool.QueryRow(ctx, `SELECT u.username||'/'||r.name FROM repositories r JOIN users u ON u.id=r.user_id WHERE r.id=$1`, repoID).Scan(&repo))
	input := setupFixtureInput(t)
	input.Repo = repo
	input.Digest = setupCandidateDigest(input, false)
	input.WorkspaceID = uuid.NewString()
	_, err := pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,status) VALUES($1,$2,$3,'running')`, input.WorkspaceID, repoID, userID)
	require.NoError(t, err)
	product := NewRepositorySetupService(pool, NewRepositoryJobService(db.New(pool), nil, pool), nil)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	runtime := &setupBlockedRuntime{entered: make(chan struct{}), release: make(chan struct{}), input: input}
	var resolutions atomic.Int32
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Projector: product, ObservationDelay: time.Millisecond, MaxObservationDelay: 5 * time.Millisecond, Resolver: flowruntime.ResolverFunc(func(ctx context.Context, target flowruntime.Target) (flowruntime.Runtime, error) {
		resolutions.Add(1)
		authority, err := product.ResolveFlowHostTarget(ctx, target)
		if err != nil {
			return nil, err
		}
		if authority.CatalogKey != "coding" {
			t.Errorf("setup selected wrong catalog %s", authority.CatalogKey)
		}
		return runtime, nil
	})})
	require.NoError(t, err)
	product.SetFlowDispatcher(dispatcher)
	first, err := product.Request(ctx, repoID, userID, input)
	require.NoError(t, err)
	require.Equal(t, "queued", first.Response.Receipt.Phase)
	require.Zero(t, resolutions.Load())
	workerCtx, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() {
		done <- dispatcher.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: "setup-test", Capacity: 1, Lease: 2 * time.Second, PollInterval: time.Millisecond, RetryDelay: time.Millisecond})
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			require.NoError(t, err)
		case <-time.After(5 * time.Second):
			t.Error("worker did not stop")
		}
	})
	select {
	case <-runtime.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not enter unresolved launch")
	}
	// The actual shared worker is blocked in launch. Duplicate HTTP intents and
	// recovery still complete through durable database state.
	bounded, stop := context.WithTimeout(ctx, time.Second)
	defer stop()
	joined, err := product.Request(bounded, repoID, userID, input)
	require.NoError(t, err)
	require.Equal(t, first.ID, joined.ID)
	require.False(t, joined.Terminal)
	read, err := product.Read(bounded, repoID, userID, repo, input.Job, input.RequestID)
	require.NoError(t, err)
	require.False(t, read.Terminal)
	before := resolutions.Load()
	recovered, err := product.Recover(bounded, repoID, userID, "owner", repo, input.Job)
	require.NoError(t, err)
	require.Equal(t, "found", recovered.Setup.State)
	require.Equal(t, before, resolutions.Load())
	changed := input
	changed.Operation = "evaluate"
	_, err = product.Request(ctx, repoID, userID, changed)
	require.Error(t, err)
	var jobsCount int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.launch'`).Scan(&jobsCount))
	require.Equal(t, 1, jobsCount)
	close(runtime.release)
	require.Eventually(t, func() bool {
		row, e := product.Read(ctx, repoID, userID, repo, input.Job, input.RequestID)
		return e == nil && !row.Terminal && row.Response.Receipt.Phase == "running"
	}, 5*time.Second, 5*time.Millisecond)
	runtime.complete.Store(true)
	require.Eventually(t, func() bool {
		row, e := product.Read(ctx, repoID, userID, repo, input.Job, input.RequestID)
		return e == nil && row.Terminal && row.Response.Receipt.Phase == "completed" && row.Response.Receipt.RunID == "run-setup"
	}, 5*time.Second, 5*time.Millisecond)
	require.EqualValues(t, 1, runtime.launches.Load())
	// The completed request survives a new service instance and no resolver runs.
	reconnected := NewRepositorySetupService(pool, product.repositoryJobs, nil)
	row, err := reconnected.Read(ctx, repoID, userID, repo, input.Job, input.RequestID)
	require.NoError(t, err)
	require.True(t, row.Terminal)
}

func TestRepositorySetupPreRunFailureRecoveryAndTerminalIsolation(t *testing.T) {
	for _, refusal := range []string{"worker404", "lostLease"} {
		t.Run(refusal, func(t *testing.T) {
			pool := newProductTestPool(t)
			ctx := context.Background()
			product := NewRepositorySetupService(pool, NewRepositoryJobService(db.New(pool), nil, pool), nil)
			store, err := jobs.NewStore(pool)
			require.NoError(t, err)
			// A real HTTP 404 must remain retryable; the raw provider body is
			// deliberately sensitive and cannot appear in the public receipt.
			host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte("worker http://private-host token=private-value"))
			}))
			defer host.Close()
			bridge, err := runtimebridge.New(runtimebridge.Config{Endpoint: host.URL, Credential: "private-value"})
			require.NoError(t, err)
			var ready atomic.Bool
			runtime := &setupBlockedRuntime{entered: make(chan struct{}), release: make(chan struct{})}
			dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Projector: product,
				ObservationDelay: time.Millisecond, MaxObservationDelay: 5 * time.Millisecond,
				Resolver: flowruntime.ResolverFunc(func(ctx context.Context, target flowruntime.Target) (flowruntime.Runtime, error) {
					if _, err := product.ResolveFlowHostTarget(ctx, target); err != nil {
						return nil, err
					}
					if ready.Load() {
						return runtime, nil
					}
					if refusal == "lostLease" {
						return nil, repositoryJobFlowFailure{code: "host_lease_lost", retryable: false}
					}
					return bridge, nil
				})})
			require.NoError(t, err)
			product.SetFlowDispatcher(dispatcher)
			request := func() SetupRecord {
				userID, repoID := setupTestUserAndRepo(t, pool)
				input := setupFixtureInput(t)
				input.RequestID = uuid.NewString()
				require.NoError(t, pool.QueryRow(ctx, `SELECT u.username||'/'||r.name FROM repositories r JOIN users u ON u.id=r.user_id WHERE r.id=$1`, repoID).Scan(&input.Repo))
				input.Digest = setupCandidateDigest(input, false)
				input.WorkspaceID = uuid.NewString()
				_, err := pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,status) VALUES($1,$2,$3,'running')`, input.WorkspaceID, repoID, userID)
				require.NoError(t, err)
				record, err := product.Request(ctx, repoID, userID, input)
				require.NoError(t, err)
				return record
			}
			blocked, other := request(), request()
			runtime.input = blocked.Input
			// Authoritative product deletion settles only this second request.
			_, err = pool.Exec(ctx, `UPDATE workspaces SET deleted_at=clock_timestamp() WHERE id=$1`, other.WorkspaceID)
			require.NoError(t, err)
			workerCtx, cancel := context.WithCancel(ctx)
			done := make(chan error, 1)
			go func() {
				done <- dispatcher.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: "setup-refusal", Capacity: 2, Lease: 2 * time.Second, PollInterval: time.Millisecond, RetryDelay: 20 * time.Millisecond})
			}()
			t.Cleanup(func() {
				cancel()
				select {
				case err := <-done:
					require.NoError(t, err)
				case <-time.After(5 * time.Second):
					t.Error("worker did not stop")
				}
			})
			read := func(record SetupRecord) SetupRecord {
				row, err := product.Read(ctx, record.RepositoryID, record.UserID, record.Input.Repo, record.Input.Job, record.Input.RequestID)
				require.NoError(t, err)
				return row
			}
			require.Eventually(t, func() bool { return read(blocked).Response.Receipt.Observation != nil }, 5*time.Second, 5*time.Millisecond)
			observed := read(blocked)
			require.False(t, observed.Terminal)
			require.Equal(t, "queued", observed.Response.Receipt.Phase)
			require.Equal(t, "Retrying", observed.Response.Receipt.Error)
			require.Equal(t, "blocked", observed.Response.Receipt.Observation.State)
			require.Equal(t, "runtime_unavailable", observed.Response.Receipt.Observation.Code)
			require.Greater(t, observed.Response.Receipt.Observation.ObservedAt, int64(0))
			raw, err := json.Marshal(observed.Response)
			require.NoError(t, err)
			for _, secret := range []string{"private-value", "private-host", "http_refused", "host_lease_lost"} {
				require.NotContains(t, string(raw), secret)
			}
			require.Equal(t, blocked.OperationID, observed.OperationID)
			require.Equal(t, blocked.WorkspaceID, observed.WorkspaceID)
			// Reload and repeated admission only observe or join the same intent.
			reloaded := NewRepositorySetupService(pool, product.repositoryJobs, nil)
			for range 3 {
				row, err := reloaded.Read(ctx, blocked.RepositoryID, blocked.UserID, blocked.Input.Repo, blocked.Input.Job, blocked.Input.RequestID)
				require.NoError(t, err)
				require.NotNil(t, row.Response.Receipt.Observation)
				recovered, err := reloaded.Recover(ctx, blocked.RepositoryID, blocked.UserID, "owner", blocked.Input.Repo, blocked.Input.Job)
				require.NoError(t, err)
				require.Equal(t, "found", recovered.Setup.State)
				require.Equal(t, blocked.Input.RequestID, recovered.Setup.Result.RequestID)
				joined, err := product.Request(ctx, blocked.RepositoryID, blocked.UserID, blocked.Input)
				require.NoError(t, err)
				require.Equal(t, blocked.ID, joined.ID)
			}
			_, err = product.Read(ctx, blocked.RepositoryID, other.UserID, blocked.Input.Repo, blocked.Input.Job, blocked.Input.RequestID)
			require.Error(t, err)
			_, err = product.Read(ctx, other.RepositoryID, blocked.UserID, blocked.Input.Repo, blocked.Input.Job, blocked.Input.RequestID)
			require.Error(t, err)
			require.Eventually(t, func() bool { return read(other).Terminal }, 5*time.Second, 5*time.Millisecond)
			failed := read(other)
			require.Equal(t, "failed", failed.Response.Receipt.Phase)
			require.Equal(t, "runtime_unrecoverable", failed.Response.Receipt.Observation.Code)
			require.Equal(t, "failed", failed.Response.Receipt.Observation.State)
			ready.Store(true)
			select {
			case <-runtime.entered:
			case <-time.After(5 * time.Second):
				t.Fatal("retry did not launch")
			}
			close(runtime.release)
			require.Eventually(t, func() bool { return read(blocked).Response.Receipt.Phase == "running" }, 5*time.Second, 5*time.Millisecond)
			require.Nil(t, read(blocked).Response.Receipt.Observation)
			runtime.complete.Store(true)
			require.Eventually(t, func() bool { return read(blocked).Terminal && read(blocked).Response.Receipt.Phase == "completed" }, 5*time.Second, 5*time.Millisecond)
			require.EqualValues(t, 1, runtime.launches.Load())
			var admitted int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE id=$1`, blocked.OperationID).Scan(&admitted))
			require.Equal(t, 1, admitted)
			require.Equal(t, blocked.WorkspaceID, read(blocked).WorkspaceID)
			require.Equal(t, "failed", read(other).Response.Receipt.Phase)
		})
	}
}

func TestRepositorySetupDeletionRemovesOnlyOwnedReceipts(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	product := NewRepositorySetupService(pool, NewRepositoryJobService(db.New(pool), nil, pool), nil)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Projector: product, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		t.Fatal("admission must not start a runtime")
		return nil, nil
	})})
	require.NoError(t, err)
	product.SetFlowDispatcher(dispatcher)
	var records []SetupRecord
	for range 2 {
		userID, repoID := setupTestUserAndRepo(t, pool)
		input := setupFixtureInput(t)
		input.RequestID = uuid.NewString()
		require.NoError(t, pool.QueryRow(ctx, `SELECT u.username||'/'||r.name FROM repositories r JOIN users u ON u.id=r.user_id WHERE r.id=$1`, repoID).Scan(&input.Repo))
		input.Digest = setupCandidateDigest(input, false)
		input.WorkspaceID = uuid.NewString()
		_, err = pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,status) VALUES($1,$2,$3,'running')`, input.WorkspaceID, repoID, userID)
		require.NoError(t, err)
		record, err := product.Request(ctx, repoID, userID, input)
		require.NoError(t, err)
		records = append(records, record)
	}
	removed, retained := records[0], records[1]
	deleteRepository := func() error {
		tx, err := pool.Begin(ctx)
		require.NoError(t, err)
		defer func() { _ = tx.Rollback(ctx) }()
		token := strings.ReplaceAll(uuid.NewString()+uuid.NewString(), "-", "")
		_, err = tx.Exec(ctx, `INSERT INTO repository_storage_operations
			(repository_id,operation_type,token,storage_route_key,source_owner,source_repo,source_user_id)
			SELECT r.id,'delete',$2,'static',u.username,r.name,r.user_id
			FROM repositories r JOIN users u ON u.id=r.user_id WHERE r.id=$1`, removed.RepositoryID, token)
		require.NoError(t, err)
		_, err = tx.Exec(ctx, `SELECT set_config('smithers.repository_storage_operation_token',$1,TRUE)`, token)
		require.NoError(t, err)
		if err = db.New(tx).DeleteRepo(ctx, removed.RepositoryID); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	// Upgrade an existing installation with setup rows, not just an empty
	// schema: the old constraint refuses deletion until migration 52 runs.
	_, err = pool.Exec(ctx, `ALTER TABLE repository_setup_requests
		DROP CONSTRAINT repository_setup_requests_repository_id_fkey,
		ADD CONSTRAINT repository_setup_requests_repository_id_fkey FOREIGN KEY(repository_id) REFERENCES repositories(id);
		DELETE FROM smithers_product_migrations WHERE version=52`)
	require.NoError(t, err)
	require.ErrorContains(t, deleteRepository(), "repository_setup_requests_repository_id_fkey")
	require.NoError(t, productdb.Apply(ctx, pool))
	require.NoError(t, deleteRepository())
	var remaining int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM repository_setup_requests WHERE id=$1`, removed.ID).Scan(&remaining))
	require.Zero(t, remaining)
	_, err = product.Read(ctx, retained.RepositoryID, retained.UserID, retained.Input.Repo, retained.Input.Job, retained.Input.RequestID)
	require.NoError(t, err)

	scope := repositoryJobFlowScope(removed.RepositoryID, removed.UserID)
	_, err = product.ResolveFlowHostTarget(ctx, flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, BindingKind: repositorySetupBinding, BindingID: removed.ID, WorkspaceID: removed.Input.WorkspaceID})
	var failure repositoryJobFlowFailure
	require.ErrorAs(t, err, &failure)
	require.Equal(t, "runtime_target_not_found", failure.FlowRuntimeCode())
	require.False(t, failure.FlowRuntimeRetryable())
	projection, err := json.Marshal(map[string]string{"kind": repositorySetupBinding, "id": removed.ID})
	require.NoError(t, err)
	require.NoError(t, product.ProjectFlowRuntime(ctx, flowdispatch.ProjectionUpdate{Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: projection}}))
}

func TestRepositorySetupProjectionRejectsForeignAndMissingCompletion(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	userID, repoID := setupTestUserAndRepo(t, pool)
	product := NewRepositorySetupService(pool, NewRepositoryJobService(db.New(pool), nil, pool), nil)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Projector: product, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		t.Fatal("projection read launched a host")
		return nil, nil
	})})
	require.NoError(t, err)
	product.SetFlowDispatcher(dispatcher)
	for _, state := range []string{"completed", "failed", "cancelled"} {
		input := setupFixtureInput(t)
		input.RequestID = state
		var repo string
		require.NoError(t, pool.QueryRow(ctx, `SELECT u.username||'/'||r.name FROM repositories r JOIN users u ON u.id=r.user_id WHERE r.id=$1`, repoID).Scan(&repo))
		input.Repo = repo
		input.Digest = setupCandidateDigest(input, false)
		record, err := product.Request(ctx, repoID, userID, input)
		require.NoError(t, err)
		scope := repositoryJobFlowScope(repoID, userID)
		projection, _ := json.Marshal(map[string]string{"kind": repositorySetupBinding, "id": record.ID})
		checkpoint := flowdispatch.RuntimeCheckpoint{Target: flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, BindingKind: repositorySetupBinding, BindingID: record.ID}, FlowID: "repository/setup", Projection: projection, RunID: "run-1", Run: &flowruntime.Run{RunID: "run-1", FlowID: "repository/setup", Status: state}}
		update := flowdispatch.ProjectionUpdate{OperationID: record.OperationID, Scope: scope, State: jobs.StateCompleted, Checkpoint: checkpoint}
		legacy := update
		legacy.State = jobs.StateWaiting
		legacy.Checkpoint.RunID, legacy.Checkpoint.Run = "", nil
		legacy.Checkpoint.FailureCode = "provider-secret"
		require.NoError(t, product.ProjectFlowRuntime(ctx, legacy))
		observed, err := product.Read(ctx, repoID, userID, repo, input.Job, input.RequestID)
		require.NoError(t, err)
		require.Equal(t, "runtime_unavailable", observed.Response.Receipt.Observation.Code)
		require.Greater(t, observed.Response.Receipt.Observation.ObservedAt, int64(0), "legacy checkpoint is observed now")
		foreign := update
		foreign.Scope.PrincipalID = "user:0"
		require.Error(t, product.ProjectFlowRuntime(ctx, foreign))
		require.NoError(t, product.ProjectFlowRuntime(ctx, update))
		saved, err := product.Read(ctx, repoID, userID, input.Repo, input.Job, input.RequestID)
		require.NoError(t, err)
		require.True(t, saved.Terminal)
		if state == "cancelled" {
			require.Equal(t, "stopped", saved.Response.Receipt.Phase)
		} else {
			require.Equal(t, "failed", saved.Response.Receipt.Phase)
		}
		if state == "completed" {
			require.NotEmpty(t, saved.ObservationError)
		}
	}
}

// Deleting a repository removes its setup requests, keeps other repositories'
// requests, and the orphaned setup job settles instead of retrying forever.
func TestRepositoryDeletionRemovesSetupRequestsAndSettlesTheirJob(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	product := NewRepositorySetupService(pool, NewRepositoryJobService(db.New(pool), nil, pool), nil)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	// The resolver runs on the worker goroutine; record, then assert after it stops.
	resolved := make(chan error, 16)
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Projector: product, Resolver: flowruntime.ResolverFunc(func(ctx context.Context, target flowruntime.Target) (flowruntime.Runtime, error) {
		_, err := product.ResolveFlowHostTarget(ctx, target)
		select {
		case resolved <- err:
		default:
		}
		return nil, err
	})})
	require.NoError(t, err)
	product.SetFlowDispatcher(dispatcher)
	request := func(userID, repoID int64) SetupRecord {
		input := setupFixtureInput(t)
		require.NoError(t, pool.QueryRow(ctx, `SELECT u.username||'/'||r.name FROM repositories r JOIN users u ON u.id=r.user_id WHERE r.id=$1`, repoID).Scan(&input.Repo))
		input.Digest = setupCandidateDigest(input, false)
		record, err := product.Request(ctx, repoID, userID, input)
		require.NoError(t, err)
		return record
	}
	userID, repoID := setupTestUserAndRepo(t, pool)
	otherUserID, otherRepoID := setupTestUserAndRepo(t, pool)
	deleted := request(userID, repoID)
	kept := request(otherUserID, otherRepoID)

	user, err := db.New(pool).GetUserByID(ctx, userID)
	require.NoError(t, err)
	var repoName string
	require.NoError(t, pool.QueryRow(ctx, `SELECT name FROM repositories WHERE id=$1`, repoID).Scan(&repoName))
	host := &preparedRepoHost{
		mockRepoHostClient: &mockRepoHostClient{finalizeDeleteRepoFn: func(context.Context, repohost.StagedDelete) error { return nil }},
		prepareDeleteFn: func(_ context.Context, owner, repo string) (repohost.StagedDelete, error) {
			return repohost.StagedDelete{BaseURL: "http://s1.test", StorageRouteKey: "static", Token: strings.Repeat("c", 64), Owner: owner, Repo: repo}, nil
		},
		executeDeleteFn: func(context.Context, repohost.StagedDelete) error { return nil },
	}
	repos := NewProductRepoServiceWithPool(db.New(pool), host, pool)
	require.NoError(t, repos.DeleteRepo(ctx, &user, user.Username, repoName))

	var remaining int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM repository_setup_requests WHERE id=$1`, deleted.ID).Scan(&remaining))
	require.Zero(t, remaining)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM repository_setup_requests WHERE id=$1 AND repository_id=$2`, kept.ID, otherRepoID).Scan(&remaining))
	require.Equal(t, 1, remaining)

	// Only the deleted repository's job is left to dispatch.
	_, err = pool.Exec(ctx, `UPDATE product_job_requests SET state='cancelled',terminal_receipt='{}' WHERE id=$1`, kept.OperationID)
	require.NoError(t, err)
	workerCtx, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() {
		done <- dispatcher.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: "setup-delete-test", Capacity: 1, Lease: 2 * time.Second, PollInterval: time.Millisecond, RetryDelay: time.Millisecond})
	}()
	var stopErr error
	var stopOnce sync.Once
	stop := func() { stopOnce.Do(func() { cancel(); stopErr = <-done }) }
	defer stop()
	require.Eventually(t, func() bool {
		var state string
		return pool.QueryRow(ctx, `SELECT state FROM product_job_requests WHERE id=$1`, deleted.OperationID).Scan(&state) == nil && state == "failed"
	}, 5*time.Second, 5*time.Millisecond)
	stop()
	require.NoError(t, stopErr)
	close(resolved)
	var resolutions int
	for err := range resolved {
		resolutions++
		require.Error(t, err, "a deleted repository's setup must not resolve a host")
	}
	require.Positive(t, resolutions)
}

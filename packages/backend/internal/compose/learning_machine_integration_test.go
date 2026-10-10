package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/process"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// The install binds its learning allocator through bindLearningMachines, the
// call main.go makes. The worker, jobs store, durable dispatcher, admission
// queue, learning target resolver and PostgreSQL are production code. The VM
// lifecycle and pinned source are test ports: this does not qualify microVM
// isolation or the guest's unprivileged user (C-SEC-02).
func TestLearningMachineComposedInstall(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "learnmachine", LowerUsername: "learnmachine"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE users SET is_active=true WHERE id=$1`, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	var repository int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'app','app') RETURNING id`, owner.ID).Scan(&repository))
	merge := strings.Repeat("a", 40)
	var item string
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,source,state,owner_id,pr_state,pr_merge_commit,checks) VALUES($1,'todo','landed',$2,'merged',$3,'{}') RETURNING id::text`, repository, owner.ID, merge).Scan(&item))
	digest := strings.Repeat("1", 64)
	_, err = q.InsertFlowVersion(ctx, repository, "learning", "flows/learning/flow.ts", merge, digest, "loaded", "", json.RawMessage(`{}`))
	require.NoError(t, err)
	_, err = q.ActivateFlowVersion(ctx, repository, "learning", digest)
	require.NoError(t, err)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	service := services.NewMythicalService(pool, nil)
	service.EnableLearningAdmission(store)
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		t.Error("admission contacted a flow runtime")
		return nil, services.ErrLearningUnavailable
	})})
	require.NoError(t, err)
	service.SetLauncher(dispatcher)
	// The confirmed merge's admission, as admitLearningInTx writes it.
	scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", repository), PrincipalID: fmt.Sprintf("user:%d", owner.ID)}
	payload, _ := json.Marshal(map[string]any{"item": item, "todo": 1, "repository": repository, "actor": owner.ID, "commit": merge})
	admission, err := store.Admit(ctx, jobs.Admission{Scope: scope, Operation: services.LearningAdmissionOperation, RequestID: "learning:" + item, Payload: payload, AuthorizationContext: json.RawMessage(`{"source":"confirmed-github-merge","class":"background"}`), EffectPolicy: jobs.EffectIdempotent, EffectKey: "learning:" + item})
	require.NoError(t, err)
	worker := func(id string) func() {
		workerCtx, cancel := context.WithCancel(ctx)
		done := make(chan error, 1)
		go func() {
			done <- store.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: id, Capacity: 1, Lease: time.Second, PollInterval: time.Millisecond, RetryDelay: time.Second, Operations: []string{services.LearningAdmissionOperation}}, service.HandleLearningAdmission)
		}()
		return func() { cancel(); require.NoError(t, <-done) }
	}
	count := func(query string, args ...any) int {
		var n int
		require.NoError(t, pool.QueryRow(ctx, query, args...).Scan(&n))
		return n
	}
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	source := &learningSourceContract{}

	t.Run("no provider: the admission parks", func(t *testing.T) {
		root, err := filepath.EvalSymlinks(t.TempDir())
		require.NoError(t, err)
		trusted, err := process.New(process.Config{Root: root, Environment: map[string]string{"PATH": os.Getenv("PATH")}})
		require.NoError(t, err)
		t.Cleanup(func() { require.NoError(t, trusted.Close()) })
		sandboxedNoQueue := struct {
			workspace.WorkspaceLifecycle
			workspace.WorkspaceSourceRevisionResolver
		}{&learningRuntimeContract{}, &learningRuntimeContract{}}
		hosted := testConfigAllFlagsOn()
		hosted.Auth.Mode = "oauth"
		for name, bind := range map[string]func() bool{
			"no runtime":           func() bool { return bindLearningMachines(service, cfg, pool, nil, source) },
			"trusted process":      func() bool { return bindLearningMachines(service, cfg, pool, trusted, source) },
			"no admission queue":   func() bool { return bindLearningMachines(service, cfg, pool, sandboxedNoQueue, source) },
			"not a single install": func() bool { return bindLearningMachines(service, hosted, pool, &learningRuntimeContract{}, source) },
		} {
			require.False(t, bind(), name)
		}
		stop := worker("learning-no-provider")
		defer stop()
		var reason string
		require.Eventually(t, func() bool {
			return pool.QueryRow(ctx, `SELECT coalesce(external_receipt->>'reason','') FROM product_job_dispatches WHERE operation_id=$1 AND status='ready' AND next_attempt_at > clock_timestamp() + interval '30 seconds'`, admission.OperationID).Scan(&reason) == nil
		}, 5*time.Second, 10*time.Millisecond)
		require.Equal(t, "learning_execution_unavailable", reason)
		time.Sleep(300 * time.Millisecond)
		require.Equal(t, 1, count(`SELECT attempt FROM product_job_dispatches WHERE operation_id=$1`, admission.OperationID), "a parked admission is not reclaimed")
		require.Zero(t, count(`SELECT count(*) FROM workspaces`))
		require.Zero(t, count(`SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.launch'`))
	})

	// One slot, held by a person: learning waits in the shared queue as
	// background and goes behind every person.
	root := t.TempDir()
	binary := filepath.Join(root, "msb")
	require.NoError(t, os.WriteFile(binary, []byte("#!/bin/sh\nif [ \"$1\" = list ]; then echo '[]'; else exit 99; fi\n"), 0700))
	queue, err := microsandbox.New(ctx, microsandbox.Config{Root: filepath.Join(root, "runtime"), Binary: binary, CPUs: 2, MemoryMiB: 8192, DiskMiB: 32768, MaxRunningVMs: 1, HostProfile: &microsandbox.HostProfile{MemoryBytes: 64 << 30, PerfCores: 8, DiskFreeBytes: 140 << 30}, SkipQualification: true})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, queue.Close()) })
	queue.SetCapacityReader(func(context.Context) (int, error) { return 1, nil })
	person := microsandbox.AdmissionProviders{Ready: func(_ context.Context, row microsandbox.AdmissionRequest) error {
		if row.Class != "person" {
			return microsandbox.ErrAdmissionNotReady
		}
		return nil
	}, FreeDisk: func(context.Context) (int64, error) { return 140 << 30, nil }}
	_, err = queue.WaitAdmission(ctx, person, "person", "held", "owner", "terminal")
	require.NoError(t, err)
	runtime := &learningRuntimeContract{queue: queue, source: source}
	source.runtime = runtime
	require.True(t, bindLearningMachines(service, cfg, pool, runtime, source))
	_, err = pool.Exec(ctx, `UPDATE product_job_dispatches SET next_attempt_at=clock_timestamp() WHERE operation_id=$1`, admission.OperationID)
	require.NoError(t, err)
	stop := worker("learning-machine")
	defer stop()
	demand := "learning:" + item
	position := func() (string, string, int) {
		for _, row := range queue.AdmissionSnapshot() {
			if row.Actor == demand {
				return row.Class, row.State, row.Position
			}
		}
		return "", "", 0
	}
	require.Eventually(t, func() bool {
		class, state, place := position()
		return class == "background" && state == "waiting" && place == 1
	}, 5*time.Second, 10*time.Millisecond)
	_, err = queue.Request("person", "next-person", "Ben", "terminal")
	require.NoError(t, err)
	_, _, place := position()
	require.Equal(t, 2, place, "a later person goes ahead of learning")
	projection := &learningMachine{pool: pool, workspace: runtime, source: source}
	require.Equal(t, 2, projection.QueuePosition(item))
	for _, invalid := range []string{"", "invalid", "00000000-0000-4000-8000-000000000001"} {
		require.Zero(t, projection.QueuePosition(invalid))
	}
	runs, err := service.LearningBackgroundRuns(ctx, repository)
	require.NoError(t, err)
	require.Len(t, runs, 1)
	require.Equal(t, "waiting", runs[0]["state"])
	require.Equal(t, "waiting for a machine #2", runs[0]["detail"])
	require.Zero(t, runtime.counts().creates, "reading a position cannot create a machine")
	queue.ConfirmAdmissionStop("held", false)
	_, err = queue.WaitAdmission(ctx, person, "person", "next-person", "Ben", "terminal")
	require.NoError(t, err)
	require.Zero(t, runtime.counts().creates, "learning cannot pass a waiting person")
	require.Zero(t, count(`SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.launch'`))
	queue.ConfirmAdmissionStop("next-person", false)

	// Granted: one machine, the pinned merge restored, one launch admitted.
	require.Eventually(t, func() bool {
		op, err := store.Get(ctx, scope, admission.OperationID)
		return err == nil && op.State == jobs.StateCompleted
	}, 10*time.Second, 10*time.Millisecond)
	require.Equal(t, learningCounts{creates: 1, restores: 1}, runtime.counts())
	require.Zero(t, projection.QueuePosition(item), "a granted run has no waiting position")
	require.Equal(t, 1, queue.InUse())
	workspaceID := learningWorkspaceID(item)
	var status, vm string
	require.NoError(t, pool.QueryRow(ctx, `SELECT status, vm_id FROM workspaces WHERE id=$1 AND repository_id=$2 AND user_id=$3`, workspaceID, repository, owner.ID).Scan(&status, &vm))
	require.Equal(t, []string{"running", workspaceID}, []string{status, vm})
	// The Flow host start seeds the machine's branch head from the row
	// (machineBranchHead); a row without the pinned merge refuses not_ready
	// three times and exhausts the start (real install run 13, Stop 1).
	var seed string
	require.NoError(t, pool.QueryRow(ctx, `SELECT COALESCE(NULLIF(head_commit_id,''),source_commit) FROM workspaces WHERE id=$1`, workspaceID).Scan(&seed))
	require.Equal(t, merge, seed, "the learning machine's branch head seed is the pinned merge")
	var launch []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT payload FROM product_job_requests WHERE operation='flow.runtime.launch' AND request_id=$1`, "learning-run:"+item).Scan(&launch))
	var saved struct {
		Target flowruntime.Target `json:"target"`
		Pin    flowruntime.Pin    `json:"pin"`
	}
	require.NoError(t, json.Unmarshal(launch, &saved))
	target := flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, WorkspaceID: workspaceID, BindingKind: "learning", BindingID: item}
	require.Equal(t, target, saved.Target)
	require.Equal(t, flowruntime.Pin{Flow: "learning", SourceCommit: merge, ExecutionDigest: digest}, saved.Pin)
	require.Equal(t, saved.Pin, source.restored)
	// The production learning resolver accepts the allocated machine.
	authority, err := service.LearningRuntime().ResolveFlowHostTarget(ctx, target)
	require.NoError(t, err)
	require.Equal(t, workspaceID, authority.WorkspaceID)
	require.Equal(t, merge, authority.SourceRevision)

	// Retirement releases the slot only after the runtime confirms deletion.
	machines := &learningMachine{pool: pool, workspace: runtime, source: source}
	wrong := target
	wrong.WorkspaceID = "another-machine"
	require.ErrorIs(t, machines.RetireLearningMachine(ctx, wrong), services.ErrLearningBinding)
	require.Equal(t, 1, queue.InUse())
	require.NoError(t, machines.RetireLearningMachine(ctx, target))
	require.Zero(t, queue.InUse())
	require.Zero(t, count(`SELECT count(*) FROM workspaces WHERE id=$1`, workspaceID))
	require.Equal(t, learningCounts{creates: 1, restores: 1, deletes: 1}, runtime.counts())
	// Retry after terminal cleanup preserves the operation, target and pin.
	var operation string
	require.NoError(t, pool.QueryRow(ctx, `SELECT id::text FROM product_job_requests WHERE request_id=$1`, "learning-run:"+item).Scan(&operation))
	_, err = pool.Exec(ctx, `UPDATE product_job_requests SET state='failed',terminal_receipt='{"error":"lint"}' WHERE id=$1`, operation)
	require.NoError(t, err)
	provider := &services.HomeBackground{Pool: pool, Billing: services.NewUnlimitedBillingPolicy()}
	service.SetHomeBackground(provider)
	receipt, err := provider.ControlLearning(ctx, repository, owner.ID, operation, "retry", "retry-after-cleanup")
	require.NoError(t, err)
	require.Equal(t, operation, receipt["run_id"])
	authority, err = service.LearningRuntime().ResolveFlowHostTarget(ctx, target)
	require.NoError(t, err)
	require.Equal(t, saved.Pin, *authority.ExecutionPin)
	require.Equal(t, learningCounts{creates: 2, restores: 2, deletes: 1}, runtime.counts())
	require.Equal(t, 1, queue.InUse())
	require.NoError(t, machines.RetireLearningMachine(ctx, target))

}

type learningCounts struct{ creates, restores, deletes int }

type learningSourceContract struct {
	runtime  *learningRuntimeContract
	restored flowruntime.Pin
}

func (*learningSourceContract) Prepare(context.Context, int64, flowruntime.Pin) error { return nil }
func (s *learningSourceContract) Restore(_ context.Context, id string, _, _ int64, pin flowruntime.Pin) error {
	s.runtime.mu.Lock()
	defer s.runtime.mu.Unlock()
	s.runtime.restores++
	s.runtime.head = pin.SourceCommit
	s.restored = pin
	return nil
}

type learningRuntimeContract struct {
	workspace.WorkspaceLifecycle
	queue  *microsandbox.Runtime
	source *learningSourceContract
	mu     sync.Mutex
	learningCounts
	id, head string
	exists   bool
}

func (*learningRuntimeContract) Isolation() workspace.IsolationLevel {
	return workspace.IsolationSandboxed
}
func (r *learningRuntimeContract) counts() learningCounts {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.learningCounts
}
func (r *learningRuntimeContract) InspectWorkspace(context.Context, string) (workspace.Workspace, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.exists {
		return workspace.Workspace{}, workspace.ErrWorkspaceNotFound
	}
	return workspace.Workspace{ID: r.id, State: workspace.WorkspaceRunning}, nil
}
func (r *learningRuntimeContract) CreateWorkspace(_ context.Context, s workspace.WorkspaceSpec) (workspace.Workspace, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.queue.BindAdmissionMachine("workspace:"+s.ID, "learning-vm"); err != nil {
		return workspace.Workspace{}, err
	}
	r.creates++
	r.id, r.exists = s.ID, true
	return workspace.Workspace{ID: s.ID, State: workspace.WorkspaceRunning}, nil
}
func (r *learningRuntimeContract) DeleteWorkspace(context.Context, string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.deletes++
	r.exists = false
	r.queue.ConfirmAdmissionStop("workspace:"+r.id, false)
	return nil
}
func (r *learningRuntimeContract) ResolveWorkspaceSourceRevision(context.Context, string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.head, nil
}
func (r *learningRuntimeContract) FreeDisk(context.Context) (int64, error) { return 140 << 30, nil }
func (r *learningRuntimeContract) WaitAdmission(ctx context.Context, p microsandbox.AdmissionProviders, class, holder, actor, reason string) (context.Context, error) {
	return r.queue.WaitAdmission(ctx, p, class, holder, actor, reason)
}
func (r *learningRuntimeContract) CancelFailedAdmission(holder, actor string) {
	r.queue.CancelFailedAdmission(holder, actor)
}
func (r *learningRuntimeContract) AdmissionSnapshot() []microsandbox.AdmissionRequest {
	return r.queue.AdmissionSnapshot()
}

package services

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// idempotentGuestController mirrors the Microsandbox controller's create
// idempotency: a key is kept with its request digest, a replay with the same
// digest returns the original guest, and a different digest is a 409.
type idempotentGuestController struct {
	mu      sync.Mutex
	digests map[string][32]byte
	vms     map[string]string
	keys    []string
	refused int
}

func (c *idempotentGuestController) create(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
	key, err := sandbox.RequestIdempotencyKey(ctx)
	if err != nil {
		return sandbox.CreateResult{}, err
	}
	body, err := json.Marshal(req)
	if err != nil {
		return sandbox.CreateResult{}, err
	}
	digest := sha256.Sum256(body)
	c.mu.Lock()
	defer c.mu.Unlock()
	c.keys = append(c.keys, key)
	if previous, ok := c.digests[key]; ok {
		if previous != digest {
			c.refused++
			return sandbox.CreateResult{}, fmt.Errorf("sandbox controller returned 409 (idempotency_conflict) for key %s", key)
		}
		return sandbox.CreateResult{ID: c.vms[key]}, nil
	}
	c.digests[key] = digest
	c.vms[key] = fmt.Sprintf("vm-%d", len(c.vms)+1)
	return sandbox.CreateResult{ID: c.vms[key]}, nil
}

func nixCIReexecutionEnv(claim workflowSandboxRunClaim) nixCIRunEnvironment {
	return nixCIRunEnvironment{
		Execution:      claim.execution(),
		RepositoryID:   100,
		Owner:          "alice",
		RepositoryName: "demo",
		CloneUserID:    9,
		Revision:       "cafebabe",
	}
}

// A task executed again after its claim was lost (a restart, a rollout, or a
// stale execution cancelled by the lease watchdog) must boot a guest: the new
// execution carries a new clone token, so reusing the first execution's keys
// would be refused for 24 hours.
func TestNixCIRun_ReexecutionAfterClaimLossCreatesAGuest(t *testing.T) {
	queries := nixCIQuerier([]db.WorkflowTask{nixCITaskRow(1, 11, "build", nil)})
	guests := &fakeNixCIGuests{
		polls:   map[string]int{},
		scripts: map[string]nixCIGuestScript{"build": {chunks: []string{"ok\n"}, exitCode: "0"}},
	}
	worker, client := newNixCIWorker(t, queries, guests)
	controller := &idempotentGuestController{digests: map[string][32]byte{}, vms: map[string]string{}}
	client.createVMFn = controller.create
	serve := client.execAwaitFn
	client.execAwaitFn = func(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
		if err := ctx.Err(); err != nil {
			return sandbox.ExecResult{}, err
		}
		return serve(ctx, vmID, req)
	}

	run := db.WorkflowRun{ID: 42, RepositoryID: 100, WorkflowDefinitionID: 5, TriggerRef: "main", TriggerCommitSha: "cafebabe"}
	first := testWorkflowSandboxRunClaim(run)
	lost, loseClaim := context.WithCancel(context.Background())
	client.createVMFn = func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
		result, err := controller.create(ctx, req)
		loseClaim() // the claim is lost once the first execution's guest exists
		return result, err
	}
	require.Error(t, worker.executeNixCIRun(lost, first, nixCIReexecutionEnv(first)), "the lost claim ends the first execution")
	require.Len(t, controller.keys, 1, "the first execution created its guest")

	client.createVMFn = controller.create
	second := first
	second.Token = "00000000-0000-4000-8000-000000000002"
	second.Generation = 2
	require.NoError(t, worker.executeNixCIRun(context.Background(), second, nixCIReexecutionEnv(second)))

	assert.Zero(t, controller.refused, "re-execution must not replay the first execution's create keys")
	require.Len(t, controller.keys, 2, "the second execution creates a guest on its first attempt")
	assert.NotEqual(t, controller.keys[0], controller.keys[1])
	require.Len(t, guests.requests, 2)
	assert.NotEqual(t, guests.requests[0].GitRepos[0].Repo, guests.requests[1].GitRepos[0].Repo,
		"each execution clones with its own credential, so the create bodies differ")
	assert.Equal(t, "done", nixCITaskStatuses(queries)[1], "the re-executed task completes in its guest")
}

// Prod 2026-09-30: a guest create failed (worker 500, then the run's context
// was cancelled), the run was claimed again, and every later create of the
// same task was refused 409 idempotency_conflict because the new execution
// sent a fresh clone token under the first execution's attempt keys. The
// re-execution must boot its guest, and each failed attempt's log line names
// the key the controller recorded so the next conflict can be traced.
func TestNixCIRun_ReexecutionAfterFailedCreateBootsWithoutConflict(t *testing.T) {
	queries := nixCIQuerier([]db.WorkflowTask{nixCITaskRow(1, 11, "go", nil)})
	guests := &fakeNixCIGuests{
		polls:   map[string]int{},
		scripts: map[string]nixCIGuestScript{"go": {chunks: []string{"ok\n"}, exitCode: "0"}},
	}
	worker, client := newNixCIWorker(t, queries, guests)
	var logs bytes.Buffer
	worker.logger = slog.New(slog.NewJSONHandler(&logs, nil))
	controller := &idempotentGuestController{digests: map[string][32]byte{}, vms: map[string]string{}}

	run := db.WorkflowRun{ID: 42, RepositoryID: 100, WorkflowDefinitionID: 5, TriggerRef: "main", TriggerCommitSha: "cafebabe"}
	first := testWorkflowSandboxRunClaim(run)
	lost, loseClaim := context.WithCancel(context.Background())
	defer loseClaim()
	client.createVMFn = func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
		// The controller records the key and digest before the worker fails.
		if _, err := controller.create(ctx, req); err != nil {
			return sandbox.CreateResult{}, err
		}
		if len(controller.keys) == 1 {
			return sandbox.CreateResult{}, &sandbox.StatusError{StatusCode: 500, ErrorCode: "worker_error", Message: "worker returned 500"}
		}
		loseClaim()
		return sandbox.CreateResult{}, context.Canceled
	}
	_ = worker.executeNixCIRun(lost, first, nixCIReexecutionEnv(first))
	require.Len(t, controller.keys, 2, "the first execution spent both provisioning attempts")

	client.createVMFn = controller.create
	second := first
	second.Token = "00000000-0000-4000-8000-000000000002"
	second.Generation = 2
	require.NoError(t, worker.executeNixCIRun(context.Background(), second, nixCIReexecutionEnv(second)))

	assert.Zero(t, controller.refused, "the re-execution must not be refused 409 idempotency_conflict")
	require.Len(t, controller.keys, 3, "the re-execution boots on its first attempt")
	assert.NotContains(t, controller.keys[:2], controller.keys[2])
	require.Len(t, guests.requests, 2)
	assert.NotEqual(t, guests.requests[0].GitRepos[0].Repo, guests.requests[1].GitRepos[0].Repo,
		"each execution carries its own clone credential, so reusing a key would conflict")
	assert.Equal(t, "done", nixCITaskStatuses(queries)[1])

	var failures []map[string]any
	for _, line := range bytes.Split(bytes.TrimSpace(logs.Bytes()), []byte("\n")) {
		var record map[string]any
		require.NoError(t, json.Unmarshal(line, &record))
		if record["msg"] == "NixOS CI guest create failed" {
			failures = append(failures, record)
		}
	}
	require.Len(t, failures, 2)
	for i, record := range failures {
		assert.Equal(t, controller.keys[i], record["idempotency_key"])
		assert.EqualValues(t, i+1, record["attempt"])
		assert.Equal(t, first.execution(), record["execution"])
	}
}

// Attempts inside one execution keep distinct keys under the execution, and
// the scheduler names the execution by its claim.
func TestNixCIRun_GuestCreateKeysNameTheClaimAndAttempt(t *testing.T) {
	queries := nixCIQuerier([]db.WorkflowTask{nixCITaskRow(1, 11, "build", nil)})
	guests := &fakeNixCIGuests{
		polls:   map[string]int{},
		scripts: map[string]nixCIGuestScript{"build": {exitCode: "0"}},
	}
	worker, client := newNixCIWorker(t, queries, guests)
	var keys []string
	client.createVMFn = func(ctx context.Context, _ sandbox.CreateRequest) (sandbox.CreateResult, error) {
		key, err := sandbox.RequestIdempotencyKey(ctx)
		require.NoError(t, err)
		keys = append(keys, key)
		if len(keys) < 2 {
			return sandbox.CreateResult{}, fmt.Errorf("controller unavailable")
		}
		return sandbox.CreateResult{ID: "vm-1"}, nil
	}

	require.NoError(t, worker.PollOnce(context.Background()))

	claim := testWorkflowSandboxRunClaim(db.WorkflowRun{ID: 42})
	expected := func(attempt int) string {
		key, err := sandbox.RequestIdempotencyKey(sandboxProvisionContext(context.Background(), "create", "workflow_task", "1", fmt.Sprintf("%s/attempt-%d", claim.execution(), attempt)))
		require.NoError(t, err)
		return key
	}
	assert.Equal(t, []string{expected(1), expected(2)}, keys)
	assert.Equal(t, "00000000-0000-4000-8000-000000000001/1", claim.execution())
	assert.Equal(t, "done", nixCITaskStatuses(queries)[1])
}

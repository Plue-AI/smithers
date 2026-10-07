package flowhost

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// Drive the production durable dispatcher into the real isolation gate after
// a retained host disappears. The launcher is a test peer: these refusals are
// Linux evidence, not a reference-host microVM kill receipt.
func TestRecoveryRequiresMachineIsolation(t *testing.T) {
	for _, isolation := range []workspaceapi.IsolationLevel{workspaceapi.IsolationTrustedProcess, "", "unknown"} {
		t.Run(string(isolation), func(t *testing.T) {
			resolver, bindings, launcher, target := testResolver(t)
			resolvedIdentity(t, resolver.ResolveFlowRuntime, target)
			launcher.running = false
			before := bindings.binding
			starts := len(launcher.starts)
			launcher.calls = nil
			launcher.isolation = isolation
			operation := dispatchRecoveryRefusal(t, resolver, target, "isolation_required")
			require.Equal(t, jobs.StateFailed, operation.State)
			require.Equal(t, before, bindings.binding)
			require.Len(t, launcher.starts, starts, "no branch command may run in a host process")
			require.Empty(t, launcher.calls)
		})
	}
}

func TestRecoveryMissingProvidersFailClosed(t *testing.T) {
	for _, provider := range []string{"launcher", "targets", "store", "catalog"} {
		t.Run(provider, func(t *testing.T) {
			resolver, bindings, launcher, target := testResolver(t)
			resolvedIdentity(t, resolver.ResolveFlowRuntime, target)
			launcher.running = false
			before := bindings.binding
			starts := len(launcher.starts)
			code := "runtime_resolver_unavailable"
			switch provider {
			case "launcher":
				resolver.launcher = nil
			case "targets":
				resolver.targets = nil
			case "store":
				resolver.store = nil
			case "catalog":
				resolver.catalogs = nil
				code = "runtime_catalog_unavailable"
			}
			dispatchRecoveryRefusal(t, resolver, target, code)
			require.Equal(t, before, bindings.binding)
			require.Len(t, launcher.starts, starts)
		})
	}
}

func dispatchRecoveryRefusal(t *testing.T, resolver *Resolver, target flowruntime.Target, code string) jobs.Operation {
	t.Helper()
	pool := hostTestPool(t)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	service, err := flowdispatch.New(flowdispatch.Config{Store: store, Resolver: resolver})
	require.NoError(t, err)
	scope := jobs.Scope{TenantID: target.TenantID, PrincipalID: target.PrincipalID}
	request := flowdispatch.LaunchRequest{Scope: scope, Target: target, RequestID: "recovery-refusal", FlowID: "coding/dispatch", Payload: json.RawMessage(`{}`), ApprovalPolicy: flowdispatch.ApprovalManual}
	receipt, err := service.Admit(context.Background(), request)
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- service.RunWorker(ctx, jobs.WorkerConfig{WorkerID: "recovery-fault", Capacity: 1, Lease: time.Second, PollInterval: time.Millisecond, RetryDelay: time.Hour})
	}()
	defer func() { cancel(); require.NoError(t, <-done) }()
	var operation jobs.Operation
	require.Eventually(t, func() bool {
		operation, err = store.Get(ctx, scope, receipt.OperationID)
		var lastError string
		queryErr := pool.QueryRow(ctx, `SELECT last_error FROM product_job_dispatches WHERE operation_id=$1`, receipt.OperationID).Scan(&lastError)
		return err == nil && (strings.Contains(string(operation.TerminalReceipt), code) || strings.Contains(string(operation.ExternalReceipt), code) || (queryErr == nil && strings.Contains(lastError, code)))
	}, 10*time.Second, 10*time.Millisecond, "refusal must be durable: %s", code)
	require.NotEqual(t, jobs.StateCompleted, operation.State)
	return operation
}

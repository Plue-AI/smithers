//go:build unix

package compose

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/flowmanifest"
	"github.com/smithersai/smithers/packages/backend/installbundle"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/testkit/faultprocess"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

func TestTodoMachineKillThroughInstall(t *testing.T) {
	if os.Getenv("SMITHERS_FAULT_HOST") != "reference" {
		t.Skip("requires reference host microVM and approved installed bundle")
	}
	bundleRoot := os.Getenv("SMITHERS_FAULT_INSTALL_BUNDLE")
	require.NotEmpty(t, bundleRoot, "reference campaign requires the approved installed bundle")
	t.Setenv("SMITHERS_CHECK_BUNDLE", bundleRoot)
	t.Setenv(pinnedMicroVMRehearsal, "1")
	t.Setenv("SMITHERS_FEATURE_FLAGS_FLOW_LOAD", "true")
	t.Setenv("TRACE_MESSAGES", "1")
	for _, point := range []string{"M1", "M2", "M3", "M4"} {
		t.Run(point, func(t *testing.T) {
			if point == "M4" {
				t.Run("crossing", runTodoMachineKeylessControl)
				return
			}
			r := newRehearsal(t, pinnedMicroVMRehearsal, "C-DUR-02", "machine-"+point+"-", 25)
			services := prepareTodoFaultServices(t, r)
			if point == "M2" {
				seedTodoFaultCheck(t, r, true)
			}
			require.True(t, r.install("Install through Machine ready"))
			t.Run("crossing", func(t *testing.T) {
				if point == "M3" {
					runTodoReconciledMachineCrossing(t, r, services)
				} else {
					runTodoHostRecordedCrossingBody(t, r, point, nil, services, nil)
				}
			})
		})
	}
}

// Reuse the approved-bundle setup rehearsal. No recording msb, process
// workspace, seeded run outcome or accepted-candidate fixture qualifies this
// control. Linux can compile it; its execution belongs to the reference Mac.
func runTodoMachineKeylessControl(t *testing.T) {
	if os.Getenv("SMITHERS_FAULT_HOST") != "reference" {
		t.Skip("reference Mac mini with approved installed bundle")
	}
	require.Equal(t, "darwin", runtime.GOOS)
	require.Equal(t, "arm64", runtime.GOARCH)
	require.NotEmpty(t, os.Getenv("SMITHERS_TEST_DATABASE_URL"))
	bundleRoot := os.Getenv("SMITHERS_FAULT_INSTALL_BUNDLE")
	require.NotEmpty(t, bundleRoot, "C-DUR-02 requires the approved installed bundle")
	bundle, err := installbundle.Open(bundleRoot)
	require.NoError(t, err)
	manifest, err := bundle.Expect("SMITHERS_FLOW_HOST_MANIFEST", "", "bin/flow-hosts.json", false)
	require.NoError(t, err)
	registry, err := flowmanifest.Load(manifest)
	require.NoError(t, err)
	msb := bundle.Program("bin/msb")
	require.NoError(t, msb.Check())
	t.Setenv("SMITHERS_REQUIRE_MICROVM_TESTS", "1")
	t.Setenv("SMITHERS_CHECK_BUNDLE", bundleRoot)
	t.Setenv("SMITHERS_MICROSANDBOX_BIN", msb.Path())
	t.Setenv("SMITHERS_FEATURE_FLAGS_FLOW_LOAD", "true")
	profile, err := microsandbox.Detect(t.TempDir())
	require.NoError(t, err)
	h := startRootLayerHarnessRuntime(t, true, rootLayerCodingFixture{bundle: bundle, registry: registry, profile: profile})
	require.Equal(t, workspaceapi.IsolationSandboxed, h.runtime.Isolation())
	h.commitMain(map[string]string{"go.mod": "module example.com/machinefault\n\ngo 1.26.8\n", "x.go": "package machinefault\n", "JOURNEY.md": "Machine recovery control\n"})
	h.runSetupThroughSource()
	state, message := h.runMachine(t, "durability-machine")
	require.Equal(t, "done", state, message)
	// Adapt only the shared browser/GitHub helpers; all workspace execution
	// remains on h.runtime, the bundle's production microVM adapter.
	r := &rehearsal{t: t, ctx: t.Context(), origin: h.origin, pool: h.pool, jar: h.jar, client: h.client,
		gitRoot: filepath.Dir(filepath.Dir(h.bare)), keyPrefix: "machine-kill-", logs: h.logs}
	marker := "/var/tmp/smithers-machine-fault-" + uuid.NewString()
	_, err = os.Lstat(marker)
	require.True(t, os.IsNotExist(err), "host canary must start absent")
	source := machineKillTodoSource(marker)
	_, d1 := activateWatchdogOverride(t, r, source)
	number, err := r.file("Recover a killed machine", "Hold at a recorded keyless crossing.")
	require.NoError(t, err)
	read := func(workspace string) (string, error) {
		result, err := h.runtime.ExecuteCommand(t.Context(), workspace, workspaceapi.Command{Args: []string{"cat", marker}})
		if err != nil {
			return "", err
		}
		if result.ExitCode != 0 {
			return "", fmt.Errorf("guest observation: %s", result.Stderr)
		}
		return result.Stdout, nil
	}
	var workspace string
	require.Eventually(t, func() bool {
		if err := h.pool.QueryRow(t.Context(), `SELECT workspace_id FROM mythical_items WHERE number=$1`, number).Scan(&workspace); err != nil || workspace == "" {
			return false
		}
		crossings, err := read(workspace)
		return err == nil && crossings == "completed\nkeyless\n"
	}, 15*time.Minute, 250*time.Millisecond, "guest never reached crossing: %s", h.logs.String())
	before, err := r.todo(number)
	require.NoError(t, err)
	require.NotNil(t, before.Run)
	require.NotNil(t, before.FlowVersion)
	require.Equal(t, d1, before.FlowVersion.Digest)
	changed := strings.Replace(source, "Machine fault D1", "Machine fault D2", 1)
	changed = strings.Replace(changed, `"completed\n"`, `"D2-completed\n"`, 1)
	_, d2 := activateWatchdogOverride(t, r, changed)
	require.NotEqual(t, d1, d2)
	faultprocess.KillMachine(t, h.runtimeState, workspace, bundleRoot)
	t.Log("CRASH-POINT M4 subject todo")
	failed, err := r.waitTodoWithin(number, time.Minute, "failed")
	require.NoError(t, err)
	require.NotNil(t, failed.FlowVersion)
	require.Equal(t, d1, failed.FlowVersion.Digest)
	card, err := r.expect("GET", fmt.Sprintf("/api/todos/%d", number), "", 200)
	require.NoError(t, err)
	var projection struct {
		Failure struct {
			Class     string `json:"class"`
			Retryable bool   `json:"retryable"`
		} `json:"failure"`
	}
	require.NoError(t, json.Unmarshal(card, &projection))
	require.Equal(t, "interrupted", projection.Failure.Class)
	require.True(t, projection.Failure.Retryable)
	// Restart the retained VM only to inspect its disk. This does not launch
	// a flow host, Retry the TODO or forge a successful recovery outcome.
	_, err = h.runtime.StartWorkspace(t.Context(), workspace)
	require.NoError(t, err)
	crossings, err := read(workspace)
	require.NoError(t, err)
	require.Equal(t, "completed\nkeyless\n", crossings)
	_, err = os.Lstat(marker)
	require.True(t, os.IsNotExist(err), "branch payload must never run on the host")
	for range 2 {
		status, receipt, err := r.keyed("POST", fmt.Sprintf("/api/todos/%d", number), `{"op":"retry"}`, "machine-kill-retry")
		require.NoError(t, err)
		require.Equal(t, 202, status, string(receipt))
	}
	var retried rehearsalTodo
	require.Eventually(t, func() bool {
		var err error
		retried, err = r.todo(number)
		if err != nil || retried.Run == nil || retried.Run.ID == before.Run.ID {
			return false
		}
		var nextWorkspace string
		if err := h.pool.QueryRow(t.Context(), `SELECT workspace_id FROM mythical_items WHERE number=$1`, number).Scan(&nextWorkspace); err != nil || nextWorkspace == "" {
			return false
		}
		crossings, err := read(nextWorkspace)
		return err == nil && crossings == "completed\nkeyless\n"
	}, 15*time.Minute, 250*time.Millisecond)
	require.Equal(t, before.Run.Attempt+1, retried.Run.Attempt)
	require.NotNil(t, retried.FlowVersion)
	require.Equal(t, d1, retried.FlowVersion.Digest)
	require.NotEmpty(t, retried.Evidence)
	preserved := false
	for _, evidence := range retried.Evidence {
		if evidence.Attempt == int32(before.Run.Attempt) && evidence.FlowDigest == d1 && evidence.SourceCommit == before.FlowVersion.SourceCommit {
			preserved = true
		}
	}
	require.True(t, preserved, "Retry must retain the original attempt's pin and source evidence")
	require.NoError(t, r.drop(number))
	t.Log(`CRASH-OBSERVATION {"point":"M4","subject":"todo","stepsReRun":0,"automaticKeylessRepeats":0,"retryAttempts":1,"hostCanaryAbsent":true}`)
}

func machineKillTodoSource(marker string) string {
	return fmt.Sprintf(`import { Action, Flow } from "@smthrs/flow"
import { Effect, Schema } from "effect"
import { appendFileSync } from "node:fs"
const Step = Action.make("fault/machine-crossing", {
 payload: {}, success: Schema.String, error: Action.IrreversibleRetryRequiresIdempotencyKey,
 tier: "sealed", idempotencyKey: "machine-crossing/v1", implementationVersion: "1"
})
export const layer = Step.toLayer(() => Effect.gen(function*() {
 yield* Action.make({ name: "fault/completed", success: Schema.String,
  tier: "sealed", idempotencyKey: "completed/v1", implementationVersion: "1",
  execute: Effect.sync(() => { if (process.getuid() !== 19999) throw new Error("guest identity"); appendFileSync(%q, "completed\n"); return "done" }) })
 return yield* Action.make({ name: "fault/keyless", success: Schema.String,
  error: Action.IrreversibleRetryRequiresIdempotencyKey,
  tier: "irreversible", idempotencyKey: undefined, implementationVersion: "1",
  execute: Effect.sync(() => { appendFileSync(%q, "keyless\n") }).pipe(Effect.andThen(Effect.never)) })
}), { implementationVersion: "1" })
export default Flow.make("todo", {
 description: "Machine fault D1", capabilities: ["*"], modelInvocable: false,
 effects: { reads: [], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
 payload: {}, success: Schema.String, error: Action.IrreversibleRetryRequiresIdempotencyKey,
 body: () => Step.call({})
})
`, marker, marker)
}
func runTodoReconciledMachineCrossing(t *testing.T, r *rehearsal, remote *todoFaultServices) {
	endpoint := strings.Replace(r.origin, "127.0.0.1", "host.microsandbox.internal", 1) + "/fault/write"
	source := fmt.Sprintf(`import { Action, Flow } from "@smthrs/flow"
import { Effect, Schema } from "effect"
import { appendFileSync } from "node:fs"
const marker = process.argv[process.argv.indexOf("--root") + 1] + "/.machine-reconcile-crossings"
const Step = Action.make("fault/migration", { payload: {}, success: Schema.String,
 error: Schema.String, tier: "sealed", idempotencyKey: "migration/v1", implementationVersion: "1" })
export const layer = Step.toLayer(() => Effect.gen(function*() {
 yield* Action.make({ name: "fault/completed", success: Schema.String, tier: "sealed",
  idempotencyKey: "completed/v1", implementationVersion: "1",
  execute: Effect.sync(() => { appendFileSync(marker, "completed\n"); return "done" }) })
 const found = yield* Action.make({ name: "fault/reconciled", success: Schema.String,
  error: Schema.String, tier: "irreversible", idempotencyKey: "external-write/v1", implementationVersion: "1",
  execute: Effect.tryPromise({ try: async () => {
   const lookup = await fetch(%q); const state = await lookup.text();
   if (state === "found") return state;
   if (state !== "absent") throw new Error("unknown remote outcome");
   const write = await fetch(%q, { method: "POST" });
   return await write.text();
  }, catch: String }) })
 return yield* Action.make({ name: "fault/found", success: Schema.String, tier: "sealed",
  idempotencyKey: "found/v1", implementationVersion: "1",
  execute: Effect.sync(() => { appendFileSync(marker, found + "\n"); return found }) })
}), { implementationVersion: "1" })
export default Flow.make("todo", { description: "Reconcile migration", capabilities: ["*"], modelInvocable: false,
 effects: { reads: [], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
 payload: {}, success: Schema.String, error: Schema.String, body: () => Step.call({}) })
`, endpoint, endpoint)
	_, digest := activateWatchdogOverride(t, r, source)
	number, err := r.file("Recover a migration", "Recover the recorded external write.")
	require.NoError(t, err)
	select {
	case <-remote.writeReached:
	case <-time.After(3 * time.Minute):
		t.Fatal("migration never reached the external service")
	}
	before, err := r.todo(number)
	require.NoError(t, err)
	require.NotNil(t, before.Run)
	workspace, _, err := r.todoHostBinding(number)
	require.NoError(t, err)
	_, d2 := activateWatchdogOverride(t, r, strings.Replace(source, "Reconcile migration", "Changed migration", 1))
	require.NotEqual(t, digest, d2)
	faultprocess.KillMachine(t, r.workspaceStateRoot, workspace, os.Getenv("SMITHERS_CHECK_BUNDLE"))
	t.Log("CRASH-POINT M3 subject todo")
	r.restartBackend()
	require.Eventually(t, func() bool {
		raw, err := r.workspaceRuntime.ReadFile(r.ctx, workspace, ".machine-reconcile-crossings")
		return err == nil && string(raw) == "completed\nfound\n"
	}, time.Minute, 100*time.Millisecond, "completed prefix or found remote outcome did not recover on the retained disk")
	remote.mu.Lock()
	log := append([]string(nil), remote.writeLog...)
	remote.mu.Unlock()
	require.Equal(t, []string{"GET", "POST", "GET"}, log, "lookup must seal the found write without another POST")
	after, err := r.todo(number)
	require.NoError(t, err)
	require.NotNil(t, after.Run)
	require.Equal(t, before.Run.ID, after.Run.ID)
	require.Equal(t, before.Run.Attempt, after.Run.Attempt)
	require.Equal(t, digest, after.FlowVersion.Digest)
	raw, err := json.MarshalIndent(map[string]any{"before": before, "after": after, "requests": log}, "", "  ")
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "migration-recovery.json"), raw, 0600))
	t.Log(`CRASH-OBSERVATION {"point":"M3","subject":"todo","completedStepCalls":1,"effectiveWrites":1,"lookups":2,"newAttempts":0}`)
}

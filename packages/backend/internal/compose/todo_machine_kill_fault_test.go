//go:build unix

package compose

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/flowmanifest"
	"github.com/smithersai/smithers/packages/backend/installbundle"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// Reuse the approved-bundle setup rehearsal. No recording msb, process
// workspace, seeded run outcome or accepted-candidate fixture qualifies this
// control. Linux can compile it; its execution belongs to the reference Mac.
func TestTodoMachineKillThroughInstall(t *testing.T) {
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
	raw, err := os.ReadFile(filepath.Join(h.runtimeState, "workspaces", workspace, "metadata.json"))
	require.NoError(t, err)
	var metadata struct {
		Machine string `json:"machine"`
	}
	require.NoError(t, json.Unmarshal(raw, &metadata))
	require.NotEmpty(t, metadata.Machine)
	require.NoError(t, msb.Check())
	stop := exec.CommandContext(t.Context(), msb.Path(), "stop", "-t", "0", "-q", metadata.Machine)
	stop.Env = []string{"HOME=" + os.Getenv("HOME"), "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "MSB_BACKEND=local", "NO_COLOR=1"}
	output, err := stop.CombinedOutput()
	require.NoError(t, err, string(output))
	fmt.Println("CRASH-POINT machine-mid-todo subject todo")
	failed, err := r.waitTodoWithin(number, 5*time.Minute, "failed")
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
	changed := strings.Replace(source, "Machine fault D1", "Machine fault D2", 1)
	changed = strings.Replace(changed, `"completed\n"`, `"D2-completed\n"`, 1)
	_, d2 := activateWatchdogOverride(t, r, changed)
	require.NotEqual(t, d1, d2)
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
	fmt.Println(`CRASH-OBSERVATION {"point":"machine-mid-todo","subject":"todo","stepsReRun":0,"automaticKeylessRepeats":0,"retryAttempts":1,"hostCanaryAbsent":true}`)
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

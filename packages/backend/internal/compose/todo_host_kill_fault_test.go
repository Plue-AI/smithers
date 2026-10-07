//go:build unix

package compose

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// The shared install rehearsal owns these hosts. This is the packaged-host
// trusted-process control; reference-machine isolation has a separate receipt.
// No completed outcome or interrupted projection is seeded into the database.
func TestTodoHostKillThroughInstall(t *testing.T) {
	if os.Getenv("SMITHERS_TODO_HOST_KILL") != "1" {
		t.Skip("set SMITHERS_TODO_HOST_KILL=1 for packaged TODO host-kill qualification")
	}
	root, err := filepath.Abs("../../../..")
	require.NoError(t, err)
	helper := rehearsalJJExport(root, os.Getenv("SMITHERS_FFI_LIBRARY_PATH"))
	require.NotEmpty(t, helper, "installed source-export helper required")
	capabilities, err := exec.Command(helper, "--capabilities").Output()
	require.NoError(t, err)
	require.Contains(t, string(capabilities), `"trusted-process-binding/v1"`)
	t.Setenv("SMITHERS_FEATURE_FLAGS_FLOW_LOAD", "true")
	r := newRehearsal(t, "SMITHERS_TODO_HOST_KILL", "C-DUR-01", "host-kill-", 25)
	require.True(t, r.install("Install through Machine ready"))
	t.Run("host-keyless-crossing", func(t *testing.T) {
		counter := filepath.Join(t.TempDir(), "crossings")
		source := fmt.Sprintf(`import { Action, Flow } from "@smthrs/flow"
import { Effect, Schema } from "effect"
import { appendFileSync } from "node:fs"
const Step = Action.make("fault/host-crossing", {
 payload: {}, success: Schema.String, error: Action.IrreversibleRetryRequiresIdempotencyKey,
 tier: "sealed", idempotencyKey: "host-crossing/v1", implementationVersion: "1"
})
export const layer = Step.toLayer(() => Effect.gen(function*() {
 yield* Action.make({ name: "fault/completed", success: Schema.String,
  tier: "sealed", idempotencyKey: "completed/v1", implementationVersion: "1",
  execute: Effect.sync(() => { appendFileSync(%q, "completed\n"); return "done" }) })
 return yield* Action.make({ name: "fault/keyless", success: Schema.String,
  error: Action.IrreversibleRetryRequiresIdempotencyKey,
  tier: "irreversible", idempotencyKey: undefined, implementationVersion: "1",
  execute: Effect.sync(() => { appendFileSync(%q, "keyless\n") }).pipe(Effect.andThen(Effect.never)) })
}), { implementationVersion: "1" })
export default Flow.make("todo", {
 description: "Hold a keyless crossing", capabilities: ["*"], modelInvocable: false,
 effects: { reads: [], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
 payload: {}, success: Schema.String, error: Action.IrreversibleRetryRequiresIdempotencyKey,
 body: () => Step.call({})
})
`, counter, counter)
		_, digest := activateWatchdogOverride(t, r, source)
		number, err := r.file("Recover a killed host", "Hold at a recorded crossing.")
		require.NoError(t, err)
		readCrossings := func() string { raw, _ := os.ReadFile(counter); return string(raw) }
		require.Eventually(t, func() bool { return readCrossings() == "completed\nkeyless\n" }, 3*time.Minute, 100*time.Millisecond)
		before, err := r.todo(number)
		require.NoError(t, err)
		require.NotNil(t, before.Run)
		require.NotNil(t, before.FlowVersion)
		require.Equal(t, digest, before.FlowVersion.Digest)
		workspace, service, err := r.todoHostBinding(number)
		require.NoError(t, err)
		host, err := r.processRuntime.InspectService(r.ctx, workspace, service)
		require.NoError(t, err)
		require.Positive(t, host.PID)
		// This PID is the service started by this rehearsal, never a host-wide search.
		require.NoError(t, syscall.Kill(host.PID, syscall.SIGKILL))
		fmt.Println("CRASH-POINT host-keyless-crossing subject todo")
		failed, err := r.waitTodoWithin(number, 3*time.Minute, "failed")
		require.NoError(t, err)
		require.NotNil(t, failed.FlowVersion)
		require.Equal(t, digest, failed.FlowVersion.Digest)
		require.Equal(t, "completed\nkeyless\n", readCrossings(), "neither a completed action nor an unknown keyless write may repeat")
		raw, err := r.expect("GET", fmt.Sprintf("/api/todos/%d", number), "", 200)
		require.NoError(t, err)
		var card map[string]any
		require.NoError(t, json.Unmarshal(raw, &card))
		require.Equal(t, "interrupted", card["failure"].(map[string]any)["class"])
		// Activate D2 before Retry. Admission must still use D1, and reconnecting
		// the same press must not create a third attempt.
		changed := strings.Replace(source, "Hold a keyless crossing", "Changed active description", 1)
		changed = strings.Replace(changed, `"completed\n"`, `"D2-completed\n"`, 1)
		_, d2 := activateWatchdogOverride(t, r, changed)
		require.NotEqual(t, digest, d2)
		path := fmt.Sprintf("/api/todos/%d", number)
		for range 2 {
			status, receipt, err := r.keyed("POST", path, `{"op":"retry"}`, "host-kill-retry")
			require.NoError(t, err)
			require.Equal(t, 202, status, string(receipt))
		}
		require.Eventually(t, func() bool { return readCrossings() == "completed\nkeyless\ncompleted\nkeyless\n" }, 3*time.Minute, 100*time.Millisecond)
		retried, err := r.todo(number)
		require.NoError(t, err)
		require.NotNil(t, retried.Run)
		require.Equal(t, before.Run.Attempt+1, retried.Run.Attempt)
		require.NotEqual(t, before.Run.ID, retried.Run.ID)
		require.Equal(t, digest, retried.FlowVersion.Digest)
		require.NotEmpty(t, retried.Evidence, "the prior attempt must remain visible")
		preserved := false
		for _, evidence := range retried.Evidence {
			if evidence.Attempt == int32(before.Run.Attempt) && evidence.FlowDigest == digest && evidence.SourceCommit == before.FlowVersion.SourceCommit {
				preserved = true
			}
		}
		require.True(t, preserved, "Retry must retain the original attempt's pin and source evidence")
		require.NoError(t, r.drop(number))
		fmt.Println(`CRASH-OBSERVATION {"point":"host-keyless-crossing","subject":"todo","stepsReRun":0,"automaticKeylessRepeats":0,"retryAttempts":1}`)
	})
}

// The actual PostgreSQL schemas use UUID host bindings and text item selectors.
// Even an absent item must return no rows, not an operator/type error.
func TestTodoHostBindingMissingSelector(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	r := &rehearsal{ctx: t.Context(), pool: pool}
	_, _, err := r.todoHostBinding(-1)
	require.ErrorIs(t, err, pgx.ErrNoRows)
}

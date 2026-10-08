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
	helper := rehearsalJJExport(t, root)
	require.NotEmpty(t, helper, "installed source-export helper required")
	capabilities, err := exec.Command(helper, "--capabilities").Output()
	require.NoError(t, err)
	require.Contains(t, string(capabilities), `"trusted-process-binding/v1"`)
	t.Setenv("SMITHERS_FEATURE_FLAGS_FLOW_LOAD", "true")
	r := newRehearsal(t, "SMITHERS_TODO_HOST_KILL", "C-DUR-01", "host-kill-", 25)
	require.True(t, r.install("Install through Machine ready"))
	t.Run("host-keyless-crossing", func(t *testing.T) {
		counter := ".smithers-host-fault-crossings"
		source := fmt.Sprintf(`import { Action, Flow } from "@smthrs/flow"
import { Effect, Schema } from "effect"
import { appendFileSync } from "node:fs"
const marker = process.argv[process.argv.indexOf("--root") + 1] + "/" + %q
const Step = Action.make("fault/host-crossing", {
 payload: {}, success: Schema.String, error: Action.IrreversibleRetryRequiresIdempotencyKey,
 tier: "sealed", idempotencyKey: "host-crossing/v1", implementationVersion: "1"
})
export const layer = Step.toLayer(() => Effect.gen(function*() {
 yield* Action.make({ name: "fault/completed", success: Schema.String,
  tier: "sealed", idempotencyKey: "completed/v1", implementationVersion: "1",
  execute: Effect.sync(() => { appendFileSync(marker, "completed\n"); return "done" }) })
 return yield* Action.make({ name: "fault/keyless", success: Schema.String,
  error: Action.IrreversibleRetryRequiresIdempotencyKey,
  tier: "irreversible", idempotencyKey: undefined, implementationVersion: "1",
  execute: Effect.sync(() => { appendFileSync(marker, "keyless\n") }).pipe(Effect.andThen(Effect.never)) })
}), { implementationVersion: "1" })
export default Flow.make("todo", {
 description: "Hold a keyless crossing", capabilities: ["*"], modelInvocable: false,
 effects: { reads: [], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
 payload: {}, success: Schema.String, error: Action.IrreversibleRetryRequiresIdempotencyKey,
 body: () => Step.call({})
})
`, counter)
		_, digest := activateWatchdogOverride(t, r, source)
		number, err := r.file("Recover a killed host", "Hold at a recorded crossing.")
		require.NoError(t, err)
		t.Cleanup(func() {
			if t.Failed() {
				status, card, err := r.request("GET", fmt.Sprintf("/api/todos/%d", number), "")
				t.Logf("host fault TODO: HTTP %d %s; error: %v", status, card, err)
			}
		})
		currentWorkspace := func() string {
			var workspace string
			_ = r.pool.QueryRow(r.ctx, `SELECT workspace_id FROM mythical_items WHERE number=$1 AND repository_id=(SELECT (value->>'repository_id')::bigint FROM install_settings WHERE key='github.repository')`, number).Scan(&workspace)
			return workspace
		}
		readWorkspaceCrossings := func(workspace string) string {
			raw, _ := r.processRuntime.ReadFile(r.ctx, workspace, counter)
			return string(raw)
		}
		readCrossings := func() string { return readWorkspaceCrossings(currentWorkspace()) }
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
		// Kill the owned service group, including its namespace wrapper and host.
		require.NoError(t, syscall.Kill(-host.PID, syscall.SIGKILL))
		t.Log("CRASH-POINT host-keyless-crossing subject todo")
		r.restartBackend()
		failed, err := r.waitTodoWithin(number, 3*time.Minute, "failed")
		require.NoError(t, err)
		require.NotNil(t, failed.FlowVersion)
		require.Equal(t, digest, failed.FlowVersion.Digest)
		require.Equal(t, "completed\nkeyless\n", readCrossings(), "neither a completed action nor an unknown keyless write may repeat")
		raw, err := r.expect("GET", fmt.Sprintf("/api/todos/%d", number), "", 200)
		require.NoError(t, err)
		var card map[string]any
		require.NoError(t, json.Unmarshal(raw, &card))
		require.Equal(t, "interrupted", card["failure"].(map[string]any)["class"], string(raw))
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
		// Retry creates a fresh branch machine. Count the new attempt's writes
		// on its own disk rather than expecting it to append to the old disk.
		require.Eventually(t, func() bool {
			return currentWorkspace() != workspace && readCrossings() == "completed\nkeyless\n"
		}, 3*time.Minute, 100*time.Millisecond)
		require.Equal(t, "completed\nkeyless\n", readWorkspaceCrossings(workspace), "the first attempt's writes must remain unchanged")
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
		// newRehearsal closes every owned runtime and worker at test cleanup.
		// Dropping a live override separately requires stopped-writer capture.
		t.Log(`CRASH-OBSERVATION {"point":"host-keyless-crossing","subject":"todo","stepsReRun":0,"automaticKeylessRepeats":0,"retryAttempts":1}`)
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

// TODO numbers are repository-scoped. A kill controller must never select a
// host from another repository just because that repository used the same n.
func TestTodoHostBindingSelectsInstalledRepository(t *testing.T) {
	t.Setenv("SMITHERS_TEST_DATABASE_NAMESPACE", "fr12_killscope")
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	var user int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES('kill-owner','kill-owner') RETURNING id`).Scan(&user))
	var wanted string
	for _, name := range []string{"other", "installed"} {
		var repository int64
		var workspace string
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,$2,$2) RETURNING id`, user, name).Scan(&repository))
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspaces(repository_id,user_id,name,status) VALUES($1,$2,$3,'running') RETURNING id`, repository, user, name).Scan(&workspace))
		_, err := pool.Exec(ctx, `INSERT INTO mythical_items(repository_id,source,state,title,workspace_id,number) VALUES($1,'todo','running',$2,$3,7)`, repository, name, workspace)
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `UPDATE mythical_items SET number=7 WHERE repository_id=$1`, repository)
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `INSERT INTO flow_runtime_host_bindings(id,tenant_id,principal_id,binding_kind,binding_id,repository_id,user_id,workspace_id,catalog_key,service_name,runtime_artifact_digest,source_revision,owner_generation,credential_ciphertext,credential_hash,state)
 VALUES(gen_random_uuid(),'fixture','owner','mythical-item',$1,$2,$3,$1::text::uuid,'coding',$4,repeat('a',64),repeat('b',40),1,'fixture-only',decode(repeat('00',32),'hex'),'running')`, workspace, repository, user, "host-"+name)
		require.NoError(t, err)
		if name == "installed" {
			_, err = pool.Exec(ctx, `INSERT INTO install_settings(key,value) VALUES('github.repository',jsonb_build_object('repository_id',$1::bigint))`, repository)
			require.NoError(t, err)
			wanted = workspace
		}
	}
	r := &rehearsal{ctx: ctx, pool: pool}
	workspace, service, err := r.todoHostBinding(7)
	require.NoError(t, err)
	require.Equal(t, wanted, workspace)
	require.Equal(t, "host-installed", service)
}

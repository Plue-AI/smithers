package compose

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// This uses the real bundled host, source activation, dispatcher and stack
// worker. Only the GitHub/model peers are scripted by the shared rehearsal.
// No candidate or successful runtime projection is seeded into PostgreSQL.
func TestTodoEarlyReturnBundledHost(t *testing.T) {
	t.Setenv("SMITHERS_FEATURE_FLAGS_FLOW_LOAD", "true")
	r := newRehearsal(t, "SMITHERS_TODO_WATCHDOG_REHEARSAL", "C-STK-06", "watchdog-")
	if !r.install("Install through Machine ready") {
		return
	}
	const source = `import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
export default Flow.make("todo", {
  description: "Return without proposing a change.",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
  modelInvocable: false,
  payload: Schema.Struct({}),
  success: Schema.Struct({ returned: Schema.Boolean }),
  body: () => Node.succeed({ returned: true })
})
`
	commit, digest := activateWatchdogOverride(t, r, source)
	number, err := r.file("A successful return needs a proposal", "Return immediately without proposing anything.")
	require.NoError(t, err)
	var checks json.RawMessage
	var runID, outcome, reason, fault, state string
	require.EventuallyWithT(t, func(c *assert.CollectT) {
		require.NoError(c, r.pool.QueryRow(r.ctx, `SELECT request_run_id,request_outcome,reason,checks,COALESCE(checks->'fault'->>'tag',''),state FROM mythical_items WHERE number=$1`, number).Scan(&runID, &outcome, &reason, &checks, &fault, &state))
		require.NotEmpty(c, runID, "a real host must accept this attempt")
		require.Equal(c, "no_proposal", fault, "reason: %s; outcome: %s", reason, outcome)
		require.Equal(c, "blocked", state, "a person must Retry this typed stop")
	}, 4*time.Minute, 500*time.Millisecond)
	var evidence struct {
		Fault struct {
			Class string `json:"class"`
			Tag   string `json:"tag"`
		} `json:"fault"`
	}
	require.NoError(t, json.Unmarshal(checks, &evidence))
	require.Equal(t, "factory", evidence.Fault.Class)
	require.Equal(t, "no_proposal", evidence.Fault.Tag)
	require.Equal(t, "completed", outcome, "the host succeeded; the missing proposal is the failure")
	card, err := r.todo(number)
	require.NoError(t, err)
	require.NotNil(t, card.FlowVersion)
	require.Equal(t, digest, card.FlowVersion.Digest)
	require.Equal(t, commit, card.FlowVersion.SourceCommit)
	require.Zero(t, card.PR.Number, "returning success cannot manufacture a proposal")
	t.Logf("real run %s completed; TODO %d failed no_proposal on %s", runID, number, digest)
}

func TestTodoStepWatchdogBundledHost(t *testing.T) {
	t.Setenv("SMITHERS_FEATURE_FLAGS_FLOW_LOAD", "true")
	r := newRehearsal(t, "SMITHERS_TODO_WATCHDOG_REHEARSAL", "C-STK-06", "watchdog-steps-")
	if !r.install("Install through Machine ready") {
		return
	}
	// Expired timers are actual engine actions with their own completed-step
	// identities. The last timer keeps this flow from returning, so an early
	// successful return cannot masquerade as step-budget enforcement.
	const source = `import { Flow, Sleep } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
export default Flow.make("todo", {
  description: "Complete more than the TODO step allowance without proposing.",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
  modelInvocable: false,
  payload: Schema.Struct({}),
  success: Schema.Void,
  error: Sleep.SleepRequestInvalid,
  body: () => Node.all(Object.fromEntries(Array.from({ length: 1030 }, (_, i) =>
    ["step" + i, Sleep.action.call({ until: i + 1 })]
  ))).pipe(Node.andThen(Sleep.action.call({ millis: 3600000 })))
})
`
	commit, digest := activateWatchdogOverride(t, r, source)
	number, err := r.file("The step allowance stops execution", "Run steps without proposing anything.")
	require.NoError(t, err)
	var checks json.RawMessage
	var runID, outcome string
	require.EventuallyWithT(t, func(c *assert.CollectT) {
		require.NoError(c, r.pool.QueryRow(r.ctx, `SELECT request_run_id,request_outcome,checks FROM mythical_items WHERE number=$1`, number).Scan(&runID, &outcome, &checks))
		require.NotEmpty(c, runID)
		require.Equal(c, "failed: no_proposal", outcome)
	}, 5*time.Minute, 500*time.Millisecond)
	var evidence struct {
		Watchdog struct {
			Steps        []string `json:"steps"`
			ActiveMillis int64    `json:"activeMillis"`
		} `json:"watchdog"`
		Fault struct {
			Class string `json:"class"`
			Tag   string `json:"tag"`
		} `json:"fault"`
	}
	require.NoError(t, json.Unmarshal(checks, &evidence))
	require.Len(t, evidence.Watchdog.Steps, 1024)
	require.Less(t, evidence.Watchdog.ActiveMillis, (4 * time.Hour).Milliseconds())
	require.Equal(t, "factory", evidence.Fault.Class)
	require.Equal(t, "no_proposal", evidence.Fault.Tag)
	require.EventuallyWithT(t, func(c *assert.CollectT) {
		var retired bool
		var lanes int
		// Terminal settlement clears the item's current workspace. The
		// immutable lane binding still proves its executing machine retired.
		require.NoError(c, r.pool.QueryRow(r.ctx, `SELECT count(*),COALESCE(bool_and(retired_at IS NOT NULL),false) FROM mythical_lanes WHERE item_id=(SELECT id FROM mythical_items WHERE number=$1)`, number).Scan(&lanes, &retired))
		require.Equal(c, 1, lanes, "a typed stop must not launch another machine")
		require.True(c, retired, "the watchdog must retire the executing machine")
	}, time.Minute, 250*time.Millisecond)
	card, err := r.todo(number)
	require.NoError(t, err)
	require.NotNil(t, card.FlowVersion)
	require.Equal(t, digest, card.FlowVersion.Digest)
	require.Equal(t, commit, card.FlowVersion.SourceCommit)
	require.Zero(t, card.PR.Number)
	t.Logf("real run %s stopped at 1024 recorded completions; TODO %d has no proposal", runID, number)
}

func activateWatchdogOverride(t *testing.T, r *rehearsal, source string) (string, string) {
	t.Helper()
	commit, err := r.pushGitHubMain("Install watchdog TODO override", map[string]string{"flows/todo/flow.ts": source})
	require.NoError(t, err)
	var digest string
	require.EventuallyWithT(t, func(c *assert.CollectT) {
		card, err := r.flowCard("todo")
		require.NoError(c, err)
		digest = card.version("active")
		require.NotEmpty(c, digest)
		var activeSource string
		require.NoError(c, r.pool.QueryRow(r.ctx, `SELECT source_commit FROM workflow_definitions WHERE name='todo' AND digest=$1 AND is_active`, digest).Scan(&activeSource))
		require.Equal(c, commit, activeSource)
	}, 5*time.Minute, 500*time.Millisecond, "the repository override must become Active before admission")
	return commit, digest
}

func TestTodoNonYieldingWatchdogBundledHost(t *testing.T) {
	testTodoNonYieldingWatchdogBundledHost(t, false)
}

func TestTodoUnobservedProposalWatchdogBundledHost(t *testing.T) {
	testTodoNonYieldingWatchdogBundledHost(t, true)
}

func testTodoNonYieldingWatchdogBundledHost(t *testing.T, unobserved bool) {
	t.Setenv("SMITHERS_FEATURE_FLAGS_FLOW_LOAD", "true")
	r := newRehearsal(t, "SMITHERS_TODO_WATCHDOG_REHEARSAL", "C-STK-06", "watchdog-spin-")
	if !r.install("Install through Machine ready") {
		return
	}
	marker := filepath.Join(t.TempDir(), "spinning.pid")
	// The marker observes the real process entering its synchronous loop. Its
	// finite fallback bounds a broken test; a passing watchdog kills it before
	// it can reach that fallback. This trusted-process fixture does not qualify
	// the production microVM's filesystem or process isolation.
	source := fmt.Sprintf(`import { Flow, Sleep } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { writeFileSync } from "node:fs"
export default Flow.make("todo", {
  description: "Spin synchronously without proposing.",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
  modelInvocable: false,
  payload: Schema.Struct({}),
  success: Schema.String,
  error: Sleep.SleepRequestInvalid,
  body: () => Sleep.action.call({ until: 1 }).pipe(Node.map(() => {
    writeFileSync(%q, String(process.pid))
    const fallback = Date.now() + 120000
    while (Date.now() < fallback) {}
    return "watchdog did not interrupt"
  }))
})
`, marker)
	activateWatchdogOverride(t, r, source)
	number, err := r.file("Stop a non-yielding override", "Spin without proposing anything.")
	require.NoError(t, err)
	var pid int
	require.EventuallyWithT(t, func(c *assert.CollectT) {
		data, err := os.ReadFile(marker)
		require.NoError(c, err)
		pid, err = strconv.Atoi(string(data))
		require.NoError(c, err)
		require.Positive(c, pid)
	}, 3*time.Minute, 250*time.Millisecond)
	var runID string
	require.EventuallyWithT(t, func(c *assert.CollectT) {
		var since int64
		require.NoError(c, r.pool.QueryRow(r.ctx, `SELECT request_run_id,COALESCE((checks->'watchdog'->>'activeSince')::bigint,0) FROM mythical_items WHERE number=$1`, number).Scan(&runID, &since))
		require.NotEmpty(c, runID)
		require.Positive(c, since, "the timer must be persisted while the guest cannot answer")
	}, 10*time.Second, 250*time.Millisecond)
	var workspace string
	if unobserved {
		require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT workspace_id FROM mythical_items WHERE number=$1`, number).Scan(&workspace))
		// Publication is a seeded fixture here: the real candidate/verify/push
		// path is covered by TestReservedCandidateWithoutProposeReleasesLane.
		// Keep this real non-yielding run and machine to prove composed retirement.
		_, err = r.pool.Exec(r.ctx, `UPDATE mythical_items SET state='proposed',candidate_base=base_commit,candidate_head=base_commit,candidate_verified=true,pr_head=base_commit,pr_state='open',checks=jsonb_set(checks,'{proposal_run}',to_jsonb(request_run_id)) WHERE number=$1`, number)
		require.NoError(t, err)
	}
	// Compress only elapsed time: keep the real launch, run and counters. The
	// clock boundary itself has separate exact 4h-1ms / 4h PostgreSQL coverage.
	aged := time.Now().Add(-4 * time.Hour).UnixMilli()
	_, err = r.pool.Exec(r.ctx, `UPDATE mythical_items SET checks=jsonb_set(checks,'{watchdog,activeSince}',to_jsonb($2::bigint)),next_attempt_at=NOW() WHERE number=$1`, number, aged)
	require.NoError(t, err)
	_, err = r.pool.Exec(r.ctx, `UPDATE mythical_stacks SET next_attempt_at=NOW()`)
	require.NoError(t, err)
	began := time.Now()
	require.EventuallyWithT(t, func(c *assert.CollectT) {
		var outcome, fault string
		require.NoError(c, r.pool.QueryRow(r.ctx, `SELECT request_outcome,checks->'fault'->>'tag' FROM mythical_items WHERE number=$1`, number).Scan(&outcome, &fault))
		require.Equal(c, "failed: no_proposal", outcome)
		require.Equal(c, "no_proposal", fault)
		require.ErrorIs(c, syscall.Kill(pid, 0), syscall.ESRCH, "the host must terminate the actual spinning process")
	}, time.Minute, 250*time.Millisecond)
	card, err := r.todo(number)
	require.NoError(t, err)
	if unobserved {
		require.Equal(t, "failed", card.State)
		require.EventuallyWithT(t, func(c *assert.CollectT) {
			var retired bool
			require.NoError(c, r.pool.QueryRow(r.ctx, `SELECT retired_at IS NOT NULL FROM mythical_lanes WHERE workspace_id=$1`, workspace).Scan(&retired))
			require.True(c, retired, "final capture and retirement must settle")
		}, time.Minute, 250*time.Millisecond)
		code, data, err := r.request("GET", fmt.Sprintf("/api/todos/%d", number), "")
		require.NoError(t, err)
		require.Equal(t, 200, code)
		var shown struct {
			Failure struct {
				Retryable bool `json:"retryable"`
			} `json:"failure"`
		}
		require.NoError(t, json.Unmarshal(data, &shown))
		require.True(t, shown.Failure.Retryable)
	} else {
		require.Zero(t, card.PR.Number)
	}
	t.Logf("real non-yielding run %s (pid %d) terminated after %s with its persisted deadline elapsed", runID, pid, time.Since(began))
}

package compose

import (
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// Exercise the served Retry door and all composed readers against GitHub fake.
// The unresolved verification is a deliberate phase fixture: sync must work
// without settling that job or waiting for its phase deadline.
func TestGitHubSyncRetryDuringVerificationRehearsal(t *testing.T) {
	r := newRehearsal(t, "SMITHERS_J10_REHEARSAL", "C-J10-06", "sync-retry-")
	if !r.install("Install") {
		return
	}
	number, err := r.file("Sync Retry", "[PR] [FILE sync-retry.md] Add a greeting to sync-retry.md")
	require.NoError(t, err)
	_, err = r.waitTodoWithin(number, 8*time.Minute, "in_review")
	require.NoError(t, err)
	require.NoError(t, r.waitSQL(time.Minute, `SELECT count(*) FROM mythical_items WHERE number=$1 AND pending_op IS NULL AND COALESCE(checks->>'proposal_run','')='' AND checks->'capture' IS NULL`, number))
	_, err = r.pool.Exec(r.ctx, `UPDATE mythical_items SET state='verifying',verify_run_id='unresolved-sync-retry',verify_outcome='',next_attempt_at=clock_timestamp()-interval '1 second' WHERE number=$1`, number)
	require.NoError(t, err)
	code, data, err := r.keyed("POST", "/api/github/sync", "", r.keyPrefix+"initial")
	require.NoError(t, err)
	require.Equal(t, 202, code, string(data))
	var before time.Time
	require.Eventually(t, func() bool {
		health, at, readErr := r.syncHealth()
		before = at
		return readErr == nil && health["state"] == "fresh" && !at.IsZero()
	}, 10*time.Second, 100*time.Millisecond, "the new PR must have a real first-read receipt")
	_, err = r.fakeControl("/_fake/outage", map[string]any{"down": true})
	require.NoError(t, err)
	defer r.fakeControl("/_fake/outage", map[string]any{"down": false})
	code, data, err = r.keyed("POST", "/api/github/sync", "", r.keyPrefix+"down")
	require.NoError(t, err)
	require.Equal(t, 202, code, string(data))
	require.Eventually(t, func() bool { return strings.Contains(r.logs.String(), "mythical.pull_hint_failed") }, 10*time.Second, 50*time.Millisecond, "the admitted read must run while verification is unresolved")
	_, err = r.fakeControl("/_fake/outage", map[string]any{"down": false})
	require.NoError(t, err)
	started := time.Now()
	code, data, err = r.keyed("POST", "/api/github/sync", "", r.keyPrefix+"up")
	require.NoError(t, err)
	require.Equal(t, 202, code, string(data))
	require.Less(t, time.Since(started), time.Second, "Retry acknowledges before its worker completes")
	var observed time.Time
	require.Eventually(t, func() bool {
		health, at, readErr := r.syncHealth()
		observed = at
		return readErr == nil && health["state"] == "fresh" && at.After(before)
	}, 10*time.Second, 100*time.Millisecond, "Retry must refresh every required stream before transient backoff expires")
	var state, outcome string
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT state,verify_outcome FROM mythical_items WHERE number=$1`, number).Scan(&state, &outcome))
	require.Equal(t, "verifying", state)
	require.Empty(t, outcome)
	r.t.Logf("Retry 202; all required streams fresh at %s in %s; verification remains unresolved", observed.Format(time.RFC3339Nano), time.Since(started).Round(time.Millisecond))
}

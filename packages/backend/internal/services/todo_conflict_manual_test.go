package services

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

func TestFailedRepairRetainsManualConflictOnlyWithNativeAttemptBinding(t *testing.T) {
	now := time.Unix(100, 0).UTC()
	makeItem := func() db.MythicalItem {
		item := db.MythicalItem{ID: pgtype.UUID{Bytes: [16]byte{1}, Valid: true}, Source: "todo", RepositoryID: 1, Attempt: 3, State: "integrating", Reason: "rebase_conflict_pending", WorkspaceID: "branch", RequestRunID: "original-todo", FlowDigest: pgtype.Text{String: strings.Repeat("b", 64), Valid: true}, Integration: []byte(`{"conflict":{"head":"change","onto":"onto","paths":["actual.txt"]}}`)}
		item.Checks = mythicalChecks{RunLaunched: true, RunAttached: true, FlowSource: strings.Repeat("a", 40), Rebase: &mythicalRebase{Onto: "onto", Native: &machined.RewriteResult{Head: "change", Paths: []string{"actual.txt"}, Inspected: true}}, ConflictReservation: &todoConflictReservation{Change: "change", Onto: "onto", Run: "original-todo", Limit: 1, Reserved: 1, Dispatched: true}}.encode()
		return item
	}
	item := makeItem()
	update := flowdispatch.ProjectionUpdate{State: jobs.StateFailed, Scope: jobs.Scope{TenantID: "repository:1", PrincipalID: "user:1"}, Checkpoint: flowdispatch.RuntimeCheckpoint{FlowID: "coding/rebase-conflict", FailureCode: "runtime_catalog_unavailable", Target: flowruntime.Target{TenantID: "repository:1", PrincipalID: "user:1", WorkspaceID: "branch", BindingKind: mythicalBindingKind, BindingID: uuidString(item.ID)}}}
	next := item
	require.True(t, mythicalProjectRun(&next, item, mythicalProjection{Phase: "conflict"}, update, "", true))
	for range 10 {
		projectManualConflictWait(&next, now)
	}
	checks := mythicalChecksOf(next)
	require.Len(t, checks.Waits, 1)
	require.Equal(t, []string{"actual.txt"}, checks.Waits[0].Paths)
	require.Nil(t, checks.Waits[0].Signal, "a failed startup has no signalable run")
	require.Equal(t, "needs_you", todoState(next))
	require.Empty(t, checks.ConflictReservation.ResolutionRun)
	require.Equal(t, "outage: infra: runtime_catalog_unavailable", checks.ConflictReservation.Outcome)
	require.Equal(t, 1, checks.ConflictReservation.Reserved)
	require.Equal(t, item.RequestRunID, next.RequestRunID)
	require.Equal(t, item.Attempt, next.Attempt)
	require.True(t, manualConflictWaitBound(next, checks.Waits[0]))
	for _, tc := range []struct {
		name   string
		mutate func(*db.MythicalItem, *mythicalChecks)
	}{
		{"settled item", func(i *db.MythicalItem, _ *mythicalChecks) { i.State = "landed" }},
		{"different reason", func(i *db.MythicalItem, _ *mythicalChecks) { i.Reason = "" }},
		{"no native inspection", func(_ *db.MythicalItem, c *mythicalChecks) { c.Rebase.Native.Inspected = false }},
		{"wrong native head", func(_ *db.MythicalItem, c *mythicalChecks) { c.Rebase.Native.Head = "other" }},
		{"wrong native paths", func(_ *db.MythicalItem, c *mythicalChecks) { c.Rebase.Native.Paths = []string{"invented"} }},
		{"no native result", func(_ *db.MythicalItem, c *mythicalChecks) { c.Rebase.Native = nil }},
		{"resolved", func(_ *db.MythicalItem, c *mythicalChecks) { c.Rebase.Native.Paths = nil }},
		{"wrong attempt", func(_ *db.MythicalItem, c *mythicalChecks) { c.ConflictReservation.Run = "other-root" }},
		{"not dispatched", func(_ *db.MythicalItem, c *mythicalChecks) { c.ConflictReservation.Dispatched = false }},
		{"still running", func(_ *db.MythicalItem, c *mythicalChecks) { c.ConflictReservation.Outcome = "" }},
		{"completed", func(_ *db.MythicalItem, c *mythicalChecks) { c.ConflictReservation.Outcome = "completed" }},
		{"wrong target", func(_ *db.MythicalItem, c *mythicalChecks) { c.Rebase.Onto = "new-main" }},
		{"no pin", func(i *db.MythicalItem, _ *mythicalChecks) { i.FlowDigest.Valid = false }},
		{"no root", func(i *db.MythicalItem, _ *mythicalChecks) { i.RequestRunID = "" }},
		{"unattached", func(_ *db.MythicalItem, c *mythicalChecks) { c.RunAttached = false }},
		{"no retained conflict", func(i *db.MythicalItem, _ *mythicalChecks) { i.Integration = json.RawMessage(`{}`) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			candidate := makeItem()
			c := mythicalChecksOf(candidate)
			c.ConflictReservation.Outcome = "failed: startup"
			tc.mutate(&candidate, &c)
			candidate.Checks = c.encode()
			_, accepted := manualConflictWait(candidate, now)
			require.False(t, accepted)
		})
	}
}

func TestFailedRepairReopensUndeliverableDone(t *testing.T) {
	item := db.MythicalItem{State: "integrating", Reason: "rebase_conflict_pending", WorkspaceID: "branch", RequestRunID: "root", FlowDigest: pgtype.Text{String: strings.Repeat("b", 64), Valid: true}, Integration: []byte(`{"conflict":{"head":"change","onto":"onto","paths":["actual.txt"]}}`)}
	now := time.Unix(100, 0).UTC()
	checks := mythicalChecks{RunLaunched: true, RunAttached: true, FlowSource: strings.Repeat("a", 40), Rebase: &mythicalRebase{Onto: "onto", Native: &machined.RewriteResult{Head: "change", Paths: []string{"actual.txt"}, Inspected: true}}, ConflictReservation: &todoConflictReservation{Change: "change", Onto: "onto", Run: "root", Dispatched: true, Outcome: "failed: repair"}}
	item.Checks = checks.encode()
	wait, ok := manualConflictWait(item, now)
	require.True(t, ok)
	wait.SettledAt = &now
	wait.Answer = "done"
	wait.AnsweredBy = "person"
	wait.Signal = &TodoWaitSignal{Run: "failed-engine"}
	checks.Waits = []TodoWait{wait}
	item.Checks = checks.encode()
	projectManualConflictWait(&item, now)
	got := mythicalChecksOf(item).Waits[0]
	require.Nil(t, got.Signal)
	require.Nil(t, got.SettledAt)
	require.Empty(t, got.Answer)
	require.Equal(t, "needs_you", todoState(item))
	checks = mythicalChecksOf(item)
	checks.ConflictReservation.Done = &mythicalRebaseRequest{User: 1}
	checks.Waits[0].SettledAt = &now
	checks.Waits[0].Answer = "done"
	item.Checks = checks.encode()
	projectManualConflictWait(&item, now)
	require.NotNil(t, mythicalChecksOf(item).Waits[0].SettledAt)
}

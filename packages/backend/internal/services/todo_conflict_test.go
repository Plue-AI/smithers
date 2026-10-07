package services

import (
	"encoding/json"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestConflictAttemptLimit(t *testing.T) {
	for _, tc := range []struct {
		config string
		limit  int
	}{
		{`{}`, 1}, {`{"conflictAttempts":0}`, 0},
		{`{"conflictAttempts":1}`, 1}, {`{"conflictAttempts":8}`, 8},
	} {
		t.Run(tc.config, func(t *testing.T) {
			limit, err := conflictAttemptLimit([]byte(tc.config))
			require.NoError(t, err)
			require.Equal(t, tc.limit, limit)
		})
	}
	for _, raw := range []string{`null`, `[]`, `{`, `{"conflictAttempts":null}`, `{"conflictAttempts":-1}`, `{"conflictAttempts":9}`, `{"conflictAttempts":1.5}`, `{"conflictAttempts":"1"}`, `{"conflictAttempts":true}`} {
		t.Run(raw, func(t *testing.T) {
			_, err := conflictAttemptLimit([]byte(raw))
			require.Error(t, err)
		})
	}
}

func TestConflictWaitRetainsAttemptAndNativePaths(t *testing.T) {
	now := time.Unix(100, 0).UTC()
	item := db.MythicalItem{ID: pgtype.UUID{Bytes: [16]byte{1}, Valid: true}, RepositoryID: 1, State: "integrating", WorkspaceID: "branch", RequestRunID: "run", FlowDigest: pgtype.Text{String: strings.Repeat("b", 64), Valid: true}, Integration: []byte(`{"conflict":{"head":"change","onto":"onto","paths":["a.txt"]}}`)}
	checks := mythicalChecks{RunLaunched: true, RunAttached: true, FlowSource: strings.Repeat("a", 40), Rebase: &mythicalRebase{Onto: "onto"}, ConflictReservation: &todoConflictReservation{Change: "change", Onto: "onto", Run: "run", Limit: 1, Reserved: 1}}
	item.Checks = checks.encode()
	wait := flowruntime.PendingWait{RunID: "child", Token: "park", Name: "conflict", Request: json.RawMessage(`{"kind":"conflict","conflict_change":"change","onto_revision":"onto","paths":["invented"]}`)}
	update := flowdispatch.ProjectionUpdate{State: jobs.StateWaiting, Scope: jobs.Scope{TenantID: "repository:1", PrincipalID: "user:1"}, Checkpoint: flowdispatch.RuntimeCheckpoint{FlowID: "todo", RunID: "run", Target: flowruntime.Target{TenantID: "repository:1", PrincipalID: "user:1", WorkspaceID: "branch", BindingKind: "mythical-item", BindingID: uuidString(item.ID)}}}
	got, ok := todoConflictWait(item, wait, update, now)
	require.True(t, ok)
	require.Equal(t, []string{"a.txt"}, got.Paths)
	require.Equal(t, "run", got.Signal.Run)
	for _, tc := range []struct {
		name   string
		mutate func(*db.MythicalItem, *flowruntime.PendingWait, *flowdispatch.ProjectionUpdate)
	}{
		{"malformed", func(i *db.MythicalItem, w *flowruntime.PendingWait, u *flowdispatch.ProjectionUpdate) {
			w.Request = []byte(`{`)
		}},
		{"question", func(i *db.MythicalItem, w *flowruntime.PendingWait, u *flowdispatch.ProjectionUpdate) {
			w.Request = []byte(`{"kind":"ask","prompt":"Resolve"}`)
		}},
		{"stale change", func(i *db.MythicalItem, w *flowruntime.PendingWait, u *flowdispatch.ProjectionUpdate) {
			w.Request = []byte(`{"kind":"conflict","conflict_change":"other","onto_revision":"onto"}`)
		}},
		{"stale onto", func(i *db.MythicalItem, w *flowruntime.PendingWait, u *flowdispatch.ProjectionUpdate) {
			w.Request = []byte(`{"kind":"conflict","conflict_change":"change","onto_revision":"other"}`)
		}},
		{"no token", func(i *db.MythicalItem, w *flowruntime.PendingWait, u *flowdispatch.ProjectionUpdate) { w.Token = "" }},
		{"no name", func(i *db.MythicalItem, w *flowruntime.PendingWait, u *flowdispatch.ProjectionUpdate) { w.Name = "" }},
		{"no child", func(i *db.MythicalItem, w *flowruntime.PendingWait, u *flowdispatch.ProjectionUpdate) { w.RunID = "" }},
		{"foreign run", func(i *db.MythicalItem, w *flowruntime.PendingWait, u *flowdispatch.ProjectionUpdate) {
			u.Checkpoint.RunID = "other"
		}},
		{"foreign flow", func(i *db.MythicalItem, w *flowruntime.PendingWait, u *flowdispatch.ProjectionUpdate) {
			u.Checkpoint.FlowID = "other"
		}},
		{"foreign branch", func(i *db.MythicalItem, w *flowruntime.PendingWait, u *flowdispatch.ProjectionUpdate) {
			u.Checkpoint.Target.WorkspaceID = "other"
		}},
		{"missing pin", func(i *db.MythicalItem, w *flowruntime.PendingWait, u *flowdispatch.ProjectionUpdate) {
			i.FlowDigest.Valid = false
		}},
		{"no retained conflict", func(i *db.MythicalItem, w *flowruntime.PendingWait, u *flowdispatch.ProjectionUpdate) {
			i.Integration = []byte(`{}`)
		}},
		{"no reservation", func(i *db.MythicalItem, w *flowruntime.PendingWait, u *flowdispatch.ProjectionUpdate) {
			c := mythicalChecksOf(*i)
			c.ConflictReservation = nil
			i.Checks = c.encode()
		}},
		{"foreign reservation", func(i *db.MythicalItem, w *flowruntime.PendingWait, u *flowdispatch.ProjectionUpdate) {
			c := mythicalChecksOf(*i)
			c.ConflictReservation.Run = "other"
			i.Checks = c.encode()
		}},
		{"unattached", func(i *db.MythicalItem, w *flowruntime.PendingWait, u *flowdispatch.ProjectionUpdate) {
			c := mythicalChecksOf(*i)
			c.RunAttached = false
			i.Checks = c.encode()
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			i, w, u := item, wait, update
			tc.mutate(&i, &w, &u)
			_, ok := todoConflictWait(i, w, u, now)
			require.False(t, ok)
		})
	}
	update.Checkpoint.Run = &flowruntime.Run{RunID: "run", PendingWaits: []flowruntime.PendingWait{wait, wait}}
	for range 10 {
		mythicalProjectWaits(&item, mythicalProjection{Phase: "todo"}, update, "run", now)
	}
	require.Len(t, mythicalChecksOf(item).Waits, 1)
	require.Equal(t, "needs_you", todoState(item))
	update.Checkpoint.Run.PendingWaits[0].Token = "recovered-park"
	update.Checkpoint.Run.PendingWaits[0].Name = "recovered-conflict"
	mythicalProjectWaits(&item, mythicalProjection{Phase: "todo"}, update, "run", now)
	require.Len(t, mythicalChecksOf(item).Waits, 1, "a new runtime park cannot duplicate the retained branch conflict")
	recovered := mythicalChecksOf(item).Waits[0]
	require.Equal(t, "recovered-conflict", recovered.Signal.Name)
	require.Equal(t, got.ID, recovered.ID)
	require.Equal(t, got.Since, recovered.Since)
	require.Equal(t, []string{"a.txt"}, recovered.Paths)
	t.Run("failed repair keeps recovered Done address", func(t *testing.T) {
		copy := item
		copy.State = "failed"
		u := update
		u.Checkpoint.Run = &flowruntime.Run{RunID: "run", PendingWaits: []flowruntime.PendingWait{wait}}
		u.Checkpoint.Run.PendingWaits[0].Name = "failed-recovered"
		mythicalProjectWaits(&copy, mythicalProjection{Phase: "todo"}, u, "run", now)
		retained := mythicalChecksOf(copy).Waits[0]
		require.Equal(t, "failed-recovered", retained.Signal.Name)
		require.Equal(t, recovered.ID, retained.ID)
		require.Equal(t, recovered.Paths, retained.Paths)
		require.Nil(t, retained.SettledAt)
	})
	for _, state := range []string{"paused", "settled", "stale target"} {
		t.Run(state+" cannot retarget recovered wait", func(t *testing.T) {
			copy := item
			c := mythicalChecksOf(copy)
			u := update
			u.Checkpoint.Run = &flowruntime.Run{RunID: "run", PendingWaits: []flowruntime.PendingWait{wait}}
			u.Checkpoint.Run.PendingWaits[0].Name = "obsolete"
			switch state {
			case "paused":
				copy.PausedAt = pgtype.Timestamptz{Time: now, Valid: true}
			case "settled":
				c.Waits[0].SettledAt = &now
			case "stale target":
				c.Rebase.Onto = "moved"
			}
			copy.Checks = c.encode()
			mythicalProjectWaits(&copy, mythicalProjection{Phase: "todo"}, u, "run", now)
			require.Equal(t, c.Waits, mythicalChecksOf(copy).Waits)
		})
	}
	update.Checkpoint.Run.PendingWaits = nil
	mythicalProjectWaits(&item, mythicalProjection{Phase: "todo"}, update, "run", now)
	require.Nil(t, mythicalChecksOf(item).Waits[0].SettledAt, "absence is not native conflict resolution")
}

// E-19 launches repair separately without replacing the finite TODO run.
func TestConflictContinuationWaitKeepsAttemptAuthority(t *testing.T) {
	now := time.Unix(100, 0).UTC()
	item := db.MythicalItem{ID: pgtype.UUID{Bytes: [16]byte{1}, Valid: true}, RepositoryID: 1, Attempt: 3, State: "integrating", WorkspaceID: "branch", RequestRunID: "original-todo", FlowDigest: pgtype.Text{String: strings.Repeat("b", 64), Valid: true}, Integration: []byte(`{"conflict":{"head":"change","onto":"onto","paths":["actual.txt"]}}`)}
	checks := mythicalChecks{RunLaunched: true, RunAttached: true, FlowSource: strings.Repeat("a", 40), Rebase: &mythicalRebase{Onto: "onto"}, ConflictReservation: &todoConflictReservation{Change: "change", Onto: "onto", Run: "original-todo", Limit: 1, Reserved: 1, Dispatched: true, ResolutionRun: "repair"}}
	item.Checks = checks.encode()
	wait := flowruntime.PendingWait{RunID: "repair-child", Token: "park", Name: "conflict", Request: json.RawMessage(`{"kind":"conflict","conflict_change":"change","onto_revision":"onto","paths":["invented"]}`)}
	update := flowdispatch.ProjectionUpdate{State: jobs.StateWaiting, Scope: jobs.Scope{TenantID: "repository:1", PrincipalID: "user:1"}, Checkpoint: flowdispatch.RuntimeCheckpoint{FlowID: "coding/rebase-conflict", RunID: "repair", Target: flowruntime.Target{TenantID: "repository:1", PrincipalID: "user:1", WorkspaceID: "branch", BindingKind: "mythical-item", BindingID: uuidString(item.ID)}, Run: &flowruntime.Run{RunID: "repair", PendingWaits: []flowruntime.PendingWait{wait, wait}}}}
	for range 10 {
		mythicalProjectWaits(&item, mythicalProjection{Phase: "conflict"}, update, "repair", now)
	}
	got := mythicalChecksOf(item)
	require.Len(t, got.Waits, 1)
	require.Equal(t, []string{"actual.txt"}, got.Waits[0].Paths)
	require.Equal(t, "repair", got.Waits[0].Signal.Run)
	require.Equal(t, "original-todo", item.RequestRunID)
	require.EqualValues(t, 3, item.Attempt)
	require.Equal(t, 1, got.ConflictReservation.Reserved)
	for _, foreign := range []string{"original-todo", "unadmitted-repair"} {
		u := update
		u.Checkpoint.RunID = foreign
		_, accepted := todoConflictWait(item, wait, u, now)
		require.False(t, accepted, foreign)
	}
	u := update
	u.Checkpoint.FlowID = "todo"
	_, accepted := todoConflictWait(item, wait, u, now)
	require.False(t, accepted, "repair cannot impersonate the original flow")
	got.ConflictReservation.Run = "other-attempt"
	item.Checks = got.encode()
	_, accepted = todoConflictWait(item, wait, update, now)
	require.False(t, accepted, "repair cannot cross attempt authority")
}

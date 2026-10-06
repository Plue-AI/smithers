package services

import (
	"context"
	"encoding/json"
	"slices"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type todoWatchdog struct {
	Accepted     bool     `json:"accepted,omitempty"`
	ActiveMillis int64    `json:"activeMillis"`
	ActiveSince  int64    `json:"activeSince,omitempty"`
	Steps        []string `json:"steps,omitempty"`
}

func (w todoWatchdog) elapsed(now time.Time) int64 {
	if w.ActiveSince > 0 {
		return w.ActiveMillis + max(0, now.UnixMilli()-w.ActiveSince)
	}
	return w.ActiveMillis
}

func todoWatchdogEligible(item db.MythicalItem) bool {
	if !item.FlowDigest.Valid || item.Attempt <= 0 || item.PausedAt.Valid {
		return false
	}
	if w := mythicalChecksOf(item).Watchdog; w != nil && w.Accepted {
		return false
	}
	switch item.State {
	case "running", "integrating", "verifying":
		return true
	}
	return false
}

func acceptTodoWatchdog(item *db.MythicalItem, now time.Time) {
	checks := mythicalChecksOf(*item)
	if w := checks.Watchdog; w != nil {
		w.ActiveMillis, w.ActiveSince, w.Accepted = w.elapsed(now), 0, true
		item.Checks = checks.encode()
	}
}

// Bound events have already passed the current-attempt, pin and run fences.
// Step identities, rather than pages or counters supplied by repository code,
// make replay and resumed observation idempotent across engine launches.
func projectTodoWatchdog(item *db.MythicalItem, update flowdispatch.ProjectionUpdate, now time.Time) {
	if item.PausedAt.Valid {
		checks := mythicalChecksOf(*item)
		if w := checks.Watchdog; w != nil && w.ActiveSince > 0 {
			w.ActiveMillis = w.elapsed(item.PausedAt.Time)
			w.ActiveSince = 0
			item.Checks = checks.encode()
		}
		return
	}
	if !todoWatchdogEligible(*item) {
		return
	}
	checks := mythicalChecksOf(*item)
	if checks.Watchdog == nil {
		checks.Watchdog = &todoWatchdog{}
	}
	w := checks.Watchdog
	until := now
	if run := update.Checkpoint.Run; run != nil {
		for _, wait := range run.PendingWaits {
			if wait.CreatedAt > 0 && int64(wait.CreatedAt) < until.UnixMilli() {
				until = time.UnixMilli(int64(wait.CreatedAt))
			}
		}
	}
	// A launch receipt binds a real run before its first observation. Start
	// the timer here even if its JavaScript body never yields to observe.
	active := update.Checkpoint.RunID != "" && !update.State.Terminal()
	if run := update.Checkpoint.Run; run != nil {
		active = run.Status == "running" && run.ExecutionObservation != "suspended" && len(run.PendingWaits) == 0
	}
	if active && w.ActiveSince == 0 {
		w.ActiveSince = now.UnixMilli()
	} else if !active && w.ActiveSince > 0 {
		w.ActiveMillis = w.elapsed(until)
		w.ActiveSince = 0
	}
	for _, event := range update.Events {
		if len(w.Steps) >= 1024 {
			break
		}
		if identity, ok := todoCompletedStep(event); ok && !slices.Contains(w.Steps, identity) {
			w.Steps = append(w.Steps, identity)
		}
	}
	item.Checks = checks.encode()
}

// The native host projects journal envelopes through control.engine.event.
// Retained v2 lifecycle records decode to the same instance identity; transport
// cursors and event ids never spend an additional step on replay.
func todoCompletedStep(event flowruntime.Event) (string, bool) {
	var execution, digest, state string
	var attempt *int64
	switch event.Kind {
	case "control.engine.event":
		var envelope struct {
			Version     int    `json:"version"`
			EventType   string `json:"eventType"`
			ExecutionID string `json:"executionId"`
			Payload     struct {
				RunID         string `json:"runId"`
				StepKeyDigest string `json:"stepKeyDigest"`
				Attempt       *int64 `json:"attempt"`
				State         string `json:"state"`
			} `json:"payload"`
		}
		if json.Unmarshal(event.Payload, &envelope) != nil || envelope.Version != 1 ||
			envelope.EventType != "flows.engine.attempt-finished" || envelope.ExecutionID != envelope.Payload.RunID ||
			envelope.Payload.Attempt == nil || *envelope.Payload.Attempt < 1 {
			return "", false
		}
		execution, digest, state, attempt = envelope.ExecutionID, envelope.Payload.StepKeyDigest, envelope.Payload.State, envelope.Payload.Attempt
	case "flows.engine.v2.attempt-lifecycle":
		var step struct {
			Version       int    `json:"version"`
			ExecutionID   string `json:"executionId"`
			StepKeyDigest string `json:"stepKeyDigest"`
			Attempt       *int64 `json:"attempt"`
			Lifecycle     struct {
				State string `json:"state"`
			} `json:"lifecycle"`
		}
		if json.Unmarshal(event.Payload, &step) != nil || step.Version != 2 || step.Attempt == nil || *step.Attempt < 0 {
			return "", false
		}
		execution, digest, state, attempt = step.ExecutionID, step.StepKeyDigest, step.Lifecycle.State, step.Attempt
	default:
		return "", false
	}
	if execution == "" || len(execution) > 1024 || digest == "" || len(digest) > 1024 ||
		(state != "succeeded" && state != "failed") {
		return "", false
	}
	encoded, _ := json.Marshal([]any{execution, digest, *attempt})
	return string(encoded), true
}

// This timer runs in the install's stack worker, outside the guest event loop.
// A repository flow that does not yield cannot disable its persisted deadline.
func (st *mythicalItemStep) enforceTodoWatchdog(ctx context.Context, item db.MythicalItem) (*db.MythicalItem, bool, error) {
	checks := mythicalChecksOf(item)
	if !todoWatchdogEligible(item) || checks.Watchdog == nil ||
		(checks.Watchdog.elapsed(st.now) < (4*time.Hour).Milliseconds() && len(checks.Watchdog.Steps) < 1024) {
		return nil, false, nil
	}
	next := *mythicalFailure(item, "the TODO allowance ended", mythicalFailPlan, "failed: no_proposal", st.now)
	next.RequestOutcome = "failed: no_proposal"
	tx, err := st.s.store.Begin(ctx)
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	if _, err = tx.Exec(ctx, `SELECT 1 FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, item.RepositoryID); err != nil {
		return nil, false, err
	}
	if err = st.s.cancelAttempt(ctx, tx, st.r.row, item); err != nil {
		return nil, false, err
	}
	saved, err := db.New(tx).SaveMythicalItem(ctx, next)
	if err != nil {
		return nil, false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, false, err
	}
	// Retire through the machine runtime, which owns process termination and
	// does not need the repository's JavaScript loop to answer a cancellation.
	if saved.WorkspaceID != "" && st.s.lanes != nil {
		if err := st.s.retireLane(ctx, st.r, saved.WorkspaceID); err != nil {
			st.s.logger.Warn("todo.watchdog_retirement_failed", "item", uuidString(saved.ID), "error", err)
		}
	}
	return &saved, true, nil
}

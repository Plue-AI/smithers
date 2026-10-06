package services

import (
	"encoding/json"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Only an observation position is retained here. The existing Plan and Route
// fields hold their values; a submitted candidate always supplies its own plan.
type todoRequestReceipt struct {
	Attempt int32                   `json:"attempt"`
	RunID   string                  `json:"runId"`
	Cursor  flowruntime.EventCursor `json:"cursor"`
}

// Called after the attempt, pin and run fences. PreparePlan is the completed
// planner boundary; its PrepareRequest wrapper is not a second plan. Built-in
// request passes are sequential; the native projection preserves their durable
// child/round order. Keep the last observed
// preparation in that journal, without ordering by a machine's wall clock.
// This is untrusted continuation context, never candidate/check authority.
func projectTodoPlan(item *db.MythicalItem, projection mythicalProjection, update flowdispatch.ProjectionUpdate) {
	if !mythicalTodo(*item) || (projection.Phase != "todo" && projection.Phase != "request") ||
		item.RequestRunID == "" || item.RequestRunID != update.Checkpoint.RunID {
		return
	}
	checks := mythicalChecksOf(*item)
	for _, event := range update.Events {
		if event.RunID != item.RequestRunID {
			continue
		}
		cursor := flowruntime.EventCursor{Sequence: event.Sequence}
		if event.Cursor != nil {
			cursor = *event.Cursor
		}
		if cursor.Sequence < 0 || (cursor.Offset != nil && *cursor.Offset < 0) {
			continue
		}
		if prior := checks.RouteReceipt; prior == nil || prior.Attempt != item.Attempt || prior.RunID != item.RequestRunID || todoPlanAfter(cursor, prior.Cursor) {
			if route := mythicalRouteJSON(todoNativeResult(event, "factory/Todo")); route != "" {
				checks.Route = route
				checks.RouteReceipt = &todoRequestReceipt{Attempt: item.Attempt, RunID: item.RequestRunID, Cursor: cursor}
			}
		}
		if item.CandidateHead != "" {
			continue // A routed decision remains useful; an admitted candidate owns its plan.
		}
		if prior := checks.PlanReceipt; prior != nil && prior.Attempt == item.Attempt && prior.RunID == item.RequestRunID && !todoPlanAfter(cursor, prior.Cursor) {
			continue
		}
		if plan := todoNativePlan(event); plan != nil {
			item.Plan = plan
			checks.PlanReceipt = &todoRequestReceipt{Attempt: item.Attempt, RunID: item.RequestRunID, Cursor: cursor}
		}
	}
	item.Checks = checks.encode()
}

func todoPlanAfter(next, previous flowruntime.EventCursor) bool {
	if next.Sequence != previous.Sequence {
		return next.Sequence > previous.Sequence
	}
	// A nil offset is the complete legacy sequence, after every partial member.
	if previous.Offset == nil {
		return false
	}
	return next.Offset == nil || *next.Offset > *previous.Offset
}

func todoNativePlan(event flowruntime.Event) json.RawMessage {
	plan := todoNativeResult(event, "coding/PreparePlan")
	if plan == nil {
		return nil
	}
	wrapped, _ := json.Marshal(struct {
		Plan json.RawMessage `json:"plan"`
	}{Plan: plan})
	return mythicalPlanSummaryJSON(wrapped)
}

// Read only a completed native flow fact whose envelope and state agree.
// Router results remain available when a later typed error has no route field.
func todoNativeResult(event flowruntime.Event, flowName string) json.RawMessage {
	if event.Kind != "control.engine.event" {
		return nil
	}
	var envelope struct {
		Version     int    `json:"version"`
		ExecutionID string `json:"executionId"`
		Generation  *int64 `json:"generation"`
		Sequence    *int64 `json:"sequence"`
		EventType   string `json:"eventType"`
		Payload     struct {
			Decision      string `json:"decision"`
			Status        string `json:"status"`
			ExecutionFact struct {
				Version     int    `json:"version"`
				Baseline    string `json:"baseline"`
				Observation struct {
					ExecutionID string `json:"executionId"`
					FlowName    string `json:"flowName"`
					Status      string `json:"status"`
				} `json:"observation"`
			} `json:"executionFact"`
			State struct {
				Version  int    `json:"version"`
				FlowName string `json:"flowName"`
				Result   struct {
					Tag  string `json:"_tag"`
					Exit struct {
						Tag   string          `json:"_tag"`
						Value json.RawMessage `json:"value"`
					} `json:"exit"`
				} `json:"result"`
			} `json:"state"`
		} `json:"payload"`
	}
	if json.Unmarshal(event.Payload, &envelope) != nil || envelope.Version != 1 || envelope.ExecutionID == "" ||
		envelope.Generation == nil || *envelope.Generation < 0 || envelope.Sequence == nil || *envelope.Sequence < 0 ||
		envelope.EventType != "flows.engine.run-decision" {
		return nil
	}
	p := envelope.Payload
	fact, state := p.ExecutionFact, p.State
	if p.Decision != "transitioned" || p.Status != "completed" || fact.Version != 1 ||
		(fact.Baseline != "created" && fact.Baseline != "legacy") ||
		fact.Observation.ExecutionID != envelope.ExecutionID || fact.Observation.Status != "completed" ||
		fact.Observation.FlowName != flowName || state.Version != 1 || state.FlowName != flowName ||
		state.Result.Tag != "Complete" || state.Result.Exit.Tag != "Success" || len(state.Result.Exit.Value) == 0 ||
		len(state.Result.Exit.Value) > 1<<20 { // Same plan bound as candidate admission.
		return nil
	}
	return state.Result.Exit.Value
}

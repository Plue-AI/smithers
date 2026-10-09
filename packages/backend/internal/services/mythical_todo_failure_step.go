package services

import (
	"encoding/json"
	"strings"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// The native journal already names the failed action. Retain that observation
// with its attempt and typed error, so a caught error or a later attempt cannot
// mislabel the terminal failure. This changes no runtime wire contract.
type todoFailureStep struct {
	Attempt int32                   `json:"attempt"`
	Run     string                  `json:"run"`
	Action  string                  `json:"action"`
	Tag     string                  `json:"tag"`
	Cursor  flowruntime.EventCursor `json:"cursor"`
}

func projectTodoFailureStep(item *db.MythicalItem, projection mythicalProjection, update flowdispatch.ProjectionUpdate) {
	if !mythicalTodo(*item) || projection.Phase != "todo" || item.RequestRunID == "" || item.RequestRunID != update.Checkpoint.RunID {
		return
	}
	checks := mythicalChecksOf(*item)
	for _, event := range update.Events {
		if event.RunID != item.RequestRunID || event.Kind != "control.engine.event" {
			continue
		}
		cursor := flowruntime.EventCursor{Sequence: event.Sequence}
		if event.Cursor != nil {
			cursor = *event.Cursor
		}
		if cursor.Sequence < 0 || (cursor.Offset != nil && *cursor.Offset < 0) {
			continue
		}
		if prior := checks.FailureStep; prior != nil && prior.Attempt == item.Attempt && prior.Run == item.RequestRunID && !todoPlanAfter(cursor, prior.Cursor) {
			continue
		}
		var envelope struct {
			Version     int    `json:"version"`
			ExecutionID string `json:"executionId"`
			EventType   string `json:"eventType"`
			Payload     struct {
				StepKeyDigests []string `json:"stepKeyDigests"`
				NodeID         string   `json:"nodeId"`
				Action         string   `json:"action"`
				Outcome        string   `json:"outcome"`
				Result         *struct {
					Preview   string `json:"preview"`
					Truncated bool   `json:"truncated"`
				} `json:"result"`
			} `json:"payload"`
		}
		if json.Unmarshal(event.Payload, &envelope) != nil || envelope.Version != 1 || envelope.ExecutionID == "" || envelope.EventType != "flows.engine.node-settled" {
			continue
		}
		p := envelope.Payload
		if len(p.StepKeyDigests) == 0 || p.NodeID == "" || p.Action == "" || len(p.Action) > 256 || strings.ContainsAny(p.Action, "\r\n\x00") || p.Outcome != "failed" || p.Result == nil || p.Result.Truncated || len(p.Result.Preview) > 1<<16 {
			continue
		}
		var failure struct {
			Tag  string `json:"_tag"`
			Code string `json:"code"`
		}
		if json.Unmarshal([]byte(p.Result.Preview), &failure) != nil || failure.Tag == "" || len(failure.Tag) > 256 || len(failure.Code) > 256 {
			continue
		}
		tag := failure.Tag
		if failure.Code != "" {
			tag += "/" + failure.Code
		}
		// Propagated factory errors must not replace the check action that failed.
		if tag == "coding/Error/check_configuration" && !todoCheckFailureAction(p.Action) {
			continue
		}
		checks.FailureStep = &todoFailureStep{Attempt: item.Attempt, Run: item.RequestRunID, Action: p.Action, Tag: tag, Cursor: cursor}
	}
	item.Checks = checks.encode()
}

func todoCheckFailureAction(action string) bool {
	return action == "coding/check-command" || action == "coding/check" || action == "coding/CommandCheck" || strings.HasPrefix(action, "checks/")
}

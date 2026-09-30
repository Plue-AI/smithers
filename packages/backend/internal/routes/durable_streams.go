package routes

import (
	"context"
	"encoding/json"
	"strconv"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
)

func (h *AgentSessionStreamHandler) durableAgentMessages(sessionID string) *sse.DurableStream {
	return &sse.DurableStream{
		Head: func(ctx context.Context) (int64, error) { return h.Service.GetAgentMessageStreamHead(ctx, sessionID) },
		Validate: func(ctx context.Context, cursor int64) error {
			rows, err := h.Service.ListMessagesAfterID(ctx, sessionID, cursor-1, 1)
			if err != nil {
				return err
			}
			if len(rows) == 0 || rows[0].ID != cursor {
				return pkgerrors.UnknownCursor("agent session cursor is not a message of this session")
			}
			return nil
		},
		Load: func(ctx context.Context, after int64, limit int) (sse.DurablePage, error) {
			rows, err := h.Service.ListMessagesAfterID(ctx, sessionID, after, limit)
			if err != nil {
				return sse.DurablePage{}, err
			}
			page := sse.DurablePage{Cursor: after, More: len(rows) == limit}
			for _, row := range rows {
				data, err := marshalAgentSessionReplayPayload(services.AgentSessionMessageEvent(row))
				if err != nil {
					return sse.DurablePage{}, err
				}
				page.Events = append(page.Events, sse.Event{ID: strconv.FormatInt(row.ID, 10), Type: "agent.session", Data: string(data)})
				page.Cursor = row.ID
			}
			return page, nil
		},
		Ephemeral: func(hint sse.Event) (sse.Event, bool) {
			var payload struct {
				Action string `json:"action"`
			}
			if json.Unmarshal([]byte(hint.Data), &payload) != nil || payload.Action != "status" {
				return sse.Event{}, false
			}
			return sse.Event{Type: "agent.session", Data: hint.Data}, true
		},
	}
}

func (h *WorkflowRunHandler) durableWorkflowLogs(runID int64) *sse.DurableStream {
	return &sse.DurableStream{
		Head: func(ctx context.Context) (int64, error) { return h.Service.GetWorkflowLogStreamHead(ctx, runID) },
		Validate: func(ctx context.Context, cursor int64) error {
			rows, err := h.Service.ListWorkflowLogsSince(ctx, runID, cursor-1, 1)
			if err != nil {
				return err
			}
			if len(rows) == 0 || rows[0].ID != cursor {
				return pkgerrors.UnknownCursor("run log cursor is not a retained log line of this run")
			}
			return nil
		},
		Load: func(ctx context.Context, after int64, limit int) (sse.DurablePage, error) {
			rows, err := h.Service.ListWorkflowLogsSince(ctx, runID, after, int32(limit))
			if err != nil {
				return sse.DurablePage{}, err
			}
			page := sse.DurablePage{Cursor: after, More: len(rows) == limit}
			for _, row := range rows {
				// Keep both the historical replay fields and the live writer's fields.
				// Every client now receives the same canonical persisted representation.
				data, err := marshalWorkflowRunReplayPayload(map[string]any{
					"log_id": row.ID, "step": row.WorkflowStepID, "line": row.Sequence, "content": row.Entry,
					"workflow_step_id": row.WorkflowStepID, "sequence": row.Sequence, "entry": row.Entry, "stream": row.Stream,
				})
				if err != nil {
					return sse.DurablePage{}, err
				}
				page.Events = append(page.Events, sse.Event{ID: strconv.FormatInt(row.ID, 10), Type: "log", Data: string(data)})
				page.Cursor = row.ID
			}
			return page, nil
		},
	}
}

func (h *NotificationHandler) durableNotifications(userID int64) *sse.DurableStream {
	return &sse.DurableStream{
		Head: func(ctx context.Context) (int64, error) { return h.Service.GetNotificationStreamHead(ctx, userID) },
		Load: func(ctx context.Context, after int64, limit int) (sse.DurablePage, error) {
			rows, err := h.Service.ListNotificationStreamPage(ctx, userID, after, limit)
			if err != nil {
				return sse.DurablePage{}, err
			}
			page := sse.DurablePage{Cursor: rows.Cursor, More: rows.More}
			for _, row := range rows.Items {
				data, err := json.Marshal(row)
				if err != nil {
					return sse.DurablePage{}, err
				}
				page.Events = append(page.Events, sse.Event{ID: strconv.FormatInt(row.ID, 10), Type: "notification", Data: string(data)})
			}
			return page, nil
		},
	}
}

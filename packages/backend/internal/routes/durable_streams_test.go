package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
)

func TestDurableRouteReplaysOverOneThousand(t *testing.T) {
	for _, kind := range []string{"agent", "workflow", "notification"} {
		t.Run(kind, func(t *testing.T) {
			var stream *sse.DurableStream
			ids := func(after int64, limit int) []int64 {
				var result []int64
				for id := (after/2 + 1) * 2; id <= 5004 && len(result) < limit; id += 2 {
					result = append(result, id)
				}
				return result
			}
			switch kind {
			case "agent":
				stream = (&AgentSessionStreamHandler{Service: &mockAgentSessionStreamService{listMessagesAfterIDFn: func(_ context.Context, _ string, after int64, limit int) ([]services.AgentMessageResponse, error) {
					var rows []services.AgentMessageResponse
					for _, id := range ids(after, limit) {
						rows = append(rows, services.AgentMessageResponse{ID: id, SessionID: "session", Role: "assistant", Sequence: id / 2})
					}
					return rows, nil
				}}}).durableAgentMessages("session")
			case "workflow":
				stream = (&WorkflowRunHandler{Service: &mockWorkflowRunRouteService{listWorkflowLogsSinceFn: func(_ context.Context, _ int64, after int64, limit int32) ([]db.WorkflowLog, error) {
					var rows []db.WorkflowLog
					for _, id := range ids(after, int(limit)) {
						rows = append(rows, db.WorkflowLog{ID: id, WorkflowStepID: 10, Sequence: id / 2, Entry: "hello", Stream: "stdout"})
					}
					return rows, nil
				}}}).durableWorkflowLogs(1)
			case "notification":
				stream = (&NotificationHandler{Service: &mockNotificationRouteService{listAfterIDFn: func(_ context.Context, _ int64, after int64, limit int) ([]services.NotificationResponse, error) {
					var rows []services.NotificationResponse
					for _, id := range ids(after, limit) {
						rows = append(rows, services.NotificationResponse{ID: id, Subject: "hello"})
					}
					return rows, nil
				}}}).durableNotifications(1)
			}
			req := httptest.NewRequest(http.MethodGet, "/stream", nil)
			req.Header.Set("Last-Event-ID", "2")
			rec := httptest.NewRecorder()
			stream.OnConnect(rec, req, rec)
			require.NotContains(t, rec.Body.String(), "stream.error")
			require.Equal(t, 2501, strings.Count(rec.Body.String(), "id: "))
			require.Contains(t, rec.Body.String(), "id: 5004\n")
			// Simulate duplicate/out-of-order notification wakeups after replay.
			original := rec.Body.String()
			stream.OnConnect(rec, req, rec)
			require.Equal(t, original, rec.Body.String())
			if kind == "workflow" {
				for _, line := range strings.Split(original, "\n") {
					if !strings.HasPrefix(line, "data: ") {
						continue
					}
					var payload map[string]any
					require.NoError(t, json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &payload))
					require.Equal(t, payload["step"], payload["workflow_step_id"])
					require.Equal(t, payload["line"], payload["sequence"])
					require.Equal(t, payload["content"], payload["entry"])
					require.Equal(t, "stdout", payload["stream"])
					break
				}
			}
		})
	}
}

func TestDurableAgentStatusRemainsEphemeralAndCannotAdvanceMessageCursor(t *testing.T) {
	stream := (&AgentSessionStreamHandler{Service: &mockAgentSessionStreamService{}}).durableAgentMessages("session")
	for _, payload := range []string{`{"action":"message","message":{"id":999}}`, `{"id":999}`, `bad-json`} {
		_, ok := stream.Ephemeral(sse.Event{Data: payload})
		require.False(t, ok)
	}
	event, ok := stream.Ephemeral(sse.Event{ID: strconv.Itoa(999), Data: `{"action":"status","status":"completed"}`})
	require.True(t, ok)
	require.Empty(t, event.ID)
	require.Equal(t, "agent.session", event.Type)
}

func TestDurableRouteResumeCursorMustNameARetainedRecord(t *testing.T) {
	ctx := context.Background()
	offline := errors.New("store offline")
	t.Run("agent", func(t *testing.T) {
		rows := map[int64]bool{7: true}
		newStream := func(err error) *sse.DurableStream {
			return (&AgentSessionStreamHandler{Service: &mockAgentSessionStreamService{listMessagesAfterIDFn: func(_ context.Context, _ string, after int64, _ int) ([]services.AgentMessageResponse, error) {
				if err != nil {
					return nil, err
				}
				if rows[after+1] {
					return []services.AgentMessageResponse{{ID: after + 1}}, nil
				}
				return nil, nil
			}}}).durableAgentMessages("session")
		}
		require.NoError(t, newStream(nil).Validate(ctx, 7))
		require.True(t, pkgerrors.IsUnknownCursor(newStream(nil).Validate(ctx, 8)))
		require.ErrorIs(t, newStream(offline).Validate(ctx, 7), offline)
	})
	t.Run("workflow", func(t *testing.T) {
		newStream := func(err error) *sse.DurableStream {
			return (&WorkflowRunHandler{Service: &mockWorkflowRunRouteService{listWorkflowLogsSinceFn: func(_ context.Context, _ int64, after int64, _ int32) ([]db.WorkflowLog, error) {
				if err != nil {
					return nil, err
				}
				if after+1 == 7 {
					return []db.WorkflowLog{{ID: 7}}, nil
				}
				return nil, nil
			}}}).durableWorkflowLogs(1)
		}
		require.NoError(t, newStream(nil).Validate(ctx, 7))
		require.True(t, pkgerrors.IsUnknownCursor(newStream(nil).Validate(ctx, 8)))
		require.ErrorIs(t, newStream(offline).Validate(ctx, 7), offline)
	})
}

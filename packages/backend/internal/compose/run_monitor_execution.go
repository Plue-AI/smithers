package compose

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func (m *runMonitors) serveExecutionTrace(w http.ResponseWriter, r *http.Request, q *db.Queries) {
	repository, _, err := installRepository(r.Context(), q)
	if err != nil {
		writeConfirmationDispatchError(w, err)
		return
	}
	id, decodeErr := url.PathUnescape(chi.URLParam(r, "id"))
	if decodeErr != nil {
		browserFlowTyped(w, 400, "invalid_request", "Invalid run")
		return
	}
	raw, err := services.ReadInstallExecutionMonitor(r.Context(), m.pool, repository, id, func(ctx context.Context, subject services.InstallSubject) (json.RawMessage, error) {
		var at *int64
		if r.URL.Query().Has("at") {
			n, err := strconv.ParseInt(r.URL.Query().Get("at"), 10, 64)
			if err != nil || n < 0 {
				return nil, &services.TodoControlError{Status: 400, Class: "user", Code: "invalid_request", Message: "Invalid replay position"}
			}
			at = &n
		}
		checkpoints, err := m.checkpoints(ctx, repository, id)
		if err != nil {
			return nil, err
		}
		if len(checkpoints) != 1 || checkpoints[0].RunID != subject.RunID || checkpoints[0].Target.WorkspaceID != subject.WorkspaceID {
			return nil, &services.AccessError{Status: 403, Class: "permission", Code: "permission", Message: "Not available"}
		}
		value, err := m.readCheckpoint(ctx, repository, id, at, checkpoints[0])
		if err != nil {
			return nil, err
		}
		return executionMonitorProjection(value, subject)
	})
	if err != nil {
		var access *services.AccessError
		var control *services.TodoControlError
		if errors.As(err, &access) || errors.As(err, &control) {
			writeConfirmationDispatchError(w, err)
		} else {
			browserFlowTyped(w, 503, "run_unavailable", "Run unavailable")
		}
		return
	}
	browserFlowJSON(w, 200, raw)
}

// The person monitor includes approvals, input/output previews and private
// conversation text. Execution credentials receive only lifecycle facts from
// their own native journal, never arbitrary payload fields or display cells.
func executionMonitorProjection(raw json.RawMessage, subject services.InstallSubject) (json.RawMessage, error) {
	var source struct {
		ID      string `json:"id"`
		Flow    string `json:"flow"`
		Version string `json:"version"`
		State   string `json:"state"`
		Journal []struct {
			Sequence int64  `json:"seq"`
			At       string `json:"at"`
			Type     string `json:"type"`
			Text     string `json:"text"`
		} `json:"journal"`
	}
	if err := json.Unmarshal(raw, &source); err != nil {
		return nil, err
	}
	type event struct {
		Sequence int64  `json:"seq"`
		At       string `json:"at"`
		Type     string `json:"type"`
		Node     string `json:"node,omitempty"`
		Action   string `json:"action,omitempty"`
		Outcome  string `json:"outcome,omitempty"`
	}
	events := []event{}
	for _, row := range source.Journal {
		if row.Type != "control.engine.event" {
			continue
		}
		var envelope struct {
			Type    string `json:"eventType"`
			Payload struct {
				Node    string `json:"nodeId"`
				Action  string `json:"action"`
				Outcome string `json:"outcome"`
			} `json:"payload"`
		}
		if json.Unmarshal([]byte(row.Text), &envelope) != nil || row.Sequence < 0 {
			return nil, errors.New("invalid execution journal")
		}
		if _, err := time.Parse(time.RFC3339Nano, row.At); err != nil {
			return nil, errors.New("invalid execution timestamp")
		}
		switch envelope.Type {
		case "flows.engine.node-started", "flows.engine.node-settled", "flows.engine.node-failed", "flows.engine.attempt-started", "flows.engine.attempt-finished", "flows.engine.interrupted":
			events = append(events, event{row.Sequence, row.At, envelope.Type, envelope.Payload.Node, envelope.Payload.Action, envelope.Payload.Outcome})
		}
	}
	return json.Marshal(struct {
		ID      string  `json:"id"`
		Flow    string  `json:"flow"`
		Version string  `json:"version"`
		State   string  `json:"state"`
		Todo    int64   `json:"todo"`
		Attempt int32   `json:"attempt"`
		Events  []event `json:"events"`
	}{source.ID, source.Flow, source.Version, source.State, subject.TodoNumber, subject.Attempt, events})
}

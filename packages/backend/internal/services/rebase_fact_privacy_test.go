package services

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// A fixed writer census makes accidental publication observable. PostgreSQL
// and the production card/fact builders are real; the composed socket test
// separately exercises authenticated daemon-session attribution.
func TestRebaseWriterNeverEntersSharedTodoFact(t *testing.T) {
	h := newMergeHarness(t)
	item := h.todo("Private writer", "Keep the writer private", h.main, "writer.md", "writer\n")
	checks := mythicalChecksOf(item)
	checks.Rebase = &mythicalRebase{Onto: h.main, Name: "main", BlockingBoot: "0123456789abcdef0123456789abcdef", BlockingSession: 7, Request: &mythicalRebaseRequest{User: h.userID}}
	item.Checks = checks.encode()
	writer := map[string]any{"actor": map[string]any{"kind": "person", "login": "ben"}, "terminal": "terminal-ben"}
	h.service.SetRebaseBlockerReader(func(context.Context, string, string, uint32) (map[string]any, error) { return writer, nil })
	private, err := h.service.todoCard(h.ctx, item, nil)
	require.NoError(t, err)
	require.Equal(t, writer, private["rebase_pending"].(map[string]any)["waiting_for"])
	tx, err := h.pool.Begin(h.ctx)
	require.NoError(t, err)
	defer tx.Rollback(h.ctx)
	event, err := h.service.recordTodoFact(h.ctx, tx, item, uuid.NewString(), "todo.run_updated", todoState(item), json.RawMessage(`{}`))
	require.NoError(t, err)
	var fact struct {
		Card struct {
			Rebase map[string]any `json:"rebase_pending"`
		} `json:"card"`
	}
	require.NoError(t, json.Unmarshal(event.Data, &fact))
	require.Equal(t, map[string]any{"onto": "main", "onto_revision": h.main}, fact.Card.Rebase)
	// Recording a shared fact does not remove the requester's private read.
	private, err = h.service.todoCard(h.ctx, item, nil)
	require.NoError(t, err)
	require.Equal(t, writer, private["rebase_pending"].(map[string]any)["waiting_for"])
}

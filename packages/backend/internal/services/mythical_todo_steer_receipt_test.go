package services

import (
	"encoding/json"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestGitHubEditedSteerReceiptPreservesConsumedRetryFeedback(t *testing.T) {
	o, synced, row, item := newReviewConsumer(t)
	consume := func(fact gitHubFetchedObject) {
		require.NoError(t, pgx.BeginFunc(t.Context(), o.pool, func(tx pgx.Tx) error {
			_, err := synced.install.consumers[gitHubReviews](t.Context(), tx, fact)
			return err
		}))
	}
	first := reviewFact(row, 77, "first", "CHANGES_REQUESTED")
	consume(first)
	next := o.byID(uuidString(item.ID))
	original := mythicalChecksOf(next).Steers[0]
	edited := reviewFact(row, 77, "edited", "CHANGES_REQUESTED")
	var object map[string]any
	require.NoError(t, json.Unmarshal(edited.Object, &object))
	object["body"] = "Corrected helper"
	object["submitted_at"] = "2026-10-05T10:01:00Z"
	edited.Object, _ = json.Marshal(object)
	consume(edited)
	next = o.byID(uuidString(item.ID))
	feedback := mythicalChecksOf(next).Steers[0]
	require.EqualValues(t, 2, feedback.InputVersion)
	require.Equal(t, original.Text, feedback.Text, "Retry sees only the last runtime-accepted payload")
	require.Equal(t, "Corrected helper", feedback.EditText)
	projection, _ := json.Marshal(map[string]any{"kind": "mythical-steer", "itemId": uuidString(item.ID), "input": feedback.ID, "inputVersion": 2, "runId": next.RequestRunID, "attempt": next.Attempt})
	body := original.Text
	update := flowdispatch.ProjectionUpdate{Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: projection, RunID: next.RequestRunID, MutationReceipt: &flowruntime.Receipt{Tag: "AlreadyApplied", InputConsumed: true, InputBody: &body}}}
	require.NoError(t, o.service.ProjectFlowRuntime(t.Context(), update))
	require.NoError(t, o.service.ProjectFlowRuntime(t.Context(), update))
	next = o.byID(uuidString(item.ID))
	feedback = mythicalChecksOf(next).Steers[0]
	require.True(t, feedback.InputConsumed)
	require.Equal(t, "Corrected helper", feedback.EditText, "lost acknowledgements still authorize replay of the admitted version")
	require.Equal(t, original.Text, feedback.Text)
	// The third edit is activity-only after the runtime attested consumption.
	object["body"] = "Too late"
	object["submitted_at"] = "2026-10-05T10:02:00Z"
	edited.Object, _ = json.Marshal(object)
	edited.Version = "third"
	consume(edited)
	next = o.byID(uuidString(item.ID))
	require.Equal(t, original.Text, mythicalChecksOf(next).Steers[0].Text)
	require.Equal(t, "Too late", mythicalChecksOf(next).GitHubInputs[0].Text)
	var count int
	require.NoError(t, o.pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.steer'`).Scan(&count))
	require.Equal(t, 2, count)
	// Neither a different run nor a stale input version may overwrite feedback.
	body = "Forged"
	update.Checkpoint.RunID = "old-run"
	require.NoError(t, o.service.ProjectFlowRuntime(t.Context(), update))
	got, err := db.New(o.pool).GetMythicalItem(t.Context(), item.ID)
	require.NoError(t, err)
	require.Equal(t, original.Text, mythicalChecksOf(got).Steers[0].Text)
}

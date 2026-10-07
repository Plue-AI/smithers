package services

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestTodoSettledAttemptKeepsDomainOutcome(t *testing.T) {
	for _, outcome := range []string{"dropped", "merged"} {
		t.Run(outcome, func(t *testing.T) {
			item := db.MythicalItem{Source: "todo", State: "proposed", Attempt: 3, Generation: 7, RequestRunID: "attempt-three", CandidateHead: "accepted", FlowDigest: pgtype.Text{String: todoPinOne, Valid: true}, Checks: mythicalChecks{FlowSource: "original-source"}.encode()}
			now := time.Unix(123, 0).UTC()
			var settled db.MythicalItem
			if outcome == "dropped" {
				settled = mythicalDropped(item, todoDrop{By: "alice", At: now})
			} else {
				settled = mythicalLanded(item, "merge", now)
			}
			rows := mythicalChecksOf(settled).Attempts
			require.Len(t, rows, 1, "settlement retains the attempt in the same item mutation")
			raw, err := json.Marshal(rows[0])
			require.NoError(t, err)
			var record map[string]any
			require.NoError(t, json.Unmarshal(raw, &record))
			require.Equal(t, outcome, record["outcome"])
			require.Equal(t, "attempt-three", record["run_id"])
			require.Equal(t, todoPinOne, record["flow_digest"])
			require.Equal(t, "original-source", record["source_commit"])
			require.Equal(t, float64(7), record["generation"])
			require.Equal(t, "accepted", record["revision"])
			// A late terminal callback or opposite settlement cannot rewrite the first
			// domain result, its original run/pin, or the accepted candidate evidence.
			late := settled
			late.RequestRunID = "late-run"
			late.RequestOutcome = "cancelled"
			late.CandidateHead = "late-candidate"
			late.Generation++
			late.FlowDigest.String = todoPinTwo
			checks := mythicalChecksOf(late)
			checks.FlowSource = "late-source"
			late.Checks = checks.encode()
			late = retainTodoAttemptEvidence(late)
			require.Equal(t, rows, mythicalChecksOf(late).Attempts)
			require.Equal(t, rows[0], currentTodoEvidence(late))
			if outcome == "dropped" {
				late = mythicalLanded(late, "late-merge", now.Add(time.Second))
			} else {
				late = mythicalDropped(late, todoDrop{By: "bob", At: now.Add(time.Second)})
			}
			require.Equal(t, rows, mythicalChecksOf(late).Attempts, "first domain outcome wins")
			// Reopening still presents attempt 3's frozen evidence. New work archives
			// it unchanged; only attempt 4 gets a fresh binding and candidate.
			late = settled
			late.State = "proposed"
			checks = mythicalChecksOf(late)
			checks.GitHubReopenedAttempt = 3
			late.Checks = checks.encode()
			late = queueReopenedTodo(late)
			require.Equal(t, rows, mythicalChecksOf(late).Attempts)
			late.Attempt = 4
			late.RequestRunID = "attempt-four"
			late.CandidateHead = "next-candidate"
			late = retainTodoAttemptEvidence(late)
			require.Len(t, mythicalChecksOf(late).Attempts, 2)
			require.Equal(t, rows[0], mythicalChecksOf(late).Attempts[0])
		})
	}
}

func TestTodoAttemptSnapshotLegacyDecoding(t *testing.T) {
	item := db.MythicalItem{Source: "todo", Attempt: 2, State: "proposed", RequestRunID: "new-run", Checks: json.RawMessage(`{"attempts":[{"attempt":1,"revision":"old-head","items":[{"kind":"flow","name":"todo","version":"old-pin"}]}]}`)}
	legacy := mythicalChecksOf(item).Attempts[0]
	require.Empty(t, legacy.RunID)
	require.Empty(t, legacy.Outcome)
	require.Equal(t, "old-head", legacy.Revision)
	settled := mythicalLanded(item, "merge", time.Unix(123, 0))
	records := mythicalChecksOf(settled).Attempts
	require.Len(t, records, 2)
	require.Equal(t, legacy, records[0], "new settlement cannot invent old history")
	require.Equal(t, "merged", records[1].Outcome)
	require.Equal(t, "new-run", records[1].RunID)
}

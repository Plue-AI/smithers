package services

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestTodoOwnerAdmissionRefusesBeforeEffects(t *testing.T) {
	now := time.Date(2026, 10, 4, 0, 0, 0, 0, time.UTC)
	for _, state := range []string{"queued", "retrying"} {
		t.Run(state, func(t *testing.T) {
			item := db.MythicalItem{Source: "todo", State: state, Attempt: 2, Generation: 3, RequestRunID: "previous", CandidateHead: "previous-candidate", Checks: json.RawMessage(`{"launches":4,"attempts":[{"attempt":1,"revision":"old","items":[]}]}`)}
			// Nil dependencies panic on any effect. The managed-artifact activation
			// boundary must remain ahead of placement, retirement and root startup.
			next, admitted, err := (&mythicalItemStep{now: now}).start(context.Background(), item)
			require.NoError(t, err)
			require.False(t, admitted)
			require.Equal(t, "TODO admission unavailable", next.Reason)
			require.Equal(t, []map[string]any{{"id": "start", "label": "Start", "state": "waiting"}, {"id": "request", "label": "Plan", "state": "waiting"}}, todoSteps(*next))
			require.Equal(t, map[string]string{"queued": "queued", "retrying": "working"}[state], todoState(*next))
			next.Reason, next.NextAttemptAt = item.Reason, item.NextAttemptAt
			require.Equal(t, item, *next, "refusal preserves all attempt history")
		})
	}
}

func TestTodoStepsUseOnlyBoundPhaseFacts(t *testing.T) {
	require.Empty(t, todoSteps(db.MythicalItem{State: "queued"}))
	for _, phase := range []string{"request", "vibe", "verify", "review"} {
		for _, outcome := range []string{"", "success", "failed: literal"} {
			t.Run(phase+"/"+outcome, func(t *testing.T) {
				item := db.MythicalItem{Source: "todo", State: "running"}
				success, label := "", ""
				switch phase {
				case "request":
					success, label = "validated", "Plan"
				case "vibe":
					success, label = "submitted", "Code"
				case "verify":
					success, label = "passed", "Verify"
				case "review":
					success, label = "approve", "Review"
				}
				held := outcome
				if outcome == "success" {
					held = success
				}
				switch phase {
				case "request":
					item.RequestOutcome = held
				case "vibe":
					item.VibeOutcome = held
				case "verify":
					item.VerifyOutcome = held
				case "review":
					item.Checks = mythicalChecks{Review: &mythicalReview{Verdict: held}}.encode()
				}
				require.Empty(t, todoSteps(item), "an outcome without its run is not a bound phase")
				switch phase {
				case "request":
					item.RequestRunID = "bound"
				case "vibe":
					item.VibeRunID = "bound"
				case "verify":
					item.VerifyRunID = "bound"
				case "review":
					item.Checks = mythicalChecks{Review: &mythicalReview{RunID: "bound", Verdict: held}}.encode()
				}
				state := "current"
				if outcome == "success" {
					state = "done"
				}
				if outcome == "failed: literal" {
					state = "failed"
				}
				require.Equal(t, []map[string]any{{"id": phase, "label": label, "state": state}}, todoSteps(item))
			})
		}
	}
	for _, state := range []string{"landed", "cancelled", "rejected", "declined"} {
		require.Empty(t, todoSteps(db.MythicalItem{State: state, RequestRunID: "retained"}))
	}
	for _, input := range []struct {
		item     db.MythicalItem
		expected string
	}{
		{db.MythicalItem{State: "queued", RequestRunID: "bound"}, "waiting"},
		{db.MythicalItem{State: "blocked", RequestRunID: "bound"}, "waiting"},
		{db.MythicalItem{State: "running", RequestRunID: "bound", PausedAt: pgtype.Timestamptz{Time: time.Now(), Valid: true}}, "paused"},
		{db.MythicalItem{State: "running", RequestRunID: "bound", Checks: mythicalChecks{Waits: []TodoWait{{ID: "q", Kind: "question"}}}.encode()}, "waiting"},
	} {
		require.Equal(t, input.expected, todoSteps(input.item)[0]["state"])
	}

}

// The pull request head is a fresh commit of the candidate's tree on main,
// so the review of that head is the candidate's evidence; it stays hidden
// once the candidate moves.
func TestTodoEvidenceHoldsTheReviewOfThePublishedHead(t *testing.T) {
	item := db.MythicalItem{Source: "todo", Attempt: 1, CandidateHead: "candidate", PRHead: "published", Checks: mythicalChecks{
		Review: &mythicalReview{Head: "published", Candidate: "candidate", Verdict: "approve"},
	}.encode()}
	require.Equal(t, []map[string]any{{"kind": "review", "summary": "approve"}}, currentTodoEvidence(item).Items)
	moved := item
	moved.CandidateHead = "next"
	require.Empty(t, currentTodoEvidence(moved).Items, "a review never vouches for another candidate")
	running := item
	running.Checks = mythicalChecks{Review: &mythicalReview{Head: "published", Candidate: "candidate"}}.encode()
	require.Empty(t, currentTodoEvidence(running).Items, "a review still running has no summary")
}

func TestTodoEvidenceSaysNoChecksFoundForAPlanWithNone(t *testing.T) {
	pinned := pgtype.Text{String: "pin", Valid: true}
	none := db.MythicalItem{Source: "todo", Attempt: 1, CandidateHead: "candidate", FlowDigest: pinned, Plan: json.RawMessage(`{"title":"Add greet","checks":null}`)}
	evidence, _ := mythicalTodoEvidenceText(none)
	require.Equal(t, "Checks:\n- No checks found\n- flow todo pin", evidence)
	// A plan that names a check, or no plan yet, never claims there are none.
	named := none
	named.Plan = json.RawMessage(`{"title":"Add greet","checks":[{"id":"test"}]}`)
	evidence, _ = mythicalTodoEvidenceText(named)
	require.Equal(t, "Checks:\n- flow todo pin", evidence)
	unplanned := none
	unplanned.Plan = nil
	evidence, _ = mythicalTodoEvidenceText(unplanned)
	require.Equal(t, "Checks:\n- flow todo pin", evidence)
}

func TestTodoEvidenceKeepsOnlyMatchingCandidateAndAttempt(t *testing.T) {
	duration := int64(0)
	item := db.MythicalItem{Source: "todo", Attempt: 1, RequestRunID: "attempt-one-run", CandidateHead: "candidate", FlowDigest: pgtype.Text{String: "pin", Valid: true}, Checks: mythicalChecks{
		Receipts: &mythicalReceipts{Run: "bound", Checks: []mythicalReceipt{
			{Check: "parent", Commit: "parent", Status: "failed"}, {Check: "unit", Commit: "candidate", Status: "passed", DurationMs: &duration},
		}}, Review: &mythicalReview{Head: "old", Verdict: "approve"},
	}.encode()}
	evidence := currentTodoEvidence(item)
	require.Equal(t, "attempt-one-run", evidence.RunID)
	require.Equal(t, []map[string]any{{"kind": "check", "name": "unit", "state": "passed", "took_s": float64(0)}, {"kind": "flow", "name": "todo", "version": "pin", "source_commit": ""}}, evidence.Items)
	archived := retainTodoAttemptEvidence(item)
	first, _ := json.Marshal(mythicalChecksOf(archived).Attempts[0])
	require.Equal(t, archived, retainTodoAttemptEvidence(archived), "replayed snapshot is identical")
	// Candidate movement hides stale receipts and review rather than reattributing them.
	moved := archived
	moved.CandidateHead = "different"
	require.Equal(t, []map[string]any{{"kind": "flow", "name": "todo", "version": "pin", "source_commit": ""}}, currentTodoEvidence(moved).Items)
	checks := mythicalChecksOf(moved)
	checks.Review = &mythicalReview{Head: "different", Verdict: "request-changes"}
	moved.Checks = checks.encode()
	require.Equal(t, map[string]any{"kind": "review", "summary": "request-changes"}, currentTodoEvidence(moved).Items[0])
	// A later attempt changes only its own evidence. Old bytes remain frozen.
	moved.Attempt = 2
	moved.RequestRunID = "attempt-two-run"
	moved = retainTodoAttemptEvidence(moved)
	second, _ := json.Marshal(mythicalChecksOf(moved).Attempts[0])
	require.Equal(t, string(first), string(second))
	require.Len(t, todoEvidence(moved), 2)
	require.Equal(t, "attempt-one-run", todoEvidence(moved)[0].RunID)
	require.Equal(t, "attempt-two-run", todoEvidence(moved)[1].RunID)
	require.Equal(t, moved, retainTodoAttemptEvidence(moved))
	for _, attempt := range []int32{0, -1} {
		empty := db.MythicalItem{Source: "todo", Attempt: attempt}
		require.Equal(t, empty, retainTodoAttemptEvidence(empty))
		require.Empty(t, todoEvidence(empty))
	}
	legacy := db.MythicalItem{Source: "issue", Attempt: 1, Checks: json.RawMessage(`{"todo":true}`)}
	require.Equal(t, legacy, retainTodoAttemptEvidence(legacy), "legacy decoding does not acquire new TODO facts")
}

func TestTodoReopenedAttemptEvidenceKeepsEndedRun(t *testing.T) {
	item := db.MythicalItem{Source: "todo", Attempt: 1, RequestRunID: "ended-run", CandidateHead: "accepted-head"}
	item = retainTodoAttemptEvidence(item)
	item.RequestRunID = ""
	item = retainTodoAttemptEvidence(item)
	require.Equal(t, "ended-run", currentTodoEvidence(item).RunID)
	require.Equal(t, "ended-run", mythicalChecksOf(item).Attempts[0].RunID)
	// A later attempt must not inherit the ended attempt's identity.
	item.Attempt = 2
	require.Empty(t, currentTodoEvidence(item).RunID)
}

func TestTodoEvidenceRetainsPreviousRevisionWithinAttempt(t *testing.T) {
	item := db.MythicalItem{Source: "todo", Attempt: 1, CandidateHead: "old", Checks: mythicalChecks{
		Receipts: &mythicalReceipts{Checks: []mythicalReceipt{{Check: "unit", Commit: "old", Status: "passed", LogDigest: "old-log"}}},
	}.encode()}
	item.Number = pgtype.Int8{Int64: 7, Valid: true}
	item = retainTodoAttemptEvidence(item)
	item.CandidateHead = "new"
	// Before another checkpoint arrives, old checks are already Previous,
	// never evidence for the new candidate and never silently discarded.
	assertPrevious := func(item db.MythicalItem, currentItems string) {
		t.Helper()
		raw, err := json.Marshal(todoEvidence(item))
		require.NoError(t, err)
		require.JSONEq(t, `[{"attempt":1,"revision":"new","items":`+currentItems+`,"previous":{"revision":"old","items":[{"kind":"check","name":"unit","state":"passed","log_digest":"old-log","log_url":"/api/todos/7/attempts/1/logs/old-log"}]}}]`, string(raw))
	}
	assertPrevious(item, `[]`)
	item = retainTodoAttemptEvidence(item)
	assertPrevious(item, `[]`)
	checks := mythicalChecksOf(item)
	checks.Receipts = &mythicalReceipts{Checks: []mythicalReceipt{{Check: "unit", Commit: "new", Status: "failed"}}}
	item.Checks = checks.encode()
	item = retainTodoAttemptEvidence(item)
	assertPrevious(item, `[{"kind":"check","name":"unit","state":"failed"}]`)
	require.Equal(t, item, retainTodoAttemptEvidence(item), "replayed checkpoints preserve both revisions")
	stored := mythicalChecksOf(item).Attempts[0]
	require.Equal(t, []LearningFailure{{Signature: "check:unit@check", Text: "Check unit failed."}}, stored.Failures)
	stored.Failures = nil // Private mining data is omitted from the card contract.
	retained, err := json.Marshal(stored)
	require.NoError(t, err)
	item.Attempt = 2
	item = retainTodoAttemptEvidence(item)
	replayed, err := json.Marshal(todoEvidence(item)[0])
	require.NoError(t, err)
	require.JSONEq(t, string(retained), string(replayed), "later attempts retain the earlier revision history")
}

func TestTodoEvidenceKeepsMeasuredPreviousAcrossEmptyCandidate(t *testing.T) {
	item := db.MythicalItem{Source: "todo", Attempt: 1, FlowDigest: pgtype.Text{String: "pin", Valid: true}}
	item = retainTodoAttemptEvidence(item)
	item.CandidateHead = "old"
	item = retainTodoAttemptEvidence(item)
	require.Nil(t, todoEvidence(item)[0].Previous, "a flow pin before the first candidate is not a reviewed revision")
	checks := mythicalChecksOf(item)
	checks.Receipts = &mythicalReceipts{Checks: []mythicalReceipt{{Check: "unit", Commit: "old", Status: "passed"}}}
	item.Checks = checks.encode()
	item = retainTodoAttemptEvidence(item)
	item.CandidateHead = ""
	item = retainTodoAttemptEvidence(item)
	previous := todoEvidence(item)[0].Previous
	require.NotNil(t, previous)
	require.Equal(t, "old", previous.Revision)
	require.Equal(t, "unit", previous.Items[0]["name"])
	item.CandidateHead = "new"
	item = retainTodoAttemptEvidence(item)
	require.Equal(t, previous, todoEvidence(item)[0].Previous, "an intermediate empty candidate must not replace retained check evidence")
}

// The card must retain the same distinction after a database round trip.
func TestTodoEvidenceCardRetainsPreviousRevisionPostgres(t *testing.T) {
	o, session := newTodoAdmission(t)
	item := o.fileTodo(session, "previous-evidence")
	item.Attempt = 1
	item.CandidateHead = "old"
	checks := mythicalChecksOf(item)
	checks.Receipts = &mythicalReceipts{Checks: []mythicalReceipt{{Check: "unit", Commit: "old", Status: "passed"}}}
	checks.Review = &mythicalReview{Head: "old", Verdict: "approve"}
	item.Checks = checks.encode()
	item = retainTodoAttemptEvidence(item)
	item.CandidateHead = "new"
	_, err := o.service.queries().SaveMythicalItem(context.Background(), retainTodoAttemptEvidence(item))
	require.NoError(t, err)
	card := o.todoCard(item.Number.Int64)
	evidence := card["evidence"].([]any)
	require.Len(t, evidence, 1)
	current := evidence[0].(map[string]any)
	require.Equal(t, "new", current["revision"])
	for _, entry := range current["items"].([]any) {
		require.NotContains(t, []string{"check", "review"}, entry.(map[string]any)["kind"], "old results must not vouch for the new candidate")
	}
	raw, err := json.Marshal(current["previous"])
	require.NoError(t, err)
	require.JSONEq(t, `{"revision":"old","items":[{"kind":"check","name":"unit","state":"passed"},{"kind":"review","summary":"approve"}]}`, string(raw))
	require.Equal(t, card["evidence"], o.todoCard(item.Number.Int64)["evidence"], "repeated reads retain both revisions")
}

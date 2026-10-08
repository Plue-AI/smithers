package compose

import (
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// This goes through the served install, durable dispatcher, packaged coding
// host and scripted HTTP model. It does not need the unrelated Branch topic.
func TestTodoSteerModelConsumption(t *testing.T) {
	t.Setenv("TRACE_MESSAGES", "1")
	r := newRehearsal(t, "SMITHERS_TODO_STEER_MODEL", "T-STK-06", "steer-model-")
	require.True(t, r.install("install"))
	n, err := r.file("Retry delivery", "[ASK] [FILE retry.ts] Add retries to webhook delivery in retry.ts")
	require.NoError(t, err)
	question, err := r.waitTodoWithin(n, 3*time.Minute, "needs_you")
	require.NoError(t, err)
	require.Len(t, question.Waits, 1)
	before, err := r.j3Lane(n)
	require.NoError(t, err)
	path := fmt.Sprintf("/api/todos/%d", n)
	const steer = "Keep the max at 5"
	const answer = "Use the existing retry helper"
	const secondSteer = "Use exponential backoff"
	for range 2 {
		code, data, err := r.keyed("POST", path, `{"steer":"Keep the max at 5"}`, "model-steer")
		require.NoError(t, err)
		require.Equal(t, 202, code, string(data))
	}
	still, err := r.todo(n)
	require.NoError(t, err)
	require.Equal(t, "needs_you", still.State)
	require.Equal(t, question.Waits[0].ID, still.Waits[0].ID)
	body, err := json.Marshal(map[string]string{"wait": question.Waits[0].ID, "answer": answer})
	require.NoError(t, err)
	// Both steers must be committed before dispatch is possible. Racing a
	// second steer against Answer cannot establish that premise: Answer may
	// already dispatch the model before the second HTTP admission completes.
	// TestTodoOrderedRecovery separately races/holds both dispatcher orders.
	code, data, err := r.keyed("POST", path, `{"steer":"Use exponential backoff"}`, "model-steer-second")
	require.NoError(t, err)
	require.Equal(t, 202, code, string(data))
	code, data, err = r.keyed("POST", path+"/answer", string(body), "model-answer")
	require.NoError(t, err)
	require.Equal(t, 202, code, string(data))
	// Admission sequence is allocated transactionally under the shared stream
	// lock. The duplicate request has no extra sequence or delivery intent.
	rows, err := r.pool.Query(r.ctx, `SELECT event.sequence, request.operation, request.payload
 FROM product_job_events event JOIN product_job_requests request ON request.id=event.operation_id
 WHERE event.event_type='operation.accepted' AND request.payload->>'runId'=$1
 AND request.operation IN ('flow.runtime.steer','flow.runtime.signal') ORDER BY event.sequence`, before.run)
	require.NoError(t, err)
	var committed []string
	var previous int64
	for rows.Next() {
		var sequence int64
		var operation string
		var payload []byte
		require.NoError(t, rows.Scan(&sequence, &operation, &payload))
		require.Greater(t, sequence, previous)
		previous = sequence
		for _, text := range []string{steer, secondSteer, answer} {
			if strings.Contains(string(payload), text) {
				committed = append(committed, text)
			}
		}
	}
	require.NoError(t, rows.Err())
	rows.Close()
	require.Len(t, committed, 3)
	require.Equal(t, steer, committed[0])
	require.Equal(t, []string{steer, secondSteer, answer}, committed)
	require.Eventually(t, func() bool {
		turns, err := r.modelTurns()
		if err != nil {
			return false
		}
		first := slices.IndexFunc(turns, func(turn map[string]any) bool { return strings.Contains(turnText(turn), answer) })
		if first < 0 {
			return false
		}
		text := turnText(turns[first])
		require.Contains(t, text, steer, "first post-answer model request")
		require.Contains(t, text, secondSteer, "all committed pre-answer inputs in the first request")
		require.Less(t, strings.Index(text, steer), strings.Index(text, secondSteer), "committed consumption order")
		return true
	}, 3*time.Minute, 50*time.Millisecond)
}

func TestTodoReviewSteerModelReentry(t *testing.T) {
	t.Setenv("TRACE_MESSAGES", "1")
	r := newRehearsal(t, "SMITHERS_TODO_STEER_MODEL", "T-STK-06", "review-model-")
	require.True(t, r.install("install"))
	_, err := r.member("alice", 202, "write")
	require.NoError(t, err)
	n, err := r.file("Retry delivery", "[FILE retry.ts] Add retries to webhook delivery in retry.ts")
	require.NoError(t, err)
	path := fmt.Sprintf("/api/todos/%d", n)
	reviewed, err := r.waitTodoWithin(n, 5*time.Minute, "in_review")
	require.NoError(t, err)
	before, err := r.j3Lane(n)
	require.NoError(t, err)
	// Two review rounds must re-enter the original run and working copy.
	for round := 0; round < 2; round++ {
		priorTurns, err := r.modelTurns()
		require.NoError(t, err)
		text := fmt.Sprintf("Also log retry attempt %d", round+1)
		if round == 0 {
			_, err := r.fakeControl("/_fake/reviews", map[string]any{
				"repo": "rehearsal-owner/app", "number": reviewed.PR.Number,
				"login": "alice", "state": "CHANGES_REQUESTED", "body": text,
				"path": "retry.ts", "line": 1,
			})
			require.NoError(t, err)
		} else {
			raw, _ := json.Marshal(map[string]string{"steer": text})
			code, data, err := r.keyed("POST", path, string(raw), fmt.Sprintf("review-steer-%d", round))
			require.NoError(t, err)
			require.Equal(t, 202, code, string(data))
		}
		require.Eventually(t, func() bool {
			card, err := r.todo(n)
			if err != nil {
				return false
			}
			if card.State == "failed" {
				t.Fatalf("review re-entry failed: %s", r.actual)
			}
			if card.State != "in_review" || card.PR.Head == reviewed.PR.Head {
				return false
			}
			require.Equal(t, reviewed.PR.Number, card.PR.Number)
			reviewed = card
			return true
		}, 5*time.Minute, 100*time.Millisecond)
		after, err := r.j3Lane(n)
		require.NoError(t, err)
		require.Equal(t, before, after, "same run, attempt and working copy after review steer")
		turns, err := r.modelTurns()
		require.NoError(t, err)
		first := slices.IndexFunc(turns[len(priorTurns):], func(turn map[string]any) bool {
			step, _ := turn["step"].(string)
			return turn["kind"] == "chat" && strings.HasPrefix(step, "coding/")
		})
		require.NotEqual(t, -1, first, "review steering must dispatch implementation")
		require.Contains(t, turnText(turns[len(priorTurns)+first]), text, "first coding request of the re-entered launch")
	}
}

// Protocol fixtures pin the shipped composition, whose identity changes with
// its source bytes. They must exercise the current pause/review contract.
func rehearsalBuiltinTodoDigest(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile("../services/builtin_flows.json")
	require.NoError(t, err)
	var digests map[string]string
	require.NoError(t, json.Unmarshal(raw, &digests))
	require.NotEmpty(t, digests["todo"])
	return digests["todo"]
}

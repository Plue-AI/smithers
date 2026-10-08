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
	testTodoNextTurnInput(t, false)
}

func TestTodoAmendModelConsumption(t *testing.T) {
	testTodoNextTurnInput(t, true)
}

func testTodoNextTurnInput(t *testing.T, amend bool) {
	t.Helper()
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
	method, field := "POST", "steer"
	if amend {
		method, field = "PATCH", "prompt"
	}
	input, err := json.Marshal(map[string]string{field: steer})
	require.NoError(t, err)
	for range 2 {
		code, data, err := r.keyed(method, path, string(input), "model-steer")
		require.NoError(t, err)
		require.Equal(t, 202, code, string(data))
	}
	still, err := r.todo(n)
	require.NoError(t, err)
	require.Equal(t, "needs_you", still.State)
	require.Equal(t, question.Waits[0].ID, still.Waits[0].ID)
	if amend {
		var revisions []byte
		require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT revisions FROM mythical_items WHERE number=$1`, n).Scan(&revisions))
		var entries []map[string]any
		require.NoError(t, json.Unmarshal(revisions, &entries))
		require.Len(t, entries, 2, "replayed amendment appends exactly one revision")
		require.Equal(t, "amend", entries[1]["reason"])
		require.Equal(t, steer, entries[1]["text"])
	}
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
	after, err := r.j3Lane(n)
	require.NoError(t, err)
	require.Equal(t, before, after, "next-turn input preserves run, attempt and working copy")
}

// Hold an actual implementing model request, rather than a planning question.
// The next implementing request must consume the amendment on the live run.
func TestTodoWorkingAmendNextImplementModelCall(t *testing.T) {
	t.Setenv("TRACE_MESSAGES", "1")
	r := newRehearsal(t, "SMITHERS_TODO_STEER_MODEL", "T-STK-06", "implement-amend-")
	require.True(t, r.install("install"))
	n, err := r.file("Retry delivery", "[HOLD amend-turn] [FILE retry.ts] Add retries to webhook delivery in retry.ts")
	require.NoError(t, err)
	defer func() { _ = r.release("amend-turn") }()
	require.NoError(t, r.waitHeld("amend-turn", 5*time.Minute))
	before, err := r.j3Lane(n)
	require.NoError(t, err)
	prior, err := r.modelTurns()
	require.NoError(t, err)
	require.NotEmpty(t, prior)
	held := slices.IndexFunc(prior, func(turn map[string]any) bool {
		return turn["step"] == "coding/edit-atom" && turn["hold"] == "amend-turn"
	})
	require.NotEqual(t, -1, held, "a real implement turn is in flight")
	const text = "Also log each retry and keep the max at 5"
	for range 2 {
		code, data, err := r.keyed("PATCH", fmt.Sprintf("/api/todos/%d", n), `{"prompt":"Also log each retry and keep the max at 5"}`, "implement-amend")
		require.NoError(t, err)
		require.Equal(t, 202, code, string(data))
	}
	var count int
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT jsonb_array_length(revisions) FROM mythical_items WHERE number=$1`, n).Scan(&count))
	require.Equal(t, 2, count, "one amendment revision after replay")
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.steer' AND payload->>'body' LIKE $1`, text+"%").Scan(&count))
	require.Equal(t, 1, count, "one delivery intent after replay")
	// HTTP 202 is admission, not guest delivery. Hold the current request until
	// the durable worker has the real runtime acknowledgement, so the input is
	// committed in the agent's context before its next implementing dispatch.
	require.Eventually(t, func() bool {
		var delivered int
		err := r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.steer' AND payload->>'body' LIKE $1 AND state='completed'`, text+"%").Scan(&delivered)
		return err == nil && delivered == 1
	}, time.Minute, 25*time.Millisecond, "amendment reaches the guest while implement is held")
	require.NoError(t, r.release("amend-turn"))
	require.Eventually(t, func() bool {
		turns, err := r.modelTurns()
		if err != nil || len(turns) <= len(prior) {
			return false
		}
		first := slices.IndexFunc(turns[len(prior):], func(turn map[string]any) bool { return turn["kind"] == "chat" && turn["step"] == "coding/edit-atom" })
		if first < 0 {
			return false
		}
		require.Contains(t, turnText(turns[len(prior)+first]), text, "first implementing request after committed amendment")
		return true
	}, 3*time.Minute, 50*time.Millisecond)
	after, err := r.j3Lane(n)
	require.NoError(t, err)
	require.Equal(t, before, after, "amendment retains run, attempt and working copy")
	items, err := r.todoList()
	require.NoError(t, err)
	require.Len(t, items, 1, "amendment allocates no TODO")
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
		require.Eventually(t, func() bool {
			var reviewedHead, verdict string
			var posted bool
			err := r.pool.QueryRow(t.Context(), `SELECT COALESCE(checks->'review'->>'head',''),COALESCE(checks->'review'->>'verdict',''),COALESCE((checks->'review'->>'posted')::boolean,false) FROM mythical_items WHERE source='todo' AND number=$1`, n).Scan(&reviewedHead, &verdict, &posted)
			return err == nil && reviewedHead == reviewed.PR.Head && verdict == "approve" && posted
		}, 5*time.Minute, 100*time.Millisecond, "the engine reviews each re-entered candidate")
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

// A 202 receipt must wake the retained In review run. Assert the next coding
// model request itself, before waiting for another capture, PR push or review.
func TestTodoRetainedReviewHTTPNextTurn(t *testing.T) {
	t.Setenv("TRACE_MESSAGES", "1")
	r := newRehearsal(t, "SMITHERS_TODO_STEER_MODEL", "T-STK-05", "retained-steer-")
	require.True(t, r.install("install"))
	n, err := r.file("Retry delivery", "[FILE retry.ts] Add retries to webhook delivery in retry.ts")
	require.NoError(t, err)
	_, err = r.waitTodoWithin(n, 5*time.Minute, "in_review")
	require.NoError(t, err)
	before, err := r.j3Lane(n)
	require.NoError(t, err)
	prior, err := r.modelTurns()
	require.NoError(t, err)
	const text = "Also log each retry attempt"
	for range 2 {
		code, data, err := r.keyed("POST", fmt.Sprintf("/api/todos/%d", n), `{"steer":"Also log each retry attempt"}`, "retained-review-steer")
		require.NoError(t, err)
		require.Equal(t, 202, code, string(data))
	}
	var first map[string]any
	require.Eventually(t, func() bool {
		turns, err := r.modelTurns()
		if err != nil || len(turns) <= len(prior) {
			return false
		}
		index := slices.IndexFunc(turns[len(prior):], func(turn map[string]any) bool {
			step, _ := turn["step"].(string)
			return turn["kind"] == "chat" && strings.HasPrefix(step, "coding/")
		})
		if index < 0 {
			return false
		}
		first = turns[len(prior)+index]
		return true
	}, 3*time.Minute, 50*time.Millisecond, "accepted review steer must dispatch another model turn")
	require.Contains(t, turnText(first), text, "spec §10.7.3: at most one model turn of latency")
	after, err := r.j3Lane(n)
	require.NoError(t, err)
	require.Equal(t, before, after, "review steer retains run, attempt and working copy")
	var inputs int
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM mythical_items, jsonb_array_elements(checks->'steers') input WHERE number=$1 AND input->>'text'=$2`, n, text).Scan(&inputs))
	require.Equal(t, 1, inputs, "duplicate HTTP admission stores one durable input")
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

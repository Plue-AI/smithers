package services

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/stretchr/testify/require"
)

// Review input re-enters the live TODO attempt through the existing durable
// worker. It never allocates a second request run.
func TestInReviewInputReentersSameAttempt(t *testing.T) {
	for _, kind := range []string{"steer", "amend", "review"} {
		t.Run(kind, func(t *testing.T) {
			o, synced, row, item := newReviewConsumer(t)
			pool := o.pool.(*pgxpool.Pool)
			q := db.New(pool)
			ctx := t.Context()
			item.CandidateHead = o.hostRef("refs/heads/main")
			item.CandidateBase, item.PRHead = item.CandidateHead, item.CandidateHead
			item.CandidateVerified, item.PRState = true, "open"
			item.RequestOutcome = ""
			checks := mythicalChecksOf(item)
			checks.FlowSource = o.landedMain()
			item.Checks = checks.encode()
			item, err := q.SaveMythicalItem(ctx, item)
			require.NoError(t, err)
			require.Equal(t, "in_review", todoState(item))
			peer := &todoRuntimeHost{digest: item.FlowDigest.String, source: checks.FlowSource}
			_, startWorker := o.runDispatcher(t, peer.resolver(t))
			session := registerTestInstallCredential(t, o.pool, middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &db.User{ID: o.userID}, SessionHash: "review-person"}), o.repoID)
			text := "Use the backoff helper"
			send := func() error {
				switch kind {
				case "steer":
					_, err := o.service.ControlTodo(session, item.Number.Int64, TodoControlInput{Repository: o.repoID, Actor: o.userID, Request: "review-work", Steer: &text})
					return err
				case "amend":
					_, err := o.service.AmendTodo(session, item.Number.Int64, TodoAmendInput{Repository: o.repoID, Actor: o.userID, Request: "review-work", Prompt: text})
					return err
				}
				return pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
					_, err := synced.install.consumers[gitHubReviews](ctx, tx, reviewFact(row, 77, "changes", "CHANGES_REQUESTED"))
					return err
				})
			}
			startWorker()
			require.NoError(t, send())
			require.NoError(t, send(), "replay must not create another input")
			next := o.byID(uuidString(item.ID))
			require.Equal(t, "running", next.State)
			require.Equal(t, item.Attempt, next.Attempt)
			require.Equal(t, item.RequestRunID, next.RequestRunID)
			require.Equal(t, item.WorkspaceID, next.WorkspaceID)
			feedback := mythicalChecksOf(next).Steers
			require.Len(t, feedback, 1)
			require.Equal(t, item.Attempt, feedback[0].Attempt)
			require.Equal(t, 0, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.launch'`))
			require.Eventually(t, func() bool {
				peer.mu.Lock()
				defer peer.mu.Unlock()
				return len(peer.steers) == 1
			}, 10*time.Second, 10*time.Millisecond)
			peer.mu.Lock()
			require.Equal(t, item.RequestRunID, peer.steers[0]["runId"])
			raw, err := json.Marshal(peer.steers[0])
			require.NoError(t, err)
			require.Contains(t, string(raw), text)
			require.Empty(t, peer.launches)
			peer.mu.Unlock()

		})
	}
}

// A live run held for review keeps RequestOutcome empty and is steered in
// place; a reopened run behind a merge fence holds the input for the next attempt.
func TestInReviewSteerDestinationFollowsRunLiveness(t *testing.T) {
	live, input, ctx := steerFixture()
	live.State = "proposed"
	next, feedback, deliver, _, err := prepareTodoSteer(ctx, live, input, nil, nil, time.Now())
	require.NoError(t, err)
	require.True(t, deliver)
	require.Equal(t, "running", next.State)
	require.Equal(t, live.Attempt, feedback.Attempt)

	ended := live
	ended.RequestOutcome = "completed"
	checks := mythicalChecksOf(ended)
	checks.GitHubReopenedAttempt = ended.Attempt
	ended.Checks = checks.encode()
	ended.PendingOp = json.RawMessage(`{"kind":"merge","target":"3","desired":"cccccccccccccccccccccccccccccccccccccccc","state":"intended"}`)
	next, feedback, deliver, _, err = prepareTodoSteer(ctx, ended, input, nil, nil, time.Now())
	require.NoError(t, err)
	require.False(t, deliver)
	require.True(t, feedback.ReleasePending)
	require.Equal(t, ended.Attempt+1, feedback.Attempt)
	require.Equal(t, "proposed", next.State, "the fence keeps the candidate")
	require.True(t, next.CandidateVerified)
	next.PendingOp = nil // the merge was refused; the worker releases the input
	queued, _, err := (&mythicalItemStep{}).advance(ctx, next)
	require.NoError(t, err)
	require.Equal(t, "queued", queued.State)
	require.False(t, queued.CandidateVerified)
}

// Historical completed attempts retain the retry path; live review runs re-enter in place.
func TestInReviewInputAfterEndedRunStartsNextAttempt(t *testing.T) {
	for _, kind := range []string{"steer", "amend", "review"} {
		t.Run(kind, func(t *testing.T) {
			o, synced, row, item := newReviewConsumer(t)
			pool := o.pool.(*pgxpool.Pool)
			q := db.New(pool)
			ctx := t.Context()
			item.CandidateHead = o.hostRef("refs/heads/main")
			item.CandidateBase, item.PRHead = item.CandidateHead, item.CandidateHead
			item.CandidateVerified, item.PRState = true, "open"
			item.RequestOutcome = "completed"
			checks := mythicalChecksOf(item)
			checks.FlowSource = o.landedMain()
			item.Checks = checks.encode()
			item, err := q.SaveMythicalItem(ctx, item)
			require.NoError(t, err)
			require.Equal(t, "in_review", todoState(item))
			peer := &todoRuntimeHost{digest: item.FlowDigest.String, source: checks.FlowSource}
			_, startWorker := o.runDispatcher(t, peer.resolver(t))
			session := registerTestInstallCredential(t, o.pool, middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &db.User{ID: o.userID}, SessionHash: "review-person"}), o.repoID)
			text := "Use the backoff helper"
			send := func() error {
				switch kind {
				case "steer":
					_, err := o.service.ControlTodo(session, item.Number.Int64, TodoControlInput{Repository: o.repoID, Actor: o.userID, Request: "review-work", Steer: &text})
					return err
				case "amend":
					_, err := o.service.AmendTodo(session, item.Number.Int64, TodoAmendInput{Repository: o.repoID, Actor: o.userID, Request: "review-work", Prompt: text})
					return err
				}
				return pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
					_, err := synced.install.consumers[gitHubReviews](ctx, tx, reviewFact(row, 77, "changes", "CHANGES_REQUESTED"))
					return err
				})
			}
			require.NoError(t, send())
			require.NoError(t, send(), "replay must not create another attempt")
			queued := o.byID(uuidString(item.ID))
			require.Equal(t, "queued", queued.State, "the ended run is never revived")
			require.Equal(t, item.Attempt, queued.Attempt, "only durable launch advances the attempt")
			require.Equal(t, 0, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.steer'`), "nothing is sent to the ended run")
			feedback := mythicalChecksOf(queued).Steers
			require.Len(t, feedback, 1)
			require.Equal(t, item.Attempt+1, feedback[0].Attempt)
			require.True(t, feedback[0].ReleasePending)
			o.wake()
			started := o.byID(uuidString(item.ID))
			require.Equal(t, "starting", todoState(started), started.Reason)
			require.Equal(t, item.Attempt+1, started.Attempt)
			require.Empty(t, started.RequestOutcome)
			var raw []byte
			require.NoError(t, pool.QueryRow(ctx, `SELECT payload FROM product_job_requests WHERE operation='flow.runtime.launch'`).Scan(&raw))
			launch := decodeJSON(t, raw)
			require.Equal(t, item.FlowDigest.String, launch["pin"].(map[string]any)["executionDigest"], "the next attempt keeps its pin")
			require.Contains(t, string(raw), text)
			// The launch carries and consumes the input on the new attempt.
			require.True(t, mythicalChecksOf(o.byID(uuidString(item.ID))).Steers[0].InputConsumed, "the launch payload carries the input")
			startWorker()
			require.Eventually(t, func() bool { return todoState(o.byID(uuidString(item.ID))) == "working" }, 10*time.Second, 10*time.Millisecond)
			peer.mu.Lock()
			launches, _ := json.Marshal(peer.launches)
			steers := len(peer.steers)
			peer.mu.Unlock()
			require.Contains(t, string(launches), text, "the input is the new run's first message")
			require.Zero(t, steers)
			require.NoError(t, send())
			require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.launch'`))
		})
	}
}

func TestInReviewSteerSurvivesLateCompositionCompletion(t *testing.T) {
	item, input, ctx := steerFixture()
	item.State = "proposed"
	item.PRNumber.Valid, item.PRNumber.Int64, item.PRHead = true, 17, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	next, feedback, deliver, _, err := prepareTodoSteer(ctx, item, input, nil, nil, time.Now())
	require.NoError(t, err)
	require.True(t, deliver)
	require.True(t, feedback.AfterProposal)
	next.RequestOutcome = "completed"
	queued := mythicalComposedOutcome(next, time.Now())
	require.NotNil(t, queued)
	require.Equal(t, "queued", queued.State)
	require.Equal(t, item.FlowDigest, queued.FlowDigest)
	require.Equal(t, item.Attempt, queued.Attempt, "admission alone advances the attempt")
	retained := mythicalChecksOf(*queued).Steers[0]
	require.Equal(t, feedback.ID, retained.ID)
	require.Equal(t, feedback.Text, retained.Text)
	require.Equal(t, mythicalChecksOf(next).Steers[0].By, retained.By)
	require.Equal(t, item.Attempt+1, retained.Attempt)
	require.True(t, retained.ReleasePending)
	require.False(t, retained.AfterProposal, "carry once rather than repeating a late completion recovery")
	require.Equal(t, int64(2), retained.InputVersion)
	require.Equal(t, item.PRHead, queued.PRHead)
	// A composition with no offered PR is still a real no-proposal failure.
	next.PRNumber.Valid = false
	require.Equal(t, "blocked", mythicalComposedOutcome(next, time.Now()).State)
}

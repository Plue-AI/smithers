package services

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// The consumer is real and transactional; the accepted candidate and settled
// branch-restoration intent are fixtures. No machine execution is claimed.
func TestReopenedTodoInputStartsNewPinnedAttempt(t *testing.T) {
	for _, kind := range []string{"steer", "amend", "review", "empty review"} {
		t.Run(kind, func(t *testing.T) {
			o, synced, row, item := newReviewConsumer(t)
			pool := o.pool.(*pgxpool.Pool)
			q := db.New(pool)
			ctx := t.Context()
			item.CandidateHead = o.hostRef("refs/heads/main")
			item.CandidateBase, item.PRHead = item.CandidateHead, item.CandidateHead
			item.CandidateVerified = true
			item.PRState = "open"
			checks := mythicalChecksOf(item)
			checks.FlowSource = o.landedMain()
			item.Checks = checks.encode()
			var err error
			item, err = q.SaveMythicalItem(ctx, item)
			require.NoError(t, err)
			accepted := item
			var closedAttempt todoAttemptEvidence
			peer := &todoRuntimeHost{digest: item.FlowDigest.String, source: checks.FlowSource}
			_, startWorker := o.runDispatcher(t, peer.resolver(t))
			for _, state := range []string{"closed", "open"} {
				raw := fmt.Sprintf(`{"number":3,"state":%q,"head":{"sha":%q,"ref":"smithers/review"},"closed_at":%q,"closed_by":{"login":"alice"}}`, state, item.PRHead, time.Now().UTC().Format(time.RFC3339))
				fact := gitHubFetchedObject{Repo: row.ID, GitHubRepository: 100, Installation: 12, Resource: GitHubRepoMetadataPulls, Number: 3, Version: state, Object: json.RawMessage(raw)}
				require.NoError(t, pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error { _, err := o.service.consumeGitHubPullTodos(ctx, tx, fact); return err }))
				if state == "closed" {
					records := mythicalChecksOf(o.byID(uuidString(item.ID))).Attempts
					require.Len(t, records, 1)
					closedAttempt = records[0]
					require.Equal(t, "dropped", closedAttempt.Outcome)
					require.Equal(t, accepted.RequestRunID, closedAttempt.RunID)
					require.Equal(t, accepted.FlowDigest.String, closedAttempt.FlowDigest)
				}

			}
			reopened := o.byID(uuidString(item.ID))
			require.Equal(t, closedAttempt, currentTodoEvidence(reopened))
			require.Equal(t, "proposed", reopened.State)
			require.Equal(t, accepted.Attempt, reopened.Attempt)
			require.Equal(t, accepted.CandidateHead, reopened.CandidateHead)
			require.True(t, reopened.CandidateVerified)
			require.False(t, mythicalChecksOf(reopened).RunAttached, "reopening restores no live run")
			projection, err := json.Marshal(mythicalProjection{Kind: mythicalBindingKind, ItemID: uuidString(item.ID), Phase: "todo", Attempt: item.Attempt, Generation: item.Generation, FlowDigest: item.FlowDigest.String, FlowSource: checks.FlowSource})
			require.NoError(t, err)
			o.projectTodo(flowdispatch.LaunchRequest{FlowID: "todo", Projection: projection}, jobs.StateRunning, item.RequestRunID, item.FlowDigest.String, "")
			require.Equal(t, reopened, o.byID(uuidString(item.ID)), "a late checkpoint cannot revive the dropped run")
			// Publication settlement is covered by the production poll lifecycle suite.
			reopened.PendingOp = nil
			reopened, err = q.SaveMythicalItem(ctx, reopened)
			require.NoError(t, err)
			session := registerTestInstallCredential(t, o.pool, middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &db.User{ID: o.userID}, SessionHash: "reopened-person"}), o.repoID)
			text := "Use the backoff helper"
			send := func() error {
				switch kind {
				case "steer":
					_, err = o.service.ControlTodo(session, item.Number.Int64, TodoControlInput{Repository: o.repoID, Actor: o.userID, Request: "reopen-work", Steer: &text})
				case "amend":
					_, err = o.service.AmendTodo(session, item.Number.Int64, TodoAmendInput{Repository: o.repoID, Actor: o.userID, Request: "reopen-work", Prompt: text})
				case "review", "empty review":
					err = pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
						fact := reviewFact(row, 77, "after-reopen", "CHANGES_REQUESTED")
						if kind == "empty review" {
							fact.Object = json.RawMessage(strings.NewReplacer("CHANGES_REQUESTED", "COMMENTED", "Use the backoff helper", "").Replace(string(fact.Object)))
						}
						_, err := synced.install.consumers[gitHubReviews](ctx, tx, fact)
						return err
					})
				}
				return err
			}
			if kind == "review" {
				require.Error(t, pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
					_, err := synced.install.consumers[gitHubReviews](ctx, tx, reviewFact(row, 77, "after-reopen", "CHANGES_REQUESTED"))
					require.NoError(t, err)
					return fmt.Errorf("crash before commit")
				}))
				require.Equal(t, reopened, o.byID(uuidString(item.ID)), "queue and input roll back together")
			}
			require.NoError(t, send())
			require.NoError(t, send(), "replay must not create another attempt")
			queued := o.byID(uuidString(item.ID))
			if kind == "empty review" {
				require.Equal(t, "proposed", queued.State, "an empty review is not work")
				require.True(t, queued.CandidateVerified)
				require.Empty(t, mythicalChecksOf(queued).Steers)
				require.Equal(t, accepted.Attempt, queued.Attempt)
				return
			}
			require.Equal(t, "queued", queued.State, "the closed run must never resume")
			require.Equal(t, accepted.Attempt, queued.Attempt, "only durable launch advances the attempt")
			require.Equal(t, accepted.FlowDigest, queued.FlowDigest)
			o.projectTodo(flowdispatch.LaunchRequest{FlowID: "todo", Projection: projection}, jobs.StateCompleted, item.RequestRunID, item.FlowDigest.String, `{"stale":"dropped run"}`)
			require.Equal(t, queued, o.byID(uuidString(item.ID)), "late completion cannot overwrite queued work")
			require.Equal(t, 0, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.steer'`), "nothing is sent to the dropped run")
			feedback := mythicalChecksOf(queued).Steers
			require.Len(t, feedback, 1)
			require.Equal(t, accepted.Attempt+1, feedback[0].Attempt)
			require.True(t, feedback[0].ReleasePending)
			o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) {
				t.Error("reopened work must use its existing pin")
				return todoPinTwo, nil
			})
			o.wake()
			started := o.byID(uuidString(item.ID))
			require.Equal(t, "starting", todoState(started), started.Reason)
			require.Equal(t, accepted.Attempt+1, started.Attempt)
			var raw []byte
			require.NoError(t, pool.QueryRow(ctx, `SELECT payload FROM product_job_requests WHERE operation=$1`, flowdispatch.OperationLaunch).Scan(&raw))
			launch := decodeJSON(t, raw)
			require.Equal(t, accepted.FlowDigest.String, launch["pin"].(map[string]any)["executionDigest"])
			require.Equal(t, mythicalChecksOf(accepted).FlowSource, launch["pin"].(map[string]any)["sourceCommit"])
			require.Contains(t, string(raw), text)
			startWorker()
			require.Eventually(t, func() bool { return todoState(o.byID(uuidString(item.ID))) == "working" }, 10*time.Second, 10*time.Millisecond)
			require.Equal(t, "todo-run", o.byID(uuidString(item.ID)).RequestRunID)
			require.Equal(t, closedAttempt, mythicalChecksOf(o.byID(uuidString(item.ID))).Attempts[0], "new work cannot rewrite the dropped attempt")
			require.NotEqual(t, accepted.RequestRunID, o.byID(uuidString(item.ID)).RequestRunID)
			peer.mu.Lock()
			launches, _ := json.Marshal(peer.launches)
			steerCount := len(peer.steers)
			peer.mu.Unlock()
			require.Equal(t, []string{"todo"}, peer.flows())
			require.Contains(t, string(launches), text, "the runtime receives feedback on the new launch")
			require.Zero(t, steerCount, "the old run receives no message")
			require.NoError(t, send())
			require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.launch'`))
		})
	}
}

func TestReopenedTodoHoldsSteerBehindMergeFence(t *testing.T) {
	item, input, ctx := steerFixture()
	item.State = "proposed"
	checks := mythicalChecksOf(item)
	checks.GitHubReopenedAttempt = item.Attempt
	item.Checks = checks.encode()
	item.PendingOp = json.RawMessage(`{"kind":"merge","target":"3","desired":"cccccccccccccccccccccccccccccccccccccccc","state":"intended"}`)
	require.True(t, mythicalMergeFenced(item))
	next, feedback, deliver, _, err := prepareTodoSteer(ctx, item, input, nil, nil, time.Now())
	require.NoError(t, err)
	require.False(t, deliver)
	require.True(t, feedback.ReleasePending)
	require.Equal(t, item.Attempt+1, feedback.Attempt)
	require.Equal(t, "proposed", next.State)
	require.Equal(t, item.CandidateVerified, next.CandidateVerified)
	require.Equal(t, checks.Land, mythicalChecksOf(next).Land)
	next.PendingOp = nil // a refused merge has reconciled; release through the worker
	queued, _, err := (&mythicalItemStep{}).advance(ctx, next)
	require.NoError(t, err)
	require.Equal(t, "queued", queued.State)
	require.False(t, queued.CandidateVerified)
	require.Nil(t, mythicalChecksOf(*queued).Land)
}

func TestReopenedTodoRebaseStartsFreshAttempt(t *testing.T) {
	item, _, _ := steerFixture()
	item.State = "proposed"
	checks := mythicalChecksOf(item)
	checks.GitHubReopenedAttempt = item.Attempt
	item.Checks = checks.encode()
	step := &mythicalItemStep{r: &mythicalRun{mainTip: "new-main"}, now: time.Now()}
	queued := step.invalidatePrefix(item)
	require.Equal(t, "queued", queued.State)
	require.Equal(t, item.Attempt, queued.Attempt)
	require.Equal(t, item.FlowDigest, queued.FlowDigest)
	require.Equal(t, "new-main", mythicalChecksOf(*queued).Rebase.Onto)
	require.False(t, mythicalChecksOf(*queued).RunAttached)
}

func TestGitHubEmptyReviewEditWithdrawsHeldText(t *testing.T) {
	o, synced, row, item := newReviewConsumer(t)
	pool := o.pool.(*pgxpool.Pool)
	item.State = "blocked"
	var err error
	item, err = db.New(pool).SaveMythicalItem(t.Context(), item)
	require.NoError(t, err)
	fact := reviewFact(row, 77, "held", "COMMENTED")
	consume := func() error {
		return pgx.BeginFunc(t.Context(), pool, func(tx pgx.Tx) error {
			_, err := synced.install.consumers[gitHubReviews](t.Context(), tx, fact)
			return err
		})
	}
	require.NoError(t, consume())
	require.Len(t, mythicalChecksOf(o.byID(uuidString(item.ID))).Steers, 1)
	fact.Version = "empty-edit"
	fact.Object = json.RawMessage(strings.Replace(string(fact.Object), "Use the backoff helper", "", 1))
	require.NoError(t, consume())
	require.NoError(t, consume())
	current := o.byID(uuidString(item.ID))
	require.Equal(t, "blocked", current.State)
	require.Empty(t, mythicalChecksOf(current).Steers)
	require.Len(t, mythicalChecksOf(current).GitHubInputs, 1)
	require.Empty(t, mythicalChecksOf(current).GitHubInputs[0].Text)
	require.Equal(t, 0, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE operation IN ('flow.runtime.launch','flow.runtime.steer')`))
}

package modelproxy

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/modelprice"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// Owner-paid calls are held to the repository's daily token budget across
// concurrent callers: each admitted call's bound counts until it settles, so
// calls racing for the last room admit only what fits. Settled rows count
// what the provider reported; a failed call counts nothing; yesterday's
// usage and other repositories' never count.
func TestOwnerMeterHoldsConcurrentCallsToTheDailyBudget(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	var userID, repoID, otherRepoID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES('owner','owner') RETURNING id`).Scan(&userID))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'repo','repo') RETURNING id`, userID).Scan(&repoID))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'other','other') RETURNING id`, userID).Scan(&otherRepoID))
	// Rows are stamped by the database clock; the meter's day follows the same time.
	now := time.Now().UTC()
	budget := int64(1_000)
	meter := OwnerMeter{DB: pool, Now: func() time.Time { return now }, DailyTokens: func(_ context.Context, repositoryID int64) (int64, error) {
		if repositoryID != repoID {
			return 0, errors.New("unknown repository")
		}
		return budget, nil
	}}
	caller := Caller{OwnerType: "user", OwnerID: userID, UserID: userID, Source: SourceFlowHost, RepositoryID: repoID, WorkspaceID: "w", Reference: "host"}
	call := Call{Provider: ProviderVercel, Model: "openai/gpt-5.1", Maximum: modelprice.Usage{InputTokens: 300, OutputTokens: 100}}
	answer := func(input, output int64) func(context.Context) (Result, error) {
		return func(context.Context) (Result, error) {
			return Result{Outcome: credits.ModelSucceeded, Usage: modelprice.Usage{InputTokens: input, OutputTokens: output}, Status: 200}, nil
		}
	}
	tokens := func() (total int64) {
		require.NoError(t, pool.QueryRow(ctx, `SELECT COALESCE(SUM(CASE WHEN outcome IN ('pending','unknown') THEN GREATEST(bound_tokens, input_tokens+output_tokens)
			ELSE input_tokens+output_tokens END),0)::bigint FROM model_usage WHERE repository_id=$1 AND created_at >= $2`, repoID, now.Truncate(24*time.Hour)).Scan(&total))
		return
	}

	// Yesterday's spend and another repository's never count.
	_, err := pool.Exec(ctx, `INSERT INTO model_usage(request_key, paid_by, owner_type, owner_id, source, repository_id, provider, model, outcome, input_tokens, settled_at, created_at)
		VALUES ('yesterday', 'owner', 'user', $1, 'flow_host', $2, 'vercel', 'm', 'succeeded', 5000, now(), $3),
		       ('other', 'owner', 'user', $1, 'flow_host', $4, 'vercel', 'm', 'succeeded', 5000, now(), $5)`,
		userID, repoID, now.Truncate(24*time.Hour).Add(-time.Hour), otherRepoID, now)
	require.NoError(t, err)

	// Two calls of bound 400 hold 800 of 1,000 while they run; a third racing
	// for the last 200 is refused before it spends.
	release := make(chan struct{})
	started := make(chan struct{}, 3)
	var wg sync.WaitGroup
	results := make(chan error, 3)
	for range 3 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- meter.Execute(ctx, caller, call, func(ctx context.Context) (Result, error) {
				started <- struct{}{}
				<-release
				return answer(50, 10)(ctx)
			})
		}()
	}
	// Exactly two are admitted; the third is refused while they hold their bounds.
	<-started
	<-started
	require.Eventually(t, func() bool { return len(results) == 1 }, 10*time.Second, 10*time.Millisecond)
	require.ErrorIs(t, <-results, ErrDailyTokenBudget)
	require.EqualValues(t, 800, tokens(), "pending calls count their bounds")
	close(release)
	wg.Wait()
	close(results)
	for err := range results {
		require.NoError(t, err)
	}
	// Settled, they count what the provider reported.
	require.EqualValues(t, 120, tokens())

	// A failed call is recorded and counts nothing.
	require.NoError(t, meter.Execute(ctx, caller, call, func(context.Context) (Result, error) {
		return Result{Outcome: credits.ModelFailed, Status: 500}, nil
	}))
	require.EqualValues(t, 120, tokens())
	// A call whose outcome is unknown keeps its bound.
	require.NoError(t, meter.Execute(ctx, caller, call, func(context.Context) (Result, error) { return Result{}, nil }))
	require.EqualValues(t, 520, tokens())
	var rows []struct{ outcome, paidBy string }
	r, err := pool.Query(ctx, `SELECT outcome, paid_by FROM model_usage WHERE repository_id=$1 AND request_key LIKE 'model:%' ORDER BY id`, repoID)
	require.NoError(t, err)
	for r.Next() {
		var row struct{ outcome, paidBy string }
		require.NoError(t, r.Scan(&row.outcome, &row.paidBy))
		rows = append(rows, row)
	}
	require.NoError(t, r.Err())
	require.Equal(t, []struct{ outcome, paidBy string }{{"succeeded", "owner"}, {"succeeded", "owner"}, {"failed", "owner"}, {"unknown", "owner"}}, rows)

	// 520 + 400 fits 1,000; the next 400 does not.
	require.NoError(t, meter.Execute(ctx, caller, call, answer(400, 0)))
	require.ErrorIs(t, meter.Execute(ctx, caller, call, answer(1, 1)), ErrDailyTokenBudget)
	// A declared 0 admits nothing, and an unreadable budget fails closed without recording.
	budget = 0
	require.ErrorIs(t, meter.Execute(ctx, caller, call, answer(1, 1)), ErrDailyTokenBudget)
	other := caller
	other.RepositoryID = otherRepoID
	err = meter.Execute(ctx, other, call, answer(1, 1))
	require.ErrorContains(t, err, "unknown repository")
	require.NotErrorIs(t, err, ErrDailyTokenBudget)
	// The next UTC day starts empty.
	budget, now = 1_000, now.Truncate(24*time.Hour).Add(24*time.Hour+time.Minute)
	require.NoError(t, meter.Execute(ctx, caller, call, answer(1, 1)))
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM model_usage WHERE request_key LIKE 'model:%'`).Scan(&count))
	require.Equal(t, 6, count, "refused calls record nothing")
	// A call with no repository has no budget to hold and is only recorded.
	require.NoError(t, OwnerMeter{DB: pool}.Execute(ctx, Caller{OwnerType: "user", OwnerID: userID, Source: SourceApp}, call, answer(1, 1)))
	// Missing accounting fails closed.
	require.Error(t, OwnerMeter{}.Execute(ctx, caller, call, answer(1, 1)))
	require.Error(t, OwnerMeter{DB: pool}.Execute(ctx, caller, call, answer(1, 1)), "a repository call needs its budget reader")
}

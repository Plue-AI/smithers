package modelproxy

import (
	"context"
	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/modelprice"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
	"net/http"
	"strings"
	"testing"
)

func TestStepCostsThroughHTTPProxy(t *testing.T) {
	for _, ownerPaid := range []bool{false, true} {
		t.Run(map[bool]string{false: "credit", true: "owner"}[ownerPaid], func(t *testing.T) {
			f := newProxyFixture(t)
			caller := Caller{OwnerType: "user", OwnerID: 7, Source: SourceFlowHost, WorkspaceID: "ws-1", Reference: "binding"}
			f.handler.Callers = fixedCaller{caller}
			f.handler.OwnerPaid = ownerPaid
			f.handler.Owner = OwnerMeter{DB: f.pool}
			if !ownerPaid {
				f.grant(10_000_000)
			}
			f.upstream = func(w http.ResponseWriter, req *http.Request, _ []byte) {
				require.Empty(t, req.Header.Get("X-Smithers-Step-Id"), "correlation stays at the proxy")
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"type":"message","usage":{"input_tokens":10,"output_tokens":20}}`))
			}
			a, b := strings.Repeat("a", 64), strings.Repeat("b", 64)
			for _, step := range []string{a, a, b} {
				response := f.call("/model-proxy/anthropic/v1/messages", anthropicBody(100), "X-Smithers-Execution-Id", "native-run", "X-Smithers-Step-Id", step)
				require.Equal(t, 200, response.Code, response.Body.String())
			}
			var total int64
			require.NoError(t, f.pool.QueryRow(context.Background(), `SELECT sum(cost_nanos)::bigint FROM model_usage WHERE execution_id='native-run'`).Scan(&total))
			// Haiku: $1/M input and $5/M output. Literal oracles, independent of modelprice.
			require.EqualValues(t, 330_000, total)
			rows, err := f.pool.Query(context.Background(), `SELECT step_id,sum(cost_nanos)::bigint,count(*) FROM model_usage WHERE execution_id='native-run' GROUP BY step_id ORDER BY step_id`)
			require.NoError(t, err)
			defer rows.Close()
			require.True(t, rows.Next())
			var step string
			var cost, count int64
			require.NoError(t, rows.Scan(&step, &cost, &count))
			require.Equal(t, a, step)
			require.EqualValues(t, 220_000, cost)
			require.EqualValues(t, 2, count)
			require.True(t, rows.Next())
			require.NoError(t, rows.Scan(&step, &cost, &count))
			require.Equal(t, b, step)
			require.EqualValues(t, 110_000, cost)
			require.EqualValues(t, 1, count)
			require.False(t, rows.Next())
			require.NoError(t, rows.Err())
		})
	}
}

func TestOwnerStepCostUnknownFailureAndCancellation(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	meter := OwnerMeter{DB: pool}
	caller := Caller{OwnerType: "user", OwnerID: 7, Source: SourceFlowHost, ExecutionID: "run", StepID: strings.Repeat("a", 64)}
	call := Call{Provider: ProviderAnthropic, Model: "claude-haiku-4-5", Maximum: modelprice.Usage{InputTokens: 100, OutputTokens: 100}}
	for _, outcome := range []credits.ModelOutcome{credits.ModelFailed, credits.ModelUnknown, credits.ModelSucceeded} {
		ctx, cancel := context.WithCancel(context.Background())
		err := meter.Execute(ctx, caller, call, func(context.Context) (Result, error) {
			cancel()
			return Result{Outcome: outcome, Usage: modelprice.Usage{InputTokens: 10, OutputTokens: 20}}, context.Canceled
		})
		require.ErrorIs(t, err, context.Canceled)
	}
	call.Model = "unlisted-owner-model"
	require.NoError(t, meter.Execute(context.Background(), caller, call, func(context.Context) (Result, error) {
		return Result{Outcome: credits.ModelSucceeded, Usage: modelprice.Usage{InputTokens: 10, OutputTokens: 20}}, nil
	}))
	rows, err := pool.Query(context.Background(), `SELECT outcome,cost_nanos FROM model_usage ORDER BY id`)
	require.NoError(t, err)
	defer rows.Close()
	for i, want := range []string{"failed", "unknown", "succeeded", "succeeded"} {
		require.True(t, rows.Next())
		var outcome string
		var cost *int64
		require.NoError(t, rows.Scan(&outcome, &cost))
		require.Equal(t, want, outcome)
		if i == 2 {
			require.NotNil(t, cost)
			require.EqualValues(t, 110_000, *cost)
		} else {
			require.Nil(t, cost)
		}
	}
	require.False(t, rows.Next())
	require.NoError(t, rows.Err())
}

package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/modelprice"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// The install router authenticates the run and step before the owner-paid
// proxy records the actual model. Parallel steps never fabricate attribution.
func TestOwnerModelProxyRecordsAuthenticatedStepPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	var user, repo, definition, run, step, otherRun, otherStep int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES('owner','owner') RETURNING id`).Scan(&user))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'repo','repo') RETURNING id`, user).Scan(&repo))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workflow_definitions(repository_id,name,path,config) VALUES($1,'todo','flows/todo/flow.ts','{}') RETURNING id`, repo).Scan(&definition))
	token := "smithers_agent_" + strings.Repeat("c", 40)
	hash := sha256.Sum256([]byte(token))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workflow_runs(repository_id,workflow_definition_id,status,trigger_event,agent_token_hash,agent_token_expires_at) VALUES($1,$2,'running','agent',$3,now()+interval '1 hour') RETURNING id`, repo, definition, hex.EncodeToString(hash[:])).Scan(&run))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workflow_runs(repository_id,workflow_definition_id,status,trigger_event) VALUES($1,$2,'running','agent') RETURNING id`, repo, definition).Scan(&otherRun))
	makeStep := func(run int64, position int) int64 {
		var id int64
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workflow_steps(workflow_run_id,name,position,status) VALUES($1,'review',$2,'running') RETURNING id`, run, position).Scan(&id))
		return id
	}
	step, otherStep = makeStep(run, 0), makeStep(otherRun, 0)
	hits := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		require.Empty(t, r.Header.Get(modelproxy.StepHeader))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"usage":{"input_tokens":3,"output_tokens":4}}`))
	}))
	defer upstream.Close()
	q := db.New(pool)
	handler := &modelproxy.Handler{OwnerPaid: true, Owner: modelproxy.OwnerMeter{DB: pool, DailyTokens: func(context.Context, int64) (int64, error) { return 1000000, nil }}, Keys: modelproxy.StaticKeys{modelproxy.ProviderAnthropic: "fixture"}, Callers: services.NewModelProxyCallers(q, pool, webhook.NoopSecretCodec{}), Upstreams: map[string]string{modelproxy.ProviderAnthropic: upstream.URL}}
	router := chi.NewRouter()
	mountModelProxy(router, q, testConfigAllFlagsOn(), handler)
	callModel := func(header, model string) int {
		req := httptest.NewRequest("POST", modelproxy.Path+"/anthropic/v1/messages", strings.NewReader(fmt.Sprintf(`{"model":%q,"max_tokens":10,"messages":[]}`, model)))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set(modelproxy.StepHeader, header)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec.Code
	}
	call := func(header string) int { return callModel(header, "claude-haiku-4-5") }
	for _, header := range []string{fmt.Sprint(step), ""} {
		require.Equal(t, 200, call(header))
		var recordedStep, recordedRun int64
		var model string
		require.NoError(t, pool.QueryRow(ctx, `SELECT workflow_step_id,workflow_run_id,model FROM model_usage ORDER BY id DESC LIMIT 1`).Scan(&recordedStep, &recordedRun, &model))
		require.Equal(t, step, recordedStep)
		require.Equal(t, run, recordedRun)
		require.Equal(t, "claude-haiku-4-5", model)
	}
	for _, header := range []string{fmt.Sprint(otherStep), "garbage", "0"} {
		require.Equal(t, 403, call(header))
	}
	require.Equal(t, 2, hits)
	secondStep := makeStep(run, 1)
	require.Equal(t, 200, call(""))
	var attribution *int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT workflow_step_id FROM model_usage ORDER BY id DESC LIMIT 1`).Scan(&attribution))
	require.Nil(t, attribution)
	require.Equal(t, 3, hits)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM model_usage`).Scan(&count))
	require.Equal(t, 3, count)
	// A second step retains its own literal price total. The two earlier
	// calls belong to the first; the parallel fallback remains unassigned.
	require.Equal(t, 200, call(fmt.Sprint(secondStep)))
	for _, expected := range []struct{ step, tokens, nanos int64 }{
		{step, 14, 46000}, {secondStep, 7, 23000},
	} {
		var tokens, nanos int64
		require.NoError(t, pool.QueryRow(ctx, `SELECT SUM(input_tokens+output_tokens)::bigint, SUM(cost_nanos)::bigint FROM model_usage WHERE workflow_run_id=$1 AND workflow_step_id=$2`, run, expected.step).Scan(&tokens, &nanos))
		require.Equal(t, expected.tokens, tokens)
		require.Equal(t, expected.nanos, nanos)
	}
	var total int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT SUM(cost_nanos)::bigint FROM model_usage WHERE workflow_run_id=$1`, run).Scan(&total))
	require.EqualValues(t, 92000, total)
	// Defense in depth: accounting refuses a mismatched binding even if a
	// caller resolver regresses. No provider invocation or receipt survives.
	for _, binding := range []modelproxy.Caller{
		{OwnerType: "user", OwnerID: user, Source: modelproxy.SourceAgentRun, RepositoryID: repo, WorkflowRunID: run, WorkflowStepID: otherStep},
		{OwnerType: "user", OwnerID: user, Source: modelproxy.SourceAgentRun, WorkflowRunID: run, WorkflowStepID: step},
	} {
		err := handler.Owner.Execute(ctx, binding, modelproxy.Call{Provider: modelproxy.ProviderAnthropic, Model: "model-b", Maximum: modelprice.Usage{InputTokens: 1, OutputTokens: 1}}, func(context.Context) (modelproxy.Result, error) {
			t.Fatal("invalid step reached provider")
			return modelproxy.Result{}, nil
		})
		require.ErrorContains(t, err, "workflow step does not belong")
	}
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM model_usage`).Scan(&count))
	require.Equal(t, 4, count)
	// A private model remains usable with the owner's key, but its spend
	// remains unknown. No table entry means no fabricated monetary zero.
	require.Equal(t, 200, callModel(fmt.Sprint(secondStep), "private-model"))
	var customCost *int64
	var customTokens int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT cost_nanos,input_tokens+output_tokens FROM model_usage WHERE model='private-model'`).Scan(&customCost, &customTokens))
	require.Nil(t, customCost)
	require.EqualValues(t, 7, customTokens)

}

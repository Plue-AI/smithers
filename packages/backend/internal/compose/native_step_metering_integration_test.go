package compose

import (
	"context"
	"crypto/sha256"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// A native coding host names the engine dispatch each model call ran under
// (T-FLW-07). The owner-paid proxy records it on the metered row beside the
// host's workspace, never forwards it, and refuses it from any credential
// but the flow host's own.
func TestNativeStepMeteringPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "owner", LowerUsername: "owner", DisplayName: "Owner"})
	require.NoError(t, err)
	repository, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	var workspaceID string
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspaces (repository_id, user_id) VALUES ($1, $2) RETURNING id::text`, repository.ID, owner.ID).Scan(&workspaceID))
	bindingID := uuid.NewString()
	control := "native-step-control-credential"
	controlHash := sha256.Sum256([]byte(control))
	_, err = pool.Exec(ctx, `INSERT INTO flow_runtime_host_bindings (id, tenant_id, principal_id, binding_kind, binding_id, repository_id, user_id, workspace_id,
			catalog_key, service_name, runtime_artifact_digest, source_revision, owner_generation, credential_ciphertext, credential_hash, state)
		VALUES ($1, 'repository:1', 'user:1', 'mythical-item', 'item-1', $2, $3, $4, 'coding', 'smithers-coding-host', $5, $6, 1, $7, $8, 'running')`,
		bindingID, repository.ID, owner.ID, workspaceID, strings.Repeat("a", 64), strings.Repeat("b", 40), control, controlHash[:])
	require.NoError(t, err)
	hostCredential := flowhost.ModelCredential(bindingID, control)

	forwarded := []string{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		forwarded = append(forwarded, r.Header.Get(modelproxy.NativeStepHeader))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"}}],"usage":{"prompt_tokens":100,"completion_tokens":100}}`))
	}))
	defer upstream.Close()
	handler := &modelproxy.Handler{OwnerPaid: true,
		Owner:     modelproxy.OwnerMeter{DB: pool, DailyTokens: func(context.Context, int64) (int64, error) { return 1_000_000, nil }},
		Keys:      modelproxy.StaticKeys{modelproxy.ProviderCerebras: "fixture"},
		Callers:   services.NewModelProxyCallers(q, pool, webhook.NoopSecretCodec{}),
		Upstreams: map[string]string{modelproxy.ProviderCerebras: upstream.URL}}
	router := chi.NewRouter()
	mountModelProxy(router, q, testConfigAllFlagsOn(), handler)
	call := func(credential, step string) int {
		request := httptest.NewRequest(http.MethodPost, modelproxy.Path+"/cerebras/v1/chat/completions",
			strings.NewReader(`{"model":"gpt-oss-120b","max_tokens":64,"messages":[{"role":"user","content":"ok"}]}`))
		request.Header.Set("Authorization", "Bearer "+credential)
		if step != "" {
			request.Header.Set(modelproxy.NativeStepHeader, step)
		}
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		return recorder.Code
	}
	review := "8719d66760d1df891d8189e10b4cd99b4aa49e12561bd97ea944bac7ff889016:" + strings.Repeat("1", 64)
	edit := "run-1:" + strings.Repeat("2", 64)
	for _, step := range []string{review, review, edit, ""} {
		require.Equal(t, http.StatusOK, call(hostCredential, step))
	}
	require.Equal(t, []string{"", "", "", ""}, forwarded, "the dispatch never reaches the provider")

	// Each step's literal metered total: gpt-oss-120b at $0.35/$0.75 per
	// million input/output tokens is 110000 nanodollars per 100/100 call.
	type stepTotal struct {
		step          *string
		calls, tokens int64
		nanos         int64
	}
	rows, err := pool.Query(ctx, `SELECT native_step, count(*), sum(input_tokens+output_tokens)::bigint, sum(cost_nanos)::bigint
		FROM model_usage WHERE workspace_id=$1 AND source='flow_host' GROUP BY native_step ORDER BY native_step NULLS LAST`, workspaceID)
	require.NoError(t, err)
	var totals []stepTotal
	for rows.Next() {
		var row stepTotal
		require.NoError(t, rows.Scan(&row.step, &row.calls, &row.tokens, &row.nanos))
		totals = append(totals, row)
	}
	require.NoError(t, rows.Err())
	rows.Close()
	require.Len(t, totals, 3)
	require.Equal(t, review, *totals[0].step)
	require.Equal(t, [3]int64{2, 400, 220000}, [3]int64{totals[0].calls, totals[0].tokens, totals[0].nanos})
	require.Equal(t, edit, *totals[1].step)
	require.Equal(t, [3]int64{1, 200, 110000}, [3]int64{totals[1].calls, totals[1].tokens, totals[1].nanos})
	require.Nil(t, totals[2].step, "a call outside any dispatch stays unattributed")

	// A malformed dispatch, or a dispatch under a forged host credential, is
	// refused before the provider is called or a row is written.
	for _, step := range []string{"run-1", "run-1:" + strings.Repeat("A", 64), "has space:" + strings.Repeat("3", 64), strings.Repeat("x", 300) + ":" + strings.Repeat("3", 64)} {
		require.Equal(t, http.StatusForbidden, call(hostCredential, step), step)
	}
	require.Equal(t, http.StatusUnauthorized, call(flowhost.ModelCredential(bindingID, "wrong-control"), edit))
	require.Len(t, forwarded, 4)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM model_usage`).Scan(&count))
	require.Equal(t, 4, count)
}

package compose

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/modelhost"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// liveGatewayKeyEnv names a funded AI Gateway key for a live run of
// TestOwnerGatewayKeyServesTheCodingHostThroughTheProxyPostgres. Unset, a
// local upstream stands in for the Gateway.
const liveGatewayKeyEnv = "SMITHERS_LIVE_AI_GATEWAY_API_KEY"

// On an install the coding host runs the coding role Model access wrote, on
// the owner's AI Gateway key, through the owner-paid model proxy: the host
// holds only its proxy credential, and the proxy signs the call with the
// owner's sealed key (engineering spec §8.8.3, §15.2.1).
func TestOwnerGatewayKeyServesTheCodingHostThroughTheProxyPostgres(t *testing.T) {
	pool, databaseURL := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "owner", LowerUsername: "owner", DisplayName: "Owner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repository, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	var workspaceID string
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspaces (repository_id, user_id) VALUES ($1, $2) RETURNING id::text`, repository.ID, owner.ID).Scan(&workspaceID))

	gatewayKey, live := strings.TrimSpace(os.Getenv(liveGatewayKeyEnv)), true
	if gatewayKey == "" {
		gatewayKey, live = "owner-gateway-fixture-key", false
	}
	const secretKey = "owner-model-proxy-secret-key"
	codec, err := webhook.NewSecretCodec(secretKey)
	require.NoError(t, err)
	sealed, err := codec.EncryptString(gatewayKey)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO owner_model_credentials (user_id,name,origin,value_encrypted) VALUES ($1,'AI_GATEWAY_API_KEY','https://ai-gateway.vercel.sh',$2)`, owner.ID, sealed)
	require.NoError(t, err)
	coding := `{"protocol":"openai-chat","modelId":"openai/gpt-5.1","credential":"AI_GATEWAY_API_KEY","baseUrl":"https://ai-gateway.vercel.sh"}`
	for key, value := range map[string]string{"agent:coding": coding, "agent:jev": `{"protocol":"evaluation","modelId":"typesafe-ai/jev","credential":"AI_GATEWAY_API_KEY"}`} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(value)}))
	}
	resolver, err := modelhost.NewOwnerSecretResolver(func() string { return databaseURL }, func() string { return secretKey })
	require.NoError(t, err)
	t.Cleanup(resolver.Close)
	keys := modelhost.OwnerGatewayKeys{Resolver: resolver}

	// The install's proxy seats, and the coding host's seat on them.
	options := runOptions{Options: Options{OwnerModelKeys: keys}}
	proxyKeys, ownerPaid := options.proxyKeys()
	require.True(t, ownerPaid)
	seats := modelproxy.OfferedSeats(proxyKeys)
	require.Equal(t, []string{"vercel"}, func() (providers []string) {
		for _, seat := range seats {
			providers = append(providers, seat.Provider)
		}
		return
	}())
	boxes := &recordingBoxes{env: map[string]string{}}
	transport := &recordingHostTransport{}
	launcher := newBoxHostLauncher(transport, boxes, nil)
	launcher.codingModel = ownerCodingSeat(q, seats)
	launch := flowhost.HostLaunch{Binding: flowhost.Binding{ID: "host-1", UserID: owner.ID}, Authority: flowhost.Authority{WorkspaceID: workspaceID, UserID: owner.ID}}
	_, err = launcher.StartFlowHost(ctx, launch)
	require.NoError(t, err)
	require.Equal(t, "vercel:openai/gpt-5.1", transport.started[0].Catalog.ImplementationModel)
	// A platform pin, and a coding role on a key the proxy does not spend, keep the catalog's model.
	launch.Catalog.ImplementationModel = "cerebras:gpt-oss-120b"
	_, err = launcher.StartFlowHost(ctx, launch)
	require.NoError(t, err)
	require.Equal(t, "cerebras:gpt-oss-120b", transport.started[1].Catalog.ImplementationModel)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "agent:coding", Value: []byte(`{"protocol":"openai-responses","modelId":"gpt-5.1","credential":"OPENAI_API_KEY"}`)}))
	seat, err := ownerCodingSeat(q, seats)(ctx)
	require.NoError(t, err)
	require.Empty(t, seat)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "agent:coding", Value: []byte(coding)}))

	// The host's one credential is its binding's proxy credential.
	bindingID := uuid.NewString()
	control := "owner-flow-host-control-credential"
	controlHash := sha256.Sum256([]byte(control))
	_, err = pool.Exec(ctx, `INSERT INTO flow_runtime_host_bindings (id, tenant_id, principal_id, binding_kind, binding_id, repository_id, user_id, workspace_id,
			catalog_key, service_name, runtime_artifact_digest, source_revision, owner_generation, credential_ciphertext, credential_hash, state)
		VALUES ($1, 'repository:1', 'user:1', 'agent-session', 's-1', $2, $3, $4, 'coding', 'smithers-coding-host', $5, $6, 1, $7, $8, 'running')`,
		bindingID, repository.ID, owner.ID, workspaceID, strings.Repeat("a", 64), strings.Repeat("b", 40), control, controlHash[:])
	require.NoError(t, err)
	hostCredential := flowhost.ModelCredential(bindingID, control)
	require.NotContains(t, hostCredential, gatewayKey)

	upstreams := map[string]string{}
	var signed []string
	if !live {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			signed = append(signed, r.Header.Get("Authorization"))
			require.Equal(t, "/v1/chat/completions", r.URL.Path)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"}}],"usage":{"prompt_tokens":9,"completion_tokens":1}}`))
		}))
		defer upstream.Close()
		upstreams[modelproxy.ProviderVercel] = upstream.URL
	}
	// The repository's daily token budget, as its committed policy would read.
	budget := int64(600_000_000)
	budgets := 0
	ownerUsage := modelproxy.OwnerMeter{DB: pool, DailyTokens: func(_ context.Context, repositoryID int64) (int64, error) {
		require.Equal(t, repository.ID, repositoryID)
		budgets++
		return budget, nil
	}}
	handler := &modelproxy.Handler{OwnerPaid: ownerPaid, Owner: ownerUsage, Keys: proxyKeys, Callers: services.NewModelProxyCallers(q, pool, webhook.NoopSecretCodec{}), Upstreams: upstreams}
	router := chi.NewRouter()
	mountModelProxy(router, q, testConfigAllFlagsOn(), handler)
	call := func(credential, model string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, modelproxy.Path+"/vercel/v1/chat/completions",
			strings.NewReader(`{"model":"`+model+`","max_tokens":64,"messages":[{"role":"user","content":"Reply with the single word ok."}]}`))
		request.Header.Set("Authorization", "Bearer "+credential)
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		return recorder
	}
	// The coding model, then the review seat beside it: a second vendor on the same Gateway key.
	for _, model := range []string{"openai/gpt-5.1", "anthropic/claude-sonnet-4.5"} {
		answered := call(hostCredential, model)
		require.Equal(t, http.StatusOK, answered.Code, answered.Body.String())
		require.NotContains(t, answered.Body.String(), gatewayKey)
		var completion struct {
			Choices []struct {
				Message struct{ Content string } `json:"message"`
			} `json:"choices"`
		}
		raw, _ := io.ReadAll(answered.Body)
		require.NoError(t, json.Unmarshal(raw, &completion))
		require.NotEmpty(t, completion.Choices)
		require.NotEmpty(t, strings.TrimSpace(completion.Choices[0].Message.Content))
		if live {
			t.Logf("live AI Gateway %s through the owner-paid proxy answered %q", model, completion.Choices[0].Message.Content)
		}
	}
	if !live {
		require.Equal(t, []string{"Bearer " + gatewayKey, "Bearer " + gatewayKey}, signed, "the proxy signs with the owner's sealed key")
	}
	require.Equal(t, 2, budgets, "every call reads the repository's budget")

	// Each call is one model_usage row the owner paid: no Smithers credit
	// moved, and the row names the run's host, machine and repository.
	type usageRow struct {
		paidBy, source, reference, workspace, provider, model, outcome string
		repository, input, output, bound                               int64
		credited                                                       bool
	}
	readUsage := func() []usageRow {
		rows, err := pool.Query(ctx, `SELECT paid_by, source, reference, workspace_id::text, provider, model, outcome,
				repository_id, input_tokens, output_tokens, bound_tokens, credit_account_id IS NOT NULL OR reservation_id IS NOT NULL
			FROM model_usage ORDER BY id`)
		require.NoError(t, err)
		defer rows.Close()
		var out []usageRow
		for rows.Next() {
			var row usageRow
			require.NoError(t, rows.Scan(&row.paidBy, &row.source, &row.reference, &row.workspace, &row.provider, &row.model, &row.outcome,
				&row.repository, &row.input, &row.output, &row.bound, &row.credited))
			out = append(out, row)
		}
		require.NoError(t, rows.Err())
		return out
	}
	recorded := readUsage()
	require.Len(t, recorded, 2)
	for i, model := range []string{"openai/gpt-5.1", "anthropic/claude-sonnet-4.5"} {
		row := recorded[i]
		require.Equal(t, "owner", row.paidBy)
		require.False(t, row.credited)
		require.Equal(t, modelproxy.SourceFlowHost, row.source)
		require.Equal(t, bindingID, row.reference)
		require.Equal(t, workspaceID, row.workspace)
		require.Equal(t, repository.ID, row.repository)
		require.Equal(t, "vercel", row.provider)
		require.Equal(t, model, row.model)
		require.Equal(t, "succeeded", row.outcome)
		require.Greater(t, row.bound, int64(64), "the bound is the prompt allowance plus the 64-token output cap")
		if !live {
			require.EqualValues(t, 9, row.input)
			require.EqualValues(t, 1, row.output)
		} else {
			require.Positive(t, row.input+row.output)
		}
	}
	// The TODO launch budget reads the same rows.
	spent, err := q.MythicalRepositoryTokensSince(ctx, repository.ID, time.Now().UTC().Truncate(24*time.Hour))
	require.NoError(t, err)
	require.Equal(t, recorded[0].input+recorded[0].output+recorded[1].input+recorded[1].output, spent)

	// Past the budget the proxy refuses before the provider: the next call's
	// bound does not fit what is left today, and a declared 0 admits nothing.
	upstreamCalls := len(signed)
	for _, refused := range []int64{spent + recorded[0].bound - 1, 0} {
		budget = refused
		over := call(hostCredential, "openai/gpt-5.1")
		require.Equal(t, http.StatusTooManyRequests, over.Code, over.Body.String())
		require.Contains(t, over.Body.String(), "insufficient_quota")
		require.Contains(t, over.Body.String(), "daily token budget is spent")
		require.NotEmpty(t, over.Header().Get("Retry-After"))
	}
	require.Len(t, signed, upstreamCalls, "a refused call never reaches the provider")
	require.Len(t, readUsage(), 2, "a refused call records nothing")
	// With room for its bound, the same call runs again.
	budget = spent + recorded[0].bound + 1_000
	if !live {
		require.Equal(t, http.StatusOK, call(hostCredential, "openai/gpt-5.1").Code)
		require.Len(t, readUsage(), 3)
	}

	// A credential the proxy does not know spends nothing.
	require.Contains(t, []int{http.StatusUnauthorized, http.StatusForbidden}, call(flowhost.ModelCredential(bindingID, "rotated"), "openai/gpt-5.1").Code)
}

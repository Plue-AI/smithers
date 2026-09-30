package compose

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/chat/turncredential"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// A hosted chat turn spends its owner's managed credit through the metered
// proxy with its turn credential, and only while that producer generation is
// live (smithersai/smithers#3148). The credential opens no other route.
func TestModelProxyChargesChatTurnOwnerPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	alice, err := q.CreateUser(ctx, db.CreateUserParams{Username: "alice", LowerUsername: "alice", DisplayName: "Alice"})
	require.NoError(t, err)
	store, err := chat.NewStore(pool)
	require.NoError(t, err)
	scope := chat.Scope{UserID: alice.ID, Owner: "owner-alice"}
	claim := func() (chat.ProducerGrant, string) {
		runID := "chat-" + uuid.NewString()
		journal := chat.JournalRequest{Version: 1, LegID: uuid.NewString(), Token: strings.Repeat("a", 48) + strings.ReplaceAll(uuid.NewString(), "-", "")}
		request, _ := json.Marshal(map[string]any{"instructions": "", "messages": []any{map[string]string{"content": "hello", "role": "user"}}, "runId": runID})
		admitted, err := store.Admit(ctx, chat.AdmitInput{Scope: scope, RunID: runID, Journal: journal, Request: request})
		require.NoError(t, err)
		require.Equal(t, "accepted", admitted.Status)
		grant, err := store.Claim(ctx, scope, admitted.TurnID, time.Minute)
		require.NoError(t, err)
		return grant, runID
	}
	live, _ := claim()
	cancelled, cancelledRun := claim()
	_, err = store.Cancel(ctx, scope, cancelledRun)
	require.NoError(t, err)

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "sk-platform", r.Header.Get("X-Api-Key"), "the platform key is attached only at the proxy")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"usage":{"input_tokens":3,"output_tokens":4}}`))
	}))
	defer upstream.Close()
	ledger := credits.Ledger{DB: pool}
	account, err := ledger.EnsureAccount(ctx, "user", alice.ID)
	require.NoError(t, err)
	require.NoError(t, ledger.Grant(ctx, account, "test", 1_000_000_000, nil))
	handler := &modelproxy.Handler{Meter: modelproxy.Meter{Ledger: ledger}, Keys: modelproxy.StaticKeys{modelproxy.ProviderAnthropic: "sk-platform"},
		Callers: services.NewModelProxyCallers(q, pool, webhook.NoopSecretCodec{}), Upstreams: map[string]string{modelproxy.ProviderAnthropic: upstream.URL}}
	router := chi.NewRouter()
	mountModelProxy(router, q, testConfigAllFlagsOn(), handler)
	router.Route("/api", func(r chi.Router) {
		r.Use(authLoader(q, testConfigAllFlagsOn().Auth))
		r.With(middleware.RequireAuth).Get("/user", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	})
	call := func(method, path, credential string) int {
		request := httptest.NewRequest(method, path, strings.NewReader(`{"model":"claude-haiku-4-5","max_tokens":10,"messages":[]}`))
		// The model host's Anthropic route sends x-api-key.
		request.Header.Set("X-Api-Key", credential)
		if strings.HasPrefix(path, "/api/") {
			request.Header.Set("Authorization", "Bearer "+credential)
		}
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		return recorder.Code
	}
	const proxied = "/model-proxy/anthropic/v1/messages"
	require.Equal(t, http.StatusOK, call(http.MethodPost, proxied, turncredential.Mint(live.TurnID, live.Generation, live.Token)))
	require.Equal(t, http.StatusUnauthorized, call(http.MethodPost, proxied, turncredential.Mint(cancelled.TurnID, cancelled.Generation, cancelled.Token)), "a cancelled turn spends nothing")
	forged := live
	forged.Token = "not-the-producer-token"
	require.Equal(t, http.StatusUnauthorized, call(http.MethodPost, proxied, turncredential.Mint(forged.TurnID, forged.Generation, forged.Token)))
	require.Equal(t, http.StatusUnauthorized, call(http.MethodGet, "/api/user", turncredential.Mint(live.TurnID, live.Generation, live.Token)), "the turn credential is scoped to the model proxy")

	var source, ownerType, reference string
	var ownerID int64
	var rows int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) OVER (), source, owner_type, owner_id, reference FROM model_usage`).Scan(&rows, &source, &ownerType, &ownerID, &reference))
	require.Equal(t, []any{1, "app", "user", alice.ID, live.TurnID}, []any{rows, source, ownerType, ownerID, reference})
}

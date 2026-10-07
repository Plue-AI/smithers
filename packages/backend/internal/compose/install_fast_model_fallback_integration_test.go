package compose

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/modelhost"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/stretchr/testify/require"
)

func TestInstallFastModelFallbackPostgres(t *testing.T) {
	var mu sync.Mutex
	mode := "ok"
	resetAt := time.Now().UTC().Truncate(24 * time.Hour).Add(48 * time.Hour).Format(time.RFC3339)
	var calls []string
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/fast-model/exchange" {
			fmt.Fprintf(w, `{"credential":"host-only-install-key","remaining":100,"reset_at":"%s"}`, resetAt)
			return
		}
		if r.URL.Path == modelproxy.FastGatewayPath+"/quota" {
			fmt.Fprintf(w, `{"remaining_tokens":98,"reset_at":"%s"}`, resetAt)
			return
		}
		require.Equal(t, modelproxy.FastGatewayPath+"/v1/chat/completions", r.URL.Path)
		require.Equal(t, "Bearer host-only-install-key", r.Header.Get("Authorization"))
		var request map[string]any
		require.NoError(t, json.NewDecoder(r.Body).Decode(&request))
		if fastSelectionFixture(w, request) {
			return
		}
		mu.Lock()
		calls = append(calls, "Smithers")
		current := mode
		mu.Unlock()
		switch current {
		case "capacity", "team-refused":
			w.WriteHeader(429)
			fmt.Fprintf(w, `{"code":"capacity","remaining":0,"reset_at":"%s"}`, resetAt)
			return
		case "refused":
			w.WriteHeader(401)
			fmt.Fprint(w, `{"error":{"code":"refused","message":"host-only-install-key"}}`)
			return
		case "outage":
			w.WriteHeader(503)
			fmt.Fprint(w, `{"code":"unavailable"}`)
			return
		}
		w.Header().Set("Smithers-Quota-Remaining", "98")
		w.Header().Set("Smithers-Quota-Reset", resetAt)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"gateway answer\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer gateway.Close()
	t.Setenv("SMITHERS_FAST_MODEL_GATEWAY", gateway.URL)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
		if fastSelectionFixture(w, body) {
			return
		}
		model, _ := body["model"].(string)
		require.NotEqual(t, "Bearer host-only-install-key", r.Header.Get("Authorization"))
		mu.Lock()
		calls = append(calls, model)
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		if model == "coding-fixture" {
			require.Equal(t, "/v1/responses", r.URL.Path)
			require.Equal(t, "Bearer coding-key", r.Header.Get("Authorization"))
			fmt.Fprint(w, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"coding answer\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\n")
			return
		}
		mu.Lock()
		teamRefused := mode == "team-refused"
		mu.Unlock()
		if teamRefused {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(401)
			fmt.Fprint(w, `{"error":{"type":"authentication_error","message":"team refused"}}`)
			return
		}
		require.Equal(t, "Bearer team-key", r.Header.Get("Authorization"))
		require.Equal(t, "/v1/chat/completions", r.URL.Path)
		fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"team answer\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer provider.Close()
	local := startConfiguredLocalChat(t, func(local *localChat, _ *chat.RuntimeOptions) {
		var err error
		local.host, err = modelhost.New(local.resolver, local.launcher, modelhost.WithProviderStandIn(provider.URL))
		require.NoError(t, err)
	})
	defer local.stop(t)
	var err error
	local.enroll(t, "OPENAI_API_KEY", "https://api.openai.com", "coding-key")
	local.enroll(t, "CEREBRAS_API_KEY", "https://api.cerebras.ai", "team-key")
	q := db.New(local.pool)
	for key, binding := range map[string]string{"agent:fast": services.InstallFastModel, "agent:coding": `{"protocol":"openai-responses","modelId":"coding-fixture","credential":"OPENAI_API_KEY"}`} {
		require.NoError(t, q.UpsertInstallSetting(local.ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(binding)}))
	}
	access := services.InstallFastModelAccess{Pool: local.pool, Codec: local.codec, Gateway: gateway.URL}
	target, err := access.Begin(local.ctx, local.ownerID, "http://example.com/api/model/fast/return")
	require.NoError(t, err)
	uri, err := url.Parse(target)
	require.NoError(t, err)
	require.NoError(t, access.Complete(local.ctx, local.ownerID, uri.Query().Get("state"), "literal-code"))
	for _, tc := range []struct {
		mode, cause, answer string
		team                bool
	}{{"ok", "", "gateway answer", true}, {"capacity", "capacity", "team answer", true}, {"refused", "refused", "team answer", true}, {"outage", "unreachable", "team answer", true}, {"team-refused", "capacity", "coding answer", true}, {"capacity", "capacity", "coding answer", false}} {
		t.Run(tc.mode+fmt.Sprint(tc.team), func(t *testing.T) {
			require.NoError(t, access.Record(local.ctx, services.FastModelStatus{SignedIn: true, Source: "Smithers"}))
			if !tc.team {
				_, err = local.pool.Exec(local.ctx, `DELETE FROM owner_model_credentials WHERE user_id=$1 AND name='CEREBRAS_API_KEY'`, local.ownerID)
				require.NoError(t, err)
			}
			mu.Lock()
			mode = tc.mode
			calls = nil
			mu.Unlock()
			result := local.turn(t, nil)
			require.Contains(t, fastAnswer(t, result), tc.answer, "turn: %s", result.stream)
			require.NotContains(t, result.stream, "host-only-install-key")
			require.NotContains(t, string(result.replay), "host-only-install-key")
			status, err := access.Status(local.ctx)
			require.NoError(t, err)
			require.Equal(t, tc.cause, string(status.Cause))
			mu.Lock()
			observed := append([]string{}, calls...)
			mu.Unlock()
			require.Equal(t, "Smithers", observed[0])
			if tc.mode == "ok" {
				require.Len(t, observed, 1)
				require.Equal(t, "Smithers", status.Source)
			} else {
				if tc.mode == "team-refused" {
					require.Len(t, observed, 3)
				} else {
					require.Len(t, observed, 2)
				}
				if tc.team && tc.mode != "team-refused" {
					require.Equal(t, "team key", status.Source)
				} else {
					require.Equal(t, "coding model", status.Source)
				}
			}
			if tc.mode == "capacity" {
				mu.Lock()
				calls = nil
				mu.Unlock()
				cached := local.turn(t, nil)
				require.Contains(t, fastAnswer(t, cached), tc.answer)
				mu.Lock()
				require.Len(t, calls, 1, "Quota cooldown must bypass the gateway until reset")
				require.NotEqual(t, "Smithers", calls[0])
				mu.Unlock()

				require.Equal(t, resetAt, status.ResetAt)
				require.EqualValues(t, 0, *status.Remaining)
				require.NoError(t, access.Record(local.ctx, services.FastModelStatus{SignedIn: true, Source: "team key", Cause: "capacity", ResetAt: "2000-01-01T00:00:00Z"}))
				mu.Lock()
				mode = "ok"
				calls = nil
				mu.Unlock()
				reset := local.turn(t, nil)
				require.Contains(t, fastAnswer(t, reset), "gateway answer")
				mu.Lock()
				require.Equal(t, []string{"Smithers"}, calls)
				mu.Unlock()

			}
		})
	}
	// A connection refusal follows the same coding fallback and completes the turn.
	require.NoError(t, access.Record(local.ctx, services.FastModelStatus{SignedIn: true, Source: "Smithers"}))
	gateway.Close()
	result := local.turn(t, nil)
	require.Contains(t, fastAnswer(t, result), "coding answer")
	status, err := access.Status(local.ctx)
	require.NoError(t, err)
	require.Equal(t, "unreachable", string(status.Cause))
	// An explicit app assignment remains the owner's choice; fast sign-in
	// still supplies the separately selected context/preflight role.
	require.NoError(t, q.UpsertInstallSetting(local.ctx, db.UpsertInstallSettingParams{Key: "agent:app", Value: []byte(`{"protocol":"openai-responses","modelId":"coding-fixture","credential":"OPENAI_API_KEY"}`)}))
	assigned := local.turn(t, nil)
	require.Contains(t, fastAnswer(t, assigned), "coding answer", "turn: %s", assigned.stream)
	_, err = local.pool.Exec(local.ctx, `DELETE FROM install_settings WHERE key='agent:app'`)
	require.NoError(t, err)
	require.NoError(t, access.SignOut(local.ctx))
	mu.Lock()
	calls = nil
	mu.Unlock()
	result = local.turn(t, nil)
	require.Contains(t, fastAnswer(t, result), "coding answer")
	mu.Lock()
	require.Equal(t, []string{"coding-fixture"}, calls)
	mu.Unlock()
	require.NotContains(t, local.logs.String(), "host-only-install-key")
	require.NotContains(t, local.logs.String(), "team-key")
	require.NotContains(t, local.logs.String(), "coding-key")
	require.False(t, strings.Contains(result.stream, "host-only-install-key"))
}

func fastAnswer(t *testing.T, turn localTurn) string {
	t.Helper()
	var answer strings.Builder
	for _, batch := range turn.batches {
		for _, raw := range batch.Frames {
			var frame struct {
				Type string `json:"type"`
				Kind string `json:"kind"`
				Text string `json:"text"`
			}
			require.NoError(t, json.Unmarshal(raw, &frame))
			if frame.Type == "delta" && frame.Kind == "text" {
				answer.WriteString(frame.Text)
			}
		}
	}
	return answer.String()
}

// The shared install harness runs the ordinary context preflight before an
// answer. Its literal selector fixture returns an empty selection; generation
// calls below exercise the gateway refusal and fallback transport modes.
func fastSelectionFixture(w http.ResponseWriter, body map[string]any) bool {
	raw, _ := json.Marshal(body)
	if !strings.Contains(string(raw), "Choose relevant context") {
		return false
	}
	w.Header().Set("Content-Type", "text/event-stream")
	if _, responses := body["input"]; responses {
		fmt.Fprint(w, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"[]\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\n")
	} else {
		fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"[]\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}
	return true
}

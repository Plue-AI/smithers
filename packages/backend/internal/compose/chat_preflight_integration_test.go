package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/stretchr/testify/require"
)

// This boundary uses the packaged executable, real encrypted credentials,
// AuthLoader, prompt admission, dispatcher, callbacks and durable journal.
// Repository content is a literal fixture; native source confinement is covered
// by services' InstallContext tests and is not claimed by this test.
func TestLocalSharedPreflightUsesFastRoleThenCodingFallback(t *testing.T) {
	type call struct{ role, key, body string }
	calls := make(chan call, 8)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "read", 400)
			return
		}
		var input struct {
			Model string `json:"model"`
		}
		if json.Unmarshal(body, &input) != nil {
			http.Error(w, "json", 400)
			return
		}
		calls <- call{input.Model, r.Header.Get("Authorization"), string(body)}
		answer := "Retries three times."
		if input.Model != "answer" {
			answer = `[{"index":0,"reason":"Retry implementation"}]`
		}
		chunk, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]string{"content": answer}, "finish_reason": nil}}})
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "data: %s\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n", chunk)
	}))
	defer provider.Close()
	sum := sha256.Sum256([]byte("composed-context-session"))
	credential := middleware.Credential{SessionHash: hex.EncodeToString(sum[:])}
	local := startConfiguredLocalChat(t, func(local *localChat, options *chat.RuntimeOptions) {
		options.ContextRepository = func(_ context.Context, got middleware.Credential, userID, repoID int64, branch string) (json.RawMessage, error) {
			if got != credential || userID != local.ownerID || repoID != local.repoID || branch != "main" {
				return nil, chat.ErrForbidden
			}
			return json.RawMessage(`{"state":"main","candidates":[{"item":{"kind":"file","label":"retry.ts","ref":"src/webhooks/retry.ts","revision":"abc123"},"text":"export const retries = 3"},{"item":{"kind":"file","label":"unselected.ts","ref":"unselected.ts","revision":"abc123"},"text":"unselected-content-canary"}],"tokenBudget":24000}`), nil
		}
	})
	defer local.stop(t)
	q := db.New(local.pool)
	_, err := local.pool.Exec(local.ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, local.ownerID)
	require.NoError(t, err)
	_, err = local.pool.Exec(local.ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, local.repoID, local.ownerID)
	require.NoError(t, err)
	repository, _ := json.Marshal(map[string]int64{"repository_id": local.repoID})
	require.NoError(t, q.UpsertInstallSetting(local.ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: repository}))
	_, err = q.CreateAuthSession(local.ctx, db.CreateAuthSessionParams{UserID: local.ownerID, Username: "chatowner", SessionKey: credential.SessionHash, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	for role, name := range map[string]string{"coding": "CODING_KEY", "fast": "FAST_KEY", "app": "ANSWER_KEY"} {
		modelID := role
		if role == "app" {
			modelID = "answer"
		}
		local.enroll(t, name, provider.URL, role+"-private-key")
		model, _ := json.Marshal(map[string]string{"protocol": "openai-chat", "modelId": modelID, "credential": name, "baseUrl": provider.URL})
		require.NoError(t, q.AssignInstallAgentModel(local.ctx, role, model))
	}
	local.composition.runtime.Handler.ResolveBranch = func(_ context.Context, scope chat.Scope, branch string) (string, error) {
		if scope.UserID != local.ownerID || scope.RepositoryID != local.repoID || branch != "main" {
			return "", chat.ErrForbidden
		}
		return branch, nil
	}
	router := chi.NewRouter()
	router.Use(middleware.AuthLoader(q, config.AuthConfig{SessionCookieName: "context_session"}))
	local.composition.runtime.MountPublic(router)
	public := httptest.NewServer(router)
	defer public.Close()
	jar, err := cookiejar.New(nil)
	require.NoError(t, err)
	origin, err := url.Parse(public.URL)
	require.NoError(t, err)
	jar.SetCookies(origin, []*http.Cookie{{Name: "context_session", Value: "composed-context-session"}})
	client := &http.Client{Jar: jar, Timeout: 30 * time.Second}
	for _, role := range []string{"fast", "coding"} {
		if role == "coding" {
			body := strings.NewReader(`{"action":"remove","requestId":"remove-fast-for-fallback","name":"FAST_KEY"}`)
			response, err := local.client.Post(local.public.URL+"/api/model/credential", "application/json", body)
			require.NoError(t, err)
			raw, err := io.ReadAll(response.Body)
			response.Body.Close()
			require.NoError(t, err)
			require.Contains(t, string(raw), `"ok":true`)
		}
		body, _ := json.Marshal(map[string]string{"prompt": "Where do we retry webhooks?", "idempotencyKey": "preflight-" + role})
		response, err := client.Post(public.URL+"/api/conversations/main/prompt", "application/json", strings.NewReader(string(body)))
		require.NoError(t, err)
		raw, err := io.ReadAll(response.Body)
		response.Body.Close()
		require.NoError(t, err)
		require.Equal(t, http.StatusAccepted, response.StatusCode, string(raw))
		var admitted struct {
			TurnID string `json:"turnId"`
			RunID  string `json:"runId"`
		}
		require.NoError(t, json.Unmarshal(raw, &admitted))
		recorded := []call{}
		for range 2 {
			select {
			case got := <-calls:
				recorded = append(recorded, got)
			case <-time.After(20 * time.Second):
				t.Fatal("missing model call")
			}
		}
		require.Equal(t, role, recorded[0].role)
		require.Equal(t, "Bearer "+role+"-private-key", recorded[0].key)
		require.Contains(t, recorded[0].body, "Choose relevant context")
		require.Contains(t, recorded[0].body, "unselected-content-canary")
		require.Equal(t, "answer", recorded[1].role)
		require.Equal(t, "Bearer app-private-key", recorded[1].key)
		require.Contains(t, recorded[1].body, "export const retries = 3")
		require.NotContains(t, recorded[1].body, "unselected-content-canary")
		require.Eventually(t, func() bool {
			var terminal bool
			err := local.pool.QueryRow(local.ctx, `SELECT terminal FROM chat_turns WHERE id=$1`, admitted.TurnID).Scan(&terminal)
			return err == nil && terminal
		}, 10*time.Second, 20*time.Millisecond)
		shared, err := local.composition.runtime.Handler.Store.SharedEntries(local.ctx, chat.Scope{UserID: local.ownerID, RepositoryID: local.repoID, Owner: "chatowner"}, "main")
		require.NoError(t, err)
		entry := shared.Entries[len(shared.Entries)-1]
		require.Equal(t, admitted.RunID, entry.RunID)
		require.NotNil(t, entry.Context)
		require.Len(t, *entry.Context, 1)
		require.JSONEq(t, `{"kind":"file","label":"retry.ts","ref":"src/webhooks/retry.ts","revision":"abc123","reason":"Retry implementation"}`, string((*entry.Context)[0]))
		frames, err := json.Marshal(entry.Frames)
		require.NoError(t, err)
		require.NotContains(t, string(frames), "context.preflight")
		var journal []byte
		require.NoError(t, local.pool.QueryRow(local.ctx, `SELECT jsonb_agg(frame ORDER BY batch_number,position)
          FROM chat_turn_batches b CROSS JOIN LATERAL jsonb_array_elements(b.frames) WITH ORDINALITY AS f(frame,position)
          WHERE b.turn_id=$1 AND frame->>'type'='context.preflight'`, admitted.TurnID).Scan(&journal))
		var steps []struct {
			Phase  string `json:"phase"`
			Result struct {
				Model string `json:"model"`
			} `json:"result"`
		}
		require.NoError(t, json.Unmarshal(journal, &steps))
		require.Len(t, steps, 2)
		require.Equal(t, "started", steps[0].Phase)
		require.Equal(t, "completed", steps[1].Phase)
		require.Equal(t, role, steps[0].Result.Model)
		require.Equal(t, role, steps[1].Result.Model)
		for _, key := range []string{"app-private-key", "fast-private-key", "coding-private-key"} {
			require.NotContains(t, string(frames), key)
			require.NotContains(t, string(journal), key)
			require.NotContains(t, local.logs.String(), key)
		}
	}
	require.Empty(t, calls)
}

package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// Real prompt authentication, Dispatcher, packaged host, bearer issuance and
// the production API router. Only the model endpoint is scripted.
func TestInstallAPIHostUsesPublicRouterAndRevokesBearer(t *testing.T) {
	var mu sync.Mutex
	var requests []string
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "read", 400)
			return
		}
		mu.Lock()
		requests = append(requests, string(body))
		mu.Unlock()
		var input struct {
			Model    string `json:"model"`
			Messages []struct {
				Role string `json:"role"`
			} `json:"messages"`
		}
		if json.Unmarshal(body, &input) != nil {
			http.Error(w, "json", 400)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		var delta map[string]any
		finish := "stop"
		if input.Model == "selector" {
			delta = map[string]any{"content": "[]"}
		} else {
			answered := false
			for _, m := range input.Messages {
				answered = answered || m.Role == "tool"
			}
			if answered {
				delta = map[string]any{"content": "Stack listed."}
			} else {
				calls := []any{}
				for i, args := range []string{
					`{"action":"execute","name":"stack"}`,
					`{"action":"execute","name":"flow","args":"todo"}`,
					`{"action":"execute","name":"flow.edit","args":"merge Add a step"}`,
					`{"action":"execute","name":"flow.edit","args":"todo Run tests"}`,
					`{"action":"execute","name":"flow.edit","args":"{\"name\":\"todo\",\"request\":\"Run tests\",\"diff\":\"+pnpm test\"}"}`,
					`{"action":"execute","name":"stack.move","args":"T2 up"}`,
					`{"action":"execute","name":"todo.stop","args":"T1"}`,
					`{"action":"execute","name":"todo.drop","args":"T1"}`,
					`{"action":"execute","name":"merge","args":"T1"}`,
				} {
					calls = append(calls, map[string]any{"index": i, "id": fmt.Sprintf("catalog-%d", i), "type": "function", "function": map[string]string{"name": "commands", "arguments": args}})
				}
				delta = map[string]any{"role": "assistant", "tool_calls": calls}
				finish = "tool_calls"
			}
		}
		chunk, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}}})
		fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", chunk)
	}))
	defer provider.Close()
	bearer := make(chan string, 32)
	calls := make(map[string]int)
	var callsMu sync.Mutex
	local := startConfiguredLocalChat(t, func(local *localChat, options *chat.RuntimeOptions) {
		q := db.New(local.pool)
		ctx := local.ctx
		_, err := local.pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, local.ownerID)
		require.NoError(t, err)
		binding := fmt.Sprintf(`{"owner_login":"chatowner","repository_name":"chatrepo","repository_id":%d}`, local.repoID)
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(strings.TrimSuffix(binding, "}") + `,"last_access_check_at":"2026-10-06T15:00:00Z"}`)}))
		_, err = local.pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, local.repoID, local.ownerID)
		require.NoError(t, err)
		cookie := sha256.Sum256([]byte("host-api-session"))
		_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: local.ownerID, Username: "chatowner", SessionKey: hex.EncodeToString(cookie[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		_, err = q.InsertMythicalTodo(ctx, local.repoID, local.ownerID, "Add greeting", "Add greeting", json.RawMessage(`[]`), json.RawMessage(`{"todo":true}`))
		require.NoError(t, err)
		_, err = q.InsertMythicalTodo(ctx, local.repoID, local.ownerID, "Second greeting", "Second greeting", json.RawMessage(`[]`), json.RawMessage(`{"todo":true}`))
		require.NoError(t, err)
		_, err = q.RequestMythicalBootstrap(ctx, local.repoID, local.ownerID, 1, false)
		require.NoError(t, err)
		_, err = local.pool.Exec(ctx, `UPDATE mythical_stacks SET state='active' WHERE repository_id=$1`, local.repoID)
		require.NoError(t, err)
		_, err = local.pool.Exec(ctx, `UPDATE mythical_items SET stack_position=number WHERE repository_id=$1`, local.repoID)
		require.NoError(t, err)
		cfg := testConfigAllFlagsOn()
		cfg.Server.PublicURL = "http://localhost:4000"
		cfg.Auth.Mode = "selfhost"
		cfg.Auth.SessionCookieName = "session"
		cfg.Server.PublicURL = "http://127.0.0.1:4000"
		cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
		auth := services.NewAuthService(q, cfg.Auth, nil, nil)
		auth.Members = &services.Members{Pool: local.pool}
		options.API = services.InstallAPI{Auth: auth}
		reader := conversationContextSource(t, local)
		options.ContextRepository = reader.Read
		local.api = func(runtime *chat.Runtime) http.Handler {
			branches := services.NewWorkspaceService(q, services.WithWorkspaceTransactions(local.pool), services.WithBranchMachineProviders(services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), nil)))
			runtime.Handler.ResolveBranch = conversationBranchResolver(branches)
			fn := reflect.ValueOf(buildRouter)
			args := make([]reflect.Value, fn.Type().NumIn())
			for i := range args {
				args[i] = reflect.Zero(fn.Type().In(i))
				for _, value := range []any{cfg, q, local.pool} {
					v := reflect.ValueOf(value)
					if v.Type() == fn.Type().In(i) {
						args[i] = v
					}
				}
			}
			service := services.NewMythicalService(local.pool, nil)
			topics := &liveTopics{queries: q, todos: service}
			args[len(args)-1] = reflect.ValueOf([]any{routerExtras{Mythical: &routes.MythicalHandler{Service: service}, Members: &routes.MembersHandler{Service: auth.Members}, Live: &routes.LiveHandler{Queries: q, Topics: topics.resolver}}})
			router := fn.CallSlice(args)[0].Interface().(chi.Router)
			mountChatPublic(router, runtime, q, cfg)
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasPrefix(r.URL.Path, "/api/flows") || r.URL.Path == "/api/stack" || strings.HasPrefix(r.URL.Path, "/api/todos/") {
					if r.URL.Path == "/api/stack" {
						require.Equal(t, "GET", r.Method)
					} else if r.Method == http.MethodPost {
						require.True(t, strings.HasPrefix(r.Header.Get("Idempotency-Key"), "chat:"))
					} else {
						require.Equal(t, http.MethodGet, r.Method)
					}
					key := r.Method + " " + r.URL.Path
					if r.Method == http.MethodPost {
						raw, err := io.ReadAll(r.Body)
						require.NoError(t, err)
						r.Body = io.NopCloser(strings.NewReader(string(raw)))
						var operation struct {
							Op string `json:"op"`
						}
						require.NoError(t, json.Unmarshal(raw, &operation))
						key += " " + operation.Op
					}
					callsMu.Lock()
					calls[key]++
					callsMu.Unlock()
					require.Equal(t, "smithers", r.Header.Get("Smithers-Via"))
					require.Empty(t, r.Header.Get("Cookie"))
					bearer <- strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
				}
				router.ServeHTTP(w, r)
			})
		}
	})
	defer local.stop(t)
	local.enroll(t, "HOST_API_KEY", provider.URL, "model-private-key")
	q := db.New(local.pool)
	for role, model := range map[string]string{"app": "answer", "fast": "selector", "coding": "selector"} {
		value, _ := json.Marshal(map[string]string{"protocol": "openai-chat", "modelId": model, "credential": "HOST_API_KEY", "baseUrl": provider.URL})
		require.NoError(t, q.AssignInstallAgentModel(local.ctx, role, value))
	}
	origin := "http://" + local.composition.listener.Addr().String()
	req, err := http.NewRequest("POST", origin+"/api/conversations/main/prompt", strings.NewReader(`{"prompt":"List the stack","idempotencyKey":"host-api"}`))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")
	req.Host = "localhost:4000"
	req.Header.Set("Origin", "http://localhost:4000")
	req.Header.Set("X-CSRF-Token", "csrf")
	req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
	req.AddCookie(&http.Cookie{Name: "session", Value: "host-api-session"})
	response, err := local.client.Do(req)
	require.NoError(t, err)
	raw, err := io.ReadAll(response.Body)
	response.Body.Close()
	require.NoError(t, err)
	require.Equal(t, 202, response.StatusCode, string(raw))
	var admitted struct {
		TurnID string `json:"turnId"`
	}
	require.NoError(t, json.Unmarshal(raw, &admitted))
	var state string
	require.Eventually(t, func() bool {
		err := local.pool.QueryRow(local.ctx, `SELECT state FROM chat_turns WHERE id=$1`, admitted.TurnID).Scan(&state)
		return err == nil && (state == "completed" || state == "failed" || state == "uncertain")
	}, 30*time.Second, 20*time.Millisecond, local.logs.String())
	require.Equal(t, "completed", state, local.logs.String())
	var token string
	select {
	case token = <-bearer:
	default:
		t.Fatal("host never called the public API")
	}
	for len(bearer) > 0 {
		require.Equal(t, token, <-bearer)
	}
	callsMu.Lock()
	require.Equal(t, 1, calls["GET /api/stack"])
	require.Equal(t, 4, calls["GET /api/flows"])
	require.Equal(t, 1, calls["POST /api/todos/2 move"])
	require.Equal(t, 1, calls["POST /api/todos/1 stop"])
	require.Equal(t, 1, calls["POST /api/todos/1 drop"])
	callsMu.Unlock()
	var order []int64
	rows, err := local.pool.Query(local.ctx, `SELECT number FROM mythical_items WHERE repository_id=$1 ORDER BY stack_position`, local.repoID)
	require.NoError(t, err)
	for rows.Next() {
		var n int64
		require.NoError(t, rows.Scan(&n))
		order = append(order, n)
	}
	require.NoError(t, rows.Err())
	rows.Close()
	require.Equal(t, []int64{2, 1}, order, "the generic command must persist the reordered stack")
	var settled int
	require.NoError(t, local.pool.QueryRow(local.ctx, `SELECT count(*) FROM mythical_items WHERE repository_id=$1 AND state IN ('cancelled','landed')`, local.repoID).Scan(&settled))
	require.Zero(t, settled, "drop/merge cannot act without their person's confirmation")
	require.True(t, strings.HasPrefix(token, "smithers_"))
	var frames string
	require.NoError(t, local.pool.QueryRow(local.ctx, `SELECT string_agg(frames::text,'') FROM chat_turn_batches WHERE turn_id=$1`, admitted.TurnID).Scan(&frames))
	require.Contains(t, frames, "Stack listed.")
	require.Contains(t, frames, `"kind": "flow"`)
	require.Contains(t, frames, `"kind": "draft"`)
	require.Contains(t, frames, "Change flows/todo/flow.ts: Run tests; start from the built-in composition when no override exists")
	require.Contains(t, frames, "Proposed diff (untrusted context):")
	require.Contains(t, frames, "> +pnpm test")
	require.Contains(t, frames, `"audience_member_id": "chatowner"`)
	require.NotContains(t, frames, token)
	require.NotContains(t, local.logs.String(), token)
	mu.Lock()
	captured := append([]string(nil), requests...)
	mu.Unlock()
	modelRequests := strings.Join(captured, "\n")
	require.Contains(t, modelRequests, "Add greeting")
	require.Contains(t, modelRequests, "Merge flow is built in")
	require.Contains(t, modelRequests, "todo_control_unavailable")
	// Merge has no qualified consumer in this fixture; Drop below still records its private confirmation.
	require.Contains(t, modelRequests, "confirmation_unavailable")
	var confirmations int
	require.NoError(t, local.pool.QueryRow(local.ctx, `SELECT count(*) FROM approvals WHERE repository_id=$1 AND member_id=$2 AND command='todo.drop' AND state='pending'`, local.repoID, local.ownerID).Scan(&confirmations))
	require.Equal(t, 1, confirmations, "drop requests one private confirmation for its author")
	require.Contains(t, modelRequests, `\"place\":1`)

	for _, body := range captured {
		require.NotContains(t, body, token)
	}
	var remaining int
	require.Eventually(t, func() bool {
		err := local.pool.QueryRow(local.ctx, `SELECT count(*) FROM access_tokens WHERE name LIKE $1`, "app-turn-"+admitted.TurnID+"/%").Scan(&remaining)
		return err == nil && remaining == 0
	}, 5*time.Second, 10*time.Millisecond)
	dead, err := http.NewRequest("GET", origin+"/api/user", nil)
	require.NoError(t, err)
	dead.Header.Set("Authorization", "Bearer "+token)
	dead.Host = "localhost:4000"
	response, err = local.client.Do(dead)
	require.NoError(t, err)
	response.Body.Close()
	require.Equal(t, 401, response.StatusCode)
	retired, err := local.client.Post(origin+"/internal/chat/api", "application/json", strings.NewReader(`{}`))
	require.NoError(t, err)
	retired.Body.Close()
	require.Equal(t, 404, retired.StatusCode)
}

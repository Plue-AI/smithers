package compose

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/modelhost"
	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/smithersai/smithers/packages/backend/process"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/smithersai/smithers/packages/backend/testkit/testdb"
)

// Exercises the local composition's actual dispatcher, process workspace,
// packaged TypeScript host, encrypted product secret store and journal.
func TestLocalChatComposedModelTurn(t *testing.T) {
	local := startLocalChat(t)
	ctx, pool, repoID, ownerID := local.ctx, local.pool, local.repoID, local.ownerID
	var resolvedID int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT r.id FROM repositories r JOIN owner_namespaces ns ON ns.user_id=r.user_id WHERE ns.lower_slug='chatowner' AND r.lower_name='chatrepo'`).Scan(&resolvedID))
	require.Equal(t, repoID, resolvedID)
	secretService := services.NewSecretService(db.New(pool), local.codec)
	_, lookupErr := db.New(pool).GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{Owner: "chatowner", LowerName: "chatrepo"})
	require.NoError(t, lookupErr)
	providerKey := "owner-private-provider-key"
	receivedKey := make(chan string, 1)
	provider := localChatProvider(receivedKey)
	defer provider.Close()
	_, err := secretService.SetSecret(ctx, local.actor, "chatowner", "chatrepo", "TEST_PROVIDER", providerKey, nil, nil, nil)
	require.NoError(t, err)
	_, err = secretService.SetSecret(ctx, local.actor, "chatowner", "chatrepo", "TEST_PROVIDER_ORIGIN", provider.URL, nil, nil, nil)
	require.NoError(t, err)
	foreignRequest, err := json.Marshal(map[string]any{"repositoryId": repoID, "model": map[string]string{
		"protocol": "openai-chat", "modelId": "test-model", "credential": "TEST_PROVIDER", "baseUrl": provider.URL,
	}})
	require.NoError(t, err)
	_, err = local.resolver.ResolveChatModel(ctx, ownerID+1, 0, foreignRequest)
	require.ErrorIs(t, err, ports.ErrModelCredentialMissing)

	repositoryTurn := func(name string) (string, string) {
		result := local.turn(t, map[string]any{"repositoryId": repoID,
			"model": map[string]string{"protocol": "openai-chat", "modelId": "test-model", "credential": name, "baseUrl": provider.URL}})
		return result.stream, string(result.replay)
	}
	stream, replay := repositoryTurn("TEST_PROVIDER")
	require.Contains(t, stream, "hello from provider")
	require.Contains(t, replay, "hello from provider")
	select {
	case got := <-receivedKey:
		require.Equal(t, "Bearer "+providerKey, got)
	case <-time.After(time.Second):
		t.Fatal("provider did not receive owner key")
	}
	require.NotContains(t, stream, providerKey)
	require.NotContains(t, replay, providerKey)

	missingStream, missingReplay := repositoryTurn("MISSING_PROVIDER")
	require.Contains(t, missingStream, `"code":"credential_missing"`)
	require.Contains(t, missingReplay, `"code":"credential_missing"`)
	require.Contains(t, missingStream, "Model credential missing")
	require.Contains(t, missingReplay, "Model credential missing")
	// The ordinary composer has no repository or model fields. Its owner
	// selection and credential must be enough to answer the turn.
	require.Contains(t, local.turn(t, nil).stream, `"code":"credential_missing"`)
	local.enroll(t, "OWNER_PROVIDER", provider.URL, providerKey)
	local.setDefault(t, map[string]string{"protocol": "openai-chat", "modelId": "test-model", "credential": "OWNER_PROVIDER", "baseUrl": provider.URL})
	require.Contains(t, local.turn(t, nil).stream, "hello from provider")
	select {
	case got := <-receivedKey:
		require.Equal(t, "Bearer "+providerKey, got)
	case <-time.After(time.Second):
		t.Fatal("provider did not receive owner credential")
	}
	local.stop(t)
}

// TestLiveProviderChatPersistsAndReplays is the opt-in live provider smoke:
// sign in, save a built-in provider key, choose it as the default model,
// chat, and read the answer back from PostgreSQL. It calls the provider
// directly; no Smithers-operated upstream is configured. Enable it with the
// model record in SMITHERS_LIVE_MODEL and the key in the environment
// variable its credential names, for example:
//
//	SMITHERS_LIVE_MODEL='{"protocol":"openai-chat","modelId":"gpt-oss-120b","credential":"CEREBRAS_API_KEY","baseUrl":"https://api.cerebras.ai"}'
func TestLiveProviderChatPersistsAndReplays(t *testing.T) {
	raw := strings.TrimSpace(os.Getenv("SMITHERS_LIVE_MODEL"))
	if raw == "" {
		t.Skip("SMITHERS_LIVE_MODEL is not set; the live provider smoke is opt-in")
	}
	var model map[string]string
	require.NoError(t, json.Unmarshal([]byte(raw), &model), "SMITHERS_LIVE_MODEL is a model record")
	require.NotEmpty(t, model["baseUrl"], "SMITHERS_LIVE_MODEL names the provider origin in baseUrl")
	key := os.Getenv(model["credential"])
	require.NotEmpty(t, key, "the environment holds no value for %s", model["credential"])

	local := startLocalChat(t)
	local.enroll(t, model["credential"], model["baseUrl"], key)
	local.setDefault(t, model)
	result := local.turn(t, map[string]any{"instructions": "Answer in one word.",
		"messages": []any{map[string]string{"role": "user", "content": "Reply with the single word pong."}}})
	local.stop(t)

	// Reloaded shared output is backed by the same persisted hash chain.
	streamed := result.batches
	var visible chat.SharedTurn
	require.NoError(t, json.Unmarshal([]byte(result.stream), &visible))
	require.Equal(t, chat.StateCompleted, visible.State)
	require.JSONEq(t, result.stream, string(result.replay))
	require.NotEmpty(t, streamed)
	var text strings.Builder
	var frames []map[string]any
	for index, batch := range streamed {
		if index > 0 {
			previous := streamed[index-1]
			require.Equal(t, previous.Hash, batch.PreviousHash)
			require.Equal(t, previous.From+int64(len(previous.Frames)), batch.From)
		}
		for _, frame := range batch.Frames {
			var decoded map[string]any
			require.NoError(t, json.Unmarshal(frame, &decoded))
			frames = append(frames, decoded)
			if decoded["type"] == "delta" && decoded["kind"] == "text" {
				text.WriteString(decoded["text"].(string))
			}
		}
	}
	done := frames[len(frames)-1]
	require.Equal(t, "done", done["type"], "%v", done)
	require.Equal(t, "stop", done["reason"], "%v", done)
	require.NotContains(t, done, "error")
	require.Contains(t, strings.ToLower(text.String()), "pong")
	t.Logf("live provider answered %q in %d frames", text.String(), len(frames))

	var state string
	var terminal bool
	require.NoError(t, local.pool.QueryRow(local.ctx, `SELECT state, terminal FROM chat_turns WHERE user_id=$1 AND run_id=$2`, local.ownerID, result.runID).Scan(&state, &terminal))
	require.Equal(t, "completed", state)
	require.True(t, terminal)
	var persisted string
	require.NoError(t, local.pool.QueryRow(local.ctx, `SELECT coalesce(string_agg(t::text, ''), '') || coalesce((SELECT string_agg(b::text, '') FROM chat_turn_batches b), '') || coalesce((SELECT string_agg(c::text, '') FROM owner_model_credentials c), '') FROM chat_turns t`).Scan(&persisted))
	for name, value := range map[string]string{"stream": result.stream, "replay": string(result.replay), "diagnostic logs": local.logs.String(), "database rows": persisted} {
		require.NotContains(t, value, key, "the provider key leaked into %s", name)
	}
}

type localChat struct {
	models          *httptest.Server
	nodeBinary      string
	hostBundle      string
	api             func(*chat.Runtime) http.Handler
	configureExtras func(*routerExtras)
	ctx             context.Context
	pool            *pgxpool.Pool
	ownerID         int64
	repoID          int64
	actor           *db.User
	codec           *webhook.AESGCMSecretCodec
	resolver        *modelhost.OwnerSecretResolver
	host            *modelhost.Host
	composition     *chatComposition
	public          *httptest.Server
	client          *http.Client
	logs            *lockedBuffer
	stopOnce        sync.Once
	stopDispatch    context.CancelFunc
	dispatchDone    chan error
	serveDone       chan error
	launcher        *modelhost.LocalLauncher
}

type localTurn struct {
	runID   string
	stream  string
	replay  []byte
	batches []chat.Batch
}

// startLocalChat composes the local chat runtime around a packaged model
// host and a fresh product database, signed in as the repository owner.
func startLocalChat(t *testing.T) *localChat {
	return startConfiguredLocalChat(t, nil)
}

func startConfiguredLocalChat(t *testing.T, configure func(*localChat, *chat.RuntimeOptions)) *localChat {
	t.Helper()
	if testdb.ServerURL() == "" {
		testdb.Unavailable(t, testdb.ErrNotConfigured)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node is required for packaged model host")
	}
	node, err = filepath.EvalSymlinks(node)
	require.NoError(t, err)
	_, source, _, ok := runtime.Caller(0)
	require.True(t, ok)
	root := filepath.Clean(filepath.Join(filepath.Dir(source), "../../../.."))
	// The host bundle is built with the workspace's esbuild; a checkout
	// without `pnpm install` cannot build it, which is not a product failure
	// unless this run requires the database suites.
	if _, err := os.Stat(filepath.Join(root, "apps/model-host/node_modules/esbuild")); err != nil && os.Getenv("SMITHERS_REQUIRE_DATABASE_TESTS") != "1" {
		t.Skip("apps/model-host dependencies are not installed; run pnpm install")
	}
	bundle := filepath.Join(t.TempDir(), "smithers-model-host")
	build := exec.Command(node, filepath.Join(root, "apps/model-host/build.mjs"), bundle)
	build.Dir = root
	output, err := build.CombinedOutput()
	require.NoError(t, err, string(output))

	// Multi-turn provider-removal rehearsals retain one install and native store
	// across outages and restoration. Bound the fixture lifetime, not each turn.
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	t.Cleanup(cancel)
	pool, databaseURL := postgresfixture.NewProductDatabase(t)
	local := &localChat{nodeBinary: node, hostBundle: bundle, ctx: ctx, pool: pool, logs: &lockedBuffer{}, client: &http.Client{Timeout: 60 * time.Second}}
	t.Cleanup(func() {
		if t.Failed() {
			t.Log(local.logs.String())
		}
	})
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users (username,lower_username) VALUES ('chatowner','chatowner') RETURNING id`).Scan(&local.ownerID))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories (user_id,name,lower_name) VALUES ($1,'chatrepo','chatrepo') RETURNING id`, local.ownerID).Scan(&local.repoID))
	local.actor = &db.User{ID: local.ownerID, Username: "chatowner"}
	local.codec, err = webhook.NewSecretCodec("local-chat-secret-key")
	require.NoError(t, err)

	// Every diagnostic line the composition writes is kept for leak checks.
	logger := slog.New(slog.NewTextHandler(local.logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	previousLogger := slog.Default()
	slog.SetDefault(logger)
	t.Cleanup(func() { slog.SetDefault(previousLogger) })

	workspaceRuntime, err := process.New(process.Config{Root: filepath.Join(t.TempDir(), "workspaces")})
	require.NoError(t, err)
	t.Cleanup(func() { _ = workspaceRuntime.Close() })
	launcher, err := modelhost.NewLocalLauncher(modelhost.LocalConfig{Runtime: workspaceRuntime, NodeBinary: node, BundlePath: bundle})
	require.NoError(t, err)
	local.resolver, err = modelhost.NewOwnerSecretResolver(func() string { return databaseURL }, func() string { return "local-chat-secret-key" })
	require.NoError(t, err)
	local.launcher = launcher
	local.host, err = modelhost.New(local.resolver, launcher)
	require.NoError(t, err)
	runtimeOptions := chat.RuntimeOptions{Logger: logger}
	if configure != nil {
		configure(local, &runtimeOptions)
	}
	// Compose install admission and credential issuance for every shared prompt fixture.
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1) ON CONFLICT DO NOTHING`, local.ownerID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin') ON CONFLICT DO NOTHING`, local.repoID, local.ownerID)
	require.NoError(t, err)
	binding, _ := json.Marshal(map[string]any{"owner_login": "chatowner", "repository_name": "chatrepo", "repository_id": local.repoID})
	_, err = pool.Exec(ctx, `INSERT INTO install_settings(key,value) VALUES('github.repository',$1) ON CONFLICT DO NOTHING`, binding)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO auth_sessions(user_id,username,session_key,expires_at) VALUES($1,'chatowner',$2,$3) ON CONFLICT DO NOTHING`, local.ownerID, strings.Repeat("a", 64), time.Now().Add(time.Hour))
	require.NoError(t, err)
	if runtimeOptions.API == nil {
		auth := services.NewAuthService(db.New(pool), config.AuthConfig{Mode: "selfhost"}, nil, nil)
		auth.Members = &services.Members{Pool: pool}
		runtimeOptions.API = services.InstallAPI{Auth: auth}
	}
	if runtimeOptions.ContextRepository == nil {
		// No repository context is needed by tests focused on provider transport.
		runtimeOptions.ContextRepository = func(context.Context, middleware.Credential, int64, int64, string) (json.RawMessage, error) {
			return json.RawMessage(`{"state":"ready","candidates":[],"tokenBudget":24000}`), nil
		}
	}
	local.composition, err = newChatComposition(runOptions{topology: localTopology, Options: Options{ChatHost: local.host}}, pool, runtimeOptions)
	require.NoError(t, err)
	t.Cleanup(local.composition.close)
	local.composition.runtime.Handler.ResolveBranch = func(_ context.Context, _ chat.Scope, branch string) (string, error) { return branch, nil }
	if local.api != nil {
		local.composition.server.Handler = chatCallbackHandler(local.composition.runtime, local.api(local.composition.runtime))
	}
	local.serveDone = make(chan error, 1)
	go func() { local.serveDone <- local.composition.server.Serve(local.composition.listener) }()
	dispatchCtx, stopDispatch := context.WithCancel(context.Background())
	local.stopDispatch = stopDispatch
	t.Cleanup(stopDispatch)
	local.dispatchDone = make(chan error, 1)
	go func() { local.dispatchDone <- local.composition.runtime.Run(dispatchCtx) }()

	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			userCtx := middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{User: local.actor, SessionHash: strings.Repeat("a", 64)})
			next.ServeHTTP(w, r.WithContext(userCtx))
		})
	})
	local.composition.runtime.MountPublic(router)
	ownerModels := modelhost.OwnerModels{Pool: pool, Codec: local.codec}
	router.Get("/api/model/catalog", ownerModels.Catalog)
	router.Post("/api/model/credential", ownerModels.Credential)
	router.Put("/api/model/default", ownerModels.SetDefault)
	local.public = httptest.NewServer(router)
	local.models = local.public
	t.Cleanup(local.public.Close)
	return local
}

// turn sends one chat turn, reads its stream to the end, then replays every
// committed batch the way a reconnecting browser does.
func (local *localChat) turn(t *testing.T, fields map[string]any) localTurn {
	t.Helper()
	if model, ok := fields["model"].(map[string]string); ok {
		local.setDefault(t, model)
	}
	prompt := "Say hello"
	if messages, ok := fields["messages"]; ok {
		encoded, _ := json.Marshal(messages)
		var decoded []struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		}
		require.NoError(t, json.Unmarshal(encoded, &decoded))
		for _, m := range decoded {
			if m.Role == "user" {
				prompt = m.Content
			}
		}
	}
	body, _ := json.Marshal(map[string]string{"prompt": prompt, "idempotencyKey": uuid.NewString()})
	response, err := local.client.Post(local.public.URL+"/api/conversations/main/prompt", "application/json", bytes.NewReader(body))
	require.NoError(t, err)
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	require.Equal(t, 202, response.StatusCode, string(raw))
	var receipt struct {
		RunID  string      `json:"runId"`
		LegID  string      `json:"legId"`
		Cursor chat.Cursor `json:"cursor"`
	}
	require.NoError(t, json.Unmarshal(raw, &receipt))
	result := localTurn{runID: receipt.RunID}
	var entry chat.SharedTurn
	require.Eventually(t, func() bool {
		replayed, e := local.client.Get(local.public.URL + "/api/conversations/main")
		require.NoError(t, e)
		defer replayed.Body.Close()
		result.replay, e = io.ReadAll(replayed.Body)
		require.NoError(t, e)
		require.Equal(t, 200, replayed.StatusCode, string(result.replay))
		var conversation chat.SharedConversation
		require.NoError(t, json.Unmarshal(result.replay, &conversation))
		for _, current := range conversation.Entries {
			if current.RunID == receipt.RunID {
				entry = current
				return current.State != chat.StateAccepted && current.State != chat.StateQueued && current.State != chat.StateRunning
			}
		}
		return false
	}, 30*time.Second, 20*time.Millisecond)
	// The shared projection is the person-facing proof; additionally verify its frames against the journal.
	rows, e := local.pool.Query(local.ctx, `SELECT jsonb_build_object('version',1,'runId',t.run_id,'legId',t.leg_id,'batch',b.batch_number,'from',b.from_position,'previousHash',b.previous_hash,'frames',b.frames,'hash',b.hash) FROM chat_turn_batches b JOIN chat_turns t ON t.id=b.turn_id WHERE t.run_id=$1 ORDER BY b.batch_number`, receipt.RunID)
	require.NoError(t, e)
	for rows.Next() {
		var batch chat.Batch
		var raw []byte
		require.NoError(t, rows.Scan(&raw))
		require.NoError(t, json.Unmarshal(raw, &batch))
		result.batches = append(result.batches, batch)
	}
	rows.Close()
	require.NoError(t, rows.Err())
	projected, err := json.Marshal(entry)
	require.NoError(t, err)
	result.stream = string(projected)
	reloaded, err := local.client.Get(local.public.URL + "/api/conversations/main")
	require.NoError(t, err)
	defer reloaded.Body.Close()
	var conversation chat.SharedConversation
	require.NoError(t, json.NewDecoder(reloaded.Body).Decode(&conversation))
	for _, current := range conversation.Entries {
		if current.ID == entry.ID {
			result.replay, err = json.Marshal(current)
			require.NoError(t, err)
		}
	}
	require.NotEmpty(t, result.replay)

	return result
}

func (local *localChat) enroll(t *testing.T, name, origin, value string) {
	t.Helper()
	body, err := json.Marshal(map[string]string{"action": "enroll", "requestId": "enroll-" + strings.ToLower(strings.ReplaceAll(name, "_", "-")), "name": name, "origin": origin, "value": value})
	require.NoError(t, err)
	response, err := local.client.Post(local.public.URL+"/api/model/credential", "application/json", bytes.NewReader(body))
	require.NoError(t, err)
	defer response.Body.Close()
	result, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	require.Contains(t, string(result), `"ok":true`)
	require.NotContains(t, string(result), value)
}

func (local *localChat) setDefault(t *testing.T, model map[string]string) {
	t.Helper()
	body, err := json.Marshal(map[string]any{"model": model})
	require.NoError(t, err)
	request, err := http.NewRequest(http.MethodPut, local.models.URL+"/api/model/default", bytes.NewReader(body))
	require.NoError(t, err)
	request.Header.Set("Content-Type", "application/json")
	response, err := local.client.Do(request)
	require.NoError(t, err)
	defer response.Body.Close()
	require.Equal(t, http.StatusOK, response.StatusCode)
}

// stop shuts the composition down and requires each part to exit cleanly.
func (local *localChat) stop(t *testing.T) {
	t.Helper()
	local.stopOnce.Do(func() {
		local.stopDispatch()
		require.NoError(t, <-local.dispatchDone)
		require.NoError(t, local.host.Close(context.Background()))
		require.NoError(t, local.composition.server.Close())
		require.ErrorIs(t, <-local.serveDone, http.ErrServerClosed)
	})
}

type lockedBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.String()
}

// Reuse the same model HTTP fixture for composed journeys. Offered the app
// agent's commands tool and asked about one of fileQuestions, it executes
// files.read on that path; told "Run /name args", it executes that command;
// a prompt with several "Run /" lines executes them in order, one per model
// leg; a question marked "(forced)" calls the tool even when none is offered.
// Asked "(instructions)", it answers with the command lines its system
// prompt lists, one per line. Given its tool results, it answers by quoting
// them, so an answer shows what was read.
func localChatProvider(receivedKey chan string, fileQuestions ...string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case receivedKey <- r.Header.Get("Authorization"):
		default:
		}
		var body struct {
			Messages []struct {
				Role    string          `json:"role"`
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
			Tools []struct {
				Function struct {
					Name string `json:"name"`
				} `json:"function"`
			} `json:"tools"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			http.Error(w, "invalid model request", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		answer := func(text string) {
			chunk, _ := json.Marshal(map[string]any{"id": "chatcmpl-local", "choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "content": text}, "finish_reason": nil}}})
			_, _ = fmt.Fprintf(w, "data: %s\n\n", chunk)
			_, _ = io.WriteString(w, "data: {\"id\":\"chatcmpl-local\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n")
			_, _ = io.WriteString(w, "data: [DONE]\n\n")
		}
		for _, message := range body.Messages {
			var text string
			if message.Role == "system" && json.Unmarshal(message.Content, &text) == nil && strings.Contains(text, "Choose relevant context") {
				answer("[]")
				return
			}
		}
		var results []string
		for _, message := range body.Messages {
			var text string
			if message.Role == "tool" && json.Unmarshal(message.Content, &text) == nil {
				results = append(results, text)
			}
		}
		offered := false
		for _, tool := range body.Tools {
			offered = offered || tool.Function.Name == "commands"
		}
		execute := func(name, args string) {
			id := "read-source"
			if len(results) > 0 {
				id = fmt.Sprintf("read-source-%d", len(results))
			}
			arguments, _ := json.Marshal(map[string]string{"action": "execute", "name": name, "args": args})
			chunk, _ := json.Marshal(map[string]any{"id": "chatcmpl-local", "choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"index": 0, "id": id, "type": "function", "function": map[string]string{"name": "commands", "arguments": string(arguments)}}}}, "finish_reason": "tool_calls"}}})
			_, _ = fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", chunk)
		}
		var system string
		for _, message := range body.Messages {
			var text string
			if json.Unmarshal(message.Content, &text) != nil {
				continue
			}
			switch {
			case message.Role == "system":
				system = text
			case message.Role != "user":
			case strings.HasPrefix(text, `{"quoted_issue_snapshot":`):
				if len(body.Tools) != 0 {
					http.Error(w, "issue drafting offered tools", http.StatusBadRequest)
					return
				}
				answer(`{"title":"Fix frozen issue","prompt":"Fix the observed issue","acceptance":["Reproduction passes"]}`)
				return
			case strings.Contains(text, "(instructions)"):
				var lines []string
				for _, line := range strings.Split(system, "\n") {
					if strings.HasPrefix(line, "- /") {
						lines = append(lines, line)
					}
				}
				answer(strings.Join(lines, "\n"))
				return
			case offered || strings.Contains(text, "(forced)"):
				if commands := runCommand.FindAllStringSubmatch(text, -1); len(commands) > len(results) {
					command := commands[len(results)]
					execute(command[1], strings.TrimSpace(strings.TrimSuffix(command[2], "(forced)")))
					return
				}
				for _, path := range fileQuestions {
					if len(results) == 0 && strings.Contains(text, path) {
						execute("files.read", path)
						return
					}
				}
			}
		}
		if len(results) > 0 {
			answer("From the source: " + strings.Join(results, "\n"))
			return
		}
		answer("hello from provider")
	}))
}

// runCommand is the fixture's command directive: "Run /name args", one per line.
var runCommand = regexp.MustCompile(`(?m)Run /(\S+)([^\n]*)$`)

func TestLocalChatProviderSourceQuestion(t *testing.T) {
	server := localChatProvider(make(chan string, 4), "JOURNEY.md")
	defer server.Close()
	request := func(body string) string {
		t.Helper()
		response, err := http.Post(server.URL, "application/json", strings.NewReader(body))
		require.NoError(t, err)
		defer response.Body.Close()
		require.Equal(t, http.StatusOK, response.StatusCode)
		data, err := io.ReadAll(response.Body)
		require.NoError(t, err)
		return string(data)
	}
	offered := `"tools":[{"type":"function","function":{"name":"commands","parameters":{"type":"object"}}}]`
	question := request(`{"messages":[{"role":"user","content":"What is in JOURNEY.md?"}],` + offered + `}`)
	require.Contains(t, question, `"name":"commands"`)
	require.Contains(t, question, `"finish_reason":"tool_calls"`)
	require.Contains(t, question, `\"action\":\"execute\"`)
	require.Contains(t, question, `\"name\":\"files.read\"`)
	require.Contains(t, question, `\"args\":\"JOURNEY.md\"`)
	require.NotContains(t, question, `"kind":"file"`)
	// Without the host's tool on offer the provider cannot call it.
	unoffered := request(`{"messages":[{"role":"user","content":"What is in JOURNEY.md?"}]}`)
	require.Contains(t, unoffered, "hello from provider")
	require.NotContains(t, unoffered, "tool_calls")
	// A question marked forced calls it anyway, to prove the host refuses it.
	forced := request(`{"messages":[{"role":"user","content":"What is in JOURNEY.md? (forced)"}]}`)
	require.Contains(t, forced, `"name":"commands"`)
	continuation := request(`{"messages":[{"role":"user","content":"What is in JOURNEY.md?"},{"role":"tool","content":"JOURNEY.md in acme/app:\nAdd a greeting to JOURNEY.md\n"}],` + offered + `}`)
	require.Contains(t, continuation, `From the source: JOURNEY.md in acme/app:\nAdd a greeting to JOURNEY.md\n`)
	require.NotContains(t, continuation, "tool_calls")
	ordinary := request(`{"messages":[{"role":"user","content":"hello"}],` + offered + `}`)
	require.Contains(t, ordinary, "hello from provider")
	require.NotContains(t, ordinary, "tool_calls")
	// A command directive executes that command with its argument text,
	// offered or forced, and never otherwise.
	command := request(`{"messages":[{"role":"user","content":"Run /todo T1"}],` + offered + `}`)
	require.Contains(t, command, `\"name\":\"todo\"`)
	require.Contains(t, command, `\"args\":\"T1\"`)
	require.Contains(t, request(`{"messages":[{"role":"user","content":"Run /stack (forced)"}]}`), `\"name\":\"stack\"`)
	require.NotContains(t, request(`{"messages":[{"role":"user","content":"Run /stack"}]}`), "tool_calls")
	// Several directive lines run in order, one per leg; the answer quotes every result.
	two := `{"role":"user","content":"Where? Run /file a.ts:3\nRun /wiki.open Webhooks.md"}`
	first := request(`{"messages":[` + two + `],` + offered + `}`)
	require.Contains(t, first, `\"name\":\"file\"`)
	require.Contains(t, first, `\"args\":\"a.ts:3\"`)
	second := request(`{"messages":[` + two + `,{"role":"tool","content":"A"}],` + offered + `}`)
	require.Contains(t, second, `\"name\":\"wiki.open\"`)
	require.Contains(t, second, `\"args\":\"Webhooks.md\"`)
	require.Contains(t, second, `"id":"read-source-1"`)
	both := request(`{"messages":[` + two + `,{"role":"tool","content":"A"},{"role":"tool","content":"B"}],` + offered + `}`)
	require.Contains(t, both, `"content":"From the source: A\nB"`)
	require.NotContains(t, both, "tool_calls")
	// Asked for its instructions, it answers the command lines it was given.
	listed := request(`{"messages":[{"role":"system","content":"Rules\n- /stack — Show the stack\nmore\n- /todo <Tn> — Open a TODO"},{"role":"user","content":"(instructions)"}]}`)
	require.Contains(t, listed, `"content":"- /stack — Show the stack\n- /todo \u003cTn\u003e — Open a TODO"`)
}

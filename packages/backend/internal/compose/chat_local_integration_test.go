package compose

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
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
	_, err := secretService.SetSecret(ctx, local.actor, "chatowner", "chatrepo", "TEST_PROVIDER", providerKey, nil, nil)
	require.NoError(t, err)
	_, err = secretService.SetSecret(ctx, local.actor, "chatowner", "chatrepo", "TEST_PROVIDER_ORIGIN", provider.URL, nil, nil)
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

	deliveries := decodeDeliveries(t, result.stream)
	require.Equal(t, "accepted", deliveries[0].Type)
	last := deliveries[len(deliveries)-1]
	require.Equal(t, "caught-up", last.Type)
	require.NotNil(t, last.Terminal)
	require.True(t, *last.Terminal)
	var streamed []chat.Batch
	for _, delivery := range deliveries[1 : len(deliveries)-1] {
		require.Equal(t, "batch", delivery.Type)
		streamed = append(streamed, *delivery.Batch)
	}
	// The browser reconnects to exactly what was streamed, in one hash chain.
	require.Equal(t, streamed, result.batches)
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
	ctx          context.Context
	pool         *pgxpool.Pool
	ownerID      int64
	repoID       int64
	actor        *db.User
	codec        *webhook.AESGCMSecretCodec
	resolver     *modelhost.OwnerSecretResolver
	host         *modelhost.Host
	composition  *chatComposition
	public       *httptest.Server
	client       *http.Client
	logs         *lockedBuffer
	stopOnce     sync.Once
	stopDispatch context.CancelFunc
	dispatchDone chan error
	serveDone    chan error
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

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	t.Cleanup(cancel)
	pool, databaseURL := postgresfixture.NewProductDatabase(t)
	local := &localChat{ctx: ctx, pool: pool, logs: &lockedBuffer{}, client: &http.Client{Timeout: 60 * time.Second}}
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
	local.host, err = modelhost.New(local.resolver, launcher)
	require.NoError(t, err)
	local.composition, err = newChatComposition(runOptions{topology: localTopology, Options: Options{ChatHost: local.host}}, pool, chat.RuntimeOptions{Logger: logger})
	require.NoError(t, err)
	t.Cleanup(local.composition.close)
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
			userCtx := middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{User: local.actor})
			next.ServeHTTP(w, r.WithContext(userCtx))
		})
	})
	local.composition.runtime.MountPublic(router)
	ownerModels := modelhost.OwnerModels{Pool: pool, Codec: local.codec}
	router.Get("/api/model/catalog", ownerModels.Catalog)
	router.Post("/api/model/credential", ownerModels.Credential)
	router.Put("/api/model/default", ownerModels.SetDefault)
	local.public = httptest.NewServer(router)
	t.Cleanup(local.public.Close)
	return local
}

// turn sends one chat turn, reads its stream to the end, then replays every
// committed batch the way a reconnecting browser does.
func (local *localChat) turn(t *testing.T, fields map[string]any) localTurn {
	t.Helper()
	runID := "local-" + uuid.NewString()
	journal := map[string]any{"version": 1, "legId": uuid.NewString(), "token": strings.Repeat("a", 48)}
	payload := map[string]any{"runId": runID, "journal": journal,
		"instructions": "Answer briefly.", "messages": []any{map[string]string{"role": "user", "content": "Say hello"}}}
	for name, value := range fields {
		payload[name] = value
	}
	body, err := json.Marshal(payload)
	require.NoError(t, err)
	response, err := local.client.Post(local.public.URL+chat.TurnPath, "application/json", bytes.NewReader(body))
	require.NoError(t, err)
	defer response.Body.Close()
	stream, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, response.StatusCode, string(stream))
	result := localTurn{runID: runID, stream: string(stream)}
	var after any
	for {
		replayBody, err := json.Marshal(map[string]any{"runId": runID, "journal": journal, "after": after})
		require.NoError(t, err)
		replayed, err := local.client.Post(local.public.URL+chat.ReplayPath, "application/json", bytes.NewReader(replayBody))
		require.NoError(t, err)
		page, err := io.ReadAll(replayed.Body)
		replayed.Body.Close()
		require.NoError(t, err)
		require.Equal(t, http.StatusOK, replayed.StatusCode, string(page))
		result.replay = append(result.replay, page...)
		var decoded chat.ReplayResult
		require.NoError(t, json.Unmarshal(page, &decoded))
		result.batches = append(result.batches, decoded.Batches...)
		if !decoded.More {
			return result
		}
		after = decoded.Next
	}
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
	request, err := http.NewRequest(http.MethodPut, local.public.URL+"/api/model/default", bytes.NewReader(body))
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

func decodeDeliveries(t *testing.T, stream string) []chat.Delivery {
	t.Helper()
	var deliveries []chat.Delivery
	scanner := bufio.NewScanner(strings.NewReader(stream))
	scanner.Buffer(make([]byte, 0, 64<<10), 8<<20)
	for scanner.Scan() {
		var delivery chat.Delivery
		require.NoError(t, json.Unmarshal(scanner.Bytes(), &delivery), scanner.Text())
		deliveries = append(deliveries, delivery)
	}
	require.NoError(t, scanner.Err())
	require.GreaterOrEqual(t, len(deliveries), 2, stream)
	return deliveries
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

// Reuse the same model HTTP fixture for composed journeys.
func localChatProvider(receivedKey chan string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case receivedKey <- r.Header.Get("Authorization"):
		default:
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"id\":\"chatcmpl-local\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"hello from provider\"},\"finish_reason\":null}]}\n\n")
		_, _ = io.WriteString(w, "data: {\"id\":\"chatcmpl-local\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n")
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	}))
}

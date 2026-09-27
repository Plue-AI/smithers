package compose

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
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
	defer cancel()
	pool, databaseURL := postgresfixture.NewProductDatabase(t)

	var ownerID, repoID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users (username,lower_username) VALUES ('chatowner','chatowner') RETURNING id`).Scan(&ownerID))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories (user_id,name,lower_name) VALUES ($1,'chatrepo','chatrepo') RETURNING id`, ownerID).Scan(&repoID))
	var resolvedID int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT r.id FROM repositories r JOIN owner_namespaces ns ON ns.user_id=r.user_id WHERE ns.lower_slug='chatowner' AND r.lower_name='chatrepo'`).Scan(&resolvedID))
	require.Equal(t, repoID, resolvedID)
	codec, err := webhook.NewSecretCodec("local-chat-secret-key")
	require.NoError(t, err)
	secretService := services.NewSecretService(db.New(pool), codec)
	_, lookupErr := db.New(pool).GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{Owner: "chatowner", LowerName: "chatrepo"})
	require.NoError(t, lookupErr)
	providerKey := "owner-private-provider-key"
	receivedKey := make(chan string, 1)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case receivedKey <- r.Header.Get("Authorization"):
		default:
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"id\":\"chatcmpl-local\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"hello from provider\"},\"finish_reason\":null}]}\n\n")
		_, _ = io.WriteString(w, "data: {\"id\":\"chatcmpl-local\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n")
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	}))
	defer provider.Close()
	actor := &db.User{ID: ownerID, Username: "chatowner"}
	_, err = secretService.SetSecret(ctx, actor, "chatowner", "chatrepo", "TEST_PROVIDER", providerKey, nil)
	require.NoError(t, err)
	_, err = secretService.SetSecret(ctx, actor, "chatowner", "chatrepo", "TEST_PROVIDER_ORIGIN", provider.URL, nil)
	require.NoError(t, err)

	workspaceRuntime, err := process.New(process.Config{Root: filepath.Join(t.TempDir(), "workspaces")})
	require.NoError(t, err)
	defer workspaceRuntime.Close()
	launcher, err := modelhost.NewLocalLauncher(modelhost.LocalConfig{Runtime: workspaceRuntime, NodeBinary: node, BundlePath: bundle})
	require.NoError(t, err)
	resolver, err := modelhost.NewOwnerSecretResolver(func() string { return databaseURL }, func() string { return "local-chat-secret-key" })
	require.NoError(t, err)
	foreignRequest, err := json.Marshal(map[string]any{"repositoryId": repoID, "model": map[string]string{
		"protocol": "openai-chat", "modelId": "test-model", "credential": "TEST_PROVIDER", "baseUrl": provider.URL,
	}})
	require.NoError(t, err)
	_, err = resolver.ResolveChatModel(ctx, ownerID+1, 0, foreignRequest)
	require.ErrorIs(t, err, ports.ErrModelCredentialMissing)
	host, err := modelhost.New(resolver, launcher)
	require.NoError(t, err)
	composition, err := newChatComposition(runOptions{topology: localTopology, Options: Options{ChatHost: host}}, pool, chat.RuntimeOptions{})
	require.NoError(t, err)
	defer composition.close()
	serveDone := make(chan error, 1)
	go func() { serveDone <- composition.server.Serve(composition.listener) }()
	dispatchCtx, stopDispatch := context.WithCancel(context.Background())
	defer stopDispatch()
	dispatchDone := make(chan error, 1)
	go func() { dispatchDone <- composition.runtime.Run(dispatchCtx) }()

	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			userCtx := middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{User: actor})
			next.ServeHTTP(w, r.WithContext(userCtx))
		})
	})
	composition.runtime.MountPublic(router)
	ownerModels := modelhost.OwnerModels{Pool: pool, Codec: codec}
	router.Get("/api/model/catalog", ownerModels.Catalog)
	router.Post("/api/model/credential", ownerModels.Credential)
	router.Put("/api/model/default", ownerModels.SetDefault)
	public := httptest.NewServer(router)
	defer public.Close()
	client := &http.Client{Timeout: 30 * time.Second}
	turn := func(name string) (string, string, []byte) {
		runID := "local-" + uuid.NewString()
		journal := map[string]any{"version": 1, "legId": uuid.NewString(), "token": strings.Repeat("a", 48)}
		payload := map[string]any{"runId": runID, "journal": journal, "repositoryId": repoID,
			"instructions": "Answer briefly.", "messages": []any{map[string]string{"role": "user", "content": "Say hello"}},
			"model": map[string]string{"protocol": "openai-chat", "modelId": "test-model", "credential": name, "baseUrl": provider.URL}}
		body, err := json.Marshal(payload)
		require.NoError(t, err)
		response, err := client.Post(public.URL+chat.TurnPath, "application/json", bytes.NewReader(body))
		require.NoError(t, err)
		defer response.Body.Close()
		require.Equal(t, http.StatusOK, response.StatusCode)
		stream, err := io.ReadAll(response.Body)
		require.NoError(t, err)
		replayBody, err := json.Marshal(map[string]any{"runId": runID, "journal": journal})
		require.NoError(t, err)
		replayed, err := client.Post(public.URL+chat.ReplayPath, "application/json", bytes.NewReader(replayBody))
		require.NoError(t, err)
		defer replayed.Body.Close()
		replay, err := io.ReadAll(replayed.Body)
		require.NoError(t, err)
		require.Equal(t, http.StatusOK, replayed.StatusCode, string(replay))
		return runID, string(stream), replay
	}
	_, stream, replay := turn("TEST_PROVIDER")
	require.Contains(t, stream, "hello from provider")
	require.Contains(t, string(replay), "hello from provider")
	select {
	case got := <-receivedKey:
		require.Equal(t, "Bearer "+providerKey, got)
	case <-time.After(time.Second):
		t.Fatal("provider did not receive owner key")
	}
	require.NotContains(t, stream, providerKey)
	require.NotContains(t, string(replay), providerKey)

	_, missingStream, missingReplay := turn("MISSING_PROVIDER")
	require.Contains(t, missingStream, `"code":"credential_missing"`)
	require.Contains(t, string(missingReplay), `"code":"credential_missing"`)
	require.Contains(t, missingStream, "Model credential missing")
	require.Contains(t, string(missingReplay), "Model credential missing")
	// The ordinary composer has no repository or model fields. Its owner
	// selection and credential must be enough to answer the turn.
	ownerTurn := func() string {
		runID := "owner-" + uuid.NewString()
		journal := map[string]any{"version": 1, "legId": uuid.NewString(), "token": strings.Repeat("b", 48)}
		body, marshalErr := json.Marshal(map[string]any{"runId": runID, "journal": journal,
			"instructions": "Answer briefly.", "messages": []any{map[string]string{"role": "user", "content": "Say hello"}}})
		require.NoError(t, marshalErr)
		response, postErr := client.Post(public.URL+chat.TurnPath, "application/json", bytes.NewReader(body))
		require.NoError(t, postErr)
		defer response.Body.Close()
		stream, readErr := io.ReadAll(response.Body)
		require.NoError(t, readErr)
		return string(stream)
	}
	require.Contains(t, ownerTurn(), `"code":"credential_missing"`)
	credentialBody, err := json.Marshal(map[string]string{"action": "enroll", "requestId": "owner-key-request", "name": "OWNER_PROVIDER", "origin": provider.URL, "value": providerKey})
	require.NoError(t, err)
	credentialResponse, err := client.Post(public.URL+"/api/model/credential", "application/json", bytes.NewReader(credentialBody))
	require.NoError(t, err)
	defer credentialResponse.Body.Close()
	credentialResult, err := io.ReadAll(credentialResponse.Body)
	require.NoError(t, err)
	require.Contains(t, string(credentialResult), `"ok":true`)
	require.NotContains(t, string(credentialResult), providerKey)
	defaultBody, err := json.Marshal(map[string]any{"model": map[string]string{"protocol": "openai-chat", "modelId": "test-model", "credential": "OWNER_PROVIDER", "baseUrl": provider.URL}})
	require.NoError(t, err)
	defaultRequest, err := http.NewRequest(http.MethodPut, public.URL+"/api/model/default", bytes.NewReader(defaultBody))
	require.NoError(t, err)
	defaultRequest.Header.Set("Content-Type", "application/json")
	defaultResponse, err := client.Do(defaultRequest)
	require.NoError(t, err)
	defer defaultResponse.Body.Close()
	require.Equal(t, http.StatusOK, defaultResponse.StatusCode)
	require.Contains(t, ownerTurn(), "hello from provider")
	select {
	case got := <-receivedKey:
		require.Equal(t, "Bearer "+providerKey, got)
	case <-time.After(time.Second):
		t.Fatal("provider did not receive owner credential")
	}
	stopDispatch()
	require.NoError(t, <-dispatchDone)
	require.NoError(t, host.Close(context.Background()))
	require.NoError(t, composition.server.Close())
	require.ErrorIs(t, <-serveDone, http.ErrServerClosed)
}

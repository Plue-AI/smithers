package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture/seed"
	"github.com/smithersai/smithers/packages/backend/testkit/testdb"
)

// Exercises the public API of the actual apps/backend composition and listener.
func TestOwnerChatHTTPIntegration(t *testing.T) {
	if testdb.ServerURL() == "" {
		testdb.Unavailable(t, testdb.ErrNotConfigured)
	}
	node, err := exec.LookPath("node")
	require.NoError(t, err)
	node, err = filepath.EvalSymlinks(node)
	require.NoError(t, err)
	_, source, _, _ := runtime.Caller(0)
	root := filepath.Clean(filepath.Join(filepath.Dir(source), "../.."))
	// The host bundle is built with the workspace's esbuild; a checkout
	// without `pnpm install` cannot build it, which is not a product failure
	// unless this run requires the database suites.
	if _, err := os.Stat(filepath.Join(root, "apps/model-host/node_modules/esbuild")); err != nil && os.Getenv("SMITHERS_REQUIRE_DATABASE_TESTS") != "1" {
		t.Skip("apps/model-host dependencies are not installed; run pnpm install")
	}
	// The box's coding host binds its checkout through the native helper.
	if os.Getenv("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY") == "" && os.Getenv("SMITHERS_REQUIRE_DATABASE_TESTS") != "1" {
		t.Skip("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY is not set; build smithers-jj-export")
	}
	bundleDir := t.TempDir()
	bundle := filepath.Join(bundleDir, "smithers-model-host")
	build := exec.Command(node, filepath.Join(root, "apps/model-host/build.mjs"), bundle)
	build.Dir = root
	output, err := build.CombinedOutput()
	require.NoError(t, err, string(output))
	// Every browser flow runs on a box's coding host (#2194).
	coding := filepath.Join(bundleDir, "smithers-coding-host")
	codingBuild := exec.Command(node, filepath.Join(root, "flows/coding/build.mjs"), coding)
	codingBuild.Dir = root
	output, err = codingBuild.CombinedOutput()
	require.NoError(t, err, string(output))
	codingBytes, err := os.ReadFile(coding)
	require.NoError(t, err)
	// Pin the fixture's Node interpreter just as the packaged model host does.
	// The manifest measures the exact executable bytes, including this banner.
	newline := bytes.IndexByte(codingBytes, '\n')
	require.GreaterOrEqual(t, newline, 0)
	shellQuote := func(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'" }
	// This shell/JavaScript banner also supports an interpreter path with spaces.
	banner := fmt.Sprintf("#!/bin/sh\n':' //; exec %s \"$0\" \"$@\"\n", shellQuote(node))
	codingBytes = append([]byte(banner), codingBytes[newline+1:]...)
	require.NoError(t, os.WriteFile(coding, codingBytes, 0700))
	codingSum := sha256.Sum256(codingBytes)
	manifest := map[string]any{"version": 1, "hosts": map[string]any{
		"coding": map[string]any{"executable": "smithers-coding-host", "sha256": hex.EncodeToString(codingSum[:]), "flows": []string{"coding/dispatch"}},
	}}
	manifestBytes, err := json.Marshal(manifest)
	require.NoError(t, err)
	manifestPath := filepath.Join(bundleDir, "flow-hosts.json")
	require.NoError(t, os.WriteFile(manifestPath, manifestBytes, 0o600))

	keysPath := filepath.Join(t.TempDir(), "platform-model-keys.json")
	require.NoError(t, os.WriteFile(keysPath, []byte(`{"cerebras":"scripted-provider-key","vercel":"scripted-evaluator-key"}`), 0o600))
	databaseURL := testdb.New(t).URL
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	addr := listener.Addr().String()
	require.NoError(t, listener.Close())
	origin := "http://" + addr
	state := t.TempDir()
	for name, value := range map[string]string{
		"SMITHERS_DATABASE_URL":                  databaseURL,
		"SMITHERS_DATA_ROOT":                     state,
		"SMITHERS_BLOB_DATA_DIR":                 filepath.Join(state, "blobs"),
		"SMITHERS_AUTH_MODE":                     "selfhost",
		"SMITHERS_AUTH_SESSION_SECRET":           "owner-session-secret",
		"SMITHERS_LFS_SIGNING_SECRET":            "owner-lfs-secret",
		"SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY": "owner-model-encryption-secret",
		"SMITHERS_REPO_HOST_AUTH_TOKEN":          "owner-repo-token",
		"SMITHERS_PUSH_HOOK_CALLBACK_TOKEN":      "owner-push-token",
		"SMITHERS_SERVER_ADDR":                   addr,
		"SMITHERS_PUBLIC_URL":                    origin,
		"SMITHERS_FEATURE_FLAGS_WORKFLOWS":       "false",
		"SMITHERS_FEATURE_FLAGS_SANDBOXES":       "true",
		"SMITHERS_FLOW_HOST_MANIFEST":            manifestPath,
		"SMITHERS_MODEL_HOST_BUNDLE":             bundle,
		"SMITHERS_NODE_BINARY":                   node,
		// The box's coding host reaches models only through the metered proxy's
		// platform seats; the catalog read below calls none of them.
		"SMITHERS_PLATFORM_MODEL_KEYS_FILE":       keysPath,
		"AI_GATEWAY_API_KEY":                      "",
		"SMITHERS_WORKSPACE_CODING_DEFAULT_MODEL": "cerebras:gpt-oss-120b",
	} {
		t.Setenv(name, value)
	}
	serverCtx, stop := context.WithCancel(context.Background())
	defer stop()
	done := make(chan error, 1)
	go func() {
		done <- run(serverCtx, nil, flowhost.WorkspaceLauncherConfig{AllowTrustedProcessForTests: true})
	}()
	client := &http.Client{Timeout: 30 * time.Second}
	ready := false
	// Fresh product migrations can take longer than ten seconds on a busy
	// PostgreSQL host. Bound readiness by elapsed time, not a poll count.
	for deadline := time.Now().Add(time.Minute); time.Now().Before(deadline); {
		response, getErr := client.Get(origin + "/readyz")
		if getErr == nil {
			response.Body.Close()
			if response.StatusCode == http.StatusOK {
				ready = true
				break
			}
		}
		select {
		case err = <-done:
			t.Fatalf("backend stopped before ready: %v", err)
		default:
		}
		time.Sleep(100 * time.Millisecond)
	}
	require.True(t, ready, "backend did not become ready")
	post := func(path, token string, body any) []byte {
		data, marshalErr := json.Marshal(body)
		require.NoError(t, marshalErr)
		request, requestErr := http.NewRequest(http.MethodPost, origin+path, bytes.NewReader(data))
		require.NoError(t, requestErr)
		request.Header.Set("Content-Type", "application/json")
		if token != "" {
			request.Header.Set("Authorization", "token "+token)
		}
		response, sendErr := client.Do(request)
		require.NoError(t, sendErr)
		defer response.Body.Close()
		result, readErr := io.ReadAll(response.Body)
		require.NoError(t, readErr)
		wantStatus := http.StatusOK
		if path == "/api/user/repos" {
			wantStatus = http.StatusCreated
		} else if strings.HasSuffix(path, "/workspaces") {
			wantStatus = http.StatusAccepted
		}
		require.Equal(t, wantStatus, response.StatusCode, string(result))
		return result
	}
	ownerPool, err := pgxpool.New(t.Context(), databaseURL)
	require.NoError(t, err)
	defer ownerPool.Close()
	ownerToken, err := seed.InstallOwner(t.Context(), ownerPool, "l3bowner", 1001)
	require.NoError(t, err)
	tokenResult := struct{ Token string }{Token: ownerToken}
	{
		post("/api/user/repos", tokenResult.Token, map[string]any{
			"name": "flow-http-integration", "private": true, "auto_init": true, "default_bookmark": "main",
		})
		// A flow call that names no box is refused: there is no repository-level host.
		noBox, err := json.Marshal(map[string]any{"repo": "l3bowner/flow-http-integration"})
		require.NoError(t, err)
		refusal, err := http.NewRequest(http.MethodPost, origin+"/api/workflow/provision", bytes.NewReader(noBox))
		require.NoError(t, err)
		refusal.Header.Set("Content-Type", "application/json")
		refusal.Header.Set("Authorization", "token "+tokenResult.Token)
		refused, err := client.Do(refusal)
		require.NoError(t, err)
		refusedBody, _ := io.ReadAll(refused.Body)
		refused.Body.Close()
		require.Equal(t, http.StatusBadRequest, refused.StatusCode, string(refusedBody))
		// Open the box, then run on its coding host.
		var workspace struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		}
		require.NoError(t, json.Unmarshal(post("/api/repos/l3bowner/flow-http-integration/workspaces", tokenResult.Token, map[string]any{
			"name": "flows", "source_bookmark": "main",
		}), &workspace))
		_, err = uuid.Parse(workspace.ID)
		require.NoError(t, err)
		require.Eventually(t, func() bool {
			request, _ := http.NewRequest(http.MethodGet, origin+"/api/repos/l3bowner/flow-http-integration/workspaces/"+workspace.ID, nil)
			request.Header.Set("Authorization", "token "+tokenResult.Token)
			response, getErr := client.Do(request)
			if getErr != nil {
				return false
			}
			defer response.Body.Close()
			var current struct {
				Status string `json:"status"`
			}
			return json.NewDecoder(response.Body).Decode(&current) == nil && current.Status == "running"
		}, 2*time.Minute, 500*time.Millisecond)
		// Provision starts the box's coding host in the background and answers
		// "provisioning" until it is live, as the app polls (ff084303de).
		for deadline := time.Now().Add(2 * time.Minute); ; time.Sleep(500 * time.Millisecond) {
			var answer struct {
				Status string `json:"status"`
			}
			require.NoError(t, json.Unmarshal(post("/api/workflow/provision", tokenResult.Token, map[string]any{
				"repo": "l3bowner/flow-http-integration", "workspaceId": workspace.ID,
			}), &answer))
			if answer.Status == "ready" {
				break
			}
			require.Equal(t, "provisioning", answer.Status)
			require.True(t, time.Now().Before(deadline), "the box's coding host did not become ready")
		}
		missing := post("/api/workflow/rpc", tokenResult.Token, map[string]any{
			"repo": "l3bowner/flow-http-integration", "workspaceId": workspace.ID, "procedure": "Plan",
			"payload": map[string]any{"flowId": "missing/flow", "input": map[string]any{}},
		})
		require.Contains(t, string(missing), `"ok":false`)
		require.Contains(t, string(missing), `No flow`)
		// Catalog reads reconnect to the host provision started.
		catalog := post("/api/workflow/rpc", tokenResult.Token, map[string]any{
			"repo": "l3bowner/flow-http-integration", "workspaceId": workspace.ID, "procedure": "List", "payload": map[string]string{"_tag": "flows"},
		})
		// The box's coding host answers its own catalog.
		require.Contains(t, string(catalog), `"ok":true`)
		require.Contains(t, string(catalog), `"flowId":"coding/dispatch"`)
	}
	key := "private-owner-model-key"
	received := make(chan string, 1)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case received <- r.Header.Get("Authorization"):
		default:
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"id\":\"chatcmpl-owner\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"owner chat reply\"},\"finish_reason\":null}]}\n\n")
		_, _ = io.WriteString(w, "data: {\"id\":\"chatcmpl-owner\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n")
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	}))
	defer provider.Close()
	credentialResponse := post("/api/model/credential", tokenResult.Token, map[string]string{"action": "enroll", "requestId": "owner-model-key-1", "name": "OWNER_PROVIDER", "origin": provider.URL, "value": key})
	require.Contains(t, string(credentialResponse), `"ok":true`)
	require.NotContains(t, string(credentialResponse), key)
	model := map[string]string{"protocol": "openai-chat", "modelId": "test-model", "credential": "OWNER_PROVIDER", "baseUrl": provider.URL}
	defaultBytes, err := json.Marshal(map[string]any{"model": model})
	require.NoError(t, err)
	defaultRequest, err := http.NewRequest(http.MethodPut, origin+"/api/model/default", bytes.NewReader(defaultBytes))
	require.NoError(t, err)
	defaultRequest.Header.Set("Content-Type", "application/json")
	defaultRequest.Header.Set("Authorization", "token "+tokenResult.Token)
	defaultResponse, err := client.Do(defaultRequest)
	require.NoError(t, err)
	defer defaultResponse.Body.Close()
	require.Equal(t, http.StatusOK, defaultResponse.StatusCode)
	stream := post("/api/agent/turn", tokenResult.Token, map[string]any{"runId": "owner-" + uuid.NewString(),
		"journal":      map[string]any{"version": 1, "legId": uuid.NewString(), "token": strings.Repeat("a", 48)},
		"instructions": "Answer briefly.", "messages": []any{map[string]string{"role": "user", "content": "Say hello"}}})
	require.Contains(t, string(stream), "owner chat reply")
	require.NotContains(t, string(stream), key)
	select {
	case got := <-received:
		require.Equal(t, "Bearer "+key, got)
	case <-time.After(time.Second):
		t.Fatal("provider did not receive owner key")
	}
	stop()
	select {
	case err = <-done:
		require.NoError(t, err)
	case <-time.After(10 * time.Second):
		t.Fatal(fmt.Sprintf("backend did not stop: %s", addr))
	}
}

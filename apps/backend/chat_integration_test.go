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
	"github.com/stretchr/testify/require"

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
	bundleDir := t.TempDir()
	bundle := filepath.Join(bundleDir, "smithers-model-host")
	build := exec.Command(node, filepath.Join(root, "apps/model-host/build.mjs"), bundle)
	build.Dir = root
	output, err := build.CombinedOutput()
	require.NoError(t, err, string(output))
	for _, family := range []string{"coding"} {
		name := "smithers-" + family + "-host"
		require.NoError(t, os.WriteFile(filepath.Join(bundleDir, name), []byte("#!/bin/sh\nexit 1\n"), 0o755))
	}
	librarian := filepath.Join(bundleDir, "smithers-librarian-host")
	librarianBuild := exec.Command(node, filepath.Join(root, "flows/librarian/build.mjs"), librarian)
	librarianBuild.Dir = root
	output, err = librarianBuild.CombinedOutput()
	require.NoError(t, err, string(output))
	require.NoError(t, os.Chmod(librarian, 0o755))
	manifest := map[string]any{"version": 1, "hosts": map[string]any{}}
	hosts := manifest["hosts"].(map[string]any)
	for _, family := range []string{"coding", "librarian"} {
		name := "smithers-" + family + "-host"
		content, readErr := os.ReadFile(filepath.Join(bundleDir, name))
		require.NoError(t, readErr)
		sum := sha256.Sum256(content)
		flows := []string{"coding/dispatch"}
		if family == "librarian" {
			flows = []string{}
		}
		hosts[family] = map[string]any{"executable": name, "sha256": hex.EncodeToString(sum[:]), "flows": flows}
	}
	manifestBytes, err := json.Marshal(manifest)
	require.NoError(t, err)
	manifestPath := filepath.Join(bundleDir, "flow-hosts.json")
	require.NoError(t, os.WriteFile(manifestPath, manifestBytes, 0o600))

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
		"SMITHERS_AUTH_BOOTSTRAP_TOKEN":          "owner-bootstrap-token",
		"SMITHERS_AUTH_SESSION_SECRET":           "owner-session-secret",
		"SMITHERS_LFS_SIGNING_SECRET":            "owner-lfs-secret",
		"SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY": "owner-model-encryption-secret",
		"SMITHERS_REPO_HOST_AUTH_TOKEN":          "owner-repo-token",
		"SMITHERS_PUSH_HOOK_CALLBACK_TOKEN":      "owner-push-token",
		"SMITHERS_SERVER_ADDR":                   addr,
		"SMITHERS_PUBLIC_URL":                    origin,
		"SMITHERS_FEATURE_FLAGS_WORKFLOWS":       "false",
		"SMITHERS_FEATURE_FLAGS_SANDBOXES":       "false",
		"SMITHERS_FLOW_HOST_MANIFEST":            manifestPath,
		"SMITHERS_MODEL_HOST_BUNDLE":             bundle,
		"SMITHERS_NODE_BINARY":                   node,
		"AI_GATEWAY_API_KEY":                     "test-gateway-key-only-for-deterministic-flow",
	} {
		t.Setenv(name, value)
	}
	serverCtx, stop := context.WithCancel(context.Background())
	defer stop()
	done := make(chan error, 1)
	go func() { done <- run(serverCtx, nil) }()
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
		if path == "/api/auth/local/bootstrap" {
			request.Header.Set("X-Smithers-Bootstrap-Token", "owner-bootstrap-token")
		}
		response, sendErr := client.Do(request)
		require.NoError(t, sendErr)
		defer response.Body.Close()
		result, readErr := io.ReadAll(response.Body)
		require.NoError(t, readErr)
		wantStatus := http.StatusOK
		if path == "/api/user/repos" {
			wantStatus = http.StatusCreated
		}
		require.Equal(t, wantStatus, response.StatusCode, string(result))
		return result
	}
	post("/api/auth/local/bootstrap", "", map[string]string{"username": "l3bowner", "email": "l3b@example.test", "password": "owner password for integration"})
	var tokenResult struct {
		Token string `json:"token"`
	}
	require.NoError(t, json.Unmarshal(post("/api/auth/local/token", "", map[string]string{"username": "l3bowner", "password": "owner password for integration", "name": "chat-integration"}), &tokenResult))
	require.NotEmpty(t, tokenResult.Token)
	{
		post("/api/user/repos", tokenResult.Token, map[string]any{
			"name": "flow-http-integration", "private": true, "auto_init": true, "default_bookmark": "main",
		})
		// Catalog reads require an existing workspace and must never provision one.
		var workspace struct {
			ID string `json:"workspaceId"`
		}
		require.NoError(t, json.Unmarshal(post("/api/workflow/provision", tokenResult.Token, map[string]any{
			"repo": "l3bowner/flow-http-integration",
		}), &workspace))
		_, err = uuid.Parse(workspace.ID)
		require.NoError(t, err)
		missing := post("/api/workflow/rpc", tokenResult.Token, map[string]any{
			"repo": "l3bowner/flow-http-integration", "workspaceId": workspace.ID, "procedure": "Plan",
			"payload": map[string]any{"flowId": "missing/flow", "input": map[string]any{}},
		})
		require.Contains(t, string(missing), `"ok":false`)
		require.Contains(t, string(missing), `No flow`)
		// Planning starts the admitted host; subsequent catalog reads only reconnect.
		catalog := post("/api/workflow/rpc", tokenResult.Token, map[string]any{
			"repo": "l3bowner/flow-http-integration", "workspaceId": workspace.ID, "procedure": "List", "payload": map[string]string{"_tag": "flows"},
		})
		// The product gateway serves no product flow (#2165); the admitted host
		// answers its catalog without one.
		require.Contains(t, string(catalog), `"ok":true`)
		require.NotContains(t, string(catalog), `"flowId":"librarian/`)
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

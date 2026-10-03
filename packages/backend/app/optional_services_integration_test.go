package app_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/app"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/smithersai/smithers/packages/backend/repository"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture/seed"
	"github.com/stretchr/testify/require"
)

// optionalServicesLog serializes startup and background worker log writes with
// assertions, so the real application's logger can be observed safely.
type optionalServicesLog struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (log *optionalServicesLog) Write(p []byte) (int, error) {
	log.mu.Lock()
	defer log.mu.Unlock()
	return log.buffer.Write(p)
}

func (log *optionalServicesLog) String() string {
	log.mu.Lock()
	defer log.mu.Unlock()
	return log.buffer.String()
}

// This acceptance test proves public startup, native repository initialization,
// and durable chat without optional services. It does not execute an agent Flow.
func TestOptionalServicesDisabledRepositoryAndChatReplay(t *testing.T) {
	pool, databaseURL := postgresfixture.NewProductDatabase(t)
	ffi := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	require.NotEmpty(t, ffi, "real native repository engine is required")
	local, err := repository.OpenLocal(repository.Config{StoragePath: t.TempDir(), AuthToken: "optional-repo-token", FFILibraryPath: ffi})
	require.NoError(t, err)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		require.NoError(t, local.Shutdown(ctx))
	})
	// Pin a complete empty configuration rather than inheriting a host config
	// containing wiki folders or third-party credentials. Environment inputs below
	// explicitly disable the optional delivery and integration surfaces.
	configFile := filepath.Join(t.TempDir(), "config.json")
	require.NoError(t, os.WriteFile(configFile, []byte(`{"email":{"smtp_host":"","smtp_user":"","smtp_pass":""},"auth":{"github_client_id":"","github_client_secret":""},"wiki_sync":{"obsidian":[]}}`), 0600))
	for key, value := range map[string]string{
		"SMITHERS_DATABASE_URL": databaseURL, "SMITHERS_DATA_ROOT": t.TempDir(), "SMITHERS_BLOB_DATA_DIR": t.TempDir(),
		"SMITHERS_AUTH_MODE":           "selfhost",
		"SMITHERS_AUTH_SESSION_SECRET": "optional-session", "SMITHERS_LFS_SIGNING_SECRET": "optional-lfs",
		"SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY": "optional-webhook", "SMITHERS_REPO_HOST_AUTH_TOKEN": "optional-repo-token",
		"SMITHERS_REPO_HOST_URL": "", "SMITHERS_PUSH_HOOK_CALLBACK_TOKEN": "optional-push-callback",
		"SMITHERS_SERVER_ADDR": "127.0.0.1:0", "SMITHERS_PUBLIC_URL": "http://127.0.0.1:4000",
		"SMITHERS_EMAIL_SMTP_HOST": "", "SMITHERS_EMAIL_SMTP_USER": "", "SMITHERS_EMAIL_SMTP_PASS": "",
		"SMITHERS_FEATURE_FLAGS_NOTIFICATIONS": "false",
		"SMITHERS_FEATURE_FLAGS_WIKI":          "false",
		"SMITHERS_FEATURE_FLAGS_AUTO_PUSH":     "false", "SMITHERS_FEATURE_FLAGS_WORKFLOWS": "false",
		"SMITHERS_FEATURE_FLAGS_WORKSPACES": "false", "SMITHERS_FEATURE_FLAGS_SANDBOXES": "false",
		"SMITHERS_AUTH_GITHUB_CLIENT_ID": "", "SMITHERS_AUTH_GITHUB_CLIENT_SECRET": "",
		"SMITHERS_AUTH_TOKEN_EXCHANGE_SECRET": "",

		"SMITHERS_AUTH_AUTH0_DOMAIN":                   "",
		"SMITHERS_AUTH_AUTH0_CLIENT_ID":                "",
		"SMITHERS_AUTH_AUTH0_CLIENT_SECRET":            "",
		"SMITHERS_AUTH_AUTH0_REDIRECT_URL":             "",
		"SMITHERS_AUTH_AUTH0_CONNECTION":               "",
		"SMITHERS_BILLING_MODE":                        "unlimited",
		"SMITHERS_BILLING_STRIPE_SECRET_KEY":           "",
		"SMITHERS_BILLING_STRIPE_WEBHOOK_SECRET":       "",
		"SMITHERS_BILLING_PORTAL_RETURN_URL":           "",
		"SMITHERS_BILLING_CHECKOUT_SUCCESS_URL":        "",
		"SMITHERS_BILLING_CHECKOUT_CANCEL_URL":         "",
		"SMITHERS_BILLING_PERSONAL_MONTHLY_PRICE_ID":   "",
		"SMITHERS_BILLING_PERSONAL_ANNUAL_PRICE_ID":    "",
		"SMITHERS_BILLING_PRO_MONTHLY_PRICE_ID":        "",
		"SMITHERS_BILLING_PRO_ANNUAL_PRICE_ID":         "",
		"SMITHERS_BILLING_MAX_MONTHLY_PRICE_ID":        "",
		"SMITHERS_BILLING_MAX_ANNUAL_PRICE_ID":         "",
		"SMITHERS_BILLING_TEAM_MONTHLY_PRICE_ID":       "",
		"SMITHERS_BILLING_TEAM_ANNUAL_PRICE_ID":        "",
		"SMITHERS_BILLING_ENTERPRISE_MONTHLY_PRICE_ID": "",
		"SMITHERS_BILLING_ENTERPRISE_ANNUAL_PRICE_ID":  "",
		"SMITHERS_FEATURE_FLAGS_MULTI_AUTH":            "false",
		"SMITHERS_OTEL_EXPORTER":                       "none", "SMITHERS_LOG_LEVEL": "info",
	} {
		t.Setenv(key, value)
	}

	// Only external model generation is deterministic: no provider credentials,
	// network inference, or costly packaged-host build is needed to prove optional
	// services are not core dependencies. The internal HTTP chat client, dispatcher,
	// private producer authentication, journal, routes, DB, and repository are real.
	grants := make(chan ports.ChatTurnGrant, 8)
	hostErrors := make(chan error, 8)
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		failure := func(err error) {
			select {
			case hostErrors <- err:
			default:
			}
			http.Error(w, err.Error(), http.StatusBadGateway)
		}
		if r.Method != http.MethodPost || r.URL.Path != chat.ModelHostTurnPath || r.Header.Get("Authorization") != "Bearer optional-model-transport" {
			failure(fmt.Errorf("unexpected model transport request"))
			return
		}
		var grant ports.ChatTurnGrant
		if err := json.NewDecoder(r.Body).Decode(&grant); err != nil {
			failure(err)
			return
		}
		select {
		case grants <- grant:
		default:
		}
		callback := func(path string, payload any, authorization string, want int) ([]byte, error) {
			raw, err := json.Marshal(payload)
			if err != nil {
				return nil, err
			}
			req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, grant.ProducerBaseURL+path, bytes.NewReader(raw))
			if err != nil {
				return nil, err
			}
			if authorization != "" {
				req.Header.Set("Authorization", authorization)
			}
			req.Header.Set("Content-Type", "application/json")
			res, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
			if err != nil {
				return nil, err
			}
			defer res.Body.Close()
			body, err := io.ReadAll(res.Body)
			if err != nil {
				return nil, err
			}
			if res.StatusCode != want {
				return nil, fmt.Errorf("callback %s: %d %s", path, res.StatusCode, body)
			}
			return body, nil
		}
		started := chat.ProviderStartedPath + "?turnId=" + url.QueryEscape(grant.TurnID) + "&generation=" + fmt.Sprint(grant.Generation)
		if _, err := callback(started, nil, "Bearer "+grant.Token, http.StatusNoContent); err != nil {
			failure(err)
			return
		}
		frames := []json.RawMessage{
			json.RawMessage(fmt.Sprintf(`{"runId":%q,"type":"delta","kind":"text","text":"optional services chat reply"}`, grant.RunID)),
			json.RawMessage(fmt.Sprintf(`{"runId":%q,"type":"done","reason":"stop"}`, grant.RunID)),
		}
		commit := map[string]any{"turnId": grant.TurnID, "generation": grant.Generation, "expected": grant.Cursor, "frames": frames}
		for _, authorization := range []string{"", "Bearer " + strings.Repeat("b", 48)} {
			if _, err := callback(chat.CommitPath, commit, authorization, http.StatusUnauthorized); err != nil {
				failure(err)
				return
			}
		}
		if _, err := callback(chat.CommitPath, commit, "Bearer "+grant.Token, http.StatusOK); err != nil {
			failure(err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(func() {
		model.Close()
		for {
			select {
			case err := <-hostErrors:
				t.Errorf("model transport: %v", err)
			default:
				return
			}
		}
	})
	host, err := chat.NewHTTPChatHost(model.URL, model.Client(), "optional-model-transport")
	require.NoError(t, err)
	previousLogger := slog.Default()
	t.Cleanup(func() { slog.SetDefault(previousLogger) })
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	startupLog := &optionalServicesLog{}
	instance, err := app.Start(ctx, app.Config{Args: []string{"--config", configFile}, Stdout: io.Discard, Stderr: startupLog, Commerce: nil, Repository: local.Client(), ChatHost: host, FlowHostRegistry: nil, PlatformModelKeys: nil})
	require.NoError(t, err)
	t.Cleanup(func() {
		closeCtx, stop := context.WithTimeout(context.Background(), 15*time.Second)
		defer stop()
		require.NoError(t, instance.Close(closeCtx))
	})
	require.Contains(t, startupLog.String(), `"email_transport":"disabled"`)
	server := httptest.NewServer(instance.Handler())
	t.Cleanup(server.Close)
	client := &http.Client{Timeout: 30 * time.Second}
	request := func(method, path, token string, payload any, want int) []byte {
		t.Helper()
		raw, err := json.Marshal(payload)
		require.NoError(t, err)
		req, err := http.NewRequestWithContext(ctx, method, server.URL+path, bytes.NewReader(raw))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("Authorization", "token "+token)
		}
		res, err := client.Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		body, err := io.ReadAll(res.Body)
		require.NoError(t, err)
		require.Equal(t, want, res.StatusCode, "%s %s: %s", method, path, body)
		return body
	}
	var bootstrap struct {
		Capabilities []string `json:"capabilities"`
	}
	require.NoError(t, json.Unmarshal(request("GET", "/api/bootstrap", "", nil, http.StatusOK), &bootstrap))
	require.Contains(t, bootstrap.Capabilities, "agent")
	require.NotContains(t, bootstrap.Capabilities, "github")
	for _, capability := range bootstrap.Capabilities {
		require.False(t, strings.HasPrefix(capability, "billing."), "unexpected optional capability %q", capability)
	}
	ready := request("GET", "/readyz", "", nil, 200)
	require.Contains(t, string(ready), `"database":"ok"`)
	ownerToken, err := seed.InstallOwner(ctx, pool, "optionalowner", 1001)
	require.NoError(t, err)
	auth := struct{ Token string }{Token: ownerToken}
	var owner struct {
		ID int64 `json:"id"`
	}
	require.NoError(t, json.Unmarshal(request("GET", "/api/user", auth.Token, nil, http.StatusOK), &owner))
	require.Positive(t, owner.ID)
	for _, path := range []string{chat.CommitPath, chat.ProviderStartedPath} {
		request("POST", path, auth.Token, map[string]any{}, http.StatusNotFound)
	}
	var repo struct {
		ID   int64  `json:"id"`
		Name string `json:"name"`
	}
	require.NoError(t, json.Unmarshal(request("POST", "/api/user/repos", auth.Token, map[string]any{"name": "optional-repo", "private": true, "auto_init": true, "default_bookmark": "main"}, 201), &repo))
	require.Positive(t, repo.ID)
	require.Equal(t, "optional-repo", repo.Name)
	var readRepo struct {
		ID int64 `json:"id"`
	}
	require.NoError(t, json.Unmarshal(request("GET", "/api/repos/optionalowner/optional-repo", auth.Token, nil, 200), &readRepo))
	require.Equal(t, repo.ID, readRepo.ID)
	// Reading initialized content exercises native storage, not just SQL metadata.
	contents := request("GET", "/api/repos/optionalowner/optional-repo/contents?ref=main", auth.Token, nil, 200)
	require.Contains(t, string(contents), "README.md")
	runID := "optional-" + uuid.NewString()
	journal := chat.JournalRequest{Version: 1, LegID: uuid.NewString(), Token: strings.Repeat("a", 48)}
	payload := map[string]any{"runId": runID, "journal": journal, "repositoryId": repo.ID, "instructions": "Answer briefly.", "messages": []any{map[string]string{"role": "user", "content": "Say hello"}}}
	request("POST", chat.TurnPath, "", payload, http.StatusUnauthorized)
	stream := request("POST", chat.TurnPath, auth.Token, payload, 200)
	require.Contains(t, string(stream), "optional services chat reply")
	require.Contains(t, string(stream), `"type":"done"`)
	replayBody := map[string]any{"runId": runID, "journal": journal}
	request("POST", chat.ReplayPath, "", replayBody, http.StatusUnauthorized)
	replay := request("POST", chat.ReplayPath, auth.Token, replayBody, 200)
	require.Contains(t, string(replay), "optional services chat reply")
	require.Contains(t, string(replay), `"type":"done"`)
	select {
	case grant := <-grants:
		require.Equal(t, owner.ID, grant.OwnerID)
		// The public chat route is account-scoped. Repository context stays
		// in the model request and does not authorize a repository scope.
		require.Zero(t, grant.RepositoryID)
		var modelRequest struct {
			RepositoryID int64 `json:"repositoryId"`
		}
		require.NoError(t, json.Unmarshal(grant.Request, &modelRequest))
		require.Equal(t, repo.ID, modelRequest.RepositoryID)
		require.Equal(t, runID, grant.RunID)
		require.Equal(t, journal.LegID, grant.LegID)
		require.NotEmpty(t, grant.Token)
		require.NotEqual(t, server.URL, grant.ProducerBaseURL)
		producerURL, err := url.Parse(grant.ProducerBaseURL)
		require.NoError(t, err)
		producerIP := net.ParseIP(producerURL.Hostname())
		require.NotNil(t, producerIP)
		require.True(t, producerIP.IsLoopback(), "producer listener must be loopback")
		require.NotContains(t, string(stream), grant.Token)
		require.NotContains(t, string(replay), grant.Token)
	default:
		t.Fatal("real dispatcher did not grant the model turn")
	}
	select {
	case err := <-hostErrors:
		require.NoError(t, err)
	default:
	}
	// Same request returns its terminal cursor without dispatching another inference.
	repeated := request("POST", chat.TurnPath, auth.Token, payload, 200)
	var existing chat.AdmitResult
	require.NoError(t, json.Unmarshal(repeated, &existing))
	require.Equal(t, "existing", existing.Status)
	require.True(t, existing.Terminal)
	require.Equal(t, runID, existing.Cursor.RunID)
	require.Equal(t, journal.LegID, existing.Cursor.LegID)
	require.Equal(t, replay, request("POST", chat.ReplayPath, auth.Token, replayBody, http.StatusOK))
	select {
	case <-grants:
		t.Fatal("completed turn dispatched twice")
	default:
	}
}

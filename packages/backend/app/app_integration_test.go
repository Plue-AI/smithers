package app_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/app"
	"github.com/smithersai/smithers/packages/backend/repository"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

func TestStartServesReadyAndBootstrapFromProductPostgres(t *testing.T) {
	_, databaseURL := postgresfixture.NewProductDatabase(t)
	ffi := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	if ffi == "" {
		t.Fatal("SMITHERS_FFI_LIBRARY_PATH is required for the real repository engine")
	}
	local, err := repository.OpenLocal(repository.Config{
		StoragePath: t.TempDir(), AuthToken: "repo-token", FFILibraryPath: ffi,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := local.Shutdown(ctx); err != nil {
			t.Errorf("close repository: %v", err)
		}
	})
	for key, value := range map[string]string{
		// A private deployment variable must not change the public process.
		"PLUE_BACKEND_ROLE":                      "hosted_worker",
		"SMITHERS_DATABASE_URL":                  databaseURL,
		"SMITHERS_BLOB_DATA_DIR":                 t.TempDir(),
		"SMITHERS_AUTH_MODE":                     "selfhost",
		"SMITHERS_AUTH_BOOTSTRAP_TOKEN":          "test-bootstrap-token",
		"SMITHERS_AUTH_SESSION_SECRET":           "test-secret",
		"SMITHERS_LFS_SIGNING_SECRET":            "test-lfs-signing-secret",
		"SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY": "test-webhook-key",
		"SMITHERS_REPO_HOST_AUTH_TOKEN":          "repo-token",
		"SMITHERS_REPO_HOST_URL":                 "",
		"SMITHERS_PUSH_HOOK_CALLBACK_TOKEN":      "push-callback-token",
		"SMITHERS_SERVER_ADDR":                   "127.0.0.1:0",
		"SMITHERS_PUBLIC_URL":                    "http://127.0.0.1:4000",
		"SMITHERS_FEATURE_FLAGS_WORKFLOWS":       "false",
		"SMITHERS_FEATURE_FLAGS_SANDBOXES":       "false",
		"SMITHERS_FEATURE_FLAGS_WORKSPACES":      "false",
	} {
		t.Setenv(key, value)
	}
	previousLogger := slog.Default()
	t.Cleanup(func() { slog.SetDefault(previousLogger) })
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	instance, err := app.Start(ctx, app.Config{Stdout: io.Discard, Stderr: io.Discard, Repository: local.Client()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		closeCtx, closeCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer closeCancel()
		if err := instance.Close(closeCtx); err != nil {
			t.Errorf("close app: %v", err)
		}
	})
	for _, path := range []string{"/readyz", "/api/bootstrap"} {
		response := httptest.NewRecorder()
		instance.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusOK {
			t.Fatalf("GET %s: status %d, body %s", path, response.Code, response.Body.String())
		}
		var body map[string]any
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatalf("GET %s JSON: %v", path, err)
		}
		if path == "/readyz" {
			checks, ok := body["checks"].(map[string]any)
			if body["status"] != "ready" || !ok || checks["database"] != "ok" {
				t.Fatalf("readiness response: %v", body)
			}
		}
		if path == "/api/bootstrap" {
			// The self-host bootstrap is a web host with owner credentials, never the native shell.
			if body["host"] != "cloud" || body["authFlow"] != "credentials" {
				t.Fatalf("bootstrap response: %v", body)
			}
		}
	}
}

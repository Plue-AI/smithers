package compose

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/repository"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// This test deliberately enters the ordinary local composition. It catches
// hosted-only blob wrappers or deployment queries that prevent startup, a
// missing transfer route, missing native cross-origin preflight, and a leaked
// filesystem ownership lock on in-process shutdown.
func TestLocalBlobTransferComposed(t *testing.T) {
	ffi := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	if ffi == "" {
		t.Skip("set SMITHERS_FFI_LIBRARY_PATH")
	}
	migrationPool, dbURL := postgresfixture.NewProductDatabase(t)
	migrationPool.Close()

	local, err := repository.OpenLocal(repository.Config{
		StoragePath: t.TempDir(), AuthToken: "local-blob-transfer-test", FFILibraryPath: ffi,
	})
	require.NoError(t, err)
	t.Cleanup(func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		require.NoError(t, local.Shutdown(closeCtx))
	})

	blobRoot := t.TempDir()
	for name, value := range map[string]string{
		"SMITHERS_AUTH_MODE":                     "selfhost",
		"SMITHERS_DATABASE_URL":                  dbURL,
		"SMITHERS_PUBLIC_URL":                    "http://127.0.0.1:4000",
		"SMITHERS_SERVER_ADDR":                   "127.0.0.1:0",
		"SMITHERS_SERVER_ALLOWED_ORIGINS":        "http://127.0.0.1:5173",
		"SMITHERS_SERVER_SHUTDOWN_TIMEOUT":       "10s",
		"SMITHERS_REPO_HOST_URL":                 "http://127.0.0.1:4001",
		"SMITHERS_REPO_HOST_AUTH_TOKEN":          "local-blob-transfer-test",
		"SMITHERS_PUSH_HOOK_CALLBACK_TOKEN":      "local-blob-transfer-callback",
		"SMITHERS_AUTH_SESSION_SECRET":           "local-blob-transfer-session-secret",
		"SMITHERS_LFS_SIGNING_SECRET":            "local-blob-transfer-lfs-secret",
		"SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY": "local-blob-transfer-webhook-key",
		"SMITHERS_BLOB_DATA_DIR":                 blobRoot,
		"SMITHERS_BLOB_RESERVE_BYTES":            "0",
		"SMITHERS_BLOB_TRANSFER_SIGNING_KEY":     "",
		"SMITHERS_FEATURE_FLAGS_WORKFLOWS":       "false",
		"SMITHERS_FEATURE_FLAGS_SANDBOXES":       "false",
		"SMITHERS_FEATURE_FLAGS_WORKSPACES":      "false",
		"SMITHERS_OTEL_EXPORTER":                 "none",
	} {
		t.Setenv(name, value)
	}

	// Observe the adapter made by the real constructor; do not inject a mock.
	original := newBlobStore
	storeCh := make(chan blob.Store, 1)
	newBlobStore = func(ctx context.Context, cfg config.BlobConfig) (blob.Store, io.Closer, time.Duration, error) {
		store, closer, expiry, err := original(ctx, cfg)
		if err == nil {
			storeCh <- store
		}
		return store, closer, expiry, err
	}
	t.Cleanup(func() { newBlobStore = original })

	serverCtx, cancelServer := context.WithCancel(context.Background())
	ready := make(chan http.Handler, 1)
	finished := make(chan struct{})
	var serverErr error
	go func() {
		serverErr = StartWithOptions(serverCtx, nil, io.Discard, io.Discard,
			Options{Repository: local.Client()},
			func(handler http.Handler) { ready <- handler })
		close(finished)
	}()
	t.Cleanup(func() {
		cancelServer()
		select {
		case <-finished:
			require.NoError(t, serverErr)
		case <-time.After(20 * time.Second):
			t.Error("local composition did not stop")
		}
	})

	var handler http.Handler
	select {
	case handler = <-ready:
	case <-finished:
		t.Fatalf("local composition stopped before ready: %v", serverErr)
	case <-time.After(30 * time.Second):
		t.Fatal("local composition did not become ready")
	}
	readiness := httptest.NewRecorder()
	handler.ServeHTTP(readiness, httptest.NewRequest(http.MethodGet, "http://127.0.0.1:4000/readyz", nil))
	require.Equal(t, http.StatusOK, readiness.Code, readiness.Body.String())
	var store blob.Store
	select {
	case store = <-storeCh:
	default:
		t.Fatal("local composition did not construct a filesystem blob store")
	}
	filesystem, ok := store.(*blob.FilesystemStore)
	require.True(t, ok, "local composition chose %T", store)

	key := "repos/1/artifacts/composed-transfer"
	upload, err := filesystem.SignedCreateOnlyUploadURL(context.Background(), key, "text/plain", 7, time.Minute)
	require.NoError(t, err)
	preflight := httptest.NewRequest(http.MethodOptions, upload.URL, nil)
	preflight.Header.Set("Origin", "http://127.0.0.1:5173")
	preflight.Header.Set("Access-Control-Request-Method", "PUT")
	preflight.Header.Set("Access-Control-Request-Headers", "content-type")
	preflightResponse := httptest.NewRecorder()
	handler.ServeHTTP(preflightResponse, preflight)
	require.Equal(t, "http://127.0.0.1:5173", preflightResponse.Header().Get("Access-Control-Allow-Origin"))
	require.Contains(t, []int{http.StatusNoContent, http.StatusOK}, preflightResponse.Code)
	foreignPreflight := httptest.NewRequest(http.MethodOptions, upload.URL, nil)
	foreignPreflight.Header.Set("Origin", "https://untrusted.example")
	foreignPreflight.Header.Set("Access-Control-Request-Method", "PUT")
	foreignResponse := httptest.NewRecorder()
	handler.ServeHTTP(foreignResponse, foreignPreflight)
	require.Empty(t, foreignResponse.Header().Get("Access-Control-Allow-Origin"))

	put := httptest.NewRequest(http.MethodPut, upload.URL, strings.NewReader("durable"))
	put.Header.Set("Content-Type", "text/plain")
	put.Header.Set("Origin", "http://127.0.0.1:5173")
	putResponse := httptest.NewRecorder()
	handler.ServeHTTP(putResponse, put)
	require.Equal(t, http.StatusCreated, putResponse.Code)
	require.Equal(t, "http://127.0.0.1:5173", putResponse.Header().Get("Access-Control-Allow-Origin"))

	downloadURL, err := filesystem.SignedDownloadURL(context.Background(), key, time.Minute)
	require.NoError(t, err)
	getResponse := httptest.NewRecorder()
	handler.ServeHTTP(getResponse, httptest.NewRequest(http.MethodGet, downloadURL, nil))
	require.Equal(t, http.StatusOK, getResponse.Code)
	require.Equal(t, "durable", getResponse.Body.String())

	denied := httptest.NewRecorder()
	handler.ServeHTTP(denied, httptest.NewRequest(http.MethodGet, downloadURL+"x", nil))
	require.Equal(t, http.StatusForbidden, denied.Code)

	cancelServer()
	select {
	case <-finished:
		require.NoError(t, serverErr)
	case <-time.After(20 * time.Second):
		t.Fatal("local composition did not stop")
	}
	reopened, err := blob.NewFilesystemStore(blob.FilesystemConfig{Root: blobRoot, PublicBaseURL: "http://127.0.0.1:4000"})
	require.NoError(t, err, "local shutdown must release filesystem ownership")
	restartedDownload := httptest.NewRecorder()
	reopened.TransferHandler().ServeHTTP(restartedDownload, httptest.NewRequest(http.MethodGet, downloadURL, nil))
	require.Equal(t, http.StatusOK, restartedDownload.Code, "persisted signing key must keep issued URLs valid after restart")
	require.Equal(t, "durable", restartedDownload.Body.String())
	require.NoError(t, reopened.Close())
}

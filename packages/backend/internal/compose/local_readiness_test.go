package compose

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type localReadinessDB struct{ err error }

func (db localReadinessDB) Ping(context.Context) error { return db.err }

func TestLocalReadinessChecksInProcessRepository(t *testing.T) {
	var status atomic.Int32
	status.Store(http.StatusOK)
	repository := repohost.NewLocalClient(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/health", r.URL.Path)
		w.WriteHeader(int(status.Load()))
	}), "secret")
	backend := withLocalReadiness(http.NotFoundHandler(), localReadinessDB{}, repository, nil)
	check := func(path string, want int) {
		t.Helper()
		response := httptest.NewRecorder()
		backend.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		require.Equal(t, want, response.Code)
	}
	check("/readyz", http.StatusOK)
	check("/healthz", http.StatusOK)
	status.Store(http.StatusServiceUnavailable)
	check("/readyz", http.StatusServiceUnavailable)
	check("/healthz", http.StatusServiceUnavailable)
	check("/api/unknown", http.StatusNotFound)

	backend = withLocalReadiness(http.NotFoundHandler(), localReadinessDB{err: errors.New("offline")}, repository, nil)
	check = func(path string, want int) {
		t.Helper()
		response := httptest.NewRecorder()
		backend.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		require.Equal(t, want, response.Code)
	}
	check("/readyz", http.StatusServiceUnavailable)
}

// Inject capacity loss at the storage boundary without exhausting the shared
// host disk; all other blob operations still use the real filesystem store.
type fullReadinessStore struct{ blob.Store }

func (fullReadinessStore) CheckHeadroom() error { return blob.ErrStorageFull }

func TestLocalReadinessReportsFullDataVolume(t *testing.T) {
	repository := repohost.NewLocalClient(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }), "secret")
	for _, tc := range []struct {
		name    string
		full    bool
		code    int
		storage string
		status  string
	}{
		{"full", true, http.StatusServiceUnavailable, "full", "not_ready"},
		{"healthy", false, http.StatusOK, "ok", "ready"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			store, err := blob.NewFilesystemStore(blob.FilesystemConfig{Root: root, PublicBaseURL: "http://127.0.0.1:4000", SigningKey: []byte("test-signing-key-0123456789abcdef"), ReserveBytes: 0})
			require.NoError(t, err)
			t.Cleanup(func() { require.NoError(t, store.Close()) })
			var blobs blob.Store = store
			if tc.full {
				blobs = fullReadinessStore{Store: store}
			}
			backend := withLocalReadiness(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("X-Delegated", r.Method+" "+r.URL.Path)
				w.WriteHeader(http.StatusAccepted)
			}), localReadinessDB{}, repository, blobs)
			response := httptest.NewRecorder()
			backend.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/readyz", nil))
			require.Equal(t, tc.code, response.Code)
			var body struct {
				Status string            `json:"status"`
				Checks map[string]string `json:"checks"`
			}
			require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
			require.Equal(t, tc.status, body.Status)
			require.Equal(t, map[string]string{"database": "ok", "repo_host": "ok", "storage": tc.storage}, body.Checks)
			response = httptest.NewRecorder()
			backend.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/healthz", nil))
			require.Equal(t, http.StatusOK, response.Code)
			body.Checks = nil
			require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
			require.Equal(t, "ok", body.Status)
			require.NotContains(t, body.Checks, "storage")
			if !tc.full {
				moved := root + "-unavailable"
				require.NoError(t, os.Rename(root, moved))
				t.Cleanup(func() { _ = os.Rename(moved, root) })
				response = httptest.NewRecorder()
				backend.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/readyz", nil))
				require.Equal(t, http.StatusServiceUnavailable, response.Code)
				require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
				require.Equal(t, "not_ready", body.Status)
				require.Equal(t, "error", body.Checks["storage"])
				require.NoError(t, os.Rename(moved, root))
				response = httptest.NewRecorder()
				backend.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/readyz", nil))
				require.Equal(t, http.StatusOK, response.Code)
				require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
				require.Equal(t, "ready", body.Status)
				require.Equal(t, "ok", body.Checks["storage"])
			}
			for _, request := range []struct{ method, path string }{{http.MethodGet, "/api/unknown"}, {http.MethodPost, "/readyz"}, {http.MethodPost, "/healthz"}} {
				response = httptest.NewRecorder()
				backend.ServeHTTP(response, httptest.NewRequest(request.method, request.path, nil))
				require.Equal(t, http.StatusAccepted, response.Code)
				require.Equal(t, request.method+" "+request.path, response.Header().Get("X-Delegated"))
			}
		})
	}
}

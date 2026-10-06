package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The owner store succeeds during authorization and fails during the second
// read. This isolates a storage failure after authorization without a database.
type quiesceOwnerReadFailure struct {
	calls int
	cause error
}

func (o *quiesceOwnerReadFailure) GetSelfHostOwner(context.Context) (db.User, error) {
	o.calls++
	if o.calls == 1 {
		return db.User{ID: 7}, nil
	}
	return db.User{}, o.cause
}

func TestInstallQuiesceOwnerReadFailureRetainsPrivateCause(t *testing.T) {
	for _, method := range []string{http.MethodPost, http.MethodDelete} {
		t.Run(method, func(t *testing.T) {
			cause := errors.New("owner database lookup failed: SQLSTATE 08006")
			owners := &quiesceOwnerReadFailure{cause: cause}
			h := &InstallQuiesceHandler{Owners: owners}
			var logs bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&logs, nil))
			r := httptest.NewRequest(method, "/api/install/quiesce", strings.NewReader(`{"op":"backup"}`))
			r = r.WithContext(middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{
				User: &db.User{ID: 7}, SessionHash: "browser",
			}))
			w := httptest.NewRecorder()
			middleware.InjectLogger(logger)(http.HandlerFunc(h.Handle)).ServeHTTP(w, r)

			require.Equal(t, 2, owners.calls)
			require.Equal(t, http.StatusInternalServerError, w.Code)
			var body map[string]any
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
			require.Equal(t, "internal", body["code"])
			require.Equal(t, "internal server error", body["message"])
			require.NotContains(t, w.Body.String(), "SQLSTATE")
			require.NotContains(t, body, "cause")

			var logged map[string]any
			require.NoError(t, json.Unmarshal(logs.Bytes(), &logged))
			require.Equal(t, cause.Error(), logged["cause"])
			require.Equal(t, "install owner unavailable", logged["error"])
		})
	}
}

func TestInstallQuiesceOwner(t *testing.T) {
	for _, method := range []string{"POST", "DELETE"} {
		for _, owner := range []bool{false, true} {
			t.Run(method+map[bool]string{false: "member", true: "owner"}[owner], func(t *testing.T) {
				h := &InstallQuiesceHandler{Owners: githubAppSetupTestOwner{user: db.User{ID: 7}}}
				id := int64(8)
				if owner {
					id = 7
				}
				r := httptest.NewRequest(method, "/api/install/quiesce", strings.NewReader(`{"op":"backup"}`))
				r = r.WithContext(middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{User: &db.User{ID: id}, SessionHash: "browser"}))
				w := httptest.NewRecorder()
				h.Handle(w, r)
				if !owner && w.Code != 403 {
					t.Fatalf("status %d", w.Code)
				}
				if owner && w.Code == 403 {
					t.Fatal("owner refused")
				}
			})
		}
	}
}
func TestInstallQuiesceFlagOff(t *testing.T) {
	r := chi.NewRouter()
	MountInstallQuiesce(r, false, nil, nil)
	r.Post("/write", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })
	for _, method := range []string{"POST", "DELETE"} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(method, "/api/install/quiesce", nil))
		if w.Code != 404 {
			t.Fatalf("%s: %d", method, w.Code)
		}
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("POST", "/write", nil))
	if w.Code != 204 {
		t.Fatal(w.Code)
	}
}
func TestInstallQuiesceHTTPGate(t *testing.T) {
	r := chi.NewRouter()
	MountInstallQuiesce(r, true, &services.QuiesceGate{}, nil)
	for _, method := range []string{"POST", "PUT", "PATCH", "DELETE", "GET"} {
		r.MethodFunc(method, "/write", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })
	}
	for _, method := range []string{"POST", "PUT", "PATCH", "DELETE", "GET"} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(method, "/write", nil))
		want := 503
		if method == "GET" {
			want = 204
		}
		if w.Code != want {
			t.Fatalf("%s %d", method, w.Code)
		}
		if want == 503 && !strings.Contains(w.Body.String(), `"class":"quiesced"`) {
			t.Fatal(w.Body.String())
		}
	}
}

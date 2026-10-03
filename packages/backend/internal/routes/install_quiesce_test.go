package routes

import (
	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

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

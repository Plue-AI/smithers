package compose

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// The MVP routes reuse repository handlers with the install's stored binding.
// Caller-supplied repository selectors never retarget these routes.
func installSecretRepository(q *db.Queries) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			command := middleware.InstallMemberCommand(r.Method, r.URL.EscapedPath())
			if _, err := services.Authorize(r.Context(), q, command); err != nil {
				status := 403
				if access, ok := err.(*services.AccessError); ok {
					status = access.Status
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(status)
				_ = json.NewEncoder(w).Encode(err)
				return
			}
			_, slug, err := installRepository(r.Context(), q)
			if err != nil {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(503)
				_ = json.NewEncoder(w).Encode(services.AccessError{Class: "infra", Code: "unavailable", Message: "Repository unavailable"})
				return
			}
			owner, repo, _ := strings.Cut(slug, "/")
			route := chi.RouteContext(r.Context())
			route.URLParams.Add("owner", owner)
			route.URLParams.Add("repo", repo)
			if r.Method == http.MethodDelete && chi.URLParam(r, "name") == "" {
				var body struct {
					Name string `json:"name"`
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(400)
					_ = json.NewEncoder(w).Encode(services.AccessError{Class: "user", Code: "invalid_input", Message: "Enter a secret name"})
					return
				}
				route.URLParams.Add("name", body.Name)
			}
			next.ServeHTTP(w, r)
		})
	}
}

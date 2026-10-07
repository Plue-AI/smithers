package compose

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
)

// mountFastGateway is shared by the single-owner and hosted compositions.
// Sign-in authenticates issuance; only install credentials reach inference.
func mountFastGateway(r chi.Router, queries *db.Queries, cfg *config.Config, g *modelproxy.FastGateway, csrf func(http.Handler) http.Handler) {
	r.Get(modelproxy.FastGatewayPath+"/quota", g.ServeHTTP)
	r.Post(modelproxy.FastGatewayPath+"/v1/chat/completions", g.ServeHTTP)
	r.Group(func(r chi.Router) {
		r.Use(authLoader(queries, cfg.Auth), middleware.RequireAuth, csrf)
		r.With(middleware.RequireScope(middleware.ScopeWriteUser)).Post("/api/fast-model/installs", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-store")
			// Only the install's host-side sign-in exchange receives a secret.
			// Browser cookies and delegated run/agent credentials cannot issue one.
			info := middleware.AuthInfoFromContext(r.Context())
			if info == nil || !info.IsTokenAuth || info.IsAgent() || info.TokenSystemIssued || info.ActingVia() != "" || r.Header.Get("Origin") != "" {
				modelproxy.WriteError(w, "", 403, "permission_error", "Host sign-in required.")
				return
			}
			var payload struct {
				Install string `json:"install_id"`
			}
			if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&payload) != nil {
				modelproxy.WriteError(w, "", 400, "invalid_request_error", "Invalid install.")
				return
			}
			token, err := g.Quota.Issue(r.Context(), middleware.UserFromContext(r.Context()).ID, payload.Install)
			if err != nil {
				modelproxy.WriteError(w, "", 403, "permission_error", "Install credential unavailable.")
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"install_id": payload.Install, "credential": token, "daily_tokens": g.Quota.Limit(), "reset_at": g.Quota.ResetAt()})
		})
		r.With(middleware.RequireScope(middleware.ScopeWriteUser)).Delete("/api/fast-model/installs/{install}", func(w http.ResponseWriter, r *http.Request) {
			if err := g.Quota.Revoke(r.Context(), middleware.UserFromContext(r.Context()).ID, chi.URLParam(r, "install")); err != nil {
				modelproxy.WriteError(w, "", 403, "permission_error", "Install credential unavailable.")
				return
			}
			w.WriteHeader(http.StatusNoContent)
		})
		r.With(middleware.RequireAdmin).Get("/api/admin/fast-model/daily-totals", func(w http.ResponseWriter, r *http.Request) {
			from, e1 := time.Parse("2006-01-02", r.URL.Query().Get("from"))
			until, e2 := time.Parse("2006-01-02", r.URL.Query().Get("until"))
			if e1 != nil || e2 != nil || !until.After(from) || until.Sub(from) > 366*24*time.Hour {
				modelproxy.WriteError(w, "", 400, "invalid_request_error", "Invalid UTC date range.")
				return
			}
			totals, err := g.Quota.DailyTotals(r.Context(), from, until)
			if err != nil {
				modelproxy.WriteError(w, "", 503, "api_error", "Totals unavailable.")
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			_ = json.NewEncoder(w).Encode(totals)
		})
	})
}

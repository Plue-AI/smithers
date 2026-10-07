package compose

import (
	"encoding/json"
	"errors"
	"github.com/smithersai/smithers/packages/backend/credits"
	apierrors "github.com/smithersai/smithers/packages/backend/errors"
	"io"
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
				apierrors.WriteError(w, apierrors.Forbidden("Host sign-in required."))
				return
			}
			var payload struct {
				Install string `json:"install_id"`
			}
			decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
			decoder.DisallowUnknownFields()
			if decoder.Decode(&payload) != nil || decoder.Decode(new(any)) != io.EOF {
				apierrors.WriteError(w, apierrors.BadRequest("Invalid install."))
				return
			}
			token, err := g.Quota.Issue(r.Context(), middleware.UserFromContext(r.Context()).ID, payload.Install)
			if err != nil {
				writeFastCredentialError(w, err)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"install_id": payload.Install, "credential": token, "daily_tokens": g.Quota.Limit(), "reset_at": g.Quota.ResetAt()})
		})
		r.With(middleware.RequireScope(middleware.ScopeWriteUser)).Delete("/api/fast-model/installs/{install}", func(w http.ResponseWriter, r *http.Request) {
			if err := g.Quota.Revoke(r.Context(), middleware.UserFromContext(r.Context()).ID, chi.URLParam(r, "install")); err != nil {
				writeFastCredentialError(w, err)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		})
		r.With(middleware.RequireAdmin).Get("/api/admin/fast-model/daily-totals", func(w http.ResponseWriter, r *http.Request) {
			from, e1 := time.Parse("2006-01-02", r.URL.Query().Get("from"))
			until, e2 := time.Parse("2006-01-02", r.URL.Query().Get("until"))
			if e1 != nil || e2 != nil || !until.After(from) || until.Sub(from) > 366*24*time.Hour {
				apierrors.WriteError(w, apierrors.BadRequest("Invalid UTC date range."))
				return
			}
			totals, err := g.Quota.DailyTotals(r.Context(), from, until)
			if err != nil {
				apierrors.WriteError(w, apierrors.New(apierrors.CodeServiceUnavailable, "Totals unavailable."))
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			_ = json.NewEncoder(w).Encode(totals)
		})
	})
}

func writeFastCredentialError(w http.ResponseWriter, err error) {
	if errors.Is(err, credits.ErrInstallCredential) {
		apierrors.WriteError(w, apierrors.Forbidden("Install credential unavailable."))
		return
	}
	apierrors.WriteError(w, apierrors.New(apierrors.CodeServiceUnavailable, "Install credential unavailable."))
}

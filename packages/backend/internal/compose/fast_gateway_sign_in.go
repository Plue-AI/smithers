package compose

import (
	"crypto/subtle"
	"encoding/json"
	"html/template"
	"net/http"
	"net/url"
	"time"

	"github.com/go-chi/chi/v5"
	apierrors "github.com/smithersai/smithers/packages/backend/errors"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
)

var fastConsent = template.Must(template.New("fast-sign-in").Parse(`<!doctype html><html><head><title>Sign in to Smithers</title><meta name="referrer" content="no-referrer"></head><body><form method="post" action="/api/fast-model/sign-in">{{range $name,$value := .Values}}<input type="hidden" name="{{$name}}" value="{{$value}}">{{end}}<button type="submit">Sign in</button></form></body></html>`))

const fastConsentCookie = "__fast_model_consent"

func mountFastGatewaySignIn(r chi.Router, q *db.Queries, cfg *config.Config, g *modelproxy.FastGateway) {
	service := services.FastGatewaySignIn{Pool: g.Quota.DB, Quota: g.Quota}
	r.With(authLoader(q, cfg.Auth)).Get("/api/fast-model/sign-in", func(w http.ResponseWriter, r *http.Request) {
		in := services.FastGatewayAuthorizeFromValues(r.URL.Query())
		if services.ValidateFastGatewayAuthorize(in) != nil {
			apierrors.WriteError(w, apierrors.BadRequest("Invalid sign-in."))
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		if middleware.UserFromContext(r.Context()) == nil {
			http.Redirect(w, r, "/api/auth/github?return_to="+url.QueryEscape(r.URL.RequestURI()), http.StatusSeeOther)
			return
		}
		info := middleware.AuthInfoFromContext(r.Context())
		if info == nil || info.IsTokenAuth {
			apierrors.WriteError(w, apierrors.Forbidden("Browser sign-in required."))
			return
		}
		nonce, err := middleware.NewCSRFToken()
		if err != nil {
			apierrors.WriteError(w, apierrors.Internal("Sign-in unavailable."))
			return
		}
		http.SetCookie(w, &http.Cookie{Name: fastConsentCookie, Value: nonce, Path: "/api/fast-model/sign-in", HttpOnly: true, Secure: cfg.Auth.CookieSecure, SameSite: http.SameSiteStrictMode, MaxAge: 600})
		values := map[string]string{}
		for name, items := range r.URL.Query() {
			if len(items) == 1 {
				values[name] = items[0]
			}
		}
		values["csrf_token"] = nonce
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
		_ = fastConsent.Execute(w, struct{ Values map[string]string }{values})
	})
	r.With(authLoader(q, cfg.Auth), middleware.RequireAuth).Post("/api/fast-model/sign-in", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		info := middleware.AuthInfoFromContext(r.Context())
		if info == nil || info.IsTokenAuth {
			apierrors.WriteError(w, apierrors.Forbidden("Browser sign-in required."))
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
		if r.ParseForm() != nil {
			apierrors.WriteError(w, apierrors.BadRequest("Invalid sign-in."))
			return
		}
		cookie, err := r.Cookie(fastConsentCookie)
		http.SetCookie(w, &http.Cookie{Name: fastConsentCookie, Value: "", Path: "/api/fast-model/sign-in", HttpOnly: true, Secure: cfg.Auth.CookieSecure, MaxAge: -1})
		nonce := r.PostForm.Get("csrf_token")
		if err != nil || nonce == "" || subtle.ConstantTimeCompare([]byte(cookie.Value), []byte(nonce)) != 1 {
			apierrors.WriteError(w, apierrors.Forbidden("Sign-in expired."))
			return
		}
		in := services.FastGatewayAuthorizeFromValues(r.PostForm)
		code, err := service.Authorize(r.Context(), info.User.ID, in)
		if err != nil {
			apierrors.WriteError(w, apierrors.BadRequest("Sign-in refused."))
			return
		}
		target, _ := url.Parse(in.Redirect)
		params := target.Query()
		params.Set("state", in.State)
		params.Set("code", code)
		target.RawQuery = params.Encode()
		http.Redirect(w, r, target.String(), http.StatusSeeOther)
	})
	r.Post("/api/fast-model/exchange", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.Header.Get("Origin") != "" {
			apierrors.WriteError(w, apierrors.Forbidden("Host exchange required."))
			return
		}
		var body struct {
			Code     string `json:"code"`
			Verifier string `json:"code_verifier"`
			Redirect string `json:"redirect_uri"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&body) != nil {
			apierrors.WriteError(w, apierrors.BadRequest("Invalid exchange."))
			return
		}
		install, credential, err := service.Exchange(r.Context(), body.Code, body.Verifier, body.Redirect)
		if err != nil {
			apierrors.WriteError(w, apierrors.BadRequest("Sign-in refused."))
			return
		}
		remaining, err := g.Quota.Remaining(r.Context(), install, credential)
		if err != nil {
			apierrors.WriteError(w, apierrors.New(apierrors.CodeServiceUnavailable, "Quota unavailable."))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"credential": credential, "install_id": install, "remaining": remaining, "reset_at": g.Quota.ResetAt().Format(time.RFC3339)})
	})
}

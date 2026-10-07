package modelhost

import (
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"net/http"
	"os"
)

func (s OwnerModels) fastAccess() services.InstallFastModelAccess {
	return services.InstallFastModelAccess{Pool: s.Pool, Codec: s.Codec, Gateway: os.Getenv("SMITHERS_FAST_MODEL_GATEWAY")}
}
func (s OwnerModels) FastModelSignIn(w http.ResponseWriter, r *http.Request) {
	owner := ownerOf(r)
	if owner <= 0 {
		modelJSON(w, 401, map[string]string{"code": "sign_in_required"})
		return
	}
	// Redirect authority is configured by the install, never supplied by the browser.
	redirect := s.FastModelCallback
	if origin, ok := middleware.EffectiveOriginFromContext(r.Context()); ok {
		redirect = origin + "/api/model/fast/return"
	}
	if redirect == "" {
		modelJSON(w, 503, map[string]string{"code": "sign_in_unavailable"})
		return
	}
	target, err := s.fastAccess().Begin(r.Context(), owner, redirect, r.Header.Get("Idempotency-Key"))
	if err != nil {
		modelJSON(w, 503, map[string]string{"code": "storage_failed"})
		return
	}
	modelJSON(w, 200, map[string]string{"url": target})
}
func (s OwnerModels) FastModelReturn(w http.ResponseWriter, r *http.Request) {
	if err := s.fastAccess().Complete(r.Context(), ownerOf(r), r.URL.Query().Get("state"), r.URL.Query().Get("code")); err != nil {
		modelJSON(w, 400, map[string]string{"code": "sign_in_refused"})
		return
	}
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, "/", http.StatusSeeOther)
}
func (s OwnerModels) FastModelSignOut(w http.ResponseWriter, r *http.Request) {
	if err := s.fastAccess().SignOut(r.Context()); err != nil {
		modelJSON(w, 503, map[string]string{"code": "storage_failed"})
		return
	}
	modelJSON(w, 200, map[string]bool{"ok": true})
}

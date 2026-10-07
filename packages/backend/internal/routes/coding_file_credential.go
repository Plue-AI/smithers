package routes

import (
	"context"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type CodingFileCredentialService interface {
	Mint(context.Context, string, string, services.CodingFileGrantInput) (services.CodingFileGrant, error)
	Revoke(context.Context, string, int64, string) error
}

// These private callbacks use host/self-revocation bearers, never browser
// cookies. The issued bearer reaches only the existing file-content PUT.
func (h *WorkspaceHandler) MintCodingFileGrant(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if h.CodingFiles == nil {
		pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "coding file issuer unavailable"))
		return
	}
	var input services.CodingFileGrantInput
	if !decodeStrictJSONBody(w, r, &input) {
		return
	}
	grant, err := h.CodingFiles.Mint(r.Context(), chi.URLParam(r, "hostID"), bearerToken(r.Header.Get("Authorization")), input)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusCreated, grant)
}

func (h *WorkspaceHandler) RevokeCodingFileGrant(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if h.CodingFiles == nil {
		pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "coding file issuer unavailable"))
		return
	}
	id, err := strconv.ParseInt(chi.URLParam(r, "tokenID"), 10, 64)
	if err != nil || id <= 0 {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid coding file grant"))
		return
	}
	if err = h.CodingFiles.Revoke(r.Context(), chi.URLParam(r, "hostID"), id, bearerToken(r.Header.Get("Authorization"))); err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

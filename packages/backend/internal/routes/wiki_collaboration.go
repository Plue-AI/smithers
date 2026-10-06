package routes

import (
	"context"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"net/http"
)

type WikiCollaborationService interface {
	GetWikiDocument(context.Context, *db.User, string, string, string) (services.WikiDocumentResponse, error)
}

type WikiCollaborationHandler struct {
	Service WikiCollaborationService
}

func wikiAddress(r *http.Request) (string, string, string, error) {
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		return "", "", "", err
	}
	slug, err := routeParam(r, "slug", "wiki slug is required")
	return owner, repo, slug, err
}

func (h *WikiCollaborationHandler) Document(w http.ResponseWriter, r *http.Request) {
	var scopeOK bool
	r, scopeOK = wikiScopeRequest(w, r)
	if !scopeOK {
		return
	}
	owner, repo, slug, err := wikiAddress(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	doc, err := h.Service.GetWikiDocument(r.Context(), middleware.UserFromContext(r.Context()), owner, repo, slug)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	pkgerrors.WriteJSON(w, http.StatusOK, doc)
}

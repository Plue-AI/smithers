package routes

import (
	"context"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func wikiScopeRequest(w http.ResponseWriter, r *http.Request) (*http.Request, bool) {
	ctx, err := services.WithWikiVisibility(r.Context(), r.URL.Query().Get("visibility"))
	if err != nil {
		writeRouteError(w, r, err)
		return r, false
	}
	w.Header().Set("Cache-Control", "private, no-store")
	return r.WithContext(ctx), true
}

// WikiIndexService extends the existing wiki product without a second handler store.
type WikiIndexService interface {
	GetWikiIndex(context.Context, *db.User, string, string) (services.WikiIndex, error)
}

func WikiIndex(svc WikiIndexService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		r, ok := wikiScopeRequest(w, r)
		if !ok {
			return
		}
		owner, repo, err := repoOwnerAndName(r)
		if err != nil {
			writeRouteError(w, r, err)
			return
		}
		result, err := svc.GetWikiIndex(r.Context(), middleware.UserFromContext(r.Context()), owner, repo)
		if err != nil {
			writeRouteError(w, r, err)
			return
		}
		pkgerrors.WriteJSON(w, http.StatusOK, result)
	}
}

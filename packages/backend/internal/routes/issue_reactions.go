package routes

import (
	api "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"net/http"
)

func (h *IssueHandler) IssueReaction(w http.ResponseWriter, r *http.Request) {
	actor, err := requireRouteUser(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	svc, ok := h.Service.(*services.IssueService)
	if !ok {
		writeRouteError(w, r, api.Internal("issue reactions unavailable"))
		return
	}
	number, err := parseInt64RouteParam(r, "number", "issue number required", "invalid issue number")
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	comment, err := parseInt64RouteParam(r, "comment", "comment required", "invalid comment")
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	var out []services.IssueReaction
	if r.Method == http.MethodGet {
		out, err = svc.IssueReactions(r.Context(), actor, owner, repo, number, comment)
	} else {
		var in services.IssueReaction
		if !decodeJSONBody(w, r, &in) {
			return
		}
		out, err = svc.SetIssueReaction(r.Context(), actor, owner, repo, number, comment, in)
	}
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	api.WriteJSON(w, 200, out)
}

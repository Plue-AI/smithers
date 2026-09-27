package routes

import (
	"errors"
	api "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"net/http"
	"strconv"
)

// Connector routing and receipts extend the issue handler, under the same auth gates.
func (h *IssueHandler) IssueSync(w http.ResponseWriter, r *http.Request) {
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
	if aliasErr := refuseGitHubSourceWrite(r, "Syncing an issue"); aliasErr != nil {
		writeRouteError(w, r, aliasErr)
		return
	}
	svc, ok := h.Service.(*services.IssueService)
	if !ok {
		writeRouteError(w, r, api.Internal("issue sync unavailable"))
		return
	}
	number, err := parseInt64RouteParam(r, "number", "issue number required", "invalid issue number")
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	if r.Method == http.MethodGet {
		out, e := svc.GetIssueSync(r.Context(), actor, owner, repo, number)
		if e != nil {
			writeRouteError(w, r, e)
			return
		}
		api.WriteJSON(w, 200, out)
		return
	}
	var in services.IssueSyncInput
	if !decodeJSONBody(w, r, &in) {
		return
	}
	out, err := svc.PutIssueSync(r.Context(), actor, owner, repo, number, in)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	api.WriteJSON(w, 200, out)
}
func (h *IssueHandler) IssueSyncChannel(w http.ResponseWriter, r *http.Request) {
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
		writeRouteError(w, r, api.Internal("issue sync unavailable"))
		return
	}
	var in services.IssueSyncInput
	if !decodeJSONBody(w, r, &in) {
		return
	}
	if err = svc.ConfigureIssueSyncChannel(r.Context(), actor, owner, repo, in); err != nil {
		writeRouteError(w, r, err)
		return
	}
	api.WriteJSON(w, 200, in)
}

// IssueSyncChannels answers GET /issues/sync/channels: the actor's admitted channels for the repository.
func (h *IssueHandler) IssueSyncChannels(w http.ResponseWriter, r *http.Request) {
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
		writeRouteError(w, r, api.Internal("issue sync unavailable"))
		return
	}
	out, err := svc.ListIssueSyncChannels(r.Context(), actor, owner, repo)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	api.WriteJSON(w, 200, out)
}
func (h *IssueHandler) IssueSyncEvent(w http.ResponseWriter, r *http.Request) {
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
		writeRouteError(w, r, api.Internal("issue sync unavailable"))
		return
	}
	var in services.IssueSyncEvent
	if !decodeJSONBody(w, r, &in) {
		return
	}
	id, err := svc.IngestIssueSync(r.Context(), actor, owner, repo, in)
	var ignored services.IssueSyncIgnored
	if errors.As(err, &ignored) {
		api.WriteJSON(w, 200, map[string]any{"ignored": ignored.Reason})
		return
	}
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	api.WriteJSON(w, 200, map[string]any{"issue_id": id})
}
func (h *IssueHandler) IssueSyncDeliveries(w http.ResponseWriter, r *http.Request) {
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
		writeRouteError(w, r, api.Internal("issue sync unavailable"))
		return
	}
	after := int64(0)
	if value := r.URL.Query().Get("after_id"); value != "" {
		var e error
		after, e = strconv.ParseInt(value, 10, 64)
		if e != nil || after < 0 {
			writeRouteError(w, r, api.BadRequest("invalid after_id"))
			return
		}
	}
	out, err := svc.IssueSyncDeliveries(r.Context(), actor, owner, repo, after)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	api.WriteJSON(w, 200, out)
}
func (h *IssueHandler) IssueSyncReceipt(w http.ResponseWriter, r *http.Request) {
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
		writeRouteError(w, r, api.Internal("issue sync unavailable"))
		return
	}
	id, err := parseInt64RouteParam(r, "id", "delivery id required", "invalid delivery id")
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	if r.Method == http.MethodPost {
		out, e := svc.ClaimIssueSync(r.Context(), actor, owner, repo, id)
		if e != nil {
			writeRouteError(w, r, e)
			return
		}
		api.WriteJSON(w, 200, out)
		return
	}
	var in services.IssueSyncReceipt
	if !decodeJSONBody(w, r, &in) {
		return
	}
	if err = svc.CompleteIssueSync(r.Context(), actor, owner, repo, id, in); err != nil {
		writeRouteError(w, r, err)
		return
	}
	api.WriteJSON(w, 200, in)
}

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

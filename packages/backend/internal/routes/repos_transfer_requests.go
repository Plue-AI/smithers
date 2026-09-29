package routes

import (
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func (h *RepoHandler) ListRepoTransfers(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	requests, err := h.Service.ListRepoTransfers(r.Context(), user)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, requests)
}

func repoTransferActorAndID(r *http.Request) (*db.User, int64, error) {
	actor, err := requireRouteUser(r)
	if err != nil {
		return nil, 0, err
	}
	id, err := strconv.ParseInt(chi.URLParam(r, "transfer_id"), 10, 64)
	if err != nil || id <= 0 {
		return nil, 0, errors.BadRequest("invalid transfer id")
	}
	return actor, id, nil
}

func (h *RepoHandler) AcceptRepoTransfer(w http.ResponseWriter, r *http.Request) {
	actor, id, err := repoTransferActorAndID(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	repository, err := h.Service.AcceptRepoTransfer(r.Context(), actor, id)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	if h.AuditService != nil {
		h.AuditService.Log(r.Context(), services.AuditEvent{
			EventType: "repo.transfer", ActorID: &actor.ID, ActorName: actor.Username,
			TargetType: "repository", TargetID: &repository.ID,
			TargetName: actor.Username + "/" + repository.Name, Action: "transfer", IPAddress: r.RemoteAddr,
		})
	}
	errors.WriteJSON(w, http.StatusOK, mapRepoResponse(actor.Username, repository, h.SSHHost))
}

func (h *RepoHandler) DeclineRepoTransfer(w http.ResponseWriter, r *http.Request) {
	h.resolveRepoTransfer(w, r, false)
}

func (h *RepoHandler) CancelRepoTransfer(w http.ResponseWriter, r *http.Request) {
	h.resolveRepoTransfer(w, r, true)
}

func (h *RepoHandler) resolveRepoTransfer(w http.ResponseWriter, r *http.Request, cancel bool) {
	actor, id, err := repoTransferActorAndID(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	if cancel {
		err = h.Service.CancelRepoTransfer(r.Context(), actor, id)
	} else {
		err = h.Service.DeclineRepoTransfer(r.Context(), actor, id)
	}
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	if h.AuditService != nil {
		action := "transfer_declined"
		if cancel {
			action = "transfer_cancelled"
		}
		h.AuditService.Log(r.Context(), services.AuditEvent{
			EventType: "repo." + action, ActorID: &actor.ID, ActorName: actor.Username,
			TargetType: "repository_transfer", TargetID: &id, Action: action, IPAddress: r.RemoteAddr,
		})
	}
	w.WriteHeader(http.StatusNoContent)
}

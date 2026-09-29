package routes

import (
	"context"
	"encoding/json"
	"github.com/go-chi/chi/v5"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"io"
	"net/http"
	"strconv"
)

type workspaceVisibilityService interface {
	SetWorkspaceServicePublic(context.Context, string, int64, int64, uint16, bool) error
	WorkspaceServicePublic(context.Context, string, int64, int64, uint16) (bool, error)
}

func (h *WorkspaceHandler) WorkspaceServiceVisibility(w http.ResponseWriter, r *http.Request) {
	user, repo, id, e := workspaceFacetRouteContext(r)
	if e != nil {
		pkgerrors.WriteError(w, e)
		return
	}
	port, err := strconv.ParseUint(chi.URLParam(r, "port"), 10, 16)
	if err != nil || port == 0 {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid preview port"))
		return
	}
	s, ok := h.Service.(workspaceVisibilityService)
	if !ok {
		pkgerrors.WriteError(w, pkgerrors.Internal("workspace visibility unavailable"))
		return
	}
	var public bool
	if r.Method == http.MethodPut {
		var body struct {
			Public *bool `json:"public"`
		}
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&body); err != nil || body.Public == nil {
			pkgerrors.WriteError(w, pkgerrors.BadRequest("public boolean required"))
			return
		}
		if dec.Decode(new(any)) != io.EOF {
			pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid request body"))
			return
		}
		public = *body.Public
		err = s.SetWorkspaceServicePublic(r.Context(), id, repo.Repository.ID, user.ID, uint16(port), public)
	} else {
		public, err = s.WorkspaceServicePublic(r.Context(), id, repo.Repository.ID, user.ID, uint16(port))
	}
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	pkgerrors.WriteJSON(w, http.StatusOK, map[string]bool{"public": public})
}

package repohostserver

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
)

// Optional only for rolling upgrades/test doubles. Missing native capability
// fails closed; a generic 404 is never evidence that a source pin is absent.
type workspaceSourceFFI interface {
	ReadWorkspaceSource(string, string, repohost.WorkspaceSource) (repohost.WorkspaceSourceReceipt, error)
}

func (s *Server) readWorkspaceSource(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("ReadWorkspaceSource")
	defer done()
	path, err := s.repoPathFromID(chi.URLParam(r, "id"))
	if err != nil {
		return err
	}
	var req repohost.WorkspaceSourceRequest
	if err := decodeRequest(r, &req); err != nil {
		return err
	}
	if err := req.Source.Validate(); err != nil {
		return badRequest(err.Error())
	}
	if _, _, ok := repohost.WorkspaceSourceFromRef(repohost.WorkspaceSourceRef(req.WorkspaceID, req.Source.CommitID)); !ok {
		return badRequest("invalid workspace source identity")
	}
	ffi, ok := s.ffi.(workspaceSourceFFI)
	if !ok {
		return &appError{StatusCode: http.StatusServiceUnavailable, Code: "workspace_source_unavailable", Message: "native source verification unavailable"}
	}
	unlock, err := s.locks.RLock(r.Context(), path)
	if err != nil {
		return err
	}
	defer unlock()
	result, err := ffi.ReadWorkspaceSource(path, req.WorkspaceID, req.Source)
	if err != nil {
		if e, ok := err.(*repohostffi.Error); ok && e.Code == "workspace_source_missing" {
			return &appError{StatusCode: 404, Code: e.Code, Message: e.Message}
		}
		return err
	}
	return writeJSON(w, http.StatusOK, result)
}

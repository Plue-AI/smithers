package repohostserver

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type appendPreparationFFI interface {
	PrepareLandAppend(string, repohost.AppendPreparationRequest) (repohost.AppendPreparation, error)
}

func (s *Server) prepareLandAppend(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("PrepareLandAppend")
	defer done()
	path, err := s.repoPathFromID(chi.URLParam(r, "id"))
	if err != nil {
		return err
	}
	var req repohost.AppendPreparationRequest
	if err = decodeRequest(r, &req); err != nil {
		return err
	}
	if err = repohost.ValidateBookmarkName(req.TargetBookmark); err != nil {
		return badRequest("invalid append target bookmark")
	}
	ffi, ok := s.ffi.(appendPreparationFFI)
	if !ok {
		return &appError{StatusCode: 503, Code: "append_prepare_unavailable", Message: "native append preparation is unavailable"}
	}
	unlock, err := s.locks.RLock(r.Context(), path)
	if err != nil {
		return err
	}
	defer unlock()
	result, err := ffi.PrepareLandAppend(path, req)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, result)
}

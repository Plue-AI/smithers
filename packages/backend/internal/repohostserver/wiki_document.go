package repohostserver

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
)

func (s *Server) mergeWikiDocument(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("MergeWikiDocument")
	defer done()
	if _, _, err := parseRepoID(chi.URLParam(r, "id")); err != nil {
		return err
	}
	var request json.RawMessage
	if err := decodeRequest(r, &request); err != nil {
		return err
	}
	// Stateless merge: no repository mutation or lock. The API service uses a
	// revision-checked write after this returns, retrying a concurrent writer.
	result, err := s.ffi.WikiDocument(string(request))
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, result)
}

func (s *Server) projectWikiRevision(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("ProjectWikiRevision")
	defer done()
	owner, repo, err := parseRepoID(chi.URLParam(r, "id"))
	if err != nil {
		return err
	}
	var input json.RawMessage
	if err = decodeRequest(r, &input); err != nil {
		return err
	}
	path := s.config.WikiRepoPath(owner, repo)
	unlock, err := s.locks.LockAll(r.Context(), s.config.RepoPath(owner, repo), path)
	if err != nil {
		return err
	}
	defer unlock()
	defer s.markMaintenanceDue(path)
	if err = checkMutationDeadline(r.Context()); err != nil {
		return err
	}
	commit, err := s.ffi.ProjectWikiRevision(path, string(input))
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, wikiCommitResponse{CommitSHA: commit})
}

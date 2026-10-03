package repohostserver

import (
	"errors"
	"fmt"
	"net/http"
	"os/exec"

	"github.com/go-chi/chi/v5"
)

// Git has the event's new objects before jj imports the updated bookmarks.
// Use immutable IDs so concurrent pushes cannot change the graph being checked.
func (s *Server) commitAncestry(w http.ResponseWriter, r *http.Request) error {
	repoPath, err := s.repoPathFromID(chi.URLParam(r, "id"))
	if err != nil {
		return err
	}
	ancestor, descendant := r.URL.Query().Get("ancestor"), r.URL.Query().Get("descendant")
	if !validGitObjectID(ancestor) || !validGitObjectID(descendant) {
		return badRequest("ancestor and descendant must be full commit ids")
	}
	unlock, err := s.locks.RLock(r.Context(), repoPath)
	if err != nil {
		return err
	}
	defer unlock()
	err = exec.CommandContext(r.Context(), "git", "--git-dir", repoGitDir(repoPath), "merge-base", "--is-ancestor", ancestor, descendant).Run()
	isAncestor := err == nil
	if err != nil {
		var exit *exec.ExitError
		if !errors.As(err, &exit) || exit.ExitCode() != 1 {
			return fmt.Errorf("read commit ancestry: %w", err)
		}
	}
	return writeJSON(w, http.StatusOK, struct {
		IsAncestor bool `json:"is_ancestor"`
	}{isAncestor})
}

package repohostserver

import (
	"errors"
	"net/http"
	"os"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// deleteWorkspaceRefs answers DELETE /repos/{id}/workspace-refs/{workspace_id}
// (#1990): it deletes every ref under refs/smithers/workspaces/<id>/, the
// workspace's head and its retained sources, under the repository write lock.
// A deleted workspace's refs would otherwise pin their objects forever. It
// is idempotent; a repository that is gone has no refs left to delete.
func (s *Server) deleteWorkspaceRefs(w http.ResponseWriter, r *http.Request) error {
	owner, repo, err := parseRepoID(chi.URLParam(r, "id"))
	if err != nil {
		return err
	}
	workspaceID := chi.URLParam(r, "workspace_id")
	if parsed, err := uuid.Parse(workspaceID); err != nil || parsed.String() != workspaceID || parsed == uuid.Nil {
		return badRequest("invalid workspace id")
	}
	unlock, err := s.lockRepo(r.Context(), s.config.RepoPath(owner, repo))
	if err != nil {
		return err
	}
	defer unlock()
	result := repohost.DeletedWorkspaceRefs{Refs: []string{}}
	gitDir := s.config.GitBackendPath(owner, repo)
	if _, err := os.Stat(gitDir); errors.Is(err, os.ErrNotExist) {
		return writeJSON(w, http.StatusOK, result)
	} else if err != nil {
		return internalError("failed to open the repository", err)
	}
	prefix := repohost.WorkspaceHeadRefPrefix + workspaceID + "/"
	refs, err := listGitRefs(r.Context(), gitDir, strings.TrimSuffix(prefix, "/"))
	if err != nil {
		return internalError("failed to list workspace refs", err)
	}
	for ref, oid := range refs {
		if !strings.HasPrefix(ref, prefix) {
			continue
		}
		if err := deleteGitRef(r.Context(), gitDir, ref, oid); err != nil {
			return internalError("failed to delete workspace refs", err)
		}
		result.Refs = append(result.Refs, ref)
	}
	sort.Strings(result.Refs)
	return writeJSON(w, http.StatusOK, result)
}

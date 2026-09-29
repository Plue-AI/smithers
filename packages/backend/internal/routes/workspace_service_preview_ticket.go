package routes

import (
	"net/url"
	"strconv"

	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// Service URLs are stable API entrypoints. Only opening the entrypoint mints
// a ticket for the clicking viewer, so copying a URL cannot share a credential.
func setWorkspaceServicePreviewURL(service *services.WorkspaceManagedService, owner, repo, workspaceID, origin string) {
	if service.Port <= 0 || service.Port > 65535 {
		service.URL = ""
		return
	}
	service.URL = origin + "/api/repos/" + url.PathEscape(owner) + "/" + url.PathEscape(repo) + "/workspaces/" + url.PathEscape(workspaceID) + "/preview/" + strconv.Itoa(service.Port)
}

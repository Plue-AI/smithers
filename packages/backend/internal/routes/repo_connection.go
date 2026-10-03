package routes

import (
	"context"
	"net/http"
	"strings"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type RepoConnectionRouteService interface {
	ConnectRepo(ctx context.Context, userID int64, owner, repo, licenseSPDX string) (services.RepoConnection, error)
	DisconnectRepo(ctx context.Context, userID int64, owner, repo string) (bool, error)
	GetRepoConnectionStatus(ctx context.Context, userID int64, owner, repo string) (services.RepoConnectionStatus, error)
	GetGitHubAppStatus(ctx context.Context, userID int64, owner, repo string) (services.GitHubAppStatus, error)
}

type RepoConnectionRequest struct {
	LicenseSPDXID string `json:"license_spdx_id,omitempty"`
	Owner         string `json:"owner"`
	Repo          string `json:"repo"`
}

type RepoConnectionResponse struct {
	Connected   bool   `json:"connected"`
	LicenseSPDX string `json:"license_spdx_id,omitempty"`
	Owner       string `json:"owner,omitempty"`
	Repo        string `json:"repo,omitempty"`
}

type GitHubAppStatusResponse struct {
	GitHubAppInstalled bool `json:"github_app_installed"`
	// Always serialized (no omitempty): false is the signal the client renders
	// the honest "integration not configured on this deployment" state from.
	GitHubAppConfigured      bool   `json:"github_app_configured"`
	InstallationID           int64  `json:"installation_id,omitempty"`
	InstallURL               string `json:"install_url"`
	Owner                    string `json:"owner,omitempty"`
	Repo                     string `json:"repo,omitempty"`
	GitHubRateLimitLimit     int    `json:"github_rate_limit_limit,omitempty"`
	GitHubRateLimitRemaining int    `json:"github_rate_limit_remaining,omitempty"`
	GitHubRateLimitReset     string `json:"github_rate_limit_reset,omitempty"`
	ReconnectRequired        bool   `json:"reconnect_required,omitempty"`
}

func (h *RepoHandler) ConnectRepo(w http.ResponseWriter, r *http.Request) {
	actor, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	if h.RepoConnectionService == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("repo connection service not configured"))
		return
	}

	var req RepoConnectionRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	connection, svcErr := h.RepoConnectionService.ConnectRepo(
		r.Context(),
		actor.ID,
		req.Owner,
		req.Repo,
		req.LicenseSPDXID,
	)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusOK, RepoConnectionResponse{
		Connected:   true,
		LicenseSPDX: connection.LicenseSPDX,
		Owner:       connection.Owner,
		Repo:        connection.Repo,
	})
}

func (h *RepoHandler) DisconnectRepo(w http.ResponseWriter, r *http.Request) {
	actor, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	if h.RepoConnectionService == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("repo connection service not configured"))
		return
	}

	var req RepoConnectionRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	_, svcErr := h.RepoConnectionService.DisconnectRepo(
		r.Context(),
		actor.ID,
		req.Owner,
		req.Repo,
	)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusOK, RepoConnectionResponse{
		Connected: false,
		Owner:     strings.TrimSpace(req.Owner),
		Repo:      strings.TrimSpace(req.Repo),
	})
}

func (h *RepoHandler) RepoConnectionStatus(w http.ResponseWriter, r *http.Request) {
	actor, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	if h.RepoConnectionService == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("repo connection service not configured"))
		return
	}

	owner := strings.TrimSpace(r.URL.Query().Get("owner"))
	repo := strings.TrimSpace(r.URL.Query().Get("repo"))
	if owner == "" {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("owner is required"))
		return
	}
	if repo == "" {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository name is required"))
		return
	}

	status, svcErr := h.RepoConnectionService.GetRepoConnectionStatus(r.Context(), actor.ID, owner, repo)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusOK, RepoConnectionResponse{
		Connected:   status.Connected,
		LicenseSPDX: status.LicenseSPDX,
		Owner:       status.Owner,
		Repo:        status.Repo,
	})
}

func (h *RepoHandler) GitHubAppStatus(w http.ResponseWriter, r *http.Request) {
	actor, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	if h.RepoConnectionService == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("repo connection service not configured"))
		return
	}

	owner, repo, ownerRepoErr := repoOwnerAndName(r)
	if ownerRepoErr != nil {
		pkgerrors.WriteError(w, ownerRepoErr.(*pkgerrors.APIError))
		return
	}

	status, svcErr := h.RepoConnectionService.GetGitHubAppStatus(r.Context(), actor.ID, owner, repo)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusOK, GitHubAppStatusResponse{
		GitHubAppInstalled:       status.GitHubAppInstalled,
		GitHubAppConfigured:      status.GitHubAppConfigured,
		InstallationID:           status.InstallationID,
		InstallURL:               status.InstallURL,
		Owner:                    status.Owner,
		Repo:                     status.Repo,
		GitHubRateLimitLimit:     status.GitHubRateLimitLimit,
		GitHubRateLimitRemaining: status.GitHubRateLimitRemaining,
		GitHubRateLimitReset:     status.GitHubRateLimitReset,
		ReconnectRequired:        status.ReconnectRequired,
	})
}

var _ RepoConnectionRouteService = (*services.RepoConnectionService)(nil)

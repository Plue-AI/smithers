package routes

import (
	"context"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type GitHubUserReposRouteService interface {
	ListAuthenticatedUserGitHubRepos(ctx context.Context, userID int64, query url.Values) (services.GitHubRepoListResult, error)
	GetAuthenticatedUserGitHubRepo(ctx context.Context, userID int64, owner, repo string) (services.GitHubRepoMetadataResult, error)
	GetAuthenticatedUserGitHubPull(ctx context.Context, userID int64, owner, repo string, number int64) (services.GitHubRepoMetadataResult, error)
	ListAuthenticatedUserGitHubRepoMetadata(ctx context.Context, userID int64, owner, repo, resource string, query url.Values) (services.GitHubRepoMetadataResult, error)
	ListAuthenticatedUserGitHubIssueComments(ctx context.Context, userID int64, owner, repo string, number int64, query url.Values) (services.GitHubRepoMetadataResult, error)
	GetAuthenticatedUserGitHubPullDiff(ctx context.Context, userID int64, owner, repo string, number int64) (services.GitHubPullDiffResult, error)
	DiagnoseGitHubAccess(ctx context.Context, userID int64, owner, repo, surface string) (services.GitHubAccessDiagnosis, error)
}

type GitHubUserReposHandler struct {
	Service GitHubUserReposRouteService
}

func (h *GitHubUserReposHandler) ListGitHubUserRepos(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("github user repos service unavailable"))
		return
	}
	result, svcErr := h.Service.ListAuthenticatedUserGitHubRepos(r.Context(), user.ID, r.URL.Query())
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	if result.Link != "" {
		w.Header().Set("Link", result.Link)
	}
	// Staleness metadata for cache-served responses. Headers (not body fields)
	// so the JSON array shape multi's parser expects never changes.
	if result.CacheSyncedAt != nil {
		w.Header().Set("X-Repos-Synced-At", result.CacheSyncedAt.UTC().Format(time.RFC3339))
	}
	if result.CacheSyncError != "" {
		w.Header().Set("X-Repos-Sync-Error", result.CacheSyncError)
	}
	pkgerrors.WriteJSON(w, http.StatusOK, result.Repos)
}

func (h *GitHubUserReposHandler) ListGitHubRepoIssues(w http.ResponseWriter, r *http.Request) {
	h.listGitHubRepoMetadata(w, r, services.GitHubRepoMetadataIssues)
}

func (h *GitHubUserReposHandler) GetGitHubRepo(w http.ResponseWriter, r *http.Request) {
	// Defense in depth for direct handler use; production applies the same
	// policy before auth so middleware errors are also non-cacheable.
	w.Header().Set("Cache-Control", "private, no-store")
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("github repository metadata service unavailable"))
		return
	}
	result, svcErr := h.Service.GetAuthenticatedUserGitHubRepo(
		r.Context(), user.ID, chi.URLParam(r, "owner"), chi.URLParam(r, "repo"),
	)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	h.writeGitHubRepoMetadataResult(w, result)
}

func (h *GitHubUserReposHandler) ListGitHubRepoPulls(w http.ResponseWriter, r *http.Request) {
	h.listGitHubRepoMetadata(w, r, services.GitHubRepoMetadataPulls)
}

func (h *GitHubUserReposHandler) GetGitHubPull(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("github pull service unavailable"))
		return
	}
	number, err := strconv.ParseInt(chi.URLParam(r, "number"), 10, 64)
	if err != nil || number <= 0 {
		writeRouteError(w, r, pkgerrors.BadRequest("invalid github pull request number"))
		return
	}
	result, err := h.Service.GetAuthenticatedUserGitHubPull(r.Context(), user.ID, chi.URLParam(r, "owner"), chi.URLParam(r, "repo"), number)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	h.writeGitHubRepoMetadataResult(w, result)
}

func (h *GitHubUserReposHandler) listGitHubRepoMetadata(w http.ResponseWriter, r *http.Request, resource string) {
	// Defense in depth for direct handler use. Production routes also apply
	// PrivateNoStore before authentication so middleware-generated errors carry
	// the same cache policy.
	w.Header().Set("Cache-Control", "private, no-store")
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("github repository metadata service unavailable"))
		return
	}
	result, svcErr := h.Service.ListAuthenticatedUserGitHubRepoMetadata(
		r.Context(),
		user.ID,
		chi.URLParam(r, "owner"),
		chi.URLParam(r, "repo"),
		resource,
		r.URL.Query(),
	)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	if result.Link != "" {
		w.Header().Set("Link", result.Link)
	}
	h.writeGitHubRepoMetadataResult(w, result)
}

// GetGitHubAccessDiagnosis answers GET /user/github-access/{owner}/{repo}
// with a typed verdict on WHY a surface read fails (app-not-installed /
// permission-missing / no-org-grant / token-broken / ok), derived from the
// GitHub App's installation lookup — never guessed from proxied status codes.
// ?surface=issues|pulls selects the permission being checked (default issues).
func (h *GitHubUserReposHandler) GetGitHubAccessDiagnosis(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("github access diagnosis service unavailable"))
		return
	}
	surface := r.URL.Query().Get("surface")
	if surface == "" {
		surface = services.GitHubRepoMetadataIssues
	}
	diagnosis, svcErr := h.Service.DiagnoseGitHubAccess(
		r.Context(), user.ID, chi.URLParam(r, "owner"), chi.URLParam(r, "repo"), surface,
	)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, diagnosis)
}

// ListGitHubAppInstallations answers GET /user/github-app/installations and
// /user/github-app/installations/{installationId} with the caller's
// repositories the GitHub App verifiably covers, as
// {"repos":[{fullName,pushedAt,installationId}]}. The path id filters the
// result; it never grants access to another user's installation.
func (h *GitHubUserReposHandler) ListGitHubAppInstallations(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("github app installations service unavailable"))
		return
	}
	installationID := chi.URLParam(r, "installationId")
	if installationID != "" && !validInstallationID.MatchString(installationID) {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("Invalid installation id."))
		return
	}
	repos, verifyErr := services.VerifyGitHubAppInstallations(r.Context(), h.Service, user.ID, installationID)
	if verifyErr != nil {
		// Every verification error carries a message written for clients, so
		// a 5xx keeps its sentence; its cause still reaches the server log.
		if verifyErr.Status >= http.StatusInternalServerError {
			middleware.LoggerFromContext(r.Context()).Error("github app installation verification failed",
				"status", verifyErr.Status, "code", verifyErr.Code, "cause", verifyErr.Cause())
		}
		pkgerrors.WriteError(w, verifyErr)
		return
	}
	installURL := ""
	if source, ok := h.Service.(interface {
		GitHubAppInstallURL(context.Context) (string, error)
	}); ok {
		installURL, err = source.GitHubAppInstallURL(r.Context())
		if err != nil {
			writeRouteError(w, r, pkgerrors.Internal("failed to load github app install url").WithCause(err))
			return
		}
	}
	pkgerrors.WriteJSON(w, http.StatusOK, map[string]any{"repos": repos, "install_url": installURL})
}

var validInstallationID = regexp.MustCompile(`^[1-9][0-9]*$`)

// ListGitHubRepoIssueComments answers GET
// /user/github-repos/{owner}/{repo}/issues/{number}/comments from the synced
// comment store when the repo is enrolled (with the X-Metadata-* provenance
// headers), falling back to the live GitHub passthrough otherwise.
func (h *GitHubUserReposHandler) ListGitHubRepoIssueComments(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("github issue comments service unavailable"))
		return
	}
	number, numErr := strconv.ParseInt(chi.URLParam(r, "number"), 10, 64)
	if numErr != nil || number <= 0 {
		writeRouteError(w, r, pkgerrors.BadRequest("invalid github issue number"))
		return
	}
	result, svcErr := h.Service.ListAuthenticatedUserGitHubIssueComments(
		r.Context(),
		user.ID,
		chi.URLParam(r, "owner"),
		chi.URLParam(r, "repo"),
		number,
		r.URL.Query(),
	)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	if result.Link != "" {
		w.Header().Set("Link", result.Link)
	}
	h.writeGitHubRepoMetadataResult(w, result)
}

// GetGitHubPullDiff answers GET
// /user/github-repos/{owner}/{repo}/pulls/{number}/diff with the raw unified
// diff (text/plain), proxied live from GitHub's diff media type. Oversize
// diffs fail with the typed github_pull_diff_too_large verdict.
func (h *GitHubUserReposHandler) GetGitHubPullDiff(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("github pull diff service unavailable"))
		return
	}
	number, numErr := strconv.ParseInt(chi.URLParam(r, "number"), 10, 64)
	if numErr != nil || number <= 0 {
		writeRouteError(w, r, pkgerrors.BadRequest("invalid github pull request number"))
		return
	}
	result, svcErr := h.Service.GetAuthenticatedUserGitHubPullDiff(
		r.Context(),
		user.ID,
		chi.URLParam(r, "owner"),
		chi.URLParam(r, "repo"),
		number,
	)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(result.Body)
}

func (h *GitHubUserReposHandler) writeGitHubRepoMetadataResult(w http.ResponseWriter, result services.GitHubRepoMetadataResult) {
	// Honest provenance for the continuously-synced mirror: whether these bytes
	// came from the store or straight off GitHub, when the store was last
	// reconciled, whether it is currently stale, and the last sync failure (if
	// any). Headers — not body fields — so the JSON shape clients parse never
	// changes, matching X-Repos-Synced-At on the repo listing.
	if result.Source != "" {
		w.Header().Set("X-Metadata-Source", result.Source)
	}
	if result.SyncedAt != nil {
		w.Header().Set("X-Metadata-Synced-At", result.SyncedAt.UTC().Format(time.RFC3339))
	}
	if result.Stale {
		w.Header().Set("X-Metadata-Stale", "true")
	}
	if result.SyncError != "" {
		w.Header().Set("X-Metadata-Sync-Error", result.SyncError)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(result.Body)
}

package routes

import (
	"context"
	"encoding/json"
	stdErrors "errors"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// LinearRepoChecker verifies that a user has access to a repository.
type LinearRepoChecker interface {
	GetRepoByID(ctx context.Context, id int64) (db.Repository, error)
	GetUserByID(ctx context.Context, id int64) (db.User, error)
	GetOrgByID(ctx context.Context, id int64) (db.Organization, error)
	ListUserRepos(ctx context.Context, arg db.ListUserReposParams) ([]db.Repository, error)
	ListUserOrgs(ctx context.Context, arg db.ListUserOrgsParams) ([]db.Organization, error)
	ListOrgRepos(ctx context.Context, arg db.ListOrgReposParams) ([]db.Repository, error)
	IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)
}

type LinearIntegrationHandler struct {
	Service        *services.LinearIntegrationService
	Sync           LinearSyncRouteService
	SyncOperations LinearSyncOperationsRouteService
	AuthConfig     linearAuthConfig
	Repos          LinearRepoChecker
}

type LinearSyncRouteService interface {
	StartInitialSync(integration db.LinearIntegration) bool
	HandleLinearWebhook(ctx context.Context, body []byte, signature string) error
}

type LinearSyncOperationsRouteService interface {
	ListSyncOps(ctx context.Context, userID, integrationID int64, filter services.LinearSyncOpsFilter) (services.LinearSyncOpsPage, error)
	RetrySyncOp(ctx context.Context, userID, integrationID, opID int64) (services.LinearSyncOp, error)
	StartInitialSyncRun(ctx context.Context, userID, integrationID int64) (int64, error)
	GetInitialSyncRun(ctx context.Context, userID, integrationID, runID int64) (services.LinearSyncRunStatus, error)
}

type linearAuthConfig interface {
	GetCookieSecure() bool
}

type linearAuthConfigImpl struct {
	cookieSecure bool
}

func (c *linearAuthConfigImpl) GetCookieSecure() bool { return c.cookieSecure }

func NewLinearAuthConfig(cookieSecure bool) linearAuthConfig {
	return &linearAuthConfigImpl{cookieSecure: cookieSecure}
}

const linearRepoListPageSize = int32(100)

type linearRepositoryOption struct {
	ID          int64  `json:"id"`
	Owner       string `json:"owner"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

func (h *LinearIntegrationHandler) userCanAdminRepo(ctx context.Context, user *db.User, repo db.Repository) (bool, error) {
	if user == nil {
		return false, nil
	}
	if h.Repos == nil {
		return false, errors.Internal("repository access checker is not configured")
	}
	permission, apiErr := middleware.ResolveRepoPermission(ctx, h.Repos, repo, user)
	if apiErr != nil {
		return false, apiErr
	}
	return permission.Satisfies(middleware.PermissionAdmin), nil
}

func (h *LinearIntegrationHandler) listAllUserRepos(ctx context.Context, userID int64) ([]db.Repository, error) {
	repos := make([]db.Repository, 0)
	for offset := int32(0); ; offset += linearRepoListPageSize {
		page, err := h.Repos.ListUserRepos(ctx, db.ListUserReposParams{
			UserID:     pgtype.Int8{Int64: userID, Valid: true},
			PageOffset: offset,
			PageSize:   linearRepoListPageSize,
		})
		if err != nil {
			return nil, errors.Internal("failed to list user repositories").WithCause(err)
		}
		repos = append(repos, page...)
		if len(page) < int(linearRepoListPageSize) {
			return repos, nil
		}
	}
}

func (h *LinearIntegrationHandler) listAllUserOrgs(ctx context.Context, userID int64) ([]db.Organization, error) {
	orgs := make([]db.Organization, 0)
	for offset := int32(0); ; offset += linearRepoListPageSize {
		page, err := h.Repos.ListUserOrgs(ctx, db.ListUserOrgsParams{
			UserID:     userID,
			PageOffset: offset,
			PageSize:   linearRepoListPageSize,
		})
		if err != nil {
			return nil, errors.Internal("failed to list organizations").WithCause(err)
		}
		orgs = append(orgs, page...)
		if len(page) < int(linearRepoListPageSize) {
			return orgs, nil
		}
	}
}

func (h *LinearIntegrationHandler) listAllOrgRepos(ctx context.Context, orgID int64) ([]db.Repository, error) {
	repos := make([]db.Repository, 0)
	for offset := int32(0); ; offset += linearRepoListPageSize {
		page, err := h.Repos.ListOrgRepos(ctx, db.ListOrgReposParams{
			OrgID:      pgtype.Int8{Int64: orgID, Valid: true},
			PageOffset: offset,
			PageSize:   linearRepoListPageSize,
		})
		if err != nil {
			return nil, errors.Internal("failed to list organization repositories").WithCause(err)
		}
		repos = append(repos, page...)
		if len(page) < int(linearRepoListPageSize) {
			return repos, nil
		}
	}
}

func (h *LinearIntegrationHandler) ListLinearRepositoryOptions(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}
	if h.Repos == nil {
		errors.WriteError(w, errors.Internal("repository access checker is not configured"))
		return
	}

	options := make([]linearRepositoryOption, 0)
	seen := make(map[int64]struct{})

	userRepos, err := h.listAllUserRepos(r.Context(), user.ID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	for _, repo := range userRepos {
		if repo.IsArchived {
			continue
		}
		canAdmin, err := h.userCanAdminRepo(r.Context(), user, repo)
		if err != nil {
			writeRouteError(w, r, err)
			return
		}
		if !canAdmin {
			continue
		}
		options = append(options, linearRepositoryOption{
			ID:          repo.ID,
			Owner:       user.Username,
			Name:        repo.Name,
			Description: repo.Description,
		})
		seen[repo.ID] = struct{}{}
	}

	orgs, err := h.listAllUserOrgs(r.Context(), user.ID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	for _, org := range orgs {
		orgRepos, err := h.listAllOrgRepos(r.Context(), org.ID)
		if err != nil {
			writeRouteError(w, r, err)
			return
		}
		for _, repo := range orgRepos {
			if repo.IsArchived {
				continue
			}
			if _, ok := seen[repo.ID]; ok {
				continue
			}
			canAdmin, err := h.userCanAdminRepo(r.Context(), user, repo)
			if err != nil {
				writeRouteError(w, r, err)
				return
			}
			if !canAdmin {
				continue
			}
			options = append(options, linearRepositoryOption{
				ID:          repo.ID,
				Owner:       org.Name,
				Name:        repo.Name,
				Description: repo.Description,
			})
			seen[repo.ID] = struct{}{}
		}
	}

	sort.Slice(options, func(i, j int) bool {
		left := options[i].Owner + "/" + options[i].Name
		right := options[j].Owner + "/" + options[j].Name
		return left < right
	})

	errors.WriteJSON(w, http.StatusOK, options)
}

func (h *LinearIntegrationHandler) GetLinearOAuthStart(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}

	stateVerifier, err := randomHex(16)
	if err != nil {
		writeRouteError(w, r, errors.Internal("failed to generate oauth state").WithCause(err))
		return
	}

	redirectURL, err := h.Service.StartLinearOAuth(r.Context(), stateVerifier)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	secure := false
	if h.AuthConfig != nil {
		secure = h.AuthConfig.GetCookieSecure()
	}
	setLinearOAuthStateCookie(w, stateVerifier, secure)
	http.Redirect(w, r, redirectURL, http.StatusFound)
}

func (h *LinearIntegrationHandler) GetLinearOAuthCallback(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}

	code := r.URL.Query().Get("code")
	state := r.URL.Query().Get("state")
	if strings.TrimSpace(code) == "" || strings.TrimSpace(state) == "" {
		errors.WriteError(w, errors.BadRequest("code and state are required"))
		return
	}

	stateVerifier := linearOAuthStateFromRequest(r)
	result, err := h.Service.CompleteLinearOAuth(r.Context(), code, state, stateVerifier)

	secure := false
	if h.AuthConfig != nil {
		secure = h.AuthConfig.GetCookieSecure()
	}
	clearLinearOAuthStateCookie(w, secure)

	if err != nil {
		redirectLinearOAuthError(w, r, err)
		return
	}

	setupKey, err := h.Service.CreateOAuthSetup(r.Context(), user.ID, result)
	if err != nil {
		redirectLinearOAuthError(w, r, err)
		return
	}

	// Redirect back to the UI with an opaque, one-time setup handle.
	params := url.Values{}
	params.Set("setup", setupKey)
	http.Redirect(w, r, "/integrations/linear?"+params.Encode(), http.StatusFound)
}

// redirectLinearOAuthError sends the browser back to the integrations UI with a
// sanitized error message. API errors below 500 carry operator-safe text;
// anything else is logged server-side and replaced with a generic message so
// raw internal error strings never land in the URL bar or browser history.
func redirectLinearOAuthError(w http.ResponseWriter, r *http.Request, err error) {
	message := "linear oauth failed"
	var apiErr *errors.APIError
	if stdErrors.As(err, &apiErr) && apiErr.Status < http.StatusInternalServerError {
		message = apiErr.Message
	} else {
		middleware.LoggerFromContext(r.Context()).Error("linear oauth callback failed", "error", err)
	}
	http.Redirect(w, r, "/integrations/linear?error="+url.QueryEscape(message), http.StatusFound)
}

func (h *LinearIntegrationHandler) GetLinearOAuthSetup(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}

	setupKey := chi.URLParam(r, "setupKey")
	if strings.TrimSpace(setupKey) == "" {
		errors.WriteError(w, errors.BadRequest("setup key is required"))
		return
	}

	result, err := h.Service.GetOAuthSetup(r.Context(), user.ID, setupKey)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	errors.WriteJSON(w, http.StatusOK, result)
}

func (h *LinearIntegrationHandler) ListLinearIntegrations(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}

	integrations, err := h.Service.ListIntegrations(r.Context(), user.ID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	type integrationResponse struct {
		ID             int64                 `json:"id"`
		LinearTeamID   string                `json:"linear_team_id"`
		LinearTeamName string                `json:"linear_team_name"`
		LinearTeamKey  string                `json:"linear_team_key"`
		RepoOwner      string                `json:"repo_owner"`
		RepoName       string                `json:"repo_name"`
		RepoID         int64                 `json:"repo_id"`
		IsActive       bool                  `json:"is_active"`
		Remediation    string                `json:"remediation_state,omitempty"`
		LastSyncAt     any                   `json:"last_sync_at"`
		CreatedAt      string                `json:"created_at"`
		LinearActor    services.LinearViewer `json:"linear_actor"`
	}

	out := make([]integrationResponse, 0, len(integrations))
	for _, i := range integrations {
		var lastSync any
		if i.LastSyncAt.Valid {
			lastSync = i.LastSyncAt.Time
		}
		remediation := ""
		if !i.IsActive && i.WebhookSecret == "" {
			remediation = "webhook_secret_reconfigure_required"
		}
		out = append(out, integrationResponse{
			ID:             i.ID,
			LinearTeamID:   i.LinearTeamID,
			LinearTeamName: i.LinearTeamName,
			LinearTeamKey:  i.LinearTeamKey,
			RepoOwner:      i.JjhubRepoOwner,
			RepoName:       i.JjhubRepoName,
			RepoID:         i.JjhubRepoID,
			IsActive:       i.IsActive,
			Remediation:    remediation,
			LastSyncAt:     lastSync,
			CreatedAt:      i.CreatedAt.Format("2006-01-02T15:04:05Z"),
			LinearActor: services.LinearViewer{
				ID: i.LinearActorID, Name: i.LinearActorName, Email: i.LinearActorEmail,
			},
		})
	}

	errors.WriteJSON(w, http.StatusOK, out)
}

type configureLinearIntegrationRequest struct {
	LinearTeamID string `json:"linear_team_id"`
	SetupKey     string `json:"setup_key"`
	Repo         string `json:"repo"`
	// RepoID keeps the former /api/integrations/linear request compatible.
	RepoID int64 `json:"repo_id"`
}

func (h *LinearIntegrationHandler) ConfigureLinearIntegration(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}

	var req configureLinearIntegrationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errors.WriteError(w, errors.BadRequest("invalid request body"))
		return
	}

	integration, err := h.Service.ConfigureIntegrationFromOAuthSetup(r.Context(), user.ID, services.ConfigureLinearIntegrationFromSetupRequest{
		SetupKey:     req.SetupKey,
		LinearTeamID: req.LinearTeamID,
		Repo:         req.Repo,
		RepoID:       req.RepoID,
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	errors.WriteJSON(w, http.StatusCreated, map[string]any{
		"id":               integration.ID,
		"linear_team_id":   integration.LinearTeamID,
		"linear_team_name": integration.LinearTeamName,
		"repo_owner":       integration.JjhubRepoOwner,
		"repo_name":        integration.JjhubRepoName,
		"is_active":        integration.IsActive,
		"linear_actor": services.LinearViewer{
			ID: integration.LinearActorID, Name: integration.LinearActorName, Email: integration.LinearActorEmail,
		},
	})
}

func (h *LinearIntegrationHandler) DeleteLinearIntegration(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}

	idStr := chi.URLParam(r, "id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		errors.WriteError(w, errors.BadRequest("invalid integration id"))
		return
	}

	if err := h.Service.DeleteIntegration(r.Context(), user.ID, id); err != nil {
		writeRouteError(w, r, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (h *LinearIntegrationHandler) TriggerInitialSync(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}

	idStr := chi.URLParam(r, "id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		errors.WriteError(w, errors.BadRequest("invalid integration id"))
		return
	}

	// Verify ownership
	integration, err := h.Service.GetIntegration(r.Context(), user.ID, id)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	// The sync service runs the initial sync in a bounded background context
	// and dedupes per integration, so repeated requests cannot stack
	// concurrent syncs.
	if !h.Sync.StartInitialSync(integration) {
		errors.WriteJSON(w, http.StatusConflict, map[string]string{"status": "sync_already_running"})
		return
	}

	errors.WriteJSON(w, http.StatusAccepted, map[string]string{"status": "sync_started"})
}

func linearPathID(r *http.Request, name, label string) (int64, *errors.APIError) {
	id, err := strconv.ParseInt(chi.URLParam(r, name), 10, 64)
	if err != nil || id <= 0 {
		return 0, errors.BadRequest("invalid " + label)
	}
	return id, nil
}

func (h *LinearIntegrationHandler) ListLinearSyncOps(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}
	if h.SyncOperations == nil {
		errors.WriteError(w, errors.Internal("linear sync operations unavailable"))
		return
	}
	integrationID, err := linearPathID(r, "id", "integration id")
	if err != nil {
		errors.WriteError(w, err)
		return
	}

	status := strings.TrimSpace(r.URL.Query().Get("status"))
	if status != "" && status != "pending" && status != "success" && status != "failed" && status != "skipped" {
		errors.WriteError(w, errors.BadRequest("invalid sync operation status"))
		return
	}
	_, limit, paginationErr := parsePaginationWithLimits(r, 50, 100, "invalid limit value", true)
	if paginationErr != nil {
		errors.WriteError(w, paginationErr.(*errors.APIError))
		return
	}
	var since *time.Time
	if rawSince := strings.TrimSpace(r.URL.Query().Get("since")); rawSince != "" {
		parsed, parseErr := time.Parse(time.RFC3339, rawSince)
		if parseErr != nil {
			errors.WriteError(w, errors.BadRequest("since must be an RFC3339 timestamp"))
			return
		}
		since = &parsed
	}

	page, svcErr := h.SyncOperations.ListSyncOps(r.Context(), user.ID, integrationID, services.LinearSyncOpsFilter{
		Status: status, Since: since, Cursor: strings.TrimSpace(r.URL.Query().Get("cursor")), Limit: int32(limit),
	})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	setCursorPaginationHeaders(w, r, limit, page.NextCursor)
	errors.WriteJSON(w, http.StatusOK, page.Ops)
}

func (h *LinearIntegrationHandler) RetryLinearSyncOp(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}
	if h.SyncOperations == nil {
		errors.WriteError(w, errors.Internal("linear sync operations unavailable"))
		return
	}
	integrationID, err := linearPathID(r, "id", "integration id")
	if err != nil {
		errors.WriteError(w, err)
		return
	}
	opID, err := linearPathID(r, "opId", "sync operation id")
	if err != nil {
		errors.WriteError(w, err)
		return
	}
	op, svcErr := h.SyncOperations.RetrySyncOp(r.Context(), user.ID, integrationID, opID)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	errors.WriteJSON(w, http.StatusAccepted, op)
}

func (h *LinearIntegrationHandler) StartLinearSyncRun(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}
	if h.SyncOperations == nil {
		errors.WriteError(w, errors.Internal("linear sync operations unavailable"))
		return
	}
	integrationID, err := linearPathID(r, "id", "integration id")
	if err != nil {
		errors.WriteError(w, err)
		return
	}
	runID, svcErr := h.SyncOperations.StartInitialSyncRun(r.Context(), user.ID, integrationID)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	errors.WriteJSON(w, http.StatusAccepted, map[string]int64{"run_id": runID})
}

func (h *LinearIntegrationHandler) GetLinearSyncRun(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}
	if h.SyncOperations == nil {
		errors.WriteError(w, errors.Internal("linear sync operations unavailable"))
		return
	}
	integrationID, err := linearPathID(r, "id", "integration id")
	if err != nil {
		errors.WriteError(w, err)
		return
	}
	runID, err := linearPathID(r, "runId", "sync run id")
	if err != nil {
		errors.WriteError(w, err)
		return
	}
	run, svcErr := h.SyncOperations.GetInitialSyncRun(r.Context(), user.ID, integrationID, runID)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	errors.WriteJSON(w, http.StatusOK, run)
}

func (h *LinearIntegrationHandler) PostLinearWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20)) // 1MB limit
	if err != nil {
		errors.WriteError(w, errors.BadRequest("failed to read request body"))
		return
	}

	signature := r.Header.Get("Linear-Signature")

	if err := h.Sync.HandleLinearWebhook(r.Context(), body, signature); err != nil {
		writeRouteError(w, r, err)
		return
	}

	w.WriteHeader(http.StatusOK)
}

const linearOAuthStateCookieName = "smithers_linear_oauth_state"

func setLinearOAuthStateCookie(w http.ResponseWriter, stateVerifier string, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     linearOAuthStateCookieName,
		Value:    stateVerifier,
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   600, // 10 minutes
	})
}

func clearLinearOAuthStateCookie(w http.ResponseWriter, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     linearOAuthStateCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
}

func linearOAuthStateFromRequest(r *http.Request) string {
	cookie, err := r.Cookie(linearOAuthStateCookieName)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(cookie.Value)
}

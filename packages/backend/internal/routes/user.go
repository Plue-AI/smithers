package routes

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type UserTokenService interface {
	ListTokens(ctx context.Context, userID int64) ([]services.TokenSummary, error)
	CreateToken(ctx context.Context, userID int64, req services.CreateTokenRequest) (services.CreateTokenResult, error)
	DeleteToken(ctx context.Context, userID, tokenID int64) error
}

type UserProfileService interface {
	GetAuthenticatedUser(ctx context.Context, userID int64) (services.UserProfile, error)
	GetUserByUsername(ctx context.Context, username string) (services.PublicUserProfile, error)
	UpdateAuthenticatedUser(ctx context.Context, userID int64, req services.UpdateUserRequest) (services.UserProfile, error)
	ListAuthenticatedUserRepos(ctx context.Context, userID int64, page, perPage int) (services.RepoListResult, error)
	ListReadableReposForAuthenticatedUser(ctx context.Context, userID int64, page, perPage int) (services.ReadableRepoListResult, error)
	ListAuthenticatedUserOrgs(ctx context.Context, userID int64, page, perPage int) (services.OrgListResult, error)
	ListUserReposByUsername(ctx context.Context, username string, page, perPage int) (services.RepoListResult, error)
	ListUserActivityByUsername(ctx context.Context, username string, page, perPage int) (services.ActivityListResult, error)
	GetNotificationPreferences(ctx context.Context, userID int64) (services.NotificationPreferences, error)
	UpdateNotificationPreferences(ctx context.Context, userID int64, req services.UpdateNotificationPreferencesRequest) (services.NotificationPreferences, error)
	ListConnectedAccounts(ctx context.Context, userID int64) ([]services.ConnectedAccountResponse, error)
	DeleteConnectedAccount(ctx context.Context, userID, accountID int64) error
}

type UserSessionService interface {
	ListUserSessions(ctx context.Context, userID int64) ([]db.AuthSession, error)
	RevokeUserSession(ctx context.Context, userID int64, sessionKey string) error
}

type UserEmailService interface {
	ListEmails(ctx context.Context, userID int64) ([]services.EmailResponse, error)
	AddEmail(ctx context.Context, userID int64, req services.AddEmailRequest) (services.EmailResponse, error)
	DeleteEmail(ctx context.Context, userID, emailID int64) error
	RequestVerification(ctx context.Context, userID, emailID int64) error
	VerifyEmail(ctx context.Context, rawToken string) (services.VerifyEmailResult, error)
}

type UserHandler struct {
	TokenService   UserTokenService
	ProfileService UserProfileService
	SessionService UserSessionService
	EmailService   UserEmailService
	DeviceService  UserDeviceRouteService
	AuditService   *services.AuditService
	// SignupProfiles stores the signup account claim and poll answers.
	SignupProfiles UserSignupProfileService
}

type patchUserRequest struct {
	DisplayName *string `json:"display_name"`
	Bio         *string `json:"bio"`
	AvatarURL   *string `json:"avatar_url"`
	Email       *string `json:"email"`
}

type userSessionResponse struct {
	ID        string    `json:"id"`
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt time.Time `json:"expires_at"`
}

func (h *UserHandler) GetUserTokens(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}

	tokens, err := h.TokenService.ListTokens(r.Context(), user.ID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	errors.WriteJSON(w, http.StatusOK, tokens)
}

func (h *UserHandler) PostUserToken(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}

	var req services.CreateTokenRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	// Scope de-escalation: a token may only mint a token whose scopes are a subset
	// of its own. Without this a leaked low-privilege PAT (e.g. write:user) could
	// escalate itself into a broadly-scoped token. Session-authenticated requests
	// carry the user's full authority and are not constrained here.
	if authInfo := middleware.AuthInfoFromContext(r.Context()); authInfo != nil && authInfo.IsTokenAuth {
		for _, raw := range req.Scopes {
			scope := middleware.NormalizeTokenScope(raw)
			if scope == "" {
				continue
			}
			if !authInfo.Scopes.Has(scope) {
				errors.WriteError(w, errors.Forbidden("a token cannot create a token with scopes it does not hold"))
				return
			}
		}
	}

	result, err := h.TokenService.CreateToken(r.Context(), user.ID, req)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	if h.AuditService != nil {
		h.AuditService.Log(r.Context(), services.AuditEvent{
			EventType:  "token.create",
			ActorID:    &user.ID,
			ActorName:  user.Username,
			TargetType: "access_token",
			TargetID:   &result.ID,
			TargetName: result.Name,
			Action:     "create",
			IPAddress:  r.RemoteAddr,
		})
	}

	errors.WriteJSON(w, http.StatusCreated, result)
}

func (h *UserHandler) DeleteUserToken(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}

	tokenID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || tokenID <= 0 {
		errors.WriteError(w, errors.BadRequest("invalid token id"))
		return
	}

	if err := h.TokenService.DeleteToken(r.Context(), user.ID, tokenID); err != nil {
		writeRouteError(w, r, err)
		return
	}

	if h.AuditService != nil {
		h.AuditService.Log(r.Context(), services.AuditEvent{
			EventType:  "token.delete",
			ActorID:    &user.ID,
			ActorName:  user.Username,
			TargetType: "access_token",
			TargetID:   &tokenID,
			TargetName: fmt.Sprintf("token_%d", tokenID),
			Action:     "delete",
			IPAddress:  r.RemoteAddr,
		})
	}

	w.WriteHeader(http.StatusNoContent)
}

func (h *UserHandler) GetUserSessions(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}

	sessions, err := h.SessionService.ListUserSessions(r.Context(), user.ID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	result := make([]userSessionResponse, 0, len(sessions))
	for _, session := range sessions {
		result = append(result, userSessionResponse{
			ID:        services.SessionPublicID(session.SessionKey),
			CreatedAt: session.CreatedAt,
			ExpiresAt: session.ExpiresAt,
		})
	}

	errors.WriteJSON(w, http.StatusOK, result)
}

func (h *UserHandler) DeleteUserSession(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}

	sessionID := strings.TrimSpace(chi.URLParam(r, "id"))
	if sessionID == "" {
		errors.WriteError(w, errors.BadRequest("invalid session id"))
		return
	}

	if err := h.SessionService.RevokeUserSession(r.Context(), user.ID, sessionID); err != nil {
		writeRouteError(w, r, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (h *UserHandler) GetAuthenticatedUser(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}

	profile, err := h.ProfileService.GetAuthenticatedUser(r.Context(), user.ID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	if authInfo := middleware.AuthInfoFromContext(r.Context()); authInfo != nil && authInfo.IsTokenAuth {
		scopes := make([]string, 0, len(authInfo.Scopes))
		for scope := range authInfo.Scopes {
			scopes = append(scopes, string(scope))
		}
		sort.Strings(scopes)
		errors.WriteJSON(w, http.StatusOK, struct {
			services.UserProfile
			TokenScopes []string `json:"token_scopes"`
			TokenSource string   `json:"token_source"`
		}{profile, scopes, string(authInfo.TokenSource)})
		return
	}

	errors.WriteJSON(w, http.StatusOK, profile)
}

func (h *UserHandler) GetUserByUsername(w http.ResponseWriter, r *http.Request) {
	username := chi.URLParam(r, "username")
	profile, err := h.ProfileService.GetUserByUsername(r.Context(), username)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	errors.WriteJSON(w, http.StatusOK, profile)
}

func (h *UserHandler) GetUserReposByUsername(w http.ResponseWriter, r *http.Request) {
	username := chi.URLParam(r, "username")

	cursor, limit, err := parseUserPagination(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	page := cursorToPage(cursor, limit)
	perPage := limit

	result, svcErr := h.ProfileService.ListUserReposByUsername(r.Context(), username, page, perPage)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	setPaginationHeaders(w, r, cursor, limit, len(result.Items), result.TotalCount)
	errors.WriteJSON(w, http.StatusOK, result.Items)
}

func (h *UserHandler) GetUserActivityByUsername(w http.ResponseWriter, r *http.Request) {
	username := chi.URLParam(r, "username")

	cursor, limit, err := parseUserPagination(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	page := cursorToPage(cursor, limit)
	perPage := limit

	result, svcErr := h.ProfileService.ListUserActivityByUsername(r.Context(), username, page, perPage)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	setPaginationHeaders(w, r, cursor, limit, len(result.Items), result.TotalCount)
	errors.WriteJSON(w, http.StatusOK, result.Items)
}

func (h *UserHandler) PatchAuthenticatedUser(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}

	var req patchUserRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	updated, err := h.ProfileService.UpdateAuthenticatedUser(r.Context(), user.ID, services.UpdateUserRequest{
		DisplayName: req.DisplayName,
		Bio:         req.Bio,
		AvatarURL:   req.AvatarURL,
		Email:       req.Email,
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	errors.WriteJSON(w, http.StatusOK, updated)
}

func (h *UserHandler) GetAuthenticatedUserRepos(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}

	cursor, limit, err := parseUserPagination(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	page := cursorToPage(cursor, limit)
	perPage := limit

	result, svcErr := h.ProfileService.ListAuthenticatedUserRepos(r.Context(), user.ID, page, perPage)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	setPaginationHeaders(w, r, cursor, limit, len(result.Items), result.TotalCount)
	errors.WriteJSON(w, http.StatusOK, result.Items)
}

// GetAuthenticatedUserReadableRepos handles GET /api/user/readable-repos
// (ticket 0135). Returns every repo the current user can read as minimal
// {id, owner, name} rows to populate the client's workspace switcher.
// Auth: RequireAuth + RequireScope(ScopeReadRepository)
// at the route-registration layer.
func (h *UserHandler) GetAuthenticatedUserReadableRepos(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}

	cursor, limit, err := parseReadableReposPagination(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	page := cursorToPage(cursor, limit)

	result, svcErr := h.ProfileService.ListReadableReposForAuthenticatedUser(r.Context(), user.ID, page, limit)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	setPaginationHeaders(w, r, cursor, limit, len(result.Items), result.TotalCount)
	errors.WriteJSON(w, http.StatusOK, result.Items)
}

func parseReadableReposPagination(r *http.Request) (string, int, error) {
	cursor := strings.TrimSpace(r.URL.Query().Get("cursor"))
	limit := services.UserDefaultPerPage
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 {
			return "", 0, errors.BadRequest("invalid limit")
		}
		if parsed > services.MaxReadableReposPerPage {
			parsed = services.MaxReadableReposPerPage
		}
		limit = parsed
	}
	return cursor, limit, nil
}

func (h *UserHandler) GetAuthenticatedUserOrgs(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}

	cursor, limit, err := parseUserPagination(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	page := cursorToPage(cursor, limit)
	perPage := limit

	result, svcErr := h.ProfileService.ListAuthenticatedUserOrgs(r.Context(), user.ID, page, perPage)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	setPaginationHeaders(w, r, cursor, limit, len(result.Items), result.TotalCount)
	errors.WriteJSON(w, http.StatusOK, result.Items)
}

// --- Email handlers ---

func (h *UserHandler) GetUserEmails(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}

	emails, err := h.EmailService.ListEmails(r.Context(), user.ID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	errors.WriteJSON(w, http.StatusOK, emails)
}

func (h *UserHandler) PostUserEmail(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}

	var req services.AddEmailRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	email, err := h.EmailService.AddEmail(r.Context(), user.ID, req)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	errors.WriteJSON(w, http.StatusCreated, email)
}

func (h *UserHandler) DeleteUserEmail(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}

	emailID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || emailID <= 0 {
		errors.WriteError(w, errors.BadRequest("invalid email id"))
		return
	}

	if err := h.EmailService.DeleteEmail(r.Context(), user.ID, emailID); err != nil {
		writeRouteError(w, r, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (h *UserHandler) PostUserEmailVerify(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}

	emailID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || emailID <= 0 {
		errors.WriteError(w, errors.BadRequest("invalid email id"))
		return
	}

	if err := h.EmailService.RequestVerification(r.Context(), user.ID, emailID); err != nil {
		writeRouteError(w, r, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// GetUserEmailVerifyToken handles GET /api/user/emails/verify-token?token=...
// This is the endpoint linked from verification emails. It accepts the token
// as a query parameter so users can verify by clicking the link directly.
func (h *UserHandler) GetUserEmailVerifyToken(w http.ResponseWriter, r *http.Request) {
	rawToken := strings.TrimSpace(r.URL.Query().Get("token"))
	if rawToken == "" {
		errors.WriteError(w, errors.BadRequest("token is required"))
		return
	}

	result, err := h.EmailService.VerifyEmail(r.Context(), rawToken)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	if h.AuditService != nil {
		h.AuditService.Log(r.Context(), services.AuditEvent{
			EventType:  "user.email.verified",
			ActorID:    &result.UserID,
			TargetType: "email",
			TargetName: result.Email,
			Action:     "verify",
			IPAddress:  r.RemoteAddr,
			Metadata:   map[string]any{"email": result.Email},
		})
	}

	errors.WriteJSON(w, http.StatusOK, map[string]string{"email": result.Email})
}

// PostUserEmailVerifyToken handles POST /api/user/emails/verify-token with token in JSON body.
// Kept for API clients that POST the token programmatically.
func (h *UserHandler) PostUserEmailVerifyToken(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Token string `json:"token"`
	}
	if !decodeJSONBody(w, r, &req) {
		return
	}

	if req.Token == "" {
		errors.WriteError(w, errors.BadRequest("token is required"))
		return
	}

	result, err := h.EmailService.VerifyEmail(r.Context(), req.Token)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	if h.AuditService != nil {
		h.AuditService.Log(r.Context(), services.AuditEvent{
			EventType:  "user.email.verified",
			ActorID:    &result.UserID,
			TargetType: "email",
			TargetName: result.Email,
			Action:     "verify",
			IPAddress:  r.RemoteAddr,
			Metadata:   map[string]any{"email": result.Email},
		})
	}

	w.WriteHeader(http.StatusNoContent)
}

// --- Notification preferences handlers ---

func (h *UserHandler) GetNotificationPreferences(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}

	prefs, err := h.ProfileService.GetNotificationPreferences(r.Context(), user.ID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	errors.WriteJSON(w, http.StatusOK, prefs)
}

func (h *UserHandler) PutNotificationPreferences(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}

	var req services.UpdateNotificationPreferencesRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	prefs, err := h.ProfileService.UpdateNotificationPreferences(r.Context(), user.ID, req)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	errors.WriteJSON(w, http.StatusOK, prefs)
}

// --- Connected accounts handlers ---

func (h *UserHandler) GetConnectedAccounts(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}

	accounts, err := h.ProfileService.ListConnectedAccounts(r.Context(), user.ID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	errors.WriteJSON(w, http.StatusOK, accounts)
}

func (h *UserHandler) DeleteConnectedAccount(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}

	accountID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || accountID <= 0 {
		errors.WriteError(w, errors.BadRequest("invalid account id"))
		return
	}

	if err := h.ProfileService.DeleteConnectedAccount(r.Context(), user.ID, accountID); err != nil {
		writeRouteError(w, r, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// --- Avatar upload handler ---

// --- Pagination helpers ---

func parseUserPagination(r *http.Request) (string, int, error) {
	return parseOffsetPaginationWithLimits(r, services.UserDefaultPerPage, services.UserMaxPerPage, "invalid limit", true)
}

func writeUserPaginationHeaders(w http.ResponseWriter, r *http.Request, limit int, nextCursor string) {
	links := []string{
		fmt.Sprintf("<%s>; rel=\"first\"", userPaginationURL(r, limit, "")),
	}
	if nextCursor != "" {
		links = append(links,
			fmt.Sprintf("<%s>; rel=\"next\"", userPaginationURL(r, limit, nextCursor)),
		)
	}
	w.Header().Set("Link", strings.Join(links, ", "))
}

func userPaginationURL(r *http.Request, limit int, cursor string) string {
	query := r.URL.Query()
	query.Del("cursor")
	query.Del("limit")
	query.Set("limit", strconv.Itoa(limit))
	if cursor != "" {
		query.Set("cursor", cursor)
	}

	return r.URL.Path + "?" + mustUserPaginationQuery(query.Encode())
}

func mustUserPaginationQuery(encoded string) string {
	if encoded == "" {
		panic("user pagination query must include limit")
	}
	return encoded
}

package services

import (
	"context"
	stdErrors "errors"
	"math"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const (
	UserDefaultPage    = 1
	UserDefaultPerPage = 30
	UserMaxPerPage     = 100
)

type UserQuerier interface {
	RepoPermQuerier
	GetUserByID(ctx context.Context, id int64) (db.User, error)
	GetUserByLowerUsername(ctx context.Context, lowerUsername string) (db.User, error)
	GetOrgByID(ctx context.Context, id int64) (db.Organization, error)
	UpdateUser(ctx context.Context, arg db.UpdateUserParams) (db.User, error)
	ListUserRepos(ctx context.Context, arg db.ListUserReposParams) ([]db.Repository, error)
	ListDefaultBookmarkHeadsByRepoIDs(ctx context.Context, repositoryIDs []int64) ([]db.ListDefaultBookmarkHeadsByRepoIDsRow, error)
	CountUserRepos(ctx context.Context, userID pgtype.Int8) (int64, error)
	ListReadableReposForUser(ctx context.Context, arg db.ListReadableReposForUserParams) ([]db.ListReadableReposForUserRow, error)
	CountReadableReposForUser(ctx context.Context, userID int64) (int64, error)
	ListPublicUserRepos(ctx context.Context, arg db.ListPublicUserReposParams) ([]db.Repository, error)
	CountPublicUserRepos(ctx context.Context, userID pgtype.Int8) (int64, error)
	ListUserOrgs(ctx context.Context, arg db.ListUserOrgsParams) ([]db.Organization, error)
	CountUserOrgs(ctx context.Context, userID int64) (int64, error)
	ListUserStarredRepos(ctx context.Context, arg db.ListUserStarredReposParams) ([]db.Repository, error)
	CountUserStarredRepos(ctx context.Context, userID int64) (int64, error)
	ListPublicUserStarredRepos(ctx context.Context, arg db.ListPublicUserStarredReposParams) ([]db.Repository, error)
	CountPublicUserStarredRepos(ctx context.Context, userID int64) (int64, error)
	ListPublicAuditLogsByActor(ctx context.Context, arg db.ListPublicAuditLogsByActorParams) ([]db.AuditLog, error)
	CountPublicAuditLogsByActor(ctx context.Context, arg db.CountPublicAuditLogsByActorParams) (int64, error)
	GetUserNotificationPreferences(ctx context.Context, id int64) (db.GetUserNotificationPreferencesRow, error)
	UpdateUserNotificationPreferences(ctx context.Context, arg db.UpdateUserNotificationPreferencesParams) (db.User, error)
	ListUserOAuthAccounts(ctx context.Context, userID int64) ([]db.OauthAccount, error)
	DeleteOAuthAccount(ctx context.Context, arg db.DeleteOAuthAccountParams) error
	DeleteGitHubSyncedRepoReadGrantsForUser(ctx context.Context, userID int64) error
}

type UserProfileService interface {
	GetAuthenticatedUser(ctx context.Context, userID int64) (UserProfile, error)
	GetUserByUsername(ctx context.Context, username string) (PublicUserProfile, error)
	UpdateAuthenticatedUser(ctx context.Context, userID int64, req UpdateUserRequest) (UserProfile, error)
	ListAuthenticatedUserRepos(ctx context.Context, userID int64, page, perPage int) (RepoListResult, error)
	ListAuthenticatedUserOrgs(ctx context.Context, userID int64, page, perPage int) (OrgListResult, error)

	ListUserReposByUsername(ctx context.Context, username string, page, perPage int) (RepoListResult, error)
	GetNotificationPreferences(ctx context.Context, userID int64) (NotificationPreferences, error)
	UpdateNotificationPreferences(ctx context.Context, userID int64, req UpdateNotificationPreferencesRequest) (NotificationPreferences, error)
	ListConnectedAccounts(ctx context.Context, userID int64) ([]ConnectedAccountResponse, error)
	DeleteConnectedAccount(ctx context.Context, userID, accountID int64) error
	ListUserActivityByUsername(ctx context.Context, username string, page, perPage int) (ActivityListResult, error)
}

type UserService struct {
	queries         UserQuerier
	install         *installAccountMutationStore
	installAdmitted bool
}

type UpdateUserRequest struct {
	DisplayName *string `json:"display_name,omitempty"`
	Bio         *string `json:"bio,omitempty"`
	AvatarURL   *string `json:"avatar_url,omitempty"`
	Email       *string `json:"email,omitempty"`
}

type UserProfile struct {
	ID          int64     `json:"id"`
	Username    string    `json:"username"`
	DisplayName string    `json:"display_name"`
	Email       string    `json:"email"`
	Bio         string    `json:"bio"`
	AvatarURL   string    `json:"avatar_url"`
	IsAdmin     bool      `json:"is_admin"`
	Suspended   bool      `json:"suspended"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// PublicUserProfile contains only fields safe to expose to any viewer.
// Sensitive fields (email, is_admin, wallet_address, etc.) are excluded.
type PublicUserProfile struct {
	ID          int64     `json:"id"`
	Username    string    `json:"username"`
	DisplayName string    `json:"display_name"`
	Bio         string    `json:"bio"`
	AvatarURL   string    `json:"avatar_url"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type RepoSummary struct {
	ID                  int64               `json:"id"`
	Owner               string              `json:"owner"`
	OwnerType           string              `json:"owner_type"`
	FullName            string              `json:"full_name"`
	Name                string              `json:"name"`
	Description         string              `json:"description"`
	IsPublic            bool                `json:"is_public"`
	NumStars            int64               `json:"num_stars"`
	DefaultBookmark     string              `json:"default_bookmark"`
	DefaultBookmarkHead DefaultBookmarkHead `json:"default_bookmark_head"`
	CreatedAt           time.Time           `json:"created_at"`
	UpdatedAt           time.Time           `json:"updated_at"`
}

type DefaultBookmarkHead struct {
	ChangeID string `json:"change_id"`
	CommitID string `json:"commit_id"`
}

type OrgSummary struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Visibility  string `json:"visibility"`
	Website     string `json:"website"`
	Location    string `json:"location"`
}

type RepoListResult struct {
	Items      []RepoSummary `json:"items"`
	TotalCount int64         `json:"total_count"`
	Page       int           `json:"page"`
	PerPage    int           `json:"per_page"`
}

// ReadableRepoRow is the minimal {id, owner, name} shape returned by
// GET /api/user/readable-repos (ticket 0135). This is intentionally thin:
// the switcher uses it solely to populate the workspaces realtime stream's
// repository_id filter, not to render repo cards.
type ReadableRepoRow struct {
	ID    int64  `json:"id"`
	Owner string `json:"owner"`
	Name  string `json:"name"`
}

// ReadableRepoListResult is the paginated readable-repos response.
type ReadableRepoListResult struct {
	Items      []ReadableRepoRow
	TotalCount int64
	Page       int
	PerPage    int
}

// MaxReadableReposPerPage is the per-request cap for readable-repos.
// Tuned higher than MaxUserWorkspacesPerPage because a user can be in many
// orgs / have many collaborator grants but typically only a fraction of
// those have workspaces.
const MaxReadableReposPerPage = 200

type OrgListResult struct {
	Items      []OrgSummary `json:"items"`
	TotalCount int64        `json:"total_count"`
	Page       int          `json:"page"`
	PerPage    int          `json:"per_page"`
}

type ActivityListResult struct {
	Items      []ActivitySummary `json:"items"`
	TotalCount int64             `json:"total_count"`
	Page       int               `json:"page"`
	PerPage    int               `json:"per_page"`
}

type ActivitySummary struct {
	ID            int64     `json:"id"`
	EventType     string    `json:"event_type"`
	Action        string    `json:"action"`
	ActorUsername string    `json:"actor_username"`
	TargetType    string    `json:"target_type"`
	TargetName    string    `json:"target_name"`
	Summary       string    `json:"summary"`
	CreatedAt     time.Time `json:"created_at"`
}

// NotificationPreferences represents the user's notification settings.
type NotificationPreferences struct {
	EmailNotificationsEnabled bool `json:"email_notifications_enabled"`
}

// UpdateNotificationPreferencesRequest is the request payload for updating notification preferences.
type UpdateNotificationPreferencesRequest struct {
	EmailNotificationsEnabled *bool `json:"email_notifications_enabled"`
}

// ConnectedAccountResponse is the API representation of a connected OAuth account.
type ConnectedAccountResponse struct {
	ID         int64     `json:"id"`
	Provider   string    `json:"provider"`
	ProviderID string    `json:"provider_user_id"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

func NewUserService(q UserQuerier, options ...UserServiceOption) *UserService {
	s := &UserService{queries: q}
	for _, option := range options {
		option(s)
	}
	return s
}

func (s *UserService) GetAuthenticatedUser(ctx context.Context, userID int64) (UserProfile, error) {
	user, err := s.queries.GetUserByID(ctx, userID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return UserProfile{}, pkgerrors.NotFound("user not found")
		}
		return UserProfile{}, pkgerrors.Internal("failed to load user").WithCause(err)
	}

	if !user.IsActive {
		return UserProfile{}, pkgerrors.NotFound("user not found")
	}

	return mapUserProfile(user), nil
}

func (s *UserService) GetUserByUsername(ctx context.Context, username string) (PublicUserProfile, error) {
	username = strings.TrimSpace(username)
	if username == "" {
		return PublicUserProfile{}, pkgerrors.BadRequest("username is required")
	}

	user, err := s.queries.GetUserByLowerUsername(ctx, strings.ToLower(username))
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return PublicUserProfile{}, pkgerrors.NotFound("user not found")
		}
		return PublicUserProfile{}, pkgerrors.Internal("failed to load user").WithCause(err)
	}

	return mapPublicUserProfile(user), nil
}

// maxUserDisplayNameLength matches users.display_name varchar(255).
const maxUserDisplayNameLength = 255

func (s *UserService) UpdateAuthenticatedUser(ctx context.Context, userID int64, req UpdateUserRequest) (UserProfile, error) {
	if s.install != nil && !s.installAdmitted {
		return withInstallAccountMutation(s.install, ctx, userID, "account.profile.update", 0, req, func(ctx context.Context, q *db.Queries) (UserProfile, error) {
			scoped := *s
			scoped.queries = q
			scoped.installAdmitted = true
			return scoped.UpdateAuthenticatedUser(ctx, userID, req)
		})
	}

	current, err := s.queries.GetUserByID(ctx, userID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return UserProfile{}, pkgerrors.NotFound("user not found")
		}
		return UserProfile{}, pkgerrors.Internal("failed to load user").WithCause(err)
	}

	displayName := current.DisplayName
	if req.DisplayName != nil {
		displayName = strings.TrimSpace(*req.DisplayName)
	}

	bio := current.Bio
	if req.Bio != nil {
		bio = *req.Bio
	}

	if apiErr := validateSafeText("User", "display_name", displayName); apiErr != nil {
		return UserProfile{}, apiErr
	}
	if utf8.RuneCountInString(displayName) > maxUserDisplayNameLength {
		return UserProfile{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "User", Field: "display_name", Code: "invalid"})
	}
	if apiErr := validateSafeText("User", "bio", bio); apiErr != nil {
		return UserProfile{}, apiErr
	}

	avatarURL := current.AvatarUrl
	if req.AvatarURL != nil {
		avatarURL = strings.TrimSpace(*req.AvatarURL)
	}
	if avatarURL != "" && !isValidAvatarURL(avatarURL) {
		return UserProfile{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{
			Resource: "User",
			Field:    "avatar_url",
			Code:     "invalid",
		})
	}

	updated, err := s.queries.UpdateUser(ctx, db.UpdateUserParams{
		UserID:      userID,
		DisplayName: displayName,
		Bio:         bio,
		AvatarUrl:   avatarURL,
		Email:       current.Email,
		LowerEmail:  current.LowerEmail,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return UserProfile{}, pkgerrors.NotFound("user not found")
		}
		if isUniqueViolation(err) {
			return UserProfile{}, pkgerrors.Conflict("email address is already in use")
		}
		return UserProfile{}, pkgerrors.Internal("failed to update user").WithCause(err)
	}

	return mapUserProfile(updated), nil
}

func (s *UserService) ListAuthenticatedUserRepos(ctx context.Context, userID int64, page, perPage int) (RepoListResult, error) {
	user, err := s.queries.GetUserByID(ctx, userID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return RepoListResult{}, pkgerrors.NotFound("user not found")
		}
		return RepoListResult{}, pkgerrors.Internal("failed to load user").WithCause(err)
	}

	page, perPage = normalizePagination(page, perPage)
	offset := ClampInt32((page - 1) * perPage)

	total, err := s.queries.CountUserRepos(ctx, pgtype.Int8{Int64: userID, Valid: true})
	if err != nil {
		return RepoListResult{}, pkgerrors.Internal("failed to count user repositories").WithCause(err)
	}

	repos, err := s.queries.ListUserRepos(ctx, db.ListUserReposParams{
		UserID:     pgtype.Int8{Int64: userID, Valid: true},
		PageSize:   int32(perPage),
		PageOffset: offset,
	})
	if err != nil {
		return RepoListResult{}, pkgerrors.Internal("failed to list user repositories").WithCause(err)
	}

	headsByRepoID, err := s.listDefaultBookmarkHeads(ctx, repos)
	if err != nil {
		return RepoListResult{}, err
	}

	items := make([]RepoSummary, 0, len(repos))
	for _, repo := range repos {
		item := mapRepoSummary(repo, user.Username)
		item.DefaultBookmarkHead = headsByRepoID[repo.ID]
		items = append(items, item)
	}

	return RepoListResult{
		Items:      items,
		TotalCount: total,
		Page:       page,
		PerPage:    perPage,
	}, nil
}

// ListReadableReposForAuthenticatedUser returns every repo the current user
// can read (owner + org-owner + team + collaborator + public). Backs
// GET /api/user/readable-repos (ticket 0135). Read semantics match
// the repository permission resolver.
func (s *UserService) ListReadableReposForAuthenticatedUser(ctx context.Context, userID int64, page, perPage int) (ReadableRepoListResult, error) {
	if page < 1 {
		page = 1
	}
	if perPage < 1 {
		perPage = UserDefaultPerPage
	}
	if perPage > MaxReadableReposPerPage {
		perPage = MaxReadableReposPerPage
	}
	// Cap page so the int32((page-1)*perPage) offset below cannot overflow —
	// an overflow wraps to a negative OFFSET and 500s the query. This endpoint
	// clamps inline rather than via normalizePagination, so guard it here too.
	if maxPage := math.MaxInt32/perPage + 1; page > maxPage {
		page = maxPage
	}
	offset := ClampInt32((page - 1) * perPage)

	rows, err := s.queries.ListReadableReposForUser(ctx, db.ListReadableReposForUserParams{
		UserID:     userID,
		PageOffset: offset,
		PageSize:   int32(perPage),
	})
	if err != nil {
		return ReadableRepoListResult{}, pkgerrors.Internal("failed to list readable repositories").WithCause(err)
	}

	total, err := s.queries.CountReadableReposForUser(ctx, userID)
	if err != nil {
		return ReadableRepoListResult{}, pkgerrors.Internal("failed to count readable repositories").WithCause(err)
	}

	items := make([]ReadableRepoRow, 0, len(rows))
	for _, r := range rows {
		items = append(items, ReadableRepoRow{
			ID:    r.ID,
			Owner: r.Owner,
			Name:  r.Name,
		})
	}

	return ReadableRepoListResult{
		Items:      items,
		TotalCount: total,
		Page:       page,
		PerPage:    perPage,
	}, nil
}

func (s *UserService) ListAuthenticatedUserOrgs(ctx context.Context, userID int64, page, perPage int) (OrgListResult, error) {
	page, perPage = normalizePagination(page, perPage)
	offset := ClampInt32((page - 1) * perPage)

	total, err := s.queries.CountUserOrgs(ctx, userID)
	if err != nil {
		return OrgListResult{}, pkgerrors.Internal("failed to count user organizations").WithCause(err)
	}

	orgs, err := s.queries.ListUserOrgs(ctx, db.ListUserOrgsParams{
		UserID:     userID,
		PageSize:   int32(perPage),
		PageOffset: offset,
	})
	if err != nil {
		return OrgListResult{}, pkgerrors.Internal("failed to list user organizations").WithCause(err)
	}

	items := make([]OrgSummary, 0, len(orgs))
	for _, org := range orgs {
		items = append(items, mapOrgSummary(org))
	}

	return OrgListResult{
		Items:      items,
		TotalCount: total,
		Page:       page,
		PerPage:    perPage,
	}, nil
}

func (s *UserService) ListUserReposByUsername(ctx context.Context, username string, page, perPage int) (RepoListResult, error) {
	username = strings.TrimSpace(username)
	if username == "" {
		return RepoListResult{}, pkgerrors.BadRequest("username is required")
	}

	user, err := s.queries.GetUserByLowerUsername(ctx, strings.ToLower(username))
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return RepoListResult{}, pkgerrors.NotFound("user not found")
		}
		return RepoListResult{}, pkgerrors.Internal("failed to load user").WithCause(err)
	}

	page, perPage = normalizePagination(page, perPage)
	offset := ClampInt32((page - 1) * perPage)

	userID := pgtype.Int8{Int64: user.ID, Valid: true}

	total, err := s.queries.CountPublicUserRepos(ctx, userID)
	if err != nil {
		return RepoListResult{}, pkgerrors.Internal("failed to count user repositories").WithCause(err)
	}

	repos, err := s.queries.ListPublicUserRepos(ctx, db.ListPublicUserReposParams{
		UserID:     userID,
		PageSize:   int32(perPage),
		PageOffset: offset,
	})
	if err != nil {
		return RepoListResult{}, pkgerrors.Internal("failed to list user repositories").WithCause(err)
	}

	items := make([]RepoSummary, 0, len(repos))
	for _, repo := range repos {
		items = append(items, mapRepoSummary(repo, user.Username))
	}

	return RepoListResult{
		Items:      items,
		TotalCount: total,
		Page:       page,
		PerPage:    perPage,
	}, nil
}

func (s *UserService) ListUserActivityByUsername(ctx context.Context, username string, page, perPage int) (ActivityListResult, error) {
	username = strings.TrimSpace(username)
	if username == "" {
		return ActivityListResult{}, pkgerrors.BadRequest("username is required")
	}

	user, err := s.queries.GetUserByLowerUsername(ctx, strings.ToLower(username))
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return ActivityListResult{}, pkgerrors.NotFound("user not found")
		}
		return ActivityListResult{}, pkgerrors.Internal("failed to load user").WithCause(err)
	}

	page, perPage = normalizePagination(page, perPage)
	offset := ClampInt32((page - 1) * perPage)

	total, err := s.queries.CountPublicAuditLogsByActor(ctx, db.CountPublicAuditLogsByActorParams{
		ActorID: pgtype.Int8{Int64: user.ID, Valid: true},
		Since:   time.Time{},
	})
	if err != nil {
		return ActivityListResult{}, pkgerrors.Internal("failed to count user activity").WithCause(err)
	}

	logs, err := s.queries.ListPublicAuditLogsByActor(ctx, db.ListPublicAuditLogsByActorParams{
		ActorID:    pgtype.Int8{Int64: user.ID, Valid: true},
		Since:      time.Time{}, // All time
		PageLimit:  int32(perPage),
		PageOffset: offset,
	})
	if err != nil {
		return ActivityListResult{}, pkgerrors.Internal("failed to list user activity").WithCause(err)
	}

	items := make([]ActivitySummary, 0, len(logs))
	for _, log := range logs {
		items = append(items, mapActivitySummary(log))
	}

	return ActivityListResult{
		Items:      items,
		TotalCount: total,
		Page:       page,
		PerPage:    perPage,
	}, nil
}

func (s *UserService) GetNotificationPreferences(ctx context.Context, userID int64) (NotificationPreferences, error) {
	row, err := s.queries.GetUserNotificationPreferences(ctx, userID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return NotificationPreferences{}, pkgerrors.NotFound("user not found")
		}
		return NotificationPreferences{}, pkgerrors.Internal("failed to load notification preferences").WithCause(err)
	}
	return NotificationPreferences{
		EmailNotificationsEnabled: row.EmailNotificationsEnabled,
	}, nil
}

func (s *UserService) UpdateNotificationPreferences(ctx context.Context, userID int64, req UpdateNotificationPreferencesRequest) (NotificationPreferences, error) {
	if s.install != nil && !s.installAdmitted {
		return withInstallAccountMutation(s.install, ctx, userID, "account.notifications.update", 0, req, func(ctx context.Context, q *db.Queries) (NotificationPreferences, error) {
			scoped := *s
			scoped.queries = q
			scoped.installAdmitted = true
			return scoped.UpdateNotificationPreferences(ctx, userID, req)
		})
	}

	current, err := s.queries.GetUserNotificationPreferences(ctx, userID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return NotificationPreferences{}, pkgerrors.NotFound("user not found")
		}
		return NotificationPreferences{}, pkgerrors.Internal("failed to load notification preferences").WithCause(err)
	}

	emailEnabled := current.EmailNotificationsEnabled
	if req.EmailNotificationsEnabled != nil {
		emailEnabled = *req.EmailNotificationsEnabled
	}

	updated, err := s.queries.UpdateUserNotificationPreferences(ctx, db.UpdateUserNotificationPreferencesParams{
		UserID:                    userID,
		EmailNotificationsEnabled: emailEnabled,
	})
	if err != nil {
		return NotificationPreferences{}, pkgerrors.Internal("failed to update notification preferences").WithCause(err)
	}
	return NotificationPreferences{
		EmailNotificationsEnabled: updated.EmailNotificationsEnabled,
	}, nil
}

func (s *UserService) ListConnectedAccounts(ctx context.Context, userID int64) ([]ConnectedAccountResponse, error) {
	accounts, err := s.queries.ListUserOAuthAccounts(ctx, userID)
	if err != nil {
		return nil, pkgerrors.Internal("failed to list connected accounts").WithCause(err)
	}

	result := make([]ConnectedAccountResponse, 0, len(accounts))
	for _, a := range accounts {
		result = append(result, ConnectedAccountResponse{
			ID:         a.ID,
			Provider:   a.Provider,
			ProviderID: a.ProviderUserID,
			CreatedAt:  a.CreatedAt,
			UpdatedAt:  a.UpdatedAt,
		})
	}
	return result, nil
}

func (s *UserService) DeleteConnectedAccount(ctx context.Context, userID, accountID int64) error {
	if s.install != nil && !s.installAdmitted {
		_, err := withInstallAccountMutation(s.install, ctx, userID, "account.connection.delete", accountID, struct{}{}, func(ctx context.Context, q *db.Queries) (struct{}, error) {
			scoped := *s
			scoped.queries = q
			scoped.installAdmitted = true
			return struct{}{}, scoped.DeleteConnectedAccount(ctx, userID, accountID)
		})
		return err
	}

	if accountID <= 0 {
		return pkgerrors.BadRequest("invalid account id")
	}

	if err := s.queries.DeleteOAuthAccount(ctx, db.DeleteOAuthAccountParams{
		ID:     accountID,
		UserID: userID,
	}); err != nil {
		return pkgerrors.Internal("failed to delete connected account").WithCause(err)
	}
	// Read grants were proved by a linked credential; after an unlink the
	// shared GitHub metadata store must re-prove access through a live read.
	if err := s.queries.DeleteGitHubSyncedRepoReadGrantsForUser(ctx, userID); err != nil {
		return pkgerrors.Internal("failed to revoke github repository read grants").WithCause(err)
	}
	return nil
}

func normalizePagination(page int, perPage int) (int, int) {
	if page < 1 {
		page = 1
	}
	if perPage < 1 {
		perPage = UserDefaultPerPage
	}
	if perPage > UserMaxPerPage {
		perPage = UserMaxPerPage
	}
	// Cap page so callers' int32((page-1)*perPage) offset cannot overflow —
	// an overflow wraps to a negative OFFSET and 500s the query.
	if maxPage := math.MaxInt32/perPage + 1; page > maxPage {
		page = maxPage
	}
	return page, perPage
}

func isValidAvatarURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return false
	}
	return u.Host != ""
}

func mapUserProfile(user db.User) UserProfile {
	return UserProfile{
		ID:          user.ID,
		Username:    user.Username,
		DisplayName: user.DisplayName,
		Email:       textValue(user.Email),
		Bio:         user.Bio,
		AvatarURL:   user.AvatarUrl,
		IsAdmin:     user.IsAdmin,
		Suspended:   user.ProhibitLogin,
		CreatedAt:   user.CreatedAt,
		UpdatedAt:   user.UpdatedAt,
	}
}

func mapPublicUserProfile(user db.User) PublicUserProfile {
	return PublicUserProfile{
		ID:          user.ID,
		Username:    user.Username,
		DisplayName: user.DisplayName,
		Bio:         user.Bio,
		AvatarURL:   user.AvatarUrl,
		CreatedAt:   user.CreatedAt,
		UpdatedAt:   user.UpdatedAt,
	}
}

func mapRepoSummary(repo db.Repository, owner string) RepoSummary {
	ownerType := "user"
	if repo.OrgID.Valid {
		ownerType = "organization"
	}

	return RepoSummary{
		ID:              repo.ID,
		Owner:           owner,
		OwnerType:       ownerType,
		FullName:        owner + "/" + repo.Name,
		Name:            repo.Name,
		Description:     repo.Description,
		IsPublic:        repo.IsPublic,
		NumStars:        repo.NumStars,
		DefaultBookmark: repo.DefaultBookmark,
		CreatedAt:       repo.CreatedAt,
		UpdatedAt:       repo.UpdatedAt,
	}
}

func (s *UserService) listDefaultBookmarkHeads(ctx context.Context, repos []db.Repository) (map[int64]DefaultBookmarkHead, error) {
	headsByRepoID := make(map[int64]DefaultBookmarkHead, len(repos))
	if len(repos) == 0 {
		return headsByRepoID, nil
	}

	repositoryIDs := make([]int64, 0, len(repos))
	for _, repo := range repos {
		repositoryIDs = append(repositoryIDs, repo.ID)
	}

	rows, err := s.queries.ListDefaultBookmarkHeadsByRepoIDs(ctx, repositoryIDs)
	if err != nil {
		return nil, pkgerrors.Internal("failed to load default bookmark heads").WithCause(err)
	}
	for _, row := range rows {
		headsByRepoID[row.RepositoryID] = DefaultBookmarkHead{
			ChangeID: row.ChangeID,
			CommitID: row.CommitID,
		}
	}

	return headsByRepoID, nil
}

func mapActivitySummary(log db.AuditLog) ActivitySummary {
	return ActivitySummary{
		ID:            log.ID,
		EventType:     log.EventType,
		Action:        log.Action,
		ActorUsername: strings.TrimSpace(log.ActorName),
		TargetType:    log.TargetType,
		TargetName:    log.TargetName,
		Summary:       formatActivitySummary(log),
		CreatedAt:     log.CreatedAt,
	}
}

func formatActivitySummary(log db.AuditLog) string {
	targetName := strings.TrimSpace(log.TargetName)

	switch log.EventType {
	case "repo.create":
		return formatActivityWithTarget("created repository", targetName)
	case "repo.delete":
		return formatActivityWithTarget("deleted repository", targetName)
	case "repo.archive":
		return formatActivityWithTarget("archived repository", targetName)
	case "repo.unarchive":
		return formatActivityWithTarget("unarchived repository", targetName)
	case "repo.transfer":
		return formatActivityWithTarget("transferred repository", targetName)
	case "repo.fork":
		return formatActivityWithTarget("forked repository", targetName)
	default:
		if targetName != "" && strings.TrimSpace(log.Action) != "" {
			return strings.TrimSpace(log.Action) + " " + targetName
		}
		if targetName != "" {
			return targetName
		}
		return strings.ReplaceAll(log.EventType, ".", " ")
	}
}

func formatActivityWithTarget(verb, targetName string) string {
	if targetName == "" {
		return verb
	}
	return verb + " " + targetName
}

func (s *UserService) mapRepoSummariesWithResolvedOwners(ctx context.Context, repos []db.Repository) ([]RepoSummary, error) {
	cache := &repoOwnerCache{
		users: make(map[int64]string),
		orgs:  make(map[int64]string),
	}

	items := make([]RepoSummary, 0, len(repos))
	for _, repo := range repos {
		owner, err := s.resolveRepoOwnerName(ctx, repo, cache)
		if err != nil {
			return nil, err
		}
		items = append(items, mapRepoSummary(repo, owner))
	}

	return items, nil
}

type repoOwnerCache struct {
	users map[int64]string
	orgs  map[int64]string
}

func (s *UserService) resolveRepoOwnerName(ctx context.Context, repo db.Repository, cache *repoOwnerCache) (string, error) {
	switch {
	case repo.UserID.Valid:
		if owner, ok := cache.users[repo.UserID.Int64]; ok {
			return owner, nil
		}

		user, err := s.queries.GetUserByID(ctx, repo.UserID.Int64)
		if err != nil {
			if stdErrors.Is(err, pgx.ErrNoRows) {
				return "", pkgerrors.NotFound("repository owner not found")
			}
			return "", pkgerrors.Internal("failed to load repository owner").WithCause(err)
		}

		cache.users[repo.UserID.Int64] = user.Username
		return user.Username, nil
	case repo.OrgID.Valid:
		if owner, ok := cache.orgs[repo.OrgID.Int64]; ok {
			return owner, nil
		}

		org, err := s.queries.GetOrgByID(ctx, repo.OrgID.Int64)
		if err != nil {
			if stdErrors.Is(err, pgx.ErrNoRows) {
				return "", pkgerrors.NotFound("repository owner not found")
			}
			return "", pkgerrors.Internal("failed to load repository owner").WithCause(err)
		}

		cache.orgs[repo.OrgID.Int64] = org.Name
		return org.Name, nil
	default:
		return "", pkgerrors.Internal("repository owner not found")
	}
}

func mapOrgSummary(org db.Organization) OrgSummary {
	return OrgSummary{
		ID:          org.ID,
		Name:        org.Name,
		Description: org.Description,
		Visibility:  org.Visibility,
		Website:     org.Website,
		Location:    org.Location,
	}
}

func textValue(value pgtype.Text) string {
	if !value.Valid {
		return ""
	}
	return value.String
}

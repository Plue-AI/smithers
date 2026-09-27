package middleware

import (
	"context"
	stdErrors "errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	apierrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const (
	repoContextKey           contextKey = "repo_context"
	repoPermissionContextKey contextKey = "repo_permission"
)

// ErrInvalidPermissionLevel is returned when parsing an unknown repository permission.
var ErrInvalidPermissionLevel = stdErrors.New("invalid repository permission level")

// PermissionLevel is the normalized repository permission rank.
type PermissionLevel string

const (
	PermissionNone  PermissionLevel = "none"
	PermissionRead  PermissionLevel = "read"
	PermissionWrite PermissionLevel = "write"
	PermissionAdmin PermissionLevel = "admin"
	PermissionOwner PermissionLevel = "owner"
)

// RepoContext is request-scoped repository information loaded from route params.
type RepoContext struct {
	Owner      string
	Repository *db.Repository
	// GitHubSourceOwner / GitHubSourceRepo record that the URL addressed this
	// repository by its GitHub SOURCE coordinates ("octocat/Hello-World") and
	// that it was resolved through the requester's own import provenance to a
	// mirror living somewhere else ("alice/hello-world"). They stay empty when
	// the URL named the repository's own Smithers coordinates. Reads are happy
	// to follow the alias; a WRITE addressed this way lands in the mirror and
	// never reaches github.com, so the write handlers refuse it by name (see
	// routes.refuseGitHubSourceWrite).
	GitHubSourceOwner string
	GitHubSourceRepo  string
}

// GitHubSourceAliasFromContext reports the GitHub source coordinates the
// request used when the repository was reached through import provenance, and
// whether it was reached that way at all.
func GitHubSourceAliasFromContext(ctx context.Context) (owner string, repo string, aliased bool) {
	rc := RepoContextFromContext(ctx)
	if rc == nil || rc.GitHubSourceOwner == "" || rc.GitHubSourceRepo == "" {
		return "", "", false
	}
	return rc.GitHubSourceOwner, rc.GitHubSourceRepo, true
}

// RepoContextQuerier defines the DB query surface needed by LoadRepoContext.
type RepoContextQuerier interface {
	GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	GetReadyImportedRepoForUserBySource(ctx context.Context, arg db.GetReadyImportedRepoForUserBySourceParams) (db.GetReadyImportedRepoForUserBySourceRow, error)
	IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)
}

// ParsePermissionLevel normalizes known permission strings.
func ParsePermissionLevel(raw string) (PermissionLevel, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case string(PermissionRead):
		return PermissionRead, nil
	case string(PermissionWrite):
		return PermissionWrite, nil
	case string(PermissionAdmin):
		return PermissionAdmin, nil
	case string(PermissionOwner):
		return PermissionOwner, nil
	default:
		return PermissionNone, fmt.Errorf("%w: %q", ErrInvalidPermissionLevel, raw)
	}
}

// Satisfies reports whether the permission level grants at least required access.
func (p PermissionLevel) Satisfies(required PermissionLevel) bool {
	if required == PermissionNone {
		return true
	}
	return permissionRank(p) >= permissionRank(required)
}

// RepoContextFromContext returns the request repository context.
func RepoContextFromContext(ctx context.Context) *RepoContext {
	rc, _ := ctx.Value(repoContextKey).(*RepoContext)
	return rc
}

// RepoFromContext returns the loaded repository or nil when absent.
func RepoFromContext(ctx context.Context) *db.Repository {
	rc := RepoContextFromContext(ctx)
	if rc == nil {
		return nil
	}
	return rc.Repository
}

// RepoPermissionFromContext returns the resolved repo permission for this request.
func RepoPermissionFromContext(ctx context.Context) PermissionLevel {
	permission, ok := ctx.Value(repoPermissionContextKey).(PermissionLevel)
	if !ok || permission == "" {
		return PermissionNone
	}
	return permission
}

// ContextWithRepoContext stores repository context and resolved permission.
func ContextWithRepoContext(ctx context.Context, repoCtx *RepoContext, permission PermissionLevel) context.Context {
	ctx = context.WithValue(ctx, repoContextKey, repoCtx)
	return context.WithValue(ctx, repoPermissionContextKey, permission)
}

// LoadRepoContext resolves owner/repo from URL params and adds repo + permission context.
func LoadRepoContext(queries RepoContextQuerier) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if queries == nil {
				apierrors.WriteError(w, apierrors.Internal("repository context queries are not configured"))
				return
			}

			owner := strings.TrimSpace(chi.URLParam(r, "owner"))
			if owner == "" {
				apierrors.WriteError(w, apierrors.BadRequest("owner is required"))
				return
			}
			repoName := strings.TrimSpace(chi.URLParam(r, "repo"))
			if repoName == "" {
				apierrors.WriteError(w, apierrors.BadRequest("repository name is required"))
				return
			}

			var githubSourceOwner, githubSourceRepo string
			repository, err := queries.GetRepoByOwnerAndLowerName(r.Context(), db.GetRepoByOwnerAndLowerNameParams{
				Owner:     strings.ToLower(owner),
				LowerName: strings.ToLower(repoName),
			})
			if err != nil {
				if !stdErrors.Is(err, pgx.ErrNoRows) {
					apierrors.WriteError(w, apierrors.Internal("failed to resolve repository"))
					return
				}
				// Mirror repos live under the IMPORTING user's namespace, not the
				// GitHub source owner ("smithersai/smithers" mirrors to
				// "alice/smithers"), but clients keep addressing them by the source
				// coordinates they picked. Before 404ing, resolve through the
				// requester's OWN completed import provenance — per-user scoped, so
				// one user's imports never resolve for another, and the normal
				// visibility/permission gate below still runs on the result.
				resolved, ok, provErr := resolveRepoBySourceProvenance(r.Context(), queries, owner, repoName)
				if provErr != nil {
					apierrors.WriteError(w, apierrors.Internal("failed to resolve repository").WithCause(provErr))
					return
				}
				if !ok {
					apierrors.WriteError(w, apierrors.NotFound("repository not found"))
					return
				}
				repository = resolved.Repository
				// Remember the alias BEFORE owner is rewritten: a write handler
				// has to be able to name both halves ("octocat/Hello-World is
				// mirrored here as alice/hello-world") to refuse honestly.
				githubSourceOwner = owner
				githubSourceRepo = repoName
				// Downstream repo-host and workspace ops key storage paths on the
				// context owner; it must be the mirror's real namespace, never the
				// GitHub source owner from the URL.
				owner = resolved.LocalOwner
			}

			permission, permErr := resolveRepoPermission(r.Context(), queries, repository, repoVisibilityUser(r.Context(), repository.ID))
			if permErr != nil {
				apierrors.WriteError(w, permErr)
				return
			}
			if !repository.IsPublic && !permission.Satisfies(PermissionRead) {
				apierrors.WriteError(w, apierrors.NotFound("repository not found"))
				return
			}

			repoCopy := repository
			ctx := ContextWithRepoContext(r.Context(), &RepoContext{
				Owner:             owner,
				Repository:        &repoCopy,
				GitHubSourceOwner: githubSourceOwner,
				GitHubSourceRepo:  githubSourceRepo,
			}, permission)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// resolveRepoBySourceProvenance maps GitHub source coordinates to the
// requesting user's own imported mirror. Only an authenticated principal whose
// token (if token auth) can read repositories may resolve; a repository-bound
// token is NOT excluded here because the permission gate after resolution
// already treats it as anonymous on every repo other than its own.
func resolveRepoBySourceProvenance(ctx context.Context, queries RepoContextQuerier, owner, repoName string) (db.GetReadyImportedRepoForUserBySourceRow, bool, error) {
	var zero db.GetReadyImportedRepoForUserBySourceRow
	authInfo := AuthInfoFromContext(ctx)
	user := UserFromContext(ctx)
	if authInfo != nil {
		user = authInfo.User
		if authInfo.IsTokenAuth && !authInfo.Scopes.Has(ScopeReadRepository) {
			return zero, false, nil
		}
	}
	if user == nil {
		return zero, false, nil
	}
	row, err := queries.GetReadyImportedRepoForUserBySource(ctx, db.GetReadyImportedRepoForUserBySourceParams{
		UserID:      user.ID,
		GithubOwner: strings.ToLower(owner),
		GithubRepo:  strings.ToLower(repoName),
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return zero, false, nil
		}
		return zero, false, err
	}
	return row, true, nil
}

func repoVisibilityUser(ctx context.Context, repositoryID int64) *db.User {
	authInfo := AuthInfoFromContext(ctx)
	if authInfo == nil {
		return UserFromContext(ctx)
	}
	if authInfo.User == nil {
		return nil
	}
	if authInfo.IsTokenAuth && !authInfo.Scopes.Has(ScopeReadRepository) {
		return nil
	}
	// A repository-bound token (per-run sandbox/agent token) acts as anonymous
	// on every repository other than the one it is bound to: private repos 404
	// and public repos are read-only, so a leaked token cannot touch the
	// owner's other repositories.
	if restricted := authInfo.RepositoryRestriction(); restricted != 0 && restricted != repositoryID {
		return nil
	}
	return authInfo.User
}

// RequireRepoPermission enforces minimum repository permission from repo context.
func RequireRepoPermission(required PermissionLevel) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			current, ok := r.Context().Value(repoPermissionContextKey).(PermissionLevel)
			if !ok || current == "" {
				apierrors.WriteError(w, apierrors.Internal("repository context not loaded"))
				return
			}

			if !current.Satisfies(required) {
				apierrors.WriteError(w, apierrors.Forbidden("permission denied"))
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

// RequireMatchingRepositoryRestriction closes the gap between repository
// visibility and repository-bound token authority. LoadRepoContext deliberately
// treats a token bound to another repository as anonymous so normal public
// source routes remain readable. Memory is never anonymous, however: a bound
// token may reach repository memory only when its repo:<id> restriction matches
// the repository loaded from the route.
func RequireMatchingRepositoryRestriction(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authInfo := AuthInfoFromContext(r.Context())
		restriction := authInfo.RepositoryRestriction()
		if restriction == 0 {
			next.ServeHTTP(w, r)
			return
		}

		repository := RepoFromContext(r.Context())
		if repository == nil {
			apierrors.WriteError(w, apierrors.Internal("repository context not loaded"))
			return
		}
		if restriction != repository.ID {
			apierrors.WriteError(w, apierrors.Forbidden("repository token does not match requested repository"))
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RepoPermissionQuerier is the query surface ResolveRepoPermission needs.
type RepoPermissionQuerier interface {
	IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)
}

// ResolveRepoPermission returns a user's effective permission on a
// repository: owner, org owner, highest team grant, or collaborator grant,
// whichever ranks highest, and read for a public repository. It is the one
// resolver every route that asks "may this user do X to this repo" uses.
func ResolveRepoPermission(ctx context.Context, queries RepoPermissionQuerier, repository db.Repository, user *db.User) (PermissionLevel, *apierrors.APIError) {
	return resolveRepoPermission(ctx, queries, repository, user)
}

func resolveRepoPermission(ctx context.Context, queries RepoPermissionQuerier, repository db.Repository, user *db.User) (PermissionLevel, *apierrors.APIError) {
	permission, err := resolveUserRepoPermission(ctx, queries, repository, user)
	if err != nil {
		return permission, err
	}
	return capCredentialPermission(ctx, repository.ID, user, permission), nil
}

func resolveUserRepoPermission(ctx context.Context, queries RepoPermissionQuerier, repository db.Repository, user *db.User) (PermissionLevel, *apierrors.APIError) {
	if user == nil {
		if repository.IsPublic {
			return PermissionRead, nil
		}
		return PermissionNone, nil
	}

	if repository.UserID.Valid && repository.UserID.Int64 == user.ID {
		return PermissionOwner, nil
	}

	permission := PermissionNone

	if repository.OrgID.Valid {
		isOrgOwner, err := queries.IsOrgOwnerForRepoUser(ctx, db.IsOrgOwnerForRepoUserParams{
			RepositoryID: repository.ID,
			UserID:       user.ID,
		})
		if err != nil {
			return PermissionNone, apierrors.Internal("failed to resolve repository permission").WithCause(err)
		}
		if isOrgOwner {
			permission = maxPermission(permission, PermissionOwner)
		}

		teamPermissionRaw, err := queries.GetHighestTeamPermissionForRepoUser(ctx, db.GetHighestTeamPermissionForRepoUserParams{
			RepositoryID: repository.ID,
			UserID:       user.ID,
		})
		if err != nil {
			return PermissionNone, apierrors.Internal("failed to resolve repository permission").WithCause(err)
		}
		if strings.TrimSpace(teamPermissionRaw) != "" {
			teamPermission, parseErr := ParsePermissionLevel(teamPermissionRaw)
			if parseErr != nil {
				return PermissionNone, apierrors.Internal("failed to parse repository permission").WithCause(parseErr)
			}
			permission = maxPermission(permission, teamPermission)
		}
	}

	collabPermissionRaw, err := queries.GetCollaboratorPermissionForRepoUser(ctx, db.GetCollaboratorPermissionForRepoUserParams{
		RepositoryID: repository.ID,
		UserID:       pgtype.Int8{Int64: user.ID, Valid: true},
	})
	if err != nil {
		return PermissionNone, apierrors.Internal("failed to resolve repository permission").WithCause(err)
	}
	if strings.TrimSpace(collabPermissionRaw) != "" {
		collabPermission, parseErr := ParsePermissionLevel(collabPermissionRaw)
		if parseErr != nil {
			return PermissionNone, apierrors.Internal("failed to parse repository permission").WithCause(parseErr)
		}
		permission = maxPermission(permission, collabPermission)
	}

	if permission == PermissionNone && repository.IsPublic {
		return PermissionRead, nil
	}

	return permission, nil
}

func maxPermission(a, b PermissionLevel) PermissionLevel {
	if permissionRank(b) > permissionRank(a) {
		return b
	}
	return a
}

func permissionRank(permission PermissionLevel) int {
	switch permission {
	case PermissionOwner:
		return 4
	case PermissionAdmin:
		return 3
	case PermissionWrite:
		return 2
	case PermissionRead:
		return 1
	default:
		return 0
	}
}

// capCredentialPermission bounds the request's own user at PermissionWrite
// when it authenticated with a system-issued credential (an agent run's
// token, or the platform's sync token) or a token bound to this repository.
// Such a token is issued for writes; the owner's admin and owner authority
// (bookmark protection, the default bookmark and every other setting, delete,
// archive, hooks, deploy keys, secrets) must not travel with it.
func capCredentialPermission(ctx context.Context, repositoryID int64, user *db.User, permission PermissionLevel) PermissionLevel {
	authInfo := AuthInfoFromContext(ctx)
	if authInfo == nil || user == nil || authInfo.User == nil || authInfo.User.ID != user.ID {
		return permission
	}
	if !authInfo.IsRunCredential() && authInfo.RepositoryRestriction() != repositoryID {
		return permission
	}
	if permissionRank(permission) > permissionRank(PermissionWrite) {
		return PermissionWrite
	}
	return permission
}

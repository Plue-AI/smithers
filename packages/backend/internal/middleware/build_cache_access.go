package middleware

import (
	"context"
	stdErrors "errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/buildcache"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	apierrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// BuildCacheCredential is what the presented credential may do with one
// repository's build cache. The classification happens once, before the
// route is even parsed, so a publication presented on a read credential is
// refused before its body is read.
type BuildCacheCredential string

const (
	BuildCacheCredentialNone  BuildCacheCredential = "none"
	BuildCacheCredentialRead  BuildCacheCredential = "read"
	BuildCacheCredentialWrite BuildCacheCredential = "write"
)

type buildCacheCredentialContextKey struct{}
type buildCacheReadTokenContextKey struct{}
type buildCacheNamespaceContextKey struct{}

// BuildCacheNamespacePrefixFromContext is empty for unrestricted credentials.
func BuildCacheNamespacePrefixFromContext(ctx context.Context) string {
	prefix, _ := ctx.Value(buildCacheNamespaceContextKey{}).(string)
	return prefix
}

// BuildCacheCredentialFromContext returns the classification the access
// middleware recorded.
func BuildCacheCredentialFromContext(ctx context.Context) BuildCacheCredential {
	credential, ok := ctx.Value(buildCacheCredentialContextKey{}).(BuildCacheCredential)
	if !ok || credential == "" {
		return BuildCacheCredentialNone
	}
	return credential
}

// ContextWithBuildCacheCredential records a classification (tests and the
// middleware use it).
func ContextWithBuildCacheCredential(ctx context.Context, credential BuildCacheCredential) context.Context {
	return context.WithValue(ctx, buildCacheCredentialContextKey{}, credential)
}

// BuildCacheReadTokenResolver maps a presented public read token to its row.
type BuildCacheReadTokenResolver interface {
	ResolveReadToken(ctx context.Context, token string) (db.BuildCacheReadToken, error)
}

// presentedReadToken returns the bearer value when it has the public read
// token shape. Every other credential is left to AuthLoader, which has already
// run; the shape check means the general loader can never accept one of these.
func presentedReadToken(r *http.Request) string {
	authorization := strings.TrimSpace(r.Header.Get("Authorization"))
	fields := strings.Fields(authorization)
	if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") {
		return ""
	}
	if !buildcache.IsReadToken(fields[1]) {
		return ""
	}
	return fields[1]
}

// BuildCacheAccess resolves the repository and classifies the credential for
// the build cache routes.
//
// Two credential classes exist. A public read token (smithers_cachero_...)
// belongs to exactly one repository, may only read that repository's cache,
// and is safe to commit. Everything else is ordinary Smithers auth loaded by
// AuthLoader: a session, a personal access token, or a system-issued run
// credential (the per-run repository token an agent computer holds, a clone
// or landing credential). A session or a user's own token classifies as write
// when it holds write permission on the repository (and, for a token, the
// write:repository scope with no foreign repository restriction), read when it
// holds read permission, and anonymous reads are allowed on a public
// repository.
//
// An agent credential is never a cache writer, whatever its scopes. It
// serves a run of code nobody has reviewed yet, and the cache trust model
// (packages/smithers/build/infra/CACHE-TRUST.md) admits only reviewed trunk
// builds as publishers: a hit is reported green, so a run that could publish
// under a key could decide a later trusted build's verdict for that key.
func BuildCacheAccess(queries RepoContextQuerier, tokens BuildCacheReadTokenResolver) func(http.Handler) http.Handler {
	loadRepo := LoadRepoContext(queries)
	return func(next http.Handler) http.Handler {
		classify := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			repository := RepoFromContext(r.Context())
			if repository == nil {
				apierrors.WriteError(w, apierrors.Internal("repository context not loaded"))
				return
			}
			permission := RepoPermissionFromContext(r.Context())
			authInfo := AuthInfoFromContext(r.Context())
			credential := BuildCacheCredentialNone
			scopeOK := func(scope TokenScope) bool {
				if authInfo == nil || !authInfo.IsTokenAuth {
					return true
				}
				if !authInfo.Scopes.Has(scope) {
					return false
				}
				restriction := authInfo.RepositoryRestriction()
				return restriction == 0 || restriction == repository.ID
			}
			agent := authInfo.IsAgent()
			switch {
			case permission.Satisfies(PermissionWrite) && scopeOK(ScopeWriteRepository) && !agent:
				credential = BuildCacheCredentialWrite
			case permission.Satisfies(PermissionRead) && scopeOK(ScopeReadRepository):
				credential = BuildCacheCredentialRead
			}
			if credential == BuildCacheCredentialNone {
				if authInfo == nil && UserFromContext(r.Context()) == nil {
					writeBuildCacheUnauthorized(w)
					return
				}
				writeBuildCacheForbidden(w)
				return
			}
			next.ServeHTTP(w, r.WithContext(ContextWithBuildCacheCredential(r.Context(), credential)))
		})
		withRepo := loadRepo(classify)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token := presentedReadToken(r)
			if token == "" {
				withRepo.ServeHTTP(w, r)
				return
			}
			if queries == nil || tokens == nil {
				apierrors.WriteError(w, apierrors.Internal("build cache access is not configured"))
				return
			}
			row, err := tokens.ResolveReadToken(r.Context(), token)
			if err != nil {
				if stdErrors.Is(err, pgx.ErrNoRows) {
					writeBuildCacheUnauthorized(w)
					return
				}
				// The tier could not answer. The protocol's clients retry a 503
				// and would read anything else as a broken remote.
				writeBuildCacheTierFailed(w)
				return
			}
			owner := strings.TrimSpace(chi.URLParam(r, "owner"))
			repoName := strings.TrimSpace(chi.URLParam(r, "repo"))
			repository, err := queries.GetRepoByOwnerAndLowerName(r.Context(), db.GetRepoByOwnerAndLowerNameParams{
				Owner:     strings.ToLower(owner),
				LowerName: strings.ToLower(repoName),
			})
			if err != nil {
				if stdErrors.Is(err, pgx.ErrNoRows) {
					// The token names a repository; a request for another one is
					// an unauthorized request, not a discovery oracle.
					writeBuildCacheUnauthorized(w)
					return
				}
				writeBuildCacheTierFailed(w)
				return
			}
			if repository.ID != row.RepositoryID {
				writeBuildCacheUnauthorized(w)
				return
			}
			repoCopy := repository
			ctx := ContextWithRepoContext(r.Context(), &RepoContext{Owner: owner, Repository: &repoCopy}, PermissionRead)
			ctx = ContextWithBuildCacheCredential(ctx, BuildCacheCredentialRead)
			ctx = context.WithValue(ctx, buildCacheReadTokenContextKey{}, row.TokenHash)
			if !buildcache.ValidNamespacePrefix(row.NamespacePrefix) {
				writeBuildCacheForbidden(w)
				return
			}
			ctx = context.WithValue(ctx, buildCacheNamespaceContextKey{}, row.NamespacePrefix)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// RequireBuildCacheWrite refuses PUT and DELETE on anything but a write
// credential, with the protocol's 403 body, before the request body is read.
func RequireBuildCacheWrite(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if (r.Method == http.MethodPut || r.Method == http.MethodDelete) &&
			BuildCacheCredentialFromContext(r.Context()) != BuildCacheCredentialWrite {
			writeBuildCacheForbidden(w)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// The three refusals the access middleware can answer with, all in the one
// typed envelope the rest of plue answers with. The challenge header stays:
// the envelope says what happened, the header says how to authenticate.
func writeBuildCacheUnauthorized(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", `Bearer realm="smithers-build-cache"`)
	apierrors.WriteError(w, apierrors.Unauthorized("this credential does not read that repository's cache"))
}

func writeBuildCacheTierFailed(w http.ResponseWriter) {
	apierrors.WriteError(w, apierrors.New(apierrors.CodeServiceUnavailable, "the cache tier failed to answer"))
}

func writeBuildCacheForbidden(w http.ResponseWriter) {
	apierrors.WriteError(w, apierrors.Forbidden("this credential may read the cache but not publish to it"))
}

const buildCacheRateLimitScope = "build_cache"

// BuildCacheRateLimit bounds cache traffic per principal: the user behind a
// session or token, the public read token itself when that is all there is,
// or the client address for anonymous reads of a public repository.
func BuildCacheRateLimit(store SearchRateLimitStore, limit int, window time.Duration) func(http.Handler) http.Handler {
	keyFn := func(r *http.Request) string {
		if hash, ok := r.Context().Value(buildCacheReadTokenContextKey{}).(string); ok && hash != "" {
			return "cachero:" + hash
		}
		return searchRateLimitKey(r)
	}
	return newRateLimitWithKey(store, buildCacheRateLimitScope, limit, window, 1200, time.Minute, keyFn)
}

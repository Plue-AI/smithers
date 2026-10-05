package middleware

import (
	"context"
	"encoding/base64"
	"net/http"
	"strconv"
	"strings"
	"unicode"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const authInfoContextKey contextKey = "auth_info"

type TokenScope string

const (
	ScopeAll               TokenScope = "all"
	ScopeAdmin             TokenScope = "admin"
	ScopeReadAdmin         TokenScope = "read:admin"
	ScopeWriteAdmin        TokenScope = "write:admin"
	ScopeReadRepository    TokenScope = "read:repository"
	ScopeWriteRepository   TokenScope = "write:repository"
	ScopeReadOrganization  TokenScope = "read:organization"
	ScopeWriteOrganization TokenScope = "write:organization"
	ScopeReadUser          TokenScope = "read:user"
	ScopeWriteUser         TokenScope = "write:user"
	ScopeReadWorkspace     TokenScope = "read:workspace"
	ScopeWriteWorkspace    TokenScope = "write:workspace"
	ScopeReadApproval      TokenScope = "read:approval"
	ScopeWriteApproval     TokenScope = "write:approval"
	ScopeReadAgent         TokenScope = "read:agent"
	ScopeWriteAgent        TokenScope = "write:agent"
)

type ScopeSet map[TokenScope]struct{}

type TokenSource string

const (
	TokenSourcePersonalAccessToken TokenSource = "personal_access_token"
	TokenSourceOAuth2AccessToken   TokenSource = "oauth2_access_token"
)

type AuthInfo struct {
	TokenSystemIssued bool
	User              *db.User
	TokenID           int64
	TokenHash         string
	// SessionHash is the SHA-256 of the browser session key for cookie auth.
	SessionHash string
	OAuth2AppID int64
	RawScopes   string
	Scopes      ScopeSet
	IsTokenAuth bool
	TokenSource TokenSource
	// ViaHint is a delegated request's Smithers-Via header: attribution
	// only, read through ActingVia, never authority.
	ViaHint string
}

// repositoryRestrictionScopePrefix marks a scopes-list entry that binds a token
// to a single repository (e.g. "repo:42"). It is a restriction, not a
// permission scope: ParseTokenScopes drops it (NormalizeTokenScope returns ""
// for unknown entries), so it can only narrow — never widen — what the token's
// real scopes grant. Per-run sandbox/agent tokens carry it so a leaked token
// cannot act on the owner's other repositories.
const repositoryRestrictionScopePrefix = "repo:"
const pathRestrictionScopePrefix = "path:"
const agentSessionRestrictionScopePrefix = "agent-session:"

// RepositoryRestrictionScope returns the scopes-list entry that binds a token
// to the given repository, for appending to a token's scopes string.
func RepositoryRestrictionScope(repositoryID int64) string {
	return repositoryRestrictionScopePrefix + strconv.FormatInt(repositoryID, 10)
}

// ParseTokenRepositoryRestriction extracts the repository binding from a raw
// scopes string. It returns 0 when the token is not repository-bound.
func ParseTokenRepositoryRestriction(raw string) int64 {
	for _, part := range tokenScopeEntries(raw) {
		part = strings.ToLower(strings.TrimSpace(part))
		if !strings.HasPrefix(part, repositoryRestrictionScopePrefix) {
			continue
		}
		id, err := strconv.ParseInt(strings.TrimPrefix(part, repositoryRestrictionScopePrefix), 10, 64)
		if err == nil && id > 0 {
			return id
		}
	}
	return 0
}

// AgentSessionRestrictionScope binds a per-run API token to the agent session
// that owns it. Like repository/path restrictions it is inert permission-wise.
func AgentSessionRestrictionScope(sessionID string) string {
	return agentSessionRestrictionScopePrefix + strings.TrimSpace(sessionID)
}

// ParseTokenAgentSessionRestriction returns the session bound to a per-run
// agent token, or an empty string for ordinary user/workflow tokens.
func ParseTokenAgentSessionRestriction(raw string) string {
	for _, part := range tokenScopeEntries(raw) {
		part = strings.TrimSpace(part)
		if strings.HasPrefix(strings.ToLower(part), agentSessionRestrictionScopePrefix) {
			return strings.TrimSpace(part[len(agentSessionRestrictionScopePrefix):])
		}
	}
	return ""
}

// PathRestrictionScopes encodes an exact/glob path allowlist as inert scope
// entries. They narrow a repository-bound token and never grant permission.
const workspaceRestrictionScopePrefix = "workspace:"

// WorkspaceRestrictionScope binds a token to one workspace (RFD-004). Such a
// token may push only that workspace's head ref and report that workspace's
// head; every other API route refuses it.
func WorkspaceRestrictionScope(workspaceID string) string {
	return workspaceRestrictionScopePrefix + strings.ToLower(strings.TrimSpace(workspaceID))
}

// landingWorkspaceScopePrefix names the workspace a landing credential was
// minted for. It is inert: it grants and restricts nothing, and only records
// which workspace opened a landing.
const landingWorkspaceScopePrefix = "landing-workspace:"

// LandingWorkspaceScope names the workspace a landing credential serves.
func LandingWorkspaceScope(workspaceID string) string {
	return landingWorkspaceScopePrefix + strings.ToLower(strings.TrimSpace(workspaceID))
}

// ParseTokenLandingWorkspace returns the workspace a landing credential
// serves, or "".
func ParseTokenLandingWorkspace(raw string) string {
	for _, part := range tokenScopeEntries(raw) {
		part = strings.TrimSpace(part)
		if strings.HasPrefix(strings.ToLower(part), landingWorkspaceScopePrefix) {
			return strings.ToLower(strings.TrimSpace(part[len(landingWorkspaceScopePrefix):]))
		}
	}
	return ""
}

// ParseTokenWorkspaceRestriction returns the workspace id a token is bound
// to, or "" when it carries no workspace binding.
func ParseTokenWorkspaceRestriction(raw string) string {
	for _, part := range tokenScopeEntries(raw) {
		part = strings.TrimSpace(part)
		if strings.HasPrefix(strings.ToLower(part), workspaceRestrictionScopePrefix) {
			return strings.ToLower(strings.TrimSpace(part[len(workspaceRestrictionScopePrefix):]))
		}
	}
	return ""
}

func PathRestrictionScopes(paths []string) []string {
	out := make([]string, 0, len(paths))
	seen := map[string]struct{}{}
	for _, item := range paths {
		item = strings.TrimSpace(strings.TrimPrefix(item, "/"))
		if item == "" {
			continue
		}
		encoded := pathRestrictionScopePrefix + base64.RawURLEncoding.EncodeToString([]byte(item))
		if _, ok := seen[encoded]; ok {
			continue
		}
		seen[encoded] = struct{}{}
		out = append(out, encoded)
	}
	return out
}

// ParseTokenPathRestrictions decodes the allowlist carried by a per-run token.
func ParseTokenPathRestrictions(raw string) []string {
	var out []string
	for _, part := range tokenScopeEntries(raw) {
		part = strings.TrimSpace(part)
		if !strings.HasPrefix(strings.ToLower(part), pathRestrictionScopePrefix) {
			continue
		}
		decoded, err := base64.RawURLEncoding.DecodeString(part[len(pathRestrictionScopePrefix):])
		if err == nil && len(decoded) > 0 {
			out = append(out, string(decoded))
		}
	}
	return out
}

// RepositoryRestriction returns the repository id this token is bound to, or
// 0 when unrestricted (session auth or a token without a repo binding).
func (a *AuthInfo) RepositoryRestriction() int64 {
	if a == nil || !a.IsTokenAuth {
		return 0
	}
	return ParseTokenRepositoryRestriction(a.RawScopes)
}

// WorkspaceRestriction returns the workspace id this token is bound to, or
// "" when unrestricted.
func (a *AuthInfo) WorkspaceRestriction() string {
	if a == nil || !a.IsTokenAuth {
		return ""
	}
	return ParseTokenWorkspaceRestriction(a.RawScopes)
}

func ContextWithAuthInfo(ctx context.Context, info *AuthInfo) context.Context {
	// The outer access logger retains its request context; authentication passes
	// a derived context downstream. Share only the verified identity, never the
	// token, so the logger can attribute the completed request.
	if identity, ok := ctx.Value(requestLogIdentityKey{}).(*requestLogIdentity); ok {
		id := int64(0)
		if info != nil && info.User != nil {
			id = info.User.ID
		}
		identity.userID.Store(id)
	}
	ctx = context.WithValue(ctx, authInfoContextKey, info)
	if info != nil && info.User != nil {
		ctx = context.WithValue(ctx, UserContextKey, info.User)
	}
	return ctx
}

func AuthInfoFromContext(ctx context.Context) *AuthInfo {
	info, _ := ctx.Value(authInfoContextKey).(*AuthInfo)
	return info
}

// Permission scopes and resource restrictions must use the same separators:
// recognizing a grant while dropping its binding widens the credential.
func tokenScopeEntries(raw string) []string {
	return strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || unicode.IsSpace(r) })
}

func ParseTokenScopes(raw string) ScopeSet {
	parsed := make(ScopeSet)

	// Both separators are live in the wild: tokens minted since 2026-07
	// store scopes comma-joined, older rows (e.g. the 2026-07-08 canary
	// PAT) are space-joined. Splitting on only one silently zeroes the
	// other cohort's scope set — every route then 403s "insufficient
	// token scope" on a token whose scopes are intact (prod 2026-08-04).
	for _, part := range tokenScopeEntries(raw) {
		scope := NormalizeTokenScope(part)
		if scope == "" {
			continue
		}

		parsed[scope] = struct{}{}
		if scope == ScopeAdmin {
			parsed[ScopeWriteAdmin] = struct{}{}
			parsed[ScopeReadAdmin] = struct{}{}
		}
		if strings.HasPrefix(string(scope), "write:") {
			readScope := TokenScope("read:" + strings.TrimPrefix(string(scope), "write:"))
			parsed[readScope] = struct{}{}
		}
	}

	return parsed
}

func (s ScopeSet) Has(required TokenScope) bool {
	if s == nil {
		return false
	}
	if _, ok := s[ScopeAll]; ok {
		return true
	}
	if _, ok := s[required]; ok {
		return true
	}

	// Legacy compatibility: "admin" grants admin scopes, but no longer acts
	// as a wildcard for all route families.
	if required == ScopeReadAdmin || required == ScopeWriteAdmin {
		if _, ok := s[ScopeAdmin]; ok {
			return true
		}
	}

	// Writes imply reads for callers that construct ScopeSet directly.
	if strings.HasPrefix(string(required), "read:") {
		writeScope := TokenScope("write:" + strings.TrimPrefix(string(required), "read:"))
		if _, ok := s[writeScope]; ok {
			return true
		}
	}

	return false
}

// repositoryRestrictionForbids is the REST-side gate for repository-bound
// tokens (see RepositoryRestrictionScope). Routes that address a single
// repository via {owner}/{repo} URL params pass through: LoadRepoContext
// resolves the binding there and treats the token as anonymous on every
// repository other than its own (repoVisibilityUser), and the git smart-HTTP
// proxy applies the same rule. Every other scope-gated route is a global
// surface — repository enumeration, create, import, connect, search — where
// the binding cannot be honored, so the restricted token fails closed instead
// of acting as a generic token of its scopes.
func repositoryRestrictionForbids(authInfo *AuthInfo, r *http.Request) bool {
	if authInfo.RepositoryRestriction() == 0 {
		return false
	}
	if chi.URLParam(r, "owner") != "" && chi.URLParam(r, "repo") != "" {
		return false
	}
	// A terminal's credential also reaches the few routes outside its
	// repository that its profile names (allowTerminalProfileToken): its
	// person's identity and the install's TODOs.
	delegation, ok := authInfo.Delegation()
	return !ok || delegation.Profile != TerminalProfileS1
}

func writeRepositoryRestrictionForbidden(w http.ResponseWriter) {
	errors.WriteError(w, errors.Forbidden("repository-bound token cannot access resources outside its repository"))
}

func RequireScope(required TokenScope) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			authInfo := AuthInfoFromContext(r.Context())
			if authInfo == nil || authInfo.User == nil {
				errors.WriteError(w, errors.Unauthorized("authentication required"))
				return
			}

			if !authInfo.IsTokenAuth {
				next.ServeHTTP(w, r)
				return
			}

			if !authInfo.Scopes.Has(required) {
				errors.WriteError(w, errors.Forbidden("insufficient token scope"))
				return
			}

			if repositoryRestrictionForbids(authInfo, r) {
				writeRepositoryRestrictionForbidden(w)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

// RequireTokenScope enforces scope checks only for token-authenticated requests.
// Anonymous and session-authenticated requests bypass this gate.
func RequireTokenScope(required TokenScope) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			authInfo := AuthInfoFromContext(r.Context())
			if authInfo == nil {
				next.ServeHTTP(w, r)
				return
			}

			if authInfo.User == nil {
				if authInfo.IsTokenAuth {
					errors.WriteError(w, errors.Unauthorized("authentication required"))
					return
				}
				next.ServeHTTP(w, r)
				return
			}

			if !authInfo.IsTokenAuth {
				next.ServeHTTP(w, r)
				return
			}

			if !authInfo.Scopes.Has(required) {
				errors.WriteError(w, errors.Forbidden("insufficient token scope"))
				return
			}

			if repositoryRestrictionForbids(authInfo, r) {
				writeRepositoryRestrictionForbidden(w)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

// RejectRepositoryRestrictedToken blocks tokens bound to one Plue repository
// from user-global endpoints. Those endpoints have no trustworthy Plue
// repository context against which to compare the repo:<id> restriction, so
// allowing the token through would silently widen its authority.
func RejectRepositoryRestrictedToken(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if authInfo := AuthInfoFromContext(r.Context()); authInfo != nil && authInfo.RepositoryRestriction() != 0 {
			errors.WriteError(w, errors.Forbidden("repository-restricted tokens cannot access this endpoint"))
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RequireFirstPartyAuth blocks third-party OAuth2 access tokens from mutating
// Smithers-managed credentials such as PATs, SSH keys, and sessions.
func RequireFirstPartyAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authInfo := AuthInfoFromContext(r.Context())
		if authInfo == nil || authInfo.User == nil {
			errors.WriteError(w, errors.Unauthorized("authentication required"))
			return
		}
		if authInfo.IsTokenAuth && authInfo.TokenSource == TokenSourceOAuth2AccessToken {
			errors.WriteError(w, errors.Forbidden("oauth2 access tokens cannot manage smithers credentials"))
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RequireAdmin ensures the authenticated user has the is_admin flag set.
// Returns 401 if unauthenticated, 403 if authenticated but not an admin.
func RequireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authInfo := AuthInfoFromContext(r.Context())
		if authInfo == nil || authInfo.User == nil {
			errors.WriteError(w, errors.Unauthorized("authentication required"))
			return
		}
		if !authInfo.User.IsAdmin {
			errors.WriteError(w, errors.Forbidden("admin access required"))
			return
		}
		if authInfo.IsTokenAuth && authInfo.TokenSource == TokenSourceOAuth2AccessToken {
			errors.WriteError(w, errors.Forbidden("oauth2 access tokens cannot access admin endpoints"))
			return
		}
		if authInfo.IsTokenAuth && !authInfo.Scopes.Has(ScopeReadAdmin) {
			errors.WriteError(w, errors.Forbidden("insufficient token scope"))
			return
		}
		next.ServeHTTP(w, r)
	})
}

func NormalizeTokenScope(raw string) TokenScope {
	scope := strings.ToLower(strings.TrimSpace(raw))
	if scope == "" {
		return ""
	}

	switch scope {
	case "all":
		return ScopeAll
	case "admin":
		return ScopeAdmin
	case "read:admin", "admin:read":
		return ScopeReadAdmin
	case "write:admin", "admin:write":
		return ScopeWriteAdmin
	case "repo", "repository", "write:repo", "write:repository":
		return ScopeWriteRepository
	case "read:repo", "read:repository":
		return ScopeReadRepository
	case "org", "organization", "write:organization":
		return ScopeWriteOrganization
	case "read:organization":
		return ScopeReadOrganization
	case "user", "write:user":
		return ScopeWriteUser
	case "read:user":
		return ScopeReadUser
	case "workspace", "write:workspace":
		return ScopeWriteWorkspace
	case "read:workspace":
		return ScopeReadWorkspace
	case "approval", "write:approval":
		return ScopeWriteApproval
	case "read:approval":
		return ScopeReadApproval
	case "agent", "write:agent":
		return ScopeWriteAgent
	case "read:agent":
		return ScopeReadAgent
	default:
		return ""
	}
}

// ContextAsAnonymous strips the authenticated identity from ctx so downstream
// handlers serve the request exactly as they serve an unauthenticated caller.
// Both the AuthInfo and the legacy UserContextKey value are cleared, so
// UserFromContext returns nil.
func ContextAsAnonymous(ctx context.Context) context.Context {
	ctx = context.WithValue(ctx, authInfoContextKey, (*AuthInfo)(nil))
	return context.WithValue(ctx, UserContextKey, (*db.User)(nil))
}

// PublicReadAsAnonymousWithoutTokenScope guards anonymous-readable routes. A
// session caller and a token holding the required scope keep their identity.
// A token lacking the scope, or bound to a resource (repo:, workspace:,
// agent-session:, path:), is served as an anonymous caller instead of being
// refused: a token must never see less than an anonymous caller on a public
// read, and the anonymous view carries no member-only data the token could
// not otherwise reach.
func PublicReadAsAnonymousWithoutTokenScope(required TokenScope) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			authInfo := AuthInfoFromContext(r.Context())
			if authInfo == nil || !authInfo.IsTokenAuth {
				next.ServeHTTP(w, r)
				return
			}
			if !authInfo.Scopes.Has(required) || authInfo.IsResourceBound() {
				next.ServeHTTP(w, r.WithContext(ContextAsAnonymous(r.Context())))
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

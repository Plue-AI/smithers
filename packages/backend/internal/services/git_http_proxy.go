package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	stdErrors "errors"
	"io"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// GitHTTPProxyQuerier defines the DB query surface for git smart HTTP authn
// and for protected-bookmark enforcement on receive-pack.
type GitHTTPProxyQuerier interface {
	GetAuthInfoByTokenHash(ctx context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error)
	UpdateAccessTokenLastUsed(ctx context.Context, id int64) error
	GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	ListAllProtectedBookmarksByRepo(ctx context.Context, repositoryID int64) ([]db.ProtectedBookmark, error)
}

// GitHTTPRepoHostClient defines git smart HTTP proxy operations against repo-host.
type GitHTTPRepoHostClient interface {
	InfoRefs(ctx context.Context, owner, repo, service string, stdout io.Writer) (string, error)
	ProxyUploadPack(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer) error
	ProxyReceivePack(ctx context.Context, owner, repo string, stdin io.Reader, stdout io.Writer, meta ...repohost.ReceivePackMetadata) error
}

// GitHTTPProxyService handles authn/authz and proxy dispatch for git smart HTTP routes.
type GitHTTPProxyService struct {
	queries       GitHTTPProxyQuerier
	authorizer    SSHAuthorizer
	repoHost      GitHTTPRepoHostClient
	ownerBoundary identity.OwnerAuthorizer
}

type GitHTTPProxyServiceOption func(*GitHTTPProxyService)

// WithGitHTTPSingleOwnerBoundary applies the installation-owner invariant to
// Git smart HTTP, whose token resolver intentionally lives outside AuthLoader.
func WithGitHTTPSingleOwnerBoundary(queries identity.OwnerQuerier) GitHTTPProxyServiceOption {
	return func(s *GitHTTPProxyService) {
		s.ownerBoundary = identity.NewSingleOwnerBoundary(queries)
	}
}

func NewGitHTTPProxyService(q GitHTTPProxyQuerier, authorizer SSHAuthorizer, repoHost GitHTTPRepoHostClient, opts ...GitHTTPProxyServiceOption) *GitHTTPProxyService {
	svc := &GitHTTPProxyService{
		queries:    q,
		authorizer: authorizer,
		repoHost:   repoHost,
	}
	for _, opt := range opts {
		if opt != nil {
			opt(svc)
		}
	}
	return svc
}

func (s *GitHTTPProxyService) ProxyInfoRefs(
	ctx context.Context,
	owner, repo, service, token string,
	stdout io.Writer,
) (string, error) {
	mode, err := accessModeFromInfoRefsService(service)
	if err != nil {
		return "", err
	}
	credential, err := s.authenticateTokenWithPaths(ctx, token, owner, repo)
	if err != nil {
		return "", err
	}
	user, scopes := credential.user, credential.scopes
	if mode == AccessModeWrite && user == nil {
		return "", errors.Unauthorized("authentication required")
	}
	if user != nil {
		if err := requireScopeForMode(scopes, mode); err != nil {
			return "", err
		}
	}

	if err := s.authorize(ctx, userID(user), owner, repo, mode); err != nil {
		return "", gitHTTPAuthErrorForUser(user, mode, err)
	}

	contentType, err := s.repoHost.InfoRefs(repohost.WithRefViewer(ctx, credential.refViewer()), owner, repo, service, stdout)
	if err != nil {
		return "", gitProxyFailure(ctx, "info refs", owner, repo, err)
	}
	return contentType, nil
}

func (s *GitHTTPProxyService) ProxyUploadPack(
	ctx context.Context,
	owner, repo, token string,
	stdin io.Reader,
	stdout io.Writer,
) error {
	credential, err := s.authenticateTokenWithPaths(ctx, token, owner, repo)
	if err != nil {
		return err
	}
	user := credential.user
	if user != nil {
		if err := requireScopeForMode(credential.scopes, AccessModeRead); err != nil {
			return err
		}
	}

	if err := s.authorize(ctx, userID(user), owner, repo, AccessModeRead); err != nil {
		return gitHTTPAuthErrorForUser(user, AccessModeRead, err)
	}

	if err := s.repoHost.ProxyUploadPack(repohost.WithRefViewer(ctx, credential.refViewer()), owner, repo, stdin, stdout); err != nil {
		return gitProxyFailure(ctx, "upload-pack", owner, repo, err)
	}
	return nil
}

func (s *GitHTTPProxyService) ProxyReceivePack(
	ctx context.Context,
	owner, repo, token string,
	stdin io.Reader,
	stdout io.Writer,
) error {
	credential, err := s.authenticateTokenWithPaths(ctx, token, owner, repo)
	if err != nil {
		return err
	}
	user := credential.user
	if user == nil {
		return errors.Unauthorized("authentication required")
	}
	if err := requireScopeForMode(credential.scopes, AccessModeWrite); err != nil {
		return err
	}

	if err := s.authorize(ctx, user.ID, owner, repo, AccessModeWrite); err != nil {
		return err
	}

	// Protected-bookmark policy: parse the ref-update commands before the pack
	// reaches git, and reject any direct update or delete of a protected
	// bookmark. Landing requests move protected bookmarks through repo-host's
	// land endpoint, not receive-pack, so this cannot block landings.
	commands, rebuilt, err := repohost.PeekReceivePackCommands(stdin)
	if err != nil {
		return errors.BadRequest("malformed git receive-pack request")
	}
	stdin = rebuilt
	if err := s.rejectProtectedBookmarkPush(ctx, owner, repo, credential.kind, commands); err != nil {
		return err
	}
	// RFD-004: refs/smithers/ is the control plane's namespace. A workspace
	// credential may write only its own head ref; a user credential only its
	// own refs/smithers/users/<id>/ (#1964); nothing else may write there.
	if msg := repohost.ReservedRefViolation(commands, credential.workspaceID, user.ID); msg != "" {
		return errors.Forbidden(msg)
	}

	repository, err := s.queries.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{
		Owner: strings.ToLower(owner), LowerName: strings.ToLower(repo),
	})
	if err != nil {
		return errors.Internal("failed to resolve push repository").WithCause(err)
	}
	meta := repohost.ReceivePackMetadata{
		RepositoryID:     repository.ID,
		PusherID:         user.ID,
		PusherLogin:      user.Username,
		PusherCredential: credential.kind,
		AllowedPaths:     credential.allowedPaths,
		WorkspaceID:      credential.workspaceID,
		VerifyLocked:     RepositoryStillAt(s.queries, repository.ID, owner, repo),
	}
	if err := s.repoHost.ProxyReceivePack(ctx, owner, repo, stdin, stdout, meta); err != nil {
		if stdErrors.Is(err, repohost.ErrRepositoryReplaced) {
			// Deleted, transferred or renamed away while the push waited for
			// the lock. A retry authorizes against whatever owner/repo names now.
			return errors.Conflict("repository was replaced during the push; retry the push")
		}
		return gitProxyFailure(ctx, "receive-pack", owner, repo, err)
	}
	return nil
}

// RepositoryStillAt is a push's ReceivePackMetadata.VerifyLocked: owner/repo
// must still name repositoryID once repo-host holds the repository lock, or
// the push is refused with repohost.ErrRepositoryReplaced. It reads the same
// row the producer authorized the push against.
func RepositoryStillAt(
	q interface {
		GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	},
	repositoryID int64,
	owner, repo string,
) func(context.Context) error {
	return func(ctx context.Context) error {
		current, err := q.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{
			Owner: strings.ToLower(owner), LowerName: strings.ToLower(repo),
		})
		if stdErrors.Is(err, pgx.ErrNoRows) || (err == nil && current.ID != repositoryID) {
			return repohost.ErrRepositoryReplaced
		}
		return err
	}
}

// rejectProtectedBookmarkPush fails a receive-pack request when any of its
// ref-update commands targets a bookmark matching a protected-bookmark
// pattern, or, for an agent run's credential, the default bookmark.
// Non-branch refs (tags, ...) are not subject to bookmark protection.
func (s *GitHTTPProxyService) rejectProtectedBookmarkPush(ctx context.Context, owner, repo string, kind middleware.CredentialKind, commands []repohost.ReceivePackCommand) error {
	if len(commands) == 0 || s.queries == nil {
		return nil
	}

	var repository db.Repository
	repoResolved := false
	for _, command := range commands {
		bookmark, ok := BookmarkNameFromRef(command.RefName)
		if !ok {
			continue
		}
		if !repoResolved {
			var err error
			repository, err = s.queries.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{
				Owner:     strings.ToLower(owner),
				LowerName: strings.ToLower(repo),
			})
			if err != nil {
				if stdErrors.Is(err, pgx.ErrNoRows) {
					return errors.NotFound("repository not found")
				}
				return errors.Internal("failed to resolve repository").WithCause(err)
			}
			repoResolved = true
		}
		if err := RequireBookmarkNotProtected(ctx, s.queries, repository.ID, bookmark); err != nil {
			return err
		}
		if err := RequireAgentRunOffDefaultBookmark(kind, repository.DefaultBookmark, bookmark); err != nil {
			return err
		}
	}
	return nil
}

// authenticateToken resolves the token to a user + scope set for a request
// against owner/repo. A repository-bound token (per-run sandbox/agent token,
// see middleware.RepositoryRestrictionScope) is downgraded to anonymous when
// the request targets any repository other than the one it is bound to, so a
// leaked token cannot read private — or push to any — other repositories.
// gitHTTPCredential is what a git request's token authenticates: its user
// (nil when anonymous), grants and bindings, and who holds it.
type gitHTTPCredential struct {
	user         *db.User
	scopes       middleware.ScopeSet
	allowedPaths []string
	workspaceID  string
	kind         middleware.CredentialKind
}

// refViewer is the user whose own refs/smithers/users/<id>/ refs the
// credential sees in git reads: a person's, never a workspace credential's,
// which writes no user ref.
func (c gitHTTPCredential) refViewer() int64 {
	if c.user == nil || c.workspaceID != "" {
		return 0
	}
	return c.user.ID
}

func (s *GitHTTPProxyService) authenticateTokenWithPaths(
	ctx context.Context,
	token string,
	owner, repo string,
) (gitHTTPCredential, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return gitHTTPCredential{}, nil
	}

	if s.queries == nil {
		return gitHTTPCredential{}, errors.Internal("token auth is not configured")
	}

	hash := sha256.Sum256([]byte(token))
	tokenHash := hex.EncodeToString(hash[:])

	authRow, err := s.queries.GetAuthInfoByTokenHash(ctx, tokenHash)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return gitHTTPCredential{}, errors.Unauthorized("invalid or expired token")
		}
		return gitHTTPCredential{}, errors.Internal("failed to authenticate token").WithCause(err)
	}

	user := db.User{
		ID:            authRow.ID,
		Username:      authRow.Username,
		LowerUsername: authRow.LowerUsername,
		Email:         authRow.Email,
		LowerEmail:    authRow.LowerEmail,
		DisplayName:   authRow.DisplayName,
		Bio:           authRow.Bio,
		AvatarUrl:     authRow.AvatarUrl,
		WalletAddress: authRow.WalletAddress,
		UserType:      authRow.UserType,
		IsActive:      authRow.IsActive,
		IsAdmin:       authRow.IsAdmin,
		ProhibitLogin: authRow.ProhibitLogin,
		LastLoginAt:   authRow.LastLoginAt,
		CreatedAt:     authRow.CreatedAt,
		UpdatedAt:     authRow.UpdatedAt,
	}
	if s.ownerBoundary != nil {
		if err := s.ownerBoundary.AuthorizeOwner(ctx, user.ID); err != nil {
			return gitHTTPCredential{}, err
		}
	}
	if err := s.queries.UpdateAccessTokenLastUsed(ctx, authRow.TokenID); err != nil {
		return gitHTTPCredential{}, errors.Internal("failed to update token last used timestamp").WithCause(err)
	}

	if restriction := middleware.ParseTokenRepositoryRestriction(authRow.TokenScopes); restriction != 0 &&
		!s.tokenBoundToRepo(ctx, restriction, owner, repo) {
		return gitHTTPCredential{}, nil
	}

	return gitHTTPCredential{
		user:         &user,
		scopes:       middleware.ParseTokenScopes(authRow.TokenScopes),
		allowedPaths: middleware.ParseTokenPathRestrictions(authRow.TokenScopes),
		workspaceID:  middleware.ParseTokenWorkspaceRestriction(authRow.TokenScopes),
		kind:         middleware.TokenCredentialKind(authRow.TokenSystemIssued, authRow.TokenScopes, user.UserType),
	}, nil
}

// tokenBoundToRepo reports whether the repository named by owner/repo is the
// one a repository-bound token is restricted to. Unresolvable repositories
// count as a mismatch (fail closed).
func (s *GitHTTPProxyService) tokenBoundToRepo(ctx context.Context, restriction int64, owner, repo string) bool {
	repository, err := s.queries.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{
		Owner:     strings.ToLower(owner),
		LowerName: strings.ToLower(repo),
	})
	if err != nil {
		return false
	}
	return repository.ID == restriction
}

func requireScopeForMode(scopes middleware.ScopeSet, mode AccessMode) error {
	switch mode {
	case AccessModeRead:
		if !scopes.Has(middleware.ScopeReadRepository) {
			return errors.Forbidden("insufficient token scope")
		}
	case AccessModeWrite:
		if !scopes.Has(middleware.ScopeWriteRepository) {
			return errors.Forbidden("insufficient token scope")
		}
	default:
		return errors.BadRequest("unsupported access mode")
	}

	return nil
}

func accessModeFromInfoRefsService(service string) (AccessMode, error) {
	switch strings.TrimSpace(service) {
	case "git-upload-pack":
		return AccessModeRead, nil
	case "git-receive-pack":
		return AccessModeWrite, nil
	default:
		return "", errors.BadRequest("unsupported git service")
	}
}

func userID(user *db.User) int64 {
	if user == nil {
		return 0
	}
	return user.ID
}

func gitHTTPAuthErrorForUser(user *db.User, mode AccessMode, err error) error {
	if err == nil {
		return nil
	}
	if user != nil || mode != AccessModeRead {
		return err
	}
	apiErr, ok := err.(*errors.APIError)
	if !ok || apiErr.Status != 403 {
		return err
	}
	return errors.Unauthorized("authentication required")
}

func (s *GitHTTPProxyService) authorize(ctx context.Context, userID int64, owner, repo string, mode AccessMode) error {
	if s.authorizer == nil {
		return errors.Internal("authorization service is not configured")
	}

	err := s.authorizer.Authorize(ctx, userID, owner, repo, mode)
	if err == nil {
		return nil
	}

	if apiErr, ok := err.(*errors.APIError); ok {
		if apiErr.Status == http.StatusNotFound {
			// Do not reveal repository existence over the git transport: the
			// SSH gateway already collapses "not found" and "permission
			// denied" into one indistinguishable denial, and the HTTP git
			// endpoints must not reintroduce an enumeration oracle. Anonymous
			// readers see this as the same 401 challenge a private repo gets;
			// authenticated callers see the same 403 as for a private repo.
			return errors.Forbidden("permission denied")
		}
		return err
	}
	return errors.Internal("failed to authorize repository access")
}

// gitProxyFailure preserves explicit admission and push refusals. Other errors
// are logged with their cause and returned as a sanitized 500.
func gitProxyFailure(ctx context.Context, operation, owner, repo string, err error) error {
	if operation == "upload-pack" {
		if admission := uploadPackAdmissionError(err); admission != nil {
			return admission
		}
	}
	if status, ok := repohost.IsStatusError(err); ok && status.Code == repohost.PushTooSlowCode {
		return errors.New(errors.CodePushTooSlow, status.Message)
	}
	if status, ok := repohost.IsStatusError(err); ok && status.StatusCode == http.StatusRequestEntityTooLarge {
		switch status.Code {
		case repohost.PushTooLargeCode:
			return errors.New(errors.CodePushTooLarge, status.Message)
		case repohost.UserRefPushTooLargeCode:
			return errors.New(errors.CodeUserRefPushTooLarge, status.Message)
		}
	}
	middleware.LoggerFromContext(ctx).Error("git proxy to repo-host failed",
		"operation", operation, "owner", owner, "repo", repo, "error", err)
	return errors.Internal("failed to proxy git " + operation)
}

package services

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	stdErrors "errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/observability"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const getGitHubAppInstallationForUserRepoSQL = `
SELECT gir.installation_id
FROM repo_connections rc
JOIN github_app_installation_repositories gir
  ON gir.owner_login_lower = rc.repo_owner_lower
 AND gir.repo_name_lower = rc.repo_name_lower
WHERE rc.user_id = $1
  AND rc.repo_owner_lower = $2
  AND rc.repo_name_lower = $3
LIMIT 1;
`

const getGitHubAppInstallationForOrgRepoSQL = `
SELECT gir.installation_id
FROM repo_connections rc
JOIN org_members om
  ON om.user_id = rc.user_id
 AND om.organization_id = $1
JOIN github_app_installation_repositories gir
  ON gir.owner_login_lower = rc.repo_owner_lower
 AND gir.repo_name_lower = rc.repo_name_lower
WHERE rc.repo_owner_lower = $2
  AND rc.repo_name_lower = $3
LIMIT 1;
`

const getPublicGitHubAppInstallationExistsForRepoSQL = `
SELECT TRUE
FROM github_app_installation_repositories
WHERE owner_login_lower = $1
  AND repo_name_lower = $2
  AND is_private = FALSE
LIMIT 1;
`

const getPublicGitHubAppInstallationForRepoSQL = `
SELECT installation_id
FROM github_app_installation_repositories
WHERE owner_login_lower = $1
  AND repo_name_lower = $2
  AND is_private = FALSE
LIMIT 1;
`

const markGitHubAppInstallationRepositoryPrivateSQL = `
UPDATE github_app_installation_repositories
SET is_private = TRUE,
    updated_at = NOW()
WHERE owner_login_lower = $1
  AND repo_name_lower = $2
  AND is_private = FALSE;
`

const getReadyImportedSourceProvenanceForUserRepoSQL = `
SELECT TRUE
FROM import_jobs
WHERE user_id = $1
  AND repository_id = $2
  AND lower(github_owner) = $3
  AND lower(github_repo) = $4
  AND status = 'ready'
LIMIT 1;
`

const (
	defaultGitHubAPIBaseURL = "https://api.github.com"
	envGitHubAppAPIBaseURL  = "SMITHERS_GITHUB_APP_API_BASE_URL"
)

// GitHubAppCredentialReader reads the install's sealed GitHub App credentials.
// Callers share one store; unavailable or corrupt credentials fail closed.
type GitHubAppCredentialReader interface {
	Load(context.Context) (GitHubAppCredentials, error)
	InstallURL(context.Context) (string, error)
	AppJWT(context.Context) (string, error)
}

func loadGitHubAppCredentials(ctx context.Context, store GitHubAppCredentialReader) (GitHubAppCredentials, error) {
	if store == nil {
		return GitHubAppCredentials{}, ErrGitHubAppNotConfigured
	}
	return store.Load(ctx)
}

func githubAppJWT(ctx context.Context, store GitHubAppCredentialReader) (string, error) {
	if store == nil {
		return "", ErrGitHubAppNotConfigured
	}
	return store.AppJWT(ctx)
}

type GitHubAppStatus struct {
	GitHubAppInstalled bool `json:"github_app_installed"`
	// GitHubAppConfigured reports whether this install has stored App credentials.
	GitHubAppConfigured      bool   `json:"github_app_configured"`
	InstallationID           int64  `json:"installation_id,omitempty"`
	InstallURL               string `json:"install_url"`
	Owner                    string `json:"owner,omitempty"`
	Repo                     string `json:"repo,omitempty"`
	GitHubRateLimitLimit     int    `json:"github_rate_limit_limit,omitempty"`
	GitHubRateLimitRemaining int    `json:"github_rate_limit_remaining,omitempty"`
	GitHubRateLimitReset     string `json:"github_rate_limit_reset,omitempty"`
}

type GitHubInstallationToken struct {
	InstallationID int64     `json:"installation_id"`
	Token          string    `json:"token"`
	ExpiresAt      time.Time `json:"expires_at"`
}

var errGitHubImportedSourceProvenanceNotFound = stdErrors.New("github imported source provenance not found")

// errGitHubImportedSourceAppNotInstalled is the cause of the refusal for a
// verified imported source the App does not cover; the proxy may then read it
// with the importer's own GitHub credential.
var errGitHubImportedSourceAppNotInstalled = stdErrors.New("github app is not installed for this imported source")

// GitHubRepositoryInstallationResolver resolves the GitHub App installation
// for a Smithers repository's owner/repo on background (no-actor) paths,
// scoped to the repository owner's repo_connections binding. Implemented by
// *RepoConnectionService.
type GitHubRepositoryInstallationResolver interface {
	GetGitHubInstallationIDForRepositoryOwner(ctx context.Context, ownerUserID int64, ownerOrgID int64, owner string, repo string) (int64, error)
}

func (s *RepoConnectionService) GetGitHubAppStatus(
	ctx context.Context,
	userID int64,
	owner string,
	repo string,
) (GitHubAppStatus, error) {
	if userID <= 0 {
		return GitHubAppStatus{}, pkgerrors.Unauthorized("authentication required")
	}

	normalizedOwner, normalizedRepo, err := normalizeRepoRef(owner, repo)
	if err != nil {
		return GitHubAppStatus{}, err
	}

	_, credentialErr := loadGitHubAppCredentials(ctx, s.githubAppCredentials)
	configured := credentialErr == nil
	if credentialErr != nil && !stdErrors.Is(credentialErr, ErrGitHubAppNotConfigured) {
		return GitHubAppStatus{}, pkgerrors.Internal("failed to load github app credentials").WithCause(credentialErr)
	}
	installURL := ""
	if configured {
		installURL, err = s.githubAppCredentials.InstallURL(ctx)
		if err != nil {
			return GitHubAppStatus{}, pkgerrors.Internal("failed to load github app install url").WithCause(err)
		}
	}
	status := GitHubAppStatus{
		GitHubAppConfigured: configured,
		InstallURL:          installURL,
		Owner:               strings.TrimSpace(owner),
		Repo:                strings.TrimSpace(repo),
	}

	// Authorized path: the caller has connected this repo (repo_connections row
	// scoped to their user_id). Only this path may expose the installation_id
	// and rate-limit budget.
	var installationID int64
	err = s.db.QueryRow(
		ctx,
		getGitHubAppInstallationForUserRepoSQL,
		userID,
		normalizedOwner,
		normalizedRepo,
	).Scan(&installationID)
	if err == nil {
		status.GitHubAppInstalled = installationID > 0
		if installationID > 0 {
			status.InstallationID = installationID
			if s.gitHubBudgetTracker != nil {
				rateLimit := s.gitHubBudgetTracker.Status(installationID)
				status.GitHubRateLimitLimit = rateLimit.Limit
				status.GitHubRateLimitRemaining = rateLimit.Remaining
				status.GitHubRateLimitReset = rateLimit.ResetAt.Format(time.RFC3339)
			} else {
				status.GitHubRateLimitLimit = GitHubInstallationHourlyBudget
				status.GitHubRateLimitRemaining = GitHubInstallationHourlyBudget
				status.GitHubRateLimitReset = time.Now().UTC().Add(time.Hour).Format(time.RFC3339)
			}
		}
		return status, nil
	}
	if !stdErrors.Is(err, pgx.ErrNoRows) {
		return GitHubAppStatus{}, pkgerrors.Internal("failed to load github app installation")
	}

	// Unauthorized-to-repo fallback: needed only for the pre-connection connect
	// flow, which exclusively targets PUBLIC repos. Reveal ONLY the boolean
	// installed signal for public repos — never the installation_id or rate-limit
	// budget, and never any signal about private repos (prevents cross-tenant
	// enumeration of GitHub App installations).
	var installedPublic bool
	err = s.db.QueryRow(
		ctx,
		getPublicGitHubAppInstallationExistsForRepoSQL,
		normalizedOwner,
		normalizedRepo,
	).Scan(&installedPublic)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return status, nil
		}
		return GitHubAppStatus{}, pkgerrors.Internal("failed to load github app installation").WithCause(err)
	}
	status.GitHubAppInstalled = installedPublic
	return status, nil
}

func (s *RepoConnectionService) CreateGitHubInstallationToken(
	ctx context.Context,
	userID int64,
	owner string,
	repo string,
) (GitHubInstallationToken, error) {
	if userID <= 0 {
		return GitHubInstallationToken{}, pkgerrors.Unauthorized("authentication required")
	}

	normalizedOwner, normalizedRepo, err := normalizeRepoRef(owner, repo)
	if err != nil {
		return GitHubInstallationToken{}, err
	}

	installationID, err := s.lookupGitHubInstallationID(ctx, userID, normalizedOwner, normalizedRepo)
	if err != nil {
		return GitHubInstallationToken{}, err
	}
	if installationID <= 0 {
		return GitHubInstallationToken{}, pkgerrors.BadRequest("github app is not installed for this repository")
	}

	return s.createGitHubInstallationTokenForInstallationID(ctx, installationID)
}

// CreateGitHubInstallationTokenForRepositoryOwner mints a token for internal
// (no-actor) workflow paths where owner/repo came from Smithers repository
// state. Resolution is still connection-scoped: a repo_connections row binding
// the Smithers repository's owning user (or, for org-owned repositories, an
// org member) to the GitHub owner/repo must exist. Smithers user/org names are
// freely chosen, so a bare owner/repo string match would let a name-colliding
// Smithers repo resolve a victim's installation.
//
// The token is scoped to that one repository and to the caller's permissions,
// which must be non-empty. These paths push agent-written commits, so they must
// never carry the App's full authority (for example workflows:write, which
// lets a pushed .github/workflows file run with the repository's secrets).
func (s *RepoConnectionService) CreateGitHubInstallationTokenForRepositoryOwner(
	ctx context.Context,
	ownerUserID int64,
	ownerOrgID int64,
	owner string,
	repo string,
	permissions map[string]string,
) (GitHubInstallationToken, error) {
	if len(permissions) == 0 {
		return GitHubInstallationToken{}, pkgerrors.Internal("scoped github installation token requires permissions")
	}
	installationID, err := s.GetGitHubInstallationIDForRepositoryOwner(ctx, ownerUserID, ownerOrgID, owner, repo)
	if err != nil {
		return GitHubInstallationToken{}, err
	}
	if installationID <= 0 {
		return GitHubInstallationToken{}, pkgerrors.BadRequest("github app is not installed for this repository")
	}
	_, normalizedRepo, err := normalizeRepoRef(owner, repo)
	if err != nil {
		return GitHubInstallationToken{}, err
	}

	return s.mintGitHubInstallationToken(ctx, installationID, &gitHubInstallationTokenScope{
		Repositories: []string{normalizedRepo},
		Permissions:  permissions,
	})
}

// gitHubInstallationTokenScope is the body of a scoped access_tokens request.
// GitHub refuses a token wider than the installation and refuses any request
// the token's permissions do not cover.
type gitHubInstallationTokenScope struct {
	Repositories []string          `json:"repositories"`
	Permissions  map[string]string `json:"permissions"`
}

// CreateGitHubInstallationTokenForImportedSource mints a token for a public
// GitHub source repository only when the actor has a completed import_jobs row
// tying that source to the resolved local Smithers repository. This gives
// imported public mirrors source-coordinate GitHub access without trusting
// owner/repo strings or requiring an actor repo_connections row for the source.
func (s *RepoConnectionService) CreateGitHubInstallationTokenForImportedSource(
	ctx context.Context,
	userID int64,
	repositoryID int64,
	owner string,
	repo string,
) (GitHubInstallationToken, error) {
	if userID <= 0 {
		return GitHubInstallationToken{}, pkgerrors.Unauthorized("authentication required")
	}
	if repositoryID <= 0 {
		return GitHubInstallationToken{}, pkgerrors.BadRequest("repository id must be positive")
	}

	normalizedOwner, normalizedRepo, err := normalizeRepoRef(owner, repo)
	if err != nil {
		return GitHubInstallationToken{}, err
	}

	provenanceMatches, err := s.readyImportedSourceProvenanceExists(ctx, userID, repositoryID, normalizedOwner, normalizedRepo)
	if err != nil {
		return GitHubInstallationToken{}, err
	}
	if !provenanceMatches {
		return GitHubInstallationToken{}, errGitHubImportedSourceProvenanceNotFound
	}

	installationID, err := s.lookupPublicGitHubInstallationID(ctx, normalizedOwner, normalizedRepo)
	if err != nil {
		return GitHubInstallationToken{}, err
	}
	if installationID <= 0 {
		return GitHubInstallationToken{}, pkgerrors.BadRequest("github app is not installed for this repository").WithCause(errGitHubImportedSourceAppNotInstalled)
	}

	token, err := s.createGitHubInstallationTokenForInstallationID(ctx, installationID)
	if err != nil {
		return GitHubInstallationToken{}, err
	}
	if err := s.confirmImportedSourceReadable(ctx, userID, normalizedOwner, normalizedRepo, token.Token); err != nil {
		return GitHubInstallationToken{}, err
	}
	return token, nil
}

// githubImportedSourcePublicTTL bounds how long a live "still public" answer
// lets imported-source tokens skip GitHub. A repo made private stops serving
// non-readers within this window.
const githubImportedSourcePublicTTL = 5 * time.Minute

// confirmImportedSourceReadable re-checks, live, that an imported source is
// still public before its installation token is used on the importer's
// behalf. is_private comes from installation webhooks, and a later visibility
// change can leave it stale. If GitHub now reports the repo private, the flag
// is corrected and the actor must prove read access with their own GitHub
// credential; otherwise the request is refused with FORBIDDEN_ACTION and
// github.proxy.imported_source_private is logged. A failed check fails closed.
func (s *RepoConnectionService) confirmImportedSourceReadable(ctx context.Context, userID int64, owner, repo, installationToken string) error {
	slug := owner + "/" + repo
	now := time.Now()
	s.importedSourceMu.Lock()
	exp, ok := s.importedSourcePublic[slug]
	s.importedSourceMu.Unlock()
	if ok && now.Before(exp) {
		return nil
	}

	private, err := s.fetchGitHubRepoPrivate(ctx, installationToken, owner, repo)
	if err != nil {
		slog.Warn("github.proxy.imported_source_visibility_unknown", "user_id", userID, "github_owner", owner, "github_repo", repo, "error", err)
		return err
	}
	if !private {
		s.importedSourceMu.Lock()
		if s.importedSourcePublic == nil {
			s.importedSourcePublic = map[string]time.Time{}
		}
		s.importedSourcePublic[slug] = now.Add(githubImportedSourcePublicTTL)
		s.importedSourceMu.Unlock()
		return nil
	}

	if _, err := s.db.Exec(ctx, markGitHubAppInstallationRepositoryPrivateSQL, owner, repo); err != nil {
		slog.Warn("github.proxy.imported_source_flag_not_corrected", "github_owner", owner, "github_repo", repo, "error", err)
	}
	if reader, ok := s.githubAccessVerifier.(RepositoryJobGitHubReadAccess); ok && reader.GitHubRepoReadAuthorized(ctx, userID, owner, repo) {
		return nil
	}
	slog.Warn("github.proxy.imported_source_private", "user_id", userID, "github_owner", owner, "github_repo", repo)
	return &pkgerrors.APIError{
		Status:  http.StatusForbidden,
		Code:    pkgerrors.CodeGitHubForbiddenAction,
		Message: fmt.Sprintf("%s/%s is now private and your GitHub account cannot read it", owner, repo),
	}
}

// fetchGitHubRepoPrivate asks GitHub for a repository's current visibility.
func (s *RepoConnectionService) fetchGitHubRepoPrivate(ctx context.Context, token, owner, repo string) (bool, error) {
	endpoint := strings.TrimRight(githubAPIBaseURL(), "/") + "/repos/" + url.PathEscape(owner) + "/" + url.PathEscape(repo)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return false, pkgerrors.Internal("failed to build github repository request").WithCause(err)
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(token))
	req.Header.Set("User-Agent", "smithers-server")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	resp, err := s.gitHubBudgetTracker.WrapClient(observability.NewHTTPClient(10 * time.Second)).Do(req)
	if err != nil {
		return false, pkgerrors.New(pkgerrors.CodeGitHubUnavailable, "github repository visibility check failed")
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode == http.StatusNotFound {
		return false, pkgerrors.BadRequest("github app is not installed for this repository")
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return false, pkgerrors.New(pkgerrors.CodeGitHubUnavailable, "github repository visibility check was rejected")
	}
	var payload struct {
		Private *bool `json:"private"`
	}
	if json.Unmarshal(body, &payload) != nil || payload.Private == nil {
		return false, pkgerrors.New(pkgerrors.CodeGitHubUnavailable, "github repository visibility check returned no visibility")
	}
	return *payload.Private, nil
}

// CreateGitHubInstallationTokenForInternalInstallation mints a token when a
// trusted workflow path already resolved the installation ID from Smithers DB.
func (s *RepoConnectionService) CreateGitHubInstallationTokenForInternalInstallation(
	ctx context.Context,
	installationID int64,
) (GitHubInstallationToken, error) {
	if installationID <= 0 {
		return GitHubInstallationToken{}, pkgerrors.BadRequest("installation id must be positive")
	}

	return s.createGitHubInstallationTokenForInstallationID(ctx, installationID)
}

func (s *RepoConnectionService) createGitHubInstallationTokenForInstallationID(
	ctx context.Context,
	installationID int64,
) (GitHubInstallationToken, error) {
	if installationID <= 0 {
		return GitHubInstallationToken{}, pkgerrors.BadRequest("github app is not installed for this repository")
	}

	if _, err := loadGitHubAppCredentials(ctx, s.githubAppCredentials); err != nil {
		return GitHubInstallationToken{}, pkgerrors.Internal("failed to load github app credentials").WithCause(err)
	}

	return s.mintGitHubInstallationToken(ctx, installationID, nil)
}

// mintGitHubInstallationToken asks GitHub for an installation token. A nil
// scope mints the full-installation token. Repository and permission scopes
// have separate cache entries; caller authorization still precedes this method.
func (s *RepoConnectionService) mintGitHubInstallationToken(
	ctx context.Context,
	installationID int64,
	scope *gitHubInstallationTokenScope,
) (GitHubInstallationToken, error) {
	requestBody := []byte("{}")
	if scope != nil {
		encoded, err := json.Marshal(scope)
		if err != nil {
			return GitHubInstallationToken{}, pkgerrors.Internal("failed to encode github token scope").WithCause(err)
		}
		requestBody = encoded
	}

	if _, err := loadGitHubAppCredentials(ctx, s.githubAppCredentials); err != nil {
		return GitHubInstallationToken{}, pkgerrors.Internal("failed to load github app credentials").WithCause(err)
	}

	cacheKey := installationTokenKey(installationID, scope)
	if cached, ok := getCachedInstallationTokenKey(cacheKey); ok {
		s.gitHubBudgetTracker.registerToken(cached.token, installationID)
		return GitHubInstallationToken{InstallationID: installationID, Token: cached.token, ExpiresAt: cached.expiresAt}, nil
	}

	jwt, err := githubAppJWT(ctx, s.githubAppCredentials)
	if err != nil {
		return GitHubInstallationToken{}, pkgerrors.Internal("failed to create github app jwt").WithCause(err)
	}

	endpoint := fmt.Sprintf(
		"%s/app/installations/%d/access_tokens",
		strings.TrimRight(githubAPIBaseURL(), "/"),
		installationID,
	)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(requestBody))
	if err != nil {
		return GitHubInstallationToken{}, pkgerrors.Internal("failed to build github token request").WithCause(err)
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Authorization", "Bearer "+jwt)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "smithers-server")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	httpClient := s.gitHubBudgetTracker.WrapClient(observability.NewHTTPClient(10 * time.Second))
	resp, err := httpClient.Do(req)
	if err != nil {
		return GitHubInstallationToken{}, pkgerrors.Internal("github installation token request failed").WithCause(err)
	}
	defer func() { _ = resp.Body.Close() }()

	bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))

	var payload struct {
		Token     string `json:"token"`
		ExpiresAt string `json:"expires_at"`
		Message   string `json:"message"`
	}
	_ = json.Unmarshal(bodyBytes, &payload)

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		message := strings.TrimSpace(payload.Message)
		if message == "" {
			message = "github installation token request was rejected"
		}
		if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
			return GitHubInstallationToken{}, pkgerrors.Forbidden(message)
		}
		return GitHubInstallationToken{}, pkgerrors.Internal(message)
	}

	token := strings.TrimSpace(payload.Token)
	if token == "" {
		return GitHubInstallationToken{}, pkgerrors.Internal("github installation token response was missing token")
	}

	expiresAt, err := time.Parse(time.RFC3339, strings.TrimSpace(payload.ExpiresAt))
	if err != nil {
		return GitHubInstallationToken{}, pkgerrors.Internal("github installation token response had invalid expiry").WithCause(err)
	}

	storeCachedInstallationTokenKey(cacheKey, token, expiresAt)
	s.gitHubBudgetTracker.registerToken(token, installationID)
	return GitHubInstallationToken{
		InstallationID: installationID,
		Token:          token,
		ExpiresAt:      expiresAt,
	}, nil
}

// installationTokenEarlyExpiry treats a cached installation token as expired this
// long before its real expiry, so a token is never handed out with too little
// life left for the caller's request (Octokit-convention default).
const installationTokenEarlyExpiry = 5 * time.Minute

type cachedInstallationToken struct {
	token     string
	expiresAt time.Time
}

var (
	installationTokenCacheMu sync.Mutex
	installationTokenCache   = map[installationTokenCacheKey]cachedInstallationToken{}
)

// installationTokenCacheKey replaces the installation-only key so a scoped
// token cannot inherit another repository's or permission set's authority.
type installationTokenCacheKey struct {
	installationID int64
	scope          string
}

func installationTokenKey(installationID int64, scope *gitHubInstallationTokenScope) installationTokenCacheKey {
	key := installationTokenCacheKey{installationID: installationID}
	if scope != nil {
		repositories := append([]string(nil), scope.Repositories...)
		sort.Strings(repositories)
		normalized := gitHubInstallationTokenScope{Repositories: repositories, Permissions: scope.Permissions}
		raw, _ := json.Marshal(normalized) // strings, slices and maps cannot fail encoding
		key.scope = string(raw)
	}
	return key
}

func getCachedInstallationToken(installationID int64) (cachedInstallationToken, bool) {
	return getCachedInstallationTokenKey(installationTokenKey(installationID, nil))
}

func getCachedInstallationTokenKey(key installationTokenCacheKey) (cachedInstallationToken, bool) {
	installationTokenCacheMu.Lock()
	defer installationTokenCacheMu.Unlock()
	cached, ok := installationTokenCache[key]
	if !ok || !time.Now().Add(installationTokenEarlyExpiry).Before(cached.expiresAt) {
		delete(installationTokenCache, key)
		return cachedInstallationToken{}, false
	}
	return cached, true
}

func storeCachedInstallationToken(installationID int64, token string, expiresAt time.Time) {
	storeCachedInstallationTokenKey(installationTokenKey(installationID, nil), token, expiresAt)
}

func storeCachedInstallationTokenKey(key installationTokenCacheKey, token string, expiresAt time.Time) {
	installationTokenCacheMu.Lock()
	defer installationTokenCacheMu.Unlock()
	installationTokenCache[key] = cachedInstallationToken{token: token, expiresAt: expiresAt}
}

// Invalidation removes every permission/repository scope for the installation.
func invalidateCachedInstallationToken(installationID int64) {
	installationTokenCacheMu.Lock()
	defer installationTokenCacheMu.Unlock()
	for key := range installationTokenCache {
		if key.installationID == installationID {
			delete(installationTokenCache, key)
		}
	}
}

func (s *RepoConnectionService) lookupGitHubInstallationID(
	ctx context.Context,
	userID int64,
	normalizedOwner string,
	normalizedRepo string,
) (int64, error) {
	var installationID int64
	err := s.db.QueryRow(
		ctx,
		getGitHubAppInstallationForUserRepoSQL,
		userID,
		normalizedOwner,
		normalizedRepo,
	).Scan(&installationID)
	if err == nil {
		return installationID, nil
	}
	if !stdErrors.Is(err, pgx.ErrNoRows) {
		return 0, pkgerrors.Internal("failed to load github app installation")
	}
	return 0, nil
}

func (s *RepoConnectionService) readyImportedSourceProvenanceExists(
	ctx context.Context,
	userID int64,
	repositoryID int64,
	normalizedOwner string,
	normalizedRepo string,
) (bool, error) {
	var exists bool
	err := s.db.QueryRow(
		ctx,
		getReadyImportedSourceProvenanceForUserRepoSQL,
		userID,
		repositoryID,
		normalizedOwner,
		normalizedRepo,
	).Scan(&exists)
	if err == nil {
		return exists, nil
	}
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return false, pkgerrors.Internal("failed to load imported github source provenance")
}

func (s *RepoConnectionService) lookupPublicGitHubInstallationID(
	ctx context.Context,
	normalizedOwner string,
	normalizedRepo string,
) (int64, error) {
	var installationID int64
	err := s.db.QueryRow(
		ctx,
		getPublicGitHubAppInstallationForRepoSQL,
		normalizedOwner,
		normalizedRepo,
	).Scan(&installationID)
	if err == nil {
		return installationID, nil
	}
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	return 0, pkgerrors.Internal("failed to load github app installation")
}

// GetGitHubInstallationIDForUserRepo resolves the GitHub App installation for
// a GitHub owner/repo only when the given user holds a repo_connections row
// binding them to it. Returns 0 when no scoped binding exists.
func (s *RepoConnectionService) GetGitHubInstallationIDForUserRepo(
	ctx context.Context,
	userID int64,
	owner string,
	repo string,
) (int64, error) {
	if userID <= 0 {
		return 0, pkgerrors.Unauthorized("authentication required")
	}
	normalizedOwner, normalizedRepo, err := normalizeRepoRef(owner, repo)
	if err != nil {
		return 0, err
	}
	return s.lookupGitHubInstallationID(ctx, userID, normalizedOwner, normalizedRepo)
}

// GetGitHubInstallationIDForRepositoryOwner resolves the installation for a
// Smithers repository's GitHub owner/repo on background paths that have no
// acting user: the binding must come from the repository's owning user, or —
// for org-owned repositories — from a member of the owning org. Returns 0 when
// no scoped binding exists.
func (s *RepoConnectionService) GetGitHubInstallationIDForRepositoryOwner(
	ctx context.Context,
	ownerUserID int64,
	ownerOrgID int64,
	owner string,
	repo string,
) (int64, error) {
	normalizedOwner, normalizedRepo, err := normalizeRepoRef(owner, repo)
	if err != nil {
		return 0, err
	}

	if ownerUserID > 0 {
		return s.lookupGitHubInstallationID(ctx, ownerUserID, normalizedOwner, normalizedRepo)
	}
	if ownerOrgID <= 0 {
		return 0, pkgerrors.BadRequest("repository owner is required")
	}

	var installationID int64
	err = s.db.QueryRow(
		ctx,
		getGitHubAppInstallationForOrgRepoSQL,
		ownerOrgID,
		normalizedOwner,
		normalizedRepo,
	).Scan(&installationID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return 0, nil
		}
		return 0, pkgerrors.Internal("failed to load github app installation").WithCause(err)
	}
	return installationID, nil
}

// reconcileInstallation is one entry from GET /app/installations.
type reconcileInstallation struct {
	ID                  int64  `json:"id"`
	RepositorySelection string `json:"repository_selection"`
	Account             struct {
		Login string `json:"login"`
		Type  string `json:"type"`
	} `json:"account"`
}

// reconcileRepository is one entry from GET /installation/repositories.
type reconcileRepository struct {
	ID      int64  `json:"id"`
	Name    string `json:"name"`
	Private bool   `json:"private"`
	Owner   struct {
		Login string `json:"login"`
	} `json:"owner"`
}

// ReconcileGitHubAppInstallations authenticates as the GitHub App and backfills
// github_app_installation_repositories from the live installation state. The
// table is otherwise written only by webhook events, so any installation created
// before webhook wiring (including all pre-existing installs) never appears —
// leaving GetGitHubAppStatus to report "not installed" for every repo. This
// walks GET /app/installations (paginated), lists each installation's
// repositories, upserts them (owner/repo lowercased), and prunes rows for
// installations or repositories that no longer exist.
//
// An installation whose token mint or repository listing fails is skipped, not
// fatal: its repository rows are left as they were, the remaining installations
// are still reconciled, and the installation prune still runs. The call then
// returns an error naming how many installations were skipped.
//
// It no-ops cleanly (logs, returns nil) when app credentials are unconfigured,
// so it is safe to call unconditionally from the periodic reconciler and the
// admin route.
func (s *RepoConnectionService) ReconcileGitHubAppInstallations(ctx context.Context) error {
	jwt, err := githubAppJWT(ctx, s.githubAppCredentials)
	if stdErrors.Is(err, ErrGitHubAppNotConfigured) {
		slog.Info("github_app.reconcile.skipped", "reason", "github app credentials not configured")
		return nil
	}
	if err != nil {
		return pkgerrors.Internal("failed to create github app jwt").WithCause(err)
	}

	installations, err := s.listGitHubAppInstallations(ctx, jwt)
	if err != nil {
		return err
	}

	seenInstallationIDs := make([]int64, 0, len(installations))
	failedInstallations := 0
	for _, installation := range installations {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if installation.ID <= 0 {
			continue
		}
		seenInstallationIDs = append(seenInstallationIDs, installation.ID)
		// Repository mappings carry a foreign key to the installation. Existing
		// installs that predate webhook delivery have neither row, so inserting
		// the child first makes the authoritative boot reconcile fail forever.
		if _, err := s.db.Exec(
			ctx,
			upsertGitHubAppInstallationSQL,
			installation.ID,
			strings.TrimSpace(installation.Account.Login),
			strings.TrimSpace(installation.Account.Type),
			strings.TrimSpace(installation.RepositorySelection),
		); err != nil {
			return pkgerrors.Internal("failed to upsert github app installation").WithCause(err)
		}

		// A token or listing failure is scoped to one installation (a suspended
		// install answers 403). Skip it and keep its last-known repository rows
		// so one tenant cannot freeze mapping freshness for every other tenant.
		token, err := s.createGitHubInstallationTokenForInstallationID(ctx, installation.ID)
		if err != nil {
			slog.Error("github_app.reconcile.token_failed", "installation_id", installation.ID, "error", err)
			failedInstallations++
			continue
		}

		repos, err := s.listGitHubInstallationRepositories(ctx, token.Token)
		if err != nil {
			slog.Error("github_app.reconcile.repos_failed", "installation_id", installation.ID, "error", err)
			failedInstallations++
			continue
		}

		seenRepoIDs := make([]int64, 0, len(repos))
		for _, repo := range repos {
			ownerLogin := strings.TrimSpace(repo.Owner.Login)
			repoName := strings.TrimSpace(repo.Name)
			if ownerLogin == "" || repoName == "" || repo.ID <= 0 {
				continue
			}
			seenRepoIDs = append(seenRepoIDs, repo.ID)
			if _, err := s.db.Exec(
				ctx,
				upsertGitHubAppInstallationRepositorySQL,
				installation.ID,
				repo.ID,
				ownerLogin,
				strings.ToLower(ownerLogin),
				repoName,
				strings.ToLower(repoName),
				repo.Private,
			); err != nil {
				return pkgerrors.Internal("failed to upsert github app installation repository").WithCause(err)
			}
		}

		// Prune repositories that were removed from this installation.
		if _, err := s.db.Exec(
			ctx,
			pruneGitHubAppInstallationRepositoriesSQL,
			installation.ID,
			seenRepoIDs,
		); err != nil {
			return pkgerrors.Internal("failed to prune github app installation repositories").WithCause(err)
		}
	}

	// Prune installations that no longer exist. The foreign key cascade removes
	// their repository mappings as one authoritative operation.
	if _, err := s.db.Exec(
		ctx,
		pruneGitHubAppInstallationsSQL,
		seenInstallationIDs,
	); err != nil {
		return pkgerrors.Internal("failed to prune github app installations").WithCause(err)
	}

	if failedInstallations > 0 {
		slog.Error("github_app.reconcile.partial",
			"installations", len(seenInstallationIDs),
			"failed_installations", failedInstallations,
		)
		return pkgerrors.Internal(fmt.Sprintf(
			"github app reconcile skipped %d of %d installations",
			failedInstallations,
			len(seenInstallationIDs),
		))
	}

	slog.Info("github_app.reconcile.ok", "installations", len(seenInstallationIDs))
	return nil
}

const pruneGitHubAppInstallationRepositoriesSQL = `
DELETE FROM github_app_installation_repositories
WHERE installation_id = $1
  AND NOT (github_repository_id = ANY($2::bigint[]));
`

const pruneGitHubAppInstallationsSQL = `
DELETE FROM github_app_installations
WHERE NOT (installation_id = ANY($1::bigint[]));
`

// listGitHubAppInstallations walks GET /app/installations, following rel="next"
// Link headers until exhausted, authenticated with the app JWT.
func (s *RepoConnectionService) listGitHubAppInstallations(ctx context.Context, jwt string) ([]reconcileInstallation, error) {
	endpoint := fmt.Sprintf("%s/app/installations?per_page=100", strings.TrimRight(githubAPIBaseURL(), "/"))
	var all []reconcileInstallation
	httpClient := s.gitHubBudgetTracker.WrapClient(observability.NewHTTPClient(15 * time.Second))
	for endpoint != "" {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			return nil, pkgerrors.Internal("failed to build github installations request").WithCause(err)
		}
		req.Header.Set("Accept", "application/vnd.github+json")
		req.Header.Set("Authorization", "Bearer "+jwt)
		req.Header.Set("User-Agent", "smithers-server")
		req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

		resp, err := httpClient.Do(req)
		if err != nil {
			return nil, pkgerrors.Internal("github installations request failed").WithCause(err)
		}
		bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		nextURL := parseGitHubNextLink(resp.Header.Get("Link"))
		_ = resp.Body.Close()

		if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
			return nil, pkgerrors.Internal("github installations request was rejected")
		}

		var page []reconcileInstallation
		if err := json.Unmarshal(bodyBytes, &page); err != nil {
			return nil, pkgerrors.Internal("github installations response was invalid").WithCause(err)
		}
		all = append(all, page...)
		endpoint = nextURL
	}
	return all, nil
}

// listGitHubInstallationRepositories walks GET /installation/repositories with an
// installation token, following rel="next" Link headers until exhausted.
func (s *RepoConnectionService) listGitHubInstallationRepositories(ctx context.Context, token string) ([]reconcileRepository, error) {
	endpoint := fmt.Sprintf("%s/installation/repositories?per_page=100", strings.TrimRight(githubAPIBaseURL(), "/"))
	var all []reconcileRepository
	httpClient := s.gitHubBudgetTracker.WrapClient(observability.NewHTTPClient(15 * time.Second))
	for endpoint != "" {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			return nil, pkgerrors.Internal("failed to build github repositories request").WithCause(err)
		}
		req.Header.Set("Accept", "application/vnd.github+json")
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("User-Agent", "smithers-server")
		req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

		resp, err := httpClient.Do(req)
		if err != nil {
			return nil, pkgerrors.Internal("github repositories request failed").WithCause(err)
		}
		bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		nextURL := parseGitHubNextLink(resp.Header.Get("Link"))
		_ = resp.Body.Close()

		if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
			return nil, pkgerrors.Internal("github repositories request was rejected")
		}

		var page struct {
			Repositories []reconcileRepository `json:"repositories"`
		}
		if err := json.Unmarshal(bodyBytes, &page); err != nil {
			return nil, pkgerrors.Internal("github repositories response was invalid").WithCause(err)
		}
		all = append(all, page.Repositories...)
		endpoint = nextURL
	}
	return all, nil
}

// parseGitHubNextLink extracts the rel="next" URL from a GitHub Link header, or
// "" when there is no next page.
func parseGitHubNextLink(header string) string {
	if strings.TrimSpace(header) == "" {
		return ""
	}
	for _, part := range strings.Split(header, ",") {
		segments := strings.Split(strings.TrimSpace(part), ";")
		if len(segments) < 2 {
			continue
		}
		urlPart := strings.TrimSpace(segments[0])
		if !strings.HasPrefix(urlPart, "<") || !strings.HasSuffix(urlPart, ">") {
			continue
		}
		for _, attr := range segments[1:] {
			attr = strings.TrimSpace(attr)
			if attr == `rel="next"` || attr == "rel=next" {
				return strings.TrimSuffix(strings.TrimPrefix(urlPart, "<"), ">")
			}
		}
	}
	return ""
}

func githubAPIBaseURL() string {
	if value := strings.TrimSpace(os.Getenv(envGitHubAppAPIBaseURL)); value != "" {
		return strings.TrimRight(value, "/")
	}
	return defaultGitHubAPIBaseURL
}

func parseGitHubAppPrivateKey(value string) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode([]byte(value))
	if block == nil {
		return nil, stdErrors.New("no pem block found")
	}

	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return key, nil
	}

	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, stdErrors.New("private key must be RSA")
	}
	return key, nil
}

var createGitHubAppJWTFunc = createGitHubAppJWT

func createGitHubAppJWT(appID int64, privateKey *rsa.PrivateKey, now time.Time) (string, error) {
	header := mustBase64URLEncodeJSON(map[string]string{
		"alg": "RS256",
		"typ": "JWT",
	})

	claims := mustBase64URLEncodeJSON(map[string]any{
		"iat": now.Add(-30 * time.Second).Unix(),
		"exp": now.Add(9 * time.Minute).Unix(),
		"iss": appID,
	})

	signingInput := header + "." + claims
	digest := sha256.Sum256([]byte(signingInput))
	signature, err := rsa.SignPKCS1v15(rand.Reader, privateKey, crypto.SHA256, digest[:])
	if err != nil {
		return "", err
	}

	return signingInput + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

func mustBase64URLEncodeJSON(value any) string {
	encoded, err := base64URLEncodeJSON(value)
	if err != nil {
		panic(err)
	}
	return encoded
}

func base64URLEncodeJSON(value any) (string, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(encoded), nil
}

// gitHubProviderClient reuses the production issuer's shared install budget.
// No ambient/global client is installed, so hosted compositions are unchanged.
func gitHubProviderClient(provider any, timeout time.Duration) *http.Client {
	client := observability.NewHTTPClient(timeout)
	if connection, ok := provider.(*RepoConnectionService); ok {
		return connection.gitHubBudgetTracker.WrapClient(client)
	}
	return client
}

package services

import (
	"context"
	"encoding/json"
	stdErrors "errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// GitHub access diagnosis: a REAL verdict on why (or whether) the signed-in
// user can read a repository surface (issues / pulls), derived from the
// GitHub App's own installation lookup instead of guessing from the status
// code a proxied surface read happened to return.
//
// Verdict taxonomy (each one names a distinct blocking action):
//
//   - ok                 — installation present, surface permission granted,
//     and the user's own GitHub credential can see the
//     repository. A failing surface read is transient.
//   - app-not-installed  — the GitHub App has no installation covering
//     owner/repo. Fix: install the app (InstallURL).
//   - permission-missing — the installation exists but its granted
//     permissions lack the surface's permission (for
//     example issues:read). Fix: grant the permission on
//     the APP's configuration (GrantURL) and approve the
//     pending update on the installation (ApproveURL).
//   - no-org-grant       — installation and permission are fine, but the
//     user's own GitHub OAuth credential cannot see the
//     repository (org access not granted to the user's
//     token). Fix: approve/authorize on the installation
//     page (ApproveURL).
//   - token-broken       — the user has no working GitHub credential on
//     jjhub (not connected, or the token is rejected and
//     cannot be refreshed). Fix: re-link GitHub.
//   - not-configured     — the server has no GitHub App credentials, so no
//     app-side diagnosis is possible and installing can
//     never help.
const (
	GitHubAccessVerdictOK                = "ok"
	GitHubAccessVerdictAppNotInstalled   = "app-not-installed"
	GitHubAccessVerdictPermissionMissing = "permission-missing"
	GitHubAccessVerdictNoOrgGrant        = "no-org-grant"
	GitHubAccessVerdictTokenBroken       = "token-broken"
	GitHubAccessVerdictNotConfigured     = "not-configured"
)

func badGateway(msg string) *pkgerrors.APIError {
	return pkgerrors.New(pkgerrors.CodeGitHubUnavailable, msg)
}

// statusOfAPIError extracts the HTTP status a *pkgerrors.APIError carries; 0
// for any other error.
func statusOfAPIError(err error) int {
	var apiErr *pkgerrors.APIError
	if stdErrors.As(err, &apiErr) {
		return apiErr.Status
	}
	return 0
}

// GitHubAccessDiagnosis is the typed verdict returned by
// GET /api/user/github-access/{owner}/{repo}?surface=issues|pulls.
type GitHubAccessDiagnosis struct {
	Verdict string `json:"verdict"`
	Surface string `json:"surface"`
	// Detail is one human sentence explaining the verdict.
	Detail string `json:"detail"`
	// MissingPermission names the exact missing grant ("issues:read",
	// "pull_requests:read") when Verdict is permission-missing.
	MissingPermission string `json:"missing_permission,omitempty"`
	// InstallURL is where to install the app (app-not-installed).
	InstallURL string `json:"install_url,omitempty"`
	// GrantURL is the app's permission-configuration page (permission-missing).
	GrantURL string `json:"grant_url,omitempty"`
	// ApproveURL is the owner's installation settings page, where permission
	// updates are approved and org access is managed.
	ApproveURL string `json:"approve_url,omitempty"`
	// InstallationID and Permissions describe the found installation, when one
	// exists. Permissions is GitHub's granted map (permission → read|write).
	InstallationID int64             `json:"installation_id,omitempty"`
	Permissions    map[string]string `json:"permissions,omitempty"`
}

func githubAppPermissionsURL(credentials GitHubAppCredentials) string {
	slug := url.PathEscape(credentials.Slug)
	if credentials.OwnerKind == "org" {
		return "https://github.com/organizations/" + url.PathEscape(credentials.OwnerLogin) + "/settings/apps/" + slug + "/permissions"
	}
	return "https://github.com/settings/apps/" + slug + "/permissions"
}

// surfaceRequiredPermission maps a surface to the GitHub App permission key
// its REST read requires, and the human "permission:access" label.
func surfaceRequiredPermission(surface string) (key string, label string) {
	if surface == GitHubRepoMetadataPulls {
		return "pull_requests", "pull_requests:read"
	}
	return "issues", "issues:read"
}

type githubRepoInstallation struct {
	ID      int64 `json:"id"`
	Account struct {
		Login string `json:"login"`
		Type  string `json:"type"`
	} `json:"account"`
	Permissions map[string]string `json:"permissions"`
}

// githubInstallationApproveURL is the settings page where the installation's
// owner approves permission updates (and manages the installation).
func githubInstallationApproveURL(accountLogin, accountType string, installationID int64) string {
	if strings.EqualFold(accountType, "Organization") && accountLogin != "" {
		return fmt.Sprintf(
			"https://github.com/organizations/%s/settings/installations/%d",
			url.PathEscape(accountLogin), installationID,
		)
	}
	return fmt.Sprintf("https://github.com/settings/installations/%d", installationID)
}

// DiagnoseGitHubAccess derives the typed verdict for one user + repository +
// surface. It never guesses from a proxied status code: the installation (and
// its granted permissions) is read with the App's own credentials, and only
// then is the user's credential checked against the repository.
func (s *GitHubUserReposService) DiagnoseGitHubAccess(
	ctx context.Context,
	userID int64,
	owner string,
	repo string,
	surface string,
) (GitHubAccessDiagnosis, error) {
	if s == nil || s.queries == nil || s.decrypter == nil {
		return GitHubAccessDiagnosis{}, pkgerrors.Internal("github access diagnosis service unavailable")
	}
	if userID <= 0 {
		return GitHubAccessDiagnosis{}, pkgerrors.Unauthorized("authentication required")
	}
	normalizedOwner, err := normalizeGitHubRepoMetadataSegment(owner, "owner")
	if err != nil {
		return GitHubAccessDiagnosis{}, err
	}
	normalizedRepo, err := normalizeGitHubRepoMetadataSegment(repo, "repository")
	if err != nil {
		return GitHubAccessDiagnosis{}, err
	}
	normalizedSurface, err := normalizeGitHubRepoMetadataResource(surface)
	if err != nil {
		return GitHubAccessDiagnosis{}, err
	}
	permissionKey, permissionLabel := surfaceRequiredPermission(normalizedSurface)

	diagnosis := GitHubAccessDiagnosis{Surface: normalizedSurface}

	credentials, credentialErr := loadGitHubAppCredentials(ctx, s.githubAppCredentials)
	if stdErrors.Is(credentialErr, ErrGitHubAppNotConfigured) {
		diagnosis.Verdict = GitHubAccessVerdictNotConfigured
		diagnosis.Detail = "The server has no GitHub App credentials, so app-side access cannot be diagnosed or fixed by installing."
		return diagnosis, nil
	}

	if credentialErr != nil {
		return GitHubAccessDiagnosis{}, pkgerrors.Internal("failed to load github app credentials").WithCause(credentialErr)
	}
	installURL, err := s.githubAppCredentials.InstallURL(ctx)
	if err != nil {
		return GitHubAccessDiagnosis{}, pkgerrors.Internal("failed to load github app install url").WithCause(err)
	}

	installation, found, err := s.lookupRepoInstallation(ctx, normalizedOwner, normalizedRepo)
	if err != nil {
		return GitHubAccessDiagnosis{}, err
	}
	if !found {
		diagnosis.Verdict = GitHubAccessVerdictAppNotInstalled
		diagnosis.Detail = fmt.Sprintf(
			"The GitHub App is not installed on %s/%s. Install it on the repository's owner, then retry.",
			normalizedOwner, normalizedRepo,
		)
		diagnosis.InstallURL = installURL
		return diagnosis, nil
	}

	diagnosis.InstallationID = installation.ID
	diagnosis.Permissions = installation.Permissions
	diagnosis.ApproveURL = githubInstallationApproveURL(
		installation.Account.Login, installation.Account.Type, installation.ID,
	)

	switch installation.Permissions[permissionKey] {
	case "read", "write", "admin":
		// granted — fall through to the user-credential check
	default:
		diagnosis.Verdict = GitHubAccessVerdictPermissionMissing
		diagnosis.MissingPermission = permissionLabel
		diagnosis.GrantURL = githubAppPermissionsURL(credentials)
		diagnosis.InstallURL = installURL
		diagnosis.Detail = fmt.Sprintf(
			"The GitHub App is installed on %s but its installation does not grant %s. Grant it on the app's permission configuration, then approve the update on the installation.",
			installation.Account.Login, permissionLabel,
		)
		return diagnosis, nil
	}

	// Installation and permission are fine; now the user's own credential.
	accessToken, account, err := s.resolveUserGitHubAccessToken(ctx, userID)
	if err != nil {
		diagnosis.Verdict = GitHubAccessVerdictTokenBroken
		diagnosis.Detail = "The jjhub account has no working GitHub credential. Re-link GitHub on jjhub."
		return diagnosis, nil
	}
	_, err = s.requestGitHubRepoObject(ctx, accessToken, normalizedOwner, normalizedRepo)
	if err != nil && isGitHubTokenExpired(err) {
		if newToken, refreshErr := s.refreshUserGitHubToken(ctx, account); refreshErr == nil {
			_, err = s.requestGitHubRepoObject(ctx, newToken, normalizedOwner, normalizedRepo)
		}
	}
	if err != nil {
		switch statusOfAPIError(err) {
		case http.StatusUnauthorized:
			diagnosis.Verdict = GitHubAccessVerdictTokenBroken
			diagnosis.Detail = "GitHub rejected the linked credential and it could not be refreshed. Re-link GitHub on jjhub."
			return diagnosis, nil
		case http.StatusNotFound, http.StatusForbidden:
			diagnosis.Verdict = GitHubAccessVerdictNoOrgGrant
			diagnosis.Detail = fmt.Sprintf(
				"The GitHub App is installed with %s granted, but your own GitHub credential cannot see %s/%s. Authorize your account on the installation's settings page.",
				permissionLabel, normalizedOwner, normalizedRepo,
			)
			return diagnosis, nil
		default:
			// Rate limits and upstream failures are errors, not access verdicts.
			return GitHubAccessDiagnosis{}, err
		}
	}

	diagnosis.Verdict = GitHubAccessVerdictOK
	diagnosis.Detail = fmt.Sprintf(
		"GitHub access to %s/%s %s is healthy; a failing read is transient.",
		normalizedOwner, normalizedRepo, normalizedSurface,
	)
	return diagnosis, nil
}

// lookupRepoInstallation resolves the App installation covering owner/repo via
// GET /repos/{owner}/{repo}/installation with an App JWT — GitHub's canonical
// answer, independent of Smithers DB state. found=false means 404 (no
// installation covers the repository, or the repository does not exist).
func (s *GitHubUserReposService) lookupRepoInstallation(
	ctx context.Context,
	owner string,
	repo string,
) (githubRepoInstallation, bool, error) {
	jwt, err := githubAppJWT(ctx, s.githubAppCredentials)
	if err != nil {
		return githubRepoInstallation{}, false, pkgerrors.Internal("failed to create github app jwt").WithCause(err)
	}

	endpoint := strings.TrimRight(githubAPIBaseURL(), "/") +
		"/repos/" + url.PathEscape(owner) + "/" + url.PathEscape(repo) + "/installation"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return githubRepoInstallation{}, false, pkgerrors.Internal("failed to build github installation lookup request").WithCause(err)
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Authorization", "Bearer "+jwt)
	req.Header.Set("User-Agent", "smithers-server")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return githubRepoInstallation{}, false, badGateway("github installation lookup failed")
	}
	defer func() { _ = resp.Body.Close() }()

	body, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if readErr != nil {
		return githubRepoInstallation{}, false, badGateway("failed to read github installation lookup response")
	}

	switch {
	case resp.StatusCode == http.StatusNotFound:
		return githubRepoInstallation{}, false, nil
	case resp.StatusCode == http.StatusUnauthorized:
		// The App JWT itself was rejected: the configured credentials are wrong.
		return githubRepoInstallation{}, false, pkgerrors.Internal("github rejected the app credentials")
	case resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices:
		return githubRepoInstallation{}, false, badGateway(
			fmt.Sprintf("github installation lookup returned status %d", resp.StatusCode),
		)
	}

	var installation githubRepoInstallation
	if err := json.Unmarshal(body, &installation); err != nil || installation.ID <= 0 {
		return githubRepoInstallation{}, false, badGateway("failed to decode github installation lookup response")
	}
	return installation, true, nil
}

package auth

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/observability"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// Auth0Client exchanges an Auth0 authorization code for a GitHub access token,
// then delegates profile/emails fetching to GitHub's API directly.
// This mirrors the GitHubClient contract so it can be used as a drop-in
// replacement for the WorkOS or GitHub OAuth clients in the auth service.
type Auth0Client struct {
	domain       string
	clientID     string
	clientSecret string
	redirectURI  string
	connection   string
	httpClient   *http.Client
	// Embedded GitHub client for user/email fetching after token exchange.
	githubAPIBaseURL string
}

const (
	defaultAuth0Connection = "github"
)

func NewAuth0Client(domain, clientID, clientSecret, redirectURI, connection, githubAPIBaseURL string) *Auth0Client {
	domain = strings.TrimSpace(domain)
	clientID = strings.TrimSpace(clientID)
	clientSecret = strings.TrimSpace(clientSecret)
	redirectURI = strings.TrimSpace(redirectURI)
	connection = strings.TrimSpace(connection)
	if connection == "" {
		connection = defaultAuth0Connection
	}
	githubAPIBaseURL = strings.TrimSpace(githubAPIBaseURL)
	if githubAPIBaseURL == "" {
		githubAPIBaseURL = defaultGitHubAPIBaseURL
	}

	return &Auth0Client{
		domain:           domain,
		clientID:         clientID,
		clientSecret:     clientSecret,
		redirectURI:      redirectURI,
		connection:       connection,
		httpClient:       observability.NewHTTPClient(10 * time.Second),
		githubAPIBaseURL: githubAPIBaseURL,
	}
}

// AuthorizationURL builds the Auth0 /authorize URL that initiates the OAuth flow.
// The connection parameter tells Auth0 to skip the Universal Login and go
// directly to GitHub.
func (c *Auth0Client) AuthorizationURL(state string) string {
	params := url.Values{
		"response_type": {"code"},
		"client_id":     {c.clientID},
		"redirect_uri":  {c.redirectURI},
		"state":         {state},
		"connection":    {c.connection},
		"scope":         {"openid profile email"},
	}
	return fmt.Sprintf("https://%s/authorize?%s", c.domain, params.Encode())
}

// ExchangeCode exchanges an Auth0 authorization code for tokens.
// Auth0 returns its own access token + id_token. To get the upstream GitHub
// access token (needed for GitHub API calls), we read it from the Auth0
// Management API identity. However, since we request the "github" connection,
// Auth0 embeds the upstream provider token in the /oauth/token response's
// "access_token" field when the API audience is not specified (default behavior
// for social connections).
//
// If Auth0 does not return the GitHub token directly, the FetchUser/FetchEmails
// methods will use Auth0's /userinfo instead.
func (c *Auth0Client) ExchangeCode(ctx context.Context, code string) (services.GitHubTokenResult, error) {
	tokenURL := fmt.Sprintf("https://%s/oauth/token", c.domain)

	form := url.Values{
		"grant_type":    {"authorization_code"},
		"client_id":     {c.clientID},
		"client_secret": {c.clientSecret},
		"code":          {strings.TrimSpace(code)},
		"redirect_uri":  {c.redirectURI},
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return services.GitHubTokenResult{}, fmt.Errorf("create auth0 token exchange request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return services.GitHubTokenResult{}, fmt.Errorf("auth0 token exchange request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	var payload struct {
		AccessToken      string `json:"access_token"`
		IDToken          string `json:"id_token"`
		TokenType        string `json:"token_type"`
		Error            string `json:"error"`
		ErrorDescription string `json:"error_description"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return services.GitHubTokenResult{}, fmt.Errorf("decode auth0 token exchange response: %w", err)
	}

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		if payload.ErrorDescription != "" {
			return services.GitHubTokenResult{}, fmt.Errorf("auth0 token exchange failed: %s", payload.ErrorDescription)
		}
		if payload.Error != "" {
			return services.GitHubTokenResult{}, fmt.Errorf("auth0 token exchange failed: %s", payload.Error)
		}
		return services.GitHubTokenResult{}, fmt.Errorf("auth0 token exchange failed with status %d", resp.StatusCode)
	}

	if strings.TrimSpace(payload.AccessToken) == "" {
		return services.GitHubTokenResult{}, fmt.Errorf("auth0 token exchange returned empty access token")
	}

	return services.GitHubTokenResult{AccessToken: payload.AccessToken}, nil
}

// FetchUser fetches the GitHub user profile using the access token.
// This first tries GitHub's API directly (works when Auth0 passes through
// the GitHub token). If that fails, it falls back to Auth0's /userinfo endpoint.
func (c *Auth0Client) FetchUser(ctx context.Context, accessToken string) (services.GitHubUserProfile, error) {
	// Try GitHub API first.
	profile, err := c.fetchGitHubUser(ctx, accessToken)
	if err == nil {
		return profile, nil
	}

	// Fall back to Auth0 /userinfo.
	info, err := c.fetchAuth0UserInfo(ctx, accessToken)
	if err != nil {
		return services.GitHubUserProfile{}, err
	}
	return auth0ProfileFromUserInfo(info)
}

// FetchEmails fetches the user's emails from GitHub's API. If the token is an
// Auth0 token (not a GitHub passthrough), GitHub rejects it, so fall back to
// the email in Auth0's /userinfo — otherwise new users would be created
// without an email. The fallback email is only marked Verified when Auth0
// reports email_verified, so an unverified address never becomes the
// account's email.
func (c *Auth0Client) FetchEmails(ctx context.Context, accessToken string) ([]services.GitHubEmail, error) {
	emails, err := c.fetchGitHubEmails(ctx, accessToken)
	if err == nil {
		return emails, nil
	}

	info, infoErr := c.fetchAuth0UserInfo(ctx, accessToken)
	if infoErr != nil {
		// A GitHub passthrough token is not valid at Auth0 /userinfo either
		// (e.g. the GitHub email call failed for scope reasons). Emails are
		// optional — username identity still authenticates — so return empty
		// rather than failing the whole login.
		return []services.GitHubEmail{}, nil
	}
	email := strings.TrimSpace(info.Email)
	if email == "" {
		return []services.GitHubEmail{}, nil
	}
	return []services.GitHubEmail{{Email: email, Primary: true, Verified: info.EmailVerified}}, nil
}

func (c *Auth0Client) fetchGitHubUser(ctx context.Context, accessToken string) (services.GitHubUserProfile, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(c.githubAPIBaseURL, "/")+"/user", nil)
	if err != nil {
		return services.GitHubUserProfile{}, fmt.Errorf("create github user request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(accessToken))

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return services.GitHubUserProfile{}, fmt.Errorf("github user request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return services.GitHubUserProfile{}, fmt.Errorf("github user request failed with status %d", resp.StatusCode)
	}

	var profile services.GitHubUserProfile
	if err := json.NewDecoder(resp.Body).Decode(&profile); err != nil {
		return services.GitHubUserProfile{}, fmt.Errorf("decode github user response: %w", err)
	}
	if profile.ID == 0 || strings.TrimSpace(profile.Login) == "" {
		return services.GitHubUserProfile{}, fmt.Errorf("github user response missing required fields")
	}
	return profile, nil
}

// auth0UserInfo is the subset of Auth0's /userinfo response used by the
// profile and email fallback paths.
type auth0UserInfo struct {
	Sub           string `json:"sub"`
	Name          string `json:"name"`
	Nickname      string `json:"nickname"`
	Picture       string `json:"picture"`
	Email         string `json:"email"`
	EmailVerified bool   `json:"email_verified"`
}

func (c *Auth0Client) fetchAuth0UserInfo(ctx context.Context, accessToken string) (auth0UserInfo, error) {
	userinfoURL := fmt.Sprintf("https://%s/userinfo", c.domain)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, userinfoURL, nil)
	if err != nil {
		return auth0UserInfo{}, fmt.Errorf("create auth0 userinfo request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(accessToken))

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return auth0UserInfo{}, fmt.Errorf("auth0 userinfo request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return auth0UserInfo{}, fmt.Errorf("auth0 userinfo request failed with status %d", resp.StatusCode)
	}

	var info auth0UserInfo
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return auth0UserInfo{}, fmt.Errorf("decode auth0 userinfo response: %w", err)
	}
	return info, nil
}

// auth0ProfileFromUserInfo maps an Auth0 /userinfo payload onto the GitHub
// profile shape used by the auth service.
func auth0ProfileFromUserInfo(info auth0UserInfo) (services.GitHubUserProfile, error) {
	login := strings.TrimSpace(info.Nickname)
	if login == "" {
		login = strings.TrimSpace(info.Name)
	}
	if login == "" {
		return services.GitHubUserProfile{}, fmt.Errorf("auth0 userinfo response missing required fields")
	}

	return services.GitHubUserProfile{
		ID:        auth0GitHubID(info.Sub),
		Login:     login,
		Name:      strings.TrimSpace(info.Name),
		AvatarURL: strings.TrimSpace(info.Picture),
	}, nil
}

// auth0GitHubID extracts the real GitHub numeric ID from an Auth0 sub
// ("github|<numeric_id>") so the /userinfo fallback yields the same provider
// user ID as the GitHub-token passthrough path. oauth_accounts rows are keyed
// on that ID; an unstable one would split a returning user into two accounts.
// Non-GitHub subs fall back to a deterministic SHA-256-derived ID.
func auth0GitHubID(sub string) int64 {
	sub = strings.TrimSpace(sub)
	if rest, ok := strings.CutPrefix(sub, "github|"); ok {
		if id, err := strconv.ParseInt(rest, 10, 64); err == nil && id > 0 {
			return id
		}
	}
	return stableInt64ID(sub)
}

func (c *Auth0Client) fetchGitHubEmails(ctx context.Context, accessToken string) ([]services.GitHubEmail, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(c.githubAPIBaseURL, "/")+"/user/emails", nil)
	if err != nil {
		return nil, fmt.Errorf("create github emails request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(accessToken))

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("github emails request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return nil, fmt.Errorf("github emails request failed with status %d", resp.StatusCode)
	}

	var emails []services.GitHubEmail
	if err := json.NewDecoder(resp.Body).Decode(&emails); err != nil {
		return nil, fmt.Errorf("decode github emails response: %w", err)
	}
	return emails, nil
}

// stableInt64ID derives a deterministic positive int64 from an arbitrary
// identity string (e.g. an Auth0 "sub"). It hashes the value with SHA-256 and
// folds the first 8 bytes into a non-negative int64 so the same identity always
// maps to the same numeric user ID.
func stableInt64ID(value string) int64 {
	sum := sha256.Sum256([]byte(strings.TrimSpace(value)))
	return stableInt64IDFromDigest(sum)
}

func stableInt64IDFromDigest(sum [sha256.Size]byte) int64 {
	id := int64(binary.BigEndian.Uint64(sum[:8]) & math.MaxInt64)
	if id == 0 {
		return 1
	}
	return id
}

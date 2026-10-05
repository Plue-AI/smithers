package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/observability"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type GitHubOAuthCredentialSource interface {
	OAuthClient(context.Context) (string, string, error)
}

type GitHubClient struct {
	credentials  GitHubOAuthCredentialSource
	httpClient   *http.Client
	oauthBaseURL string
	apiBaseURL   string
	redirectURL  string
}

const (
	defaultGitHubOAuthBaseURL = "https://github.com"
	defaultGitHubAPIBaseURL   = "https://api.github.com"
	githubOAuthScope          = "read:user user:email repo"
	githubUserAgent           = "smithers-plue"
	githubAPIVersion          = "2022-11-28"
)

type GitHubClientOption func(*GitHubClient)

// WithGitHubBudget shares admission with the install's other GitHub callers.
func WithGitHubBudget(budget *services.BudgetTracker) GitHubClientOption {
	return func(c *GitHubClient) { c.httpClient = budget.WrapClient(c.httpClient) }
}

func NewGitHubClient(credentials GitHubOAuthCredentialSource, redirectURL, oauthBaseURL, apiBaseURL string, options ...GitHubClientOption) *GitHubClient {
	oauthBaseURL = strings.TrimSpace(oauthBaseURL)
	if oauthBaseURL == "" {
		oauthBaseURL = defaultGitHubOAuthBaseURL
	}
	apiBaseURL = strings.TrimSpace(apiBaseURL)
	if apiBaseURL == "" {
		apiBaseURL = defaultGitHubAPIBaseURL
	}

	c := &GitHubClient{
		credentials:  credentials,
		httpClient:   observability.NewHTTPClient(10 * time.Second),
		oauthBaseURL: oauthBaseURL,
		apiBaseURL:   apiBaseURL,
		redirectURL:  strings.TrimSpace(redirectURL),
	}
	for _, option := range options {
		option(c)
	}
	return c
}

func (c *GitHubClient) oauthClient(ctx context.Context) (string, string, error) {
	if err := ctx.Err(); err != nil {
		return "", "", err
	}
	if c == nil || c.credentials == nil {
		return "", "", services.ErrGitHubAppNotConfigured
	}
	id, secret, err := c.credentials.OAuthClient(ctx)
	if err != nil {
		return "", "", fmt.Errorf("load github app oauth credentials: %w", err)
	}
	id, secret = strings.TrimSpace(id), strings.TrimSpace(secret)
	if id == "" || secret == "" {
		return "", "", services.ErrGitHubAppNotConfigured
	}
	return id, secret, nil
}

func (c *GitHubClient) AuthorizationURL(ctx context.Context, state string) (string, error) {
	clientID, _, err := c.oauthClient(ctx)
	if err != nil {
		return "", err
	}
	values := url.Values{}
	values.Set("client_id", clientID)
	redirect := services.GitHubRedirectURI(ctx)
	if redirect == "" {
		redirect = c.redirectURL
	}
	values.Set("redirect_uri", redirect)
	values.Set("scope", githubOAuthScope)
	values.Set("state", strings.TrimSpace(state))
	return strings.TrimRight(c.oauthBaseURL, "/") + "/login/oauth/authorize?" + values.Encode(), nil
}

func (c *GitHubClient) ExchangeCode(ctx context.Context, code string) (services.GitHubTokenResult, error) {
	clientID, clientSecret, err := c.oauthClient(ctx)
	if err != nil {
		return services.GitHubTokenResult{}, err
	}
	form := url.Values{}
	form.Set("client_id", clientID)
	form.Set("client_secret", clientSecret)
	form.Set("code", strings.TrimSpace(code))
	if redirect := services.GitHubRedirectURI(ctx); redirect != "" {
		form.Set("redirect_uri", redirect)
	}
	form.Set("grant_type", "authorization_code")

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(c.oauthBaseURL, "/")+"/login/oauth/access_token", strings.NewReader(form.Encode()))
	if err != nil {
		return services.GitHubTokenResult{}, fmt.Errorf("create github oauth exchange request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return services.GitHubTokenResult{}, fmt.Errorf("github oauth exchange request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if limited := services.GitHubRateLimitError(resp.StatusCode, resp.Header, time.Now()); limited != nil {
		return services.GitHubTokenResult{}, limited
	}

	body, err := readGitHubBody(resp.Body)
	if err != nil {
		return services.GitHubTokenResult{}, fmt.Errorf("read github oauth exchange response: %w", err)
	}
	var payload struct {
		AccessToken           string `json:"access_token"`
		RefreshToken          string `json:"refresh_token"`
		ExpiresIn             int64  `json:"expires_in"`
		RefreshTokenExpiresIn int64  `json:"refresh_token_expires_in"`
		Error                 string `json:"error"`
		ErrorDescription      string `json:"error_description"`
	}
	decodeErr := json.Unmarshal(body, &payload)
	ok := resp.StatusCode >= http.StatusOK && resp.StatusCode < http.StatusMultipleChoices
	// GitHub reports a failed exchange (bad_verification_code,
	// redirect_uri_mismatch, incorrect_client_credentials) with HTTP 200 and an
	// error body, so the error fields are checked whatever the status.
	if strings.TrimSpace(payload.Error) != "" || !ok {
		return services.GitHubTokenResult{}, &GitHubOAuthError{
			Action:      "exchange",
			Status:      resp.StatusCode,
			Code:        strings.TrimSpace(payload.Error),
			Description: strings.TrimSpace(payload.ErrorDescription),
		}
	}
	if decodeErr != nil {
		return services.GitHubTokenResult{}, fmt.Errorf("decode github oauth exchange response: %w", decodeErr)
	}

	if strings.TrimSpace(payload.AccessToken) == "" {
		return services.GitHubTokenResult{}, fmt.Errorf("github oauth exchange returned empty access token")
	}

	return services.GitHubTokenResult{
		AccessToken:           payload.AccessToken,
		RefreshToken:          payload.RefreshToken,
		ExpiresIn:             payload.ExpiresIn,
		RefreshTokenExpiresIn: payload.RefreshTokenExpiresIn,
	}, nil
}

// RefreshToken exchanges a GitHub App user-to-server refresh token for a fresh
// access token (and, since GitHub rotates them, a fresh refresh token). It
// mirrors ExchangeCode, POSTing to the same /login/oauth/access_token endpoint
// with grant_type=refresh_token. GitHub returns HTTP 200 with an `error` body
// when the refresh token is itself invalid/expired — the empty-access-token
// guard surfaces that as a refresh failure.
func (c *GitHubClient) RefreshToken(ctx context.Context, refreshToken string) (services.GitHubTokenResult, error) {
	clientID, clientSecret, err := c.oauthClient(ctx)
	if err != nil {
		return services.GitHubTokenResult{}, err
	}
	form := url.Values{}
	form.Set("client_id", clientID)
	form.Set("client_secret", clientSecret)
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", strings.TrimSpace(refreshToken))

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(c.oauthBaseURL, "/")+"/login/oauth/access_token", strings.NewReader(form.Encode()))
	if err != nil {
		return services.GitHubTokenResult{}, fmt.Errorf("create github oauth refresh request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return services.GitHubTokenResult{}, fmt.Errorf("github oauth refresh request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if limited := services.GitHubRateLimitError(resp.StatusCode, resp.Header, time.Now()); limited != nil {
		return services.GitHubTokenResult{}, limited
	}

	var payload struct {
		AccessToken           string `json:"access_token"`
		RefreshToken          string `json:"refresh_token"`
		ExpiresIn             int64  `json:"expires_in"`
		RefreshTokenExpiresIn int64  `json:"refresh_token_expires_in"`
		Error                 string `json:"error"`
		ErrorDescription      string `json:"error_description"`
	}
	body, err := readGitHubBody(resp.Body)
	if err != nil {
		return services.GitHubTokenResult{}, fmt.Errorf("read github oauth refresh response: %w", err)
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return services.GitHubTokenResult{}, fmt.Errorf("decode github oauth refresh response: %w", err)
	}

	// GitHub reports a definitively-dead refresh token via the OAuth error code
	// (returned with HTTP 200 or 4xx). Surface it as the typed sentinel so the
	// caller CLEARS the stored refresh token rather than retrying it forever.
	switch strings.ToLower(strings.TrimSpace(payload.Error)) {
	case "bad_refresh_token", "invalid_grant":
		detail := strings.TrimSpace(payload.ErrorDescription)
		if detail == "" {
			detail = strings.TrimSpace(payload.Error)
		}
		return services.GitHubTokenResult{}, fmt.Errorf("%w: %s", services.ErrGitHubRefreshTokenInvalid, detail)
	}

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		if payload.ErrorDescription != "" {
			return services.GitHubTokenResult{}, fmt.Errorf("github oauth refresh failed: %s", payload.ErrorDescription)
		}
		if payload.Error != "" {
			return services.GitHubTokenResult{}, fmt.Errorf("github oauth refresh failed: %s", payload.Error)
		}
		return services.GitHubTokenResult{}, fmt.Errorf("github oauth refresh failed with status %d", resp.StatusCode)
	}

	if strings.TrimSpace(payload.AccessToken) == "" {
		if payload.ErrorDescription != "" {
			return services.GitHubTokenResult{}, fmt.Errorf("github oauth refresh failed: %s", payload.ErrorDescription)
		}
		if payload.Error != "" {
			return services.GitHubTokenResult{}, fmt.Errorf("github oauth refresh failed: %s", payload.Error)
		}
		return services.GitHubTokenResult{}, fmt.Errorf("github oauth refresh returned empty access token")
	}

	return services.GitHubTokenResult{
		AccessToken:           payload.AccessToken,
		RefreshToken:          payload.RefreshToken,
		ExpiresIn:             payload.ExpiresIn,
		RefreshTokenExpiresIn: payload.RefreshTokenExpiresIn,
	}, nil
}

func (c *GitHubClient) FetchUser(ctx context.Context, accessToken string) (services.GitHubUserProfile, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(c.apiBaseURL, "/")+"/user", nil)
	if err != nil {
		return services.GitHubUserProfile{}, fmt.Errorf("create github user request: %w", err)
	}
	setGitHubAPIHeaders(req, accessToken)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return services.GitHubUserProfile{}, services.GitHubRequestFailure(ctx, "GitHub profile request failed")
	}
	defer func() { _ = resp.Body.Close() }()
	if limited := services.GitHubRateLimitError(resp.StatusCode, resp.Header, time.Now()); limited != nil {
		return services.GitHubUserProfile{}, limited
	}

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return services.GitHubUserProfile{}, githubStatusError("github user request", resp.StatusCode)
	}

	var profile services.GitHubUserProfile
	body, err := readGitHubBody(resp.Body)
	if err != nil {
		return services.GitHubUserProfile{}, services.GitHubRequestFailure(ctx, "GitHub returned an incomplete profile response")
	}
	if err := json.Unmarshal(body, &profile); err != nil {
		return services.GitHubUserProfile{}, services.GitHubRequestFailure(ctx, "GitHub returned an unreadable profile response")
	}
	if profile.ID == 0 || strings.TrimSpace(profile.Login) == "" {
		return services.GitHubUserProfile{}, services.GitHubRequestFailure(ctx, "GitHub profile response is missing required fields")
	}

	return profile, nil
}

func (c *GitHubClient) FetchEmails(ctx context.Context, accessToken string) ([]services.GitHubEmail, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(c.apiBaseURL, "/")+"/user/emails", nil)
	if err != nil {
		return nil, fmt.Errorf("create github emails request: %w", err)
	}
	setGitHubAPIHeaders(req, accessToken)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, services.GitHubRequestFailure(ctx, "GitHub email request failed")
	}
	defer func() { _ = resp.Body.Close() }()
	if limited := services.GitHubRateLimitError(resp.StatusCode, resp.Header, time.Now()); limited != nil {
		return nil, limited
	}

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return nil, githubStatusError("github emails request", resp.StatusCode)
	}

	var emails []services.GitHubEmail
	body, err := readGitHubBody(resp.Body)
	if err != nil {
		return nil, services.GitHubRequestFailure(ctx, "GitHub returned an incomplete email response")
	}
	if err := json.Unmarshal(body, &emails); err != nil {
		return nil, services.GitHubRequestFailure(ctx, "GitHub returned an unreadable email response")
	}

	return emails, nil
}

// A rejected user token can be repaired by reconnecting. Other GitHub failures
// retain their dependency class without blaming the local login.
func githubStatusError(label string, status int) error {
	if status == http.StatusUnauthorized {
		return fmt.Errorf("%s failed with status %d: %w", label, status, services.ErrGitHubTokenRejected)
	}
	if failure := services.GitHubResponseFailure(status, nil, time.Now()); failure != nil {
		return failure
	}
	return services.GitHubRequestFailure(context.Background(), "GitHub returned an unexpected identity response")
}

func setGitHubAPIHeaders(req *http.Request, accessToken string) {
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(accessToken))
	req.Header.Set("User-Agent", githubUserAgent)
	req.Header.Set("X-GitHub-Api-Version", githubAPIVersion)
}

// Read to EOF within the limit before trusting tokens or identity fields.
// A valid JSON prefix on a truncated connection is not an authoritative response.
func readGitHubBody(body io.Reader) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(body, githubResponseLimit+1))
	if err != nil {
		return nil, err
	}
	if len(data) > githubResponseLimit {
		return nil, fmt.Errorf("github response exceeds size limit")
	}
	return data, nil
}

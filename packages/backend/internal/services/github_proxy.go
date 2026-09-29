package services

import (
	"bytes"
	"context"
	"encoding/json"
	stdErrors "errors"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/observability"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const GitHubProxyForbiddenActionCode = pkgerrors.CodeGitHubForbiddenAction

type GitHubProxyInstallationTokenIssuer interface {
	CreateGitHubInstallationToken(ctx context.Context, userID int64, owner string, repo string) (GitHubInstallationToken, error)
}

type gitHubProxyImportedSourceTokenIssuer interface {
	CreateGitHubInstallationTokenForImportedSource(ctx context.Context, userID int64, repositoryID int64, owner string, repo string) (GitHubInstallationToken, error)
}

// GitHubProxyUserTokens resolves the acting user's own GitHub credential and
// rotates it once after a 401. Implemented by *GitHubUserReposService.
type GitHubProxyUserTokens interface {
	UserGitHubReadToken(ctx context.Context, userID int64) (string, db.OauthAccount, error)
	RefreshUserGitHubReadToken(ctx context.Context, account db.OauthAccount) (string, error)
}

type GitHubProxyService struct {
	tokenIssuer         GitHubProxyInstallationTokenIssuer
	userTokens          GitHubProxyUserTokens
	httpClient          *http.Client
	gitHubBudgetTracker *BudgetTracker
}

type GitHubProxyServiceOption func(*GitHubProxyService)

func WithGitHubProxyHTTPClient(client *http.Client) GitHubProxyServiceOption {
	return func(s *GitHubProxyService) {
		if client != nil {
			s.httpClient = client
		}
	}
}

func WithGitHubProxyBudgetTracker(tracker *BudgetTracker) GitHubProxyServiceOption {
	return func(s *GitHubProxyService) {
		s.gitHubBudgetTracker = tracker
	}
}

// WithGitHubProxyUserTokens lets read-only pull request and CI reads of a
// verified imported source the App does not cover use the importer's own
// GitHub credential.
func WithGitHubProxyUserTokens(tokens GitHubProxyUserTokens) GitHubProxyServiceOption {
	return func(s *GitHubProxyService) {
		s.userTokens = tokens
	}
}

func NewGitHubProxyService(tokenIssuer GitHubProxyInstallationTokenIssuer, opts ...GitHubProxyServiceOption) *GitHubProxyService {
	svc := &GitHubProxyService{
		tokenIssuer: tokenIssuer,
		httpClient:  observability.NewHTTPClient(30 * time.Second),
	}
	for _, opt := range opts {
		if opt != nil {
			opt(svc)
		}
	}
	return svc
}

type GitHubProxyRequest struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers"`
	Body    json.RawMessage   `json:"body"`
}

type GitHubProxyResponse struct {
	StatusCode int
	Headers    http.Header
	Body       io.ReadCloser
}

func (s *GitHubProxyService) ProxyRepoRequest(ctx context.Context, actor *db.User, owner string, repo string, input GitHubProxyRequest) (*GitHubProxyResponse, error) {
	if s == nil || s.tokenIssuer == nil {
		return nil, pkgerrors.Internal("github proxy service unavailable")
	}
	if actor == nil || actor.ID <= 0 {
		return nil, pkgerrors.Unauthorized("authentication required")
	}
	trimmedOwner := strings.TrimSpace(owner)
	trimmedRepo := strings.TrimSpace(repo)
	if trimmedOwner == "" || trimmedRepo == "" {
		return nil, pkgerrors.BadRequest("owner and repo are required")
	}

	resolved := gitHubProxyResolvedContext{
		ActorUserID: actor.ID,
		Owner:       trimmedOwner,
		Repo:        trimmedRepo,
	}
	if repoCtx := middleware.RepoContextFromContext(ctx); repoCtx != nil && repoCtx.Repository != nil {
		if repoCtx.Repository.ID > 0 {
			resolved.RepositoryID = repoCtx.Repository.ID
			resolved.TryImportedSourceInstallationID = true
		}
		if gitHubProxyRepoContextUsesImportedSource(repoCtx, trimmedOwner, trimmedRepo) {
			resolved.UseImportedSourceInstallationID = true
		}
	}

	return s.proxyRequest(ctx, resolved, input, GitHubProxyPolicyInput{
		AllowPullWrites:      true,
		WithholdConversation: middleware.ConversationWithheldFromContext(ctx),
	})
}

type gitHubProxyResolvedContext struct {
	ActorUserID                     int64
	Owner                           string
	Repo                            string
	UseImportedSourceInstallationID bool
	TryImportedSourceInstallationID bool
	RepositoryID                    int64
}

func gitHubProxyRepoContextUsesImportedSource(repoCtx *middleware.RepoContext, owner string, repo string) bool {
	if repoCtx == nil || repoCtx.Repository == nil || repoCtx.Repository.ID <= 0 {
		return false
	}
	if !strings.EqualFold(strings.TrimSpace(repoCtx.Owner), strings.TrimSpace(owner)) {
		return true
	}
	repositoryName := strings.TrimSpace(repoCtx.Repository.Name)
	if repositoryName == "" {
		repositoryName = strings.TrimSpace(repoCtx.Repository.LowerName)
	}
	return !strings.EqualFold(repositoryName, strings.TrimSpace(repo))
}

func (s *GitHubProxyService) proxyRequest(ctx context.Context, resolved gitHubProxyResolvedContext, input GitHubProxyRequest, policyOverrides GitHubProxyPolicyInput) (*GitHubProxyResponse, error) {
	method, requestPath, err := normalizeGitHubProxyMethodAndPath(input.Method, input.Path)
	if err != nil {
		logGitHubProxyRequest(strings.ToUpper(strings.TrimSpace(input.Method)), strings.TrimSpace(input.Path), statusCodeFromError(err), "deny", err.Error())
		return nil, err
	}

	bodyBytes, hasBody, err := normalizeGitHubProxyBody(input.Body)
	if err != nil {
		logGitHubProxyRequest(method, requestPath, statusCodeFromError(err), "deny", err.Error())
		return nil, err
	}

	policyDecision := EvaluateGitHubProxyPolicy(GitHubProxyPolicyInput{
		Method:               method,
		Path:                 requestPath,
		Body:                 json.RawMessage(bodyBytes),
		RepoOwner:            resolved.Owner,
		RepoName:             resolved.Repo,
		AllowPullWrites:      policyOverrides.AllowPullWrites,
		AllowMerges:          policyOverrides.AllowMerges,
		AllowBranchDeletes:   policyOverrides.AllowBranchDeletes,
		WithholdConversation: policyOverrides.WithholdConversation,
	})
	if !policyDecision.Allowed {
		logGitHubProxyRequest(method, requestPath, http.StatusForbidden, "deny", policyDecision.Reason)
		return nil, &pkgerrors.APIError{
			Status:  http.StatusForbidden,
			Code:    GitHubProxyForbiddenActionCode,
			Message: policyDecision.Reason,
		}
	}

	installationToken, err := s.createInstallationToken(ctx, resolved)
	if err != nil && s.canReadWithUserToken(method, requestPath, err) {
		return s.proxyWithUserToken(ctx, resolved.ActorUserID, method, requestPath, input.Headers, policyDecision.Reason)
	}
	if err != nil {
		logGitHubProxyRequest(method, requestPath, statusCodeFromError(err), "deny", "failed to create github installation token")
		return nil, err
	}
	if s.gitHubBudgetTracker != nil {
		allowed, retryAfter, rateLimit := s.gitHubBudgetTracker.AllowWithStatus(installationToken.InstallationID)
		if !allowed {
			retryAfterSeconds := gitHubProxyRetryAfterSeconds(retryAfter)
			logGitHubProxyRequest(method, requestPath, http.StatusTooManyRequests, "deny", "github installation rate limit exceeded")
			return nil, &pkgerrors.APIError{
				Status:     http.StatusTooManyRequests,
				Code:       pkgerrors.CodeGitHubRateLimited,
				Message:    "github installation rate limit exceeded",
				Limit:      &rateLimit.Limit,
				Remaining:  &rateLimit.Remaining,
				ResetAt:    &rateLimit.ResetAt,
				RetryAfter: retryAfterSeconds,
			}
		}
	}

	upstreamReq, err := s.buildUpstreamRequest(ctx, method, requestPath, input.Headers, bodyBytes, hasBody, installationToken.Token)
	if err != nil {
		logGitHubProxyRequest(method, requestPath, statusCodeFromError(err), "deny", "failed to build github proxy request")
		return nil, err
	}

	// The route owns the streamed body and closes it in writeGitHubProxyResponse.
	upstreamResp, err := s.httpClient.Do(upstreamReq) //nolint:bodyclose // Body ownership transfers to GitHubProxyResponse and its caller.
	if err != nil {
		logGitHubProxyRequest(method, requestPath, http.StatusBadGateway, "deny", "github proxy request failed")
		return nil, pkgerrors.Internal("failed to proxy github request").WithCause(err)
	}

	// A 401 means the cached installation token was revoked upstream — evict it
	// so the next proxied call re-mints. Deliberately NOT 403: proxied 403s are
	// routinely per-endpoint permission or secondary-rate-limit denials, and
	// evicting on those would thrash the cache; a suspended installation's 403 is
	// covered by the webhook invalidation instead.
	if upstreamResp.StatusCode == http.StatusUnauthorized {
		invalidateCachedInstallationToken(installationToken.InstallationID)
	}

	logGitHubProxyRequest(method, requestPath, upstreamResp.StatusCode, "allow", policyDecision.Reason)

	return &GitHubProxyResponse{
		StatusCode: upstreamResp.StatusCode,
		Headers:    upstreamResp.Header.Clone(),
		Body:       upstreamResp.Body,
	}, nil
}

// canReadWithUserToken is true only for a read-only pull request or CI GET of
// an imported source whose provenance was verified and that the App does not
// cover. The importer's own credential then reads what GitHub lets them see.
func (s *GitHubProxyService) canReadWithUserToken(method string, requestPath string, err error) bool {
	if s.userTokens == nil || method != http.MethodGet {
		return false
	}
	var apiErr *pkgerrors.APIError
	if !stdErrors.As(err, &apiErr) || apiErr.Cause() != errGitHubImportedSourceAppNotInstalled {
		return false
	}
	_, _, subpath, ok := parseGitHubRepoPath(normalizeGitHubProxyPath(requestPath))
	return ok && isUserTokenReadPath(subpath)
}

func (s *GitHubProxyService) proxyWithUserToken(ctx context.Context, userID int64, method string, requestPath string, headers map[string]string, reason string) (*GitHubProxyResponse, error) {
	token, account, err := s.userTokens.UserGitHubReadToken(ctx, userID)
	if err != nil {
		logGitHubProxyRequest(method, requestPath, statusCodeFromError(err), "deny", "failed to resolve github user token")
		return nil, err
	}
	send := func(token string) (*http.Response, error) {
		upstreamReq, err := s.buildUpstreamRequest(ctx, method, requestPath, headers, nil, false, token)
		if err != nil {
			return nil, err
		}
		resp, err := s.httpClient.Do(upstreamReq) //nolint:bodyclose // Body ownership transfers to GitHubProxyResponse and its caller.
		if err != nil {
			return nil, pkgerrors.Internal("failed to proxy github request").WithCause(err)
		}
		return resp, nil
	}
	upstreamResp, err := send(token)
	if err == nil && upstreamResp.StatusCode == http.StatusUnauthorized {
		// GitHub App user tokens expire: rotate once on an actual 401.
		if rotated, refreshErr := s.userTokens.RefreshUserGitHubReadToken(ctx, account); refreshErr == nil {
			_ = upstreamResp.Body.Close()
			upstreamResp, err = send(rotated)
		}
	}
	if err != nil {
		logGitHubProxyRequest(method, requestPath, http.StatusBadGateway, "deny", "github proxy request failed")
		return nil, err
	}
	logGitHubProxyRequest(method, requestPath, upstreamResp.StatusCode, "allow", reason+" with the importer's github token")
	return &GitHubProxyResponse{
		StatusCode: upstreamResp.StatusCode,
		Headers:    upstreamResp.Header.Clone(),
		Body:       upstreamResp.Body,
	}, nil
}

func (s *GitHubProxyService) createInstallationToken(ctx context.Context, resolved gitHubProxyResolvedContext) (GitHubInstallationToken, error) {
	if resolved.UseImportedSourceInstallationID || resolved.TryImportedSourceInstallationID {
		importedIssuer, ok := s.tokenIssuer.(gitHubProxyImportedSourceTokenIssuer)
		if !ok {
			if resolved.UseImportedSourceInstallationID {
				return GitHubInstallationToken{}, pkgerrors.Internal("github proxy service unavailable")
			}
		} else {
			token, err := importedIssuer.CreateGitHubInstallationTokenForImportedSource(ctx, resolved.ActorUserID, resolved.RepositoryID, resolved.Owner, resolved.Repo)
			if err == nil {
				return token, nil
			}
			if !(resolved.TryImportedSourceInstallationID && !resolved.UseImportedSourceInstallationID && stdErrors.Is(err, errGitHubImportedSourceProvenanceNotFound)) {
				if stdErrors.Is(err, errGitHubImportedSourceProvenanceNotFound) {
					return GitHubInstallationToken{}, pkgerrors.BadRequest("github app is not installed for this repository")
				}
				return GitHubInstallationToken{}, err
			}
		}
	}
	return s.tokenIssuer.CreateGitHubInstallationToken(ctx, resolved.ActorUserID, resolved.Owner, resolved.Repo)
}

func (s *GitHubProxyService) buildUpstreamRequest(
	ctx context.Context,
	method string,
	requestPath string,
	requestHeaders map[string]string,
	body []byte,
	hasBody bool,
	installationToken string,
) (*http.Request, error) {
	upstreamURL := strings.TrimRight(githubAPIBaseURL(), "/") + requestPath

	var bodyReader io.Reader
	if hasBody {
		bodyReader = bytes.NewReader(body)
	}

	req, err := http.NewRequestWithContext(ctx, method, upstreamURL, bodyReader)
	if err != nil {
		return nil, pkgerrors.Internal("failed to build github proxy request").WithCause(err)
	}

	for key, value := range requestHeaders {
		headerName := strings.TrimSpace(key)
		if headerName == "" || isRestrictedGitHubProxyRequestHeader(headerName) {
			continue
		}
		req.Header.Set(headerName, strings.TrimSpace(value))
	}

	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(installationToken))
	if strings.TrimSpace(req.Header.Get("Accept")) == "" {
		req.Header.Set("Accept", "application/vnd.github+json")
	}
	if strings.TrimSpace(req.Header.Get("User-Agent")) == "" {
		req.Header.Set("User-Agent", "smithers-server")
	}
	if strings.TrimSpace(req.Header.Get("X-GitHub-Api-Version")) == "" {
		req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	}
	if hasBody && strings.TrimSpace(req.Header.Get("Content-Type")) == "" {
		req.Header.Set("Content-Type", "application/json")
	}

	return req, nil
}

// logGitHubProxyRequest records one proxied request and its policy decision.
func logGitHubProxyRequest(
	method string,
	requestPath string,
	statusCode int,
	decision string,
	reason string,
) {
	slog.Info("github proxy repo request",
		"auth_source", "server_github_app_installation",
		"method", method,
		"path", requestPath,
		"status_code", statusCode,
		"decision", decision,
		"failure_category", gitHubProxyFailureCategory(statusCode, decision),
		"reason", reason,
	)
}

func gitHubProxyFailureCategory(statusCode int, decision string) string {
	if strings.EqualFold(strings.TrimSpace(decision), "allow") && statusCode >= http.StatusOK && statusCode < http.StatusMultipleChoices {
		return ""
	}
	switch {
	case statusCode == http.StatusUnauthorized:
		return "auth"
	case statusCode == http.StatusForbidden:
		return "permission"
	case statusCode == http.StatusNotFound:
		return "not_found"
	case statusCode == http.StatusTooManyRequests:
		return "rate_limit"
	case statusCode >= http.StatusBadGateway:
		return "upstream"
	case statusCode >= http.StatusBadRequest:
		return "request"
	default:
		return "unknown"
	}
}

func normalizeGitHubProxyMethodAndPath(method string, requestPath string) (string, string, error) {
	normalizedMethod := strings.ToUpper(strings.TrimSpace(method))
	switch normalizedMethod {
	case http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
	default:
		return "", "", pkgerrors.BadRequest("unsupported method")
	}

	trimmedPath := strings.TrimSpace(requestPath)
	if trimmedPath == "" {
		return "", "", pkgerrors.BadRequest("path is required")
	}

	parsed, err := url.ParseRequestURI(trimmedPath)
	if err != nil || parsed == nil {
		return "", "", pkgerrors.BadRequest("invalid path")
	}
	if strings.TrimSpace(parsed.Scheme) != "" || strings.TrimSpace(parsed.Host) != "" {
		return "", "", pkgerrors.BadRequest("path must be relative to the github api")
	}

	cleanPath := normalizeGitHubProxyPath(parsed.Path)

	if strings.TrimSpace(parsed.RawQuery) != "" {
		cleanPath = cleanPath + "?" + parsed.RawQuery
	}

	return normalizedMethod, cleanPath, nil
}

func gitHubProxyRetryAfterSeconds(retryAfter time.Duration) int {
	retryAfterSeconds := int(math.Ceil(retryAfter.Seconds()))
	if retryAfterSeconds < 1 {
		return 1
	}
	return retryAfterSeconds
}

func normalizeGitHubProxyBody(raw json.RawMessage) ([]byte, bool, error) {
	if len(raw) == 0 {
		return nil, false, nil
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil, false, nil
	}
	if !json.Valid(trimmed) {
		return nil, false, pkgerrors.BadRequest("body must be valid json")
	}
	return trimmed, true, nil
}

func isRestrictedGitHubProxyRequestHeader(headerName string) bool {
	switch strings.ToLower(strings.TrimSpace(headerName)) {
	case "authorization",
		"host",
		"content-length",
		"connection",
		"proxy-connection",
		"keep-alive",
		"proxy-authenticate",
		"proxy-authorization",
		"te",
		"trailer",
		"transfer-encoding",
		"upgrade",
		"cookie":
		return true
	default:
		return false
	}
}

func statusCodeFromError(err error) int {
	var apiErr *pkgerrors.APIError
	if stdErrors.As(err, &apiErr) {
		return apiErr.Status
	}
	return http.StatusInternalServerError
}

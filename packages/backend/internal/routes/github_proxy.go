package routes

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type GitHubProxyRouteService interface {
	ProxyRepoRequest(ctx context.Context, actor *db.User, owner string, repo string, input services.GitHubProxyRequest) (*services.GitHubProxyResponse, error)
}

type GitHubProxyHandler struct {
	Service GitHubProxyRouteService
}

type postGitHubProxyRequest struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers"`
	Body    json.RawMessage   `json:"body"`
}

func (h *GitHubProxyHandler) PostRepoGitHubProxy(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("github proxy service unavailable"))
		return
	}

	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	// RAW URL params, not repoOwnerAndName: clients address imported mirrors by
	// their GitHub SOURCE coordinates, and the proxy policy compares these
	// against the GitHub request path. RepoContext rewrites the owner to the
	// mirror's local namespace (provenance fallback), which would 403 every
	// source-coords proxy call. The path rail is a cross-posting guard, not an
	// authz boundary — the middleware already gated repo access, and the proxy
	// rides the acting user's own GitHub credential.
	owner, err := routeParam(r, "owner", "owner is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	repo, err := routeParam(r, "repo", "repository name is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	var req postGitHubProxyRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	if middleware.AuthInfoFromContext(r.Context()).IsAgent() {
		switch strings.ToUpper(strings.TrimSpace(req.Method)) {
		case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
			pkgerrors.WriteError(w, &pkgerrors.APIError{Status: http.StatusForbidden,
				Code: services.GitHubProxyForbiddenActionCode, Message: "machine GitHub mutations are forbidden"})
			return
		}
	}

	proxyResp, svcErr := h.Service.ProxyRepoRequest(r.Context(), user, owner, repo, services.GitHubProxyRequest{
		Method:  req.Method,
		Path:    req.Path,
		Headers: req.Headers,
		Body:    req.Body,
	})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	writeGitHubProxyResponse(w, proxyResp)
}

func writeGitHubProxyResponse(w http.ResponseWriter, proxyResp *services.GitHubProxyResponse) {
	if proxyResp == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("github proxy response missing"))
		return
	}

	body := proxyResp.Body
	if body == nil {
		body = io.NopCloser(strings.NewReader(""))
	}
	defer func() { _ = body.Close() }()

	for key, values := range proxyResp.Headers {
		if isRestrictedGitHubProxyResponseHeader(key) {
			continue
		}
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}

	statusCode := proxyResp.StatusCode
	if statusCode == 0 {
		statusCode = http.StatusOK
	}
	w.WriteHeader(statusCode)
	_, _ = io.Copy(w, body)
}

func isRestrictedGitHubProxyResponseHeader(headerName string) bool {
	switch strings.ToLower(strings.TrimSpace(headerName)) {
	case "set-cookie",
		"connection",
		"proxy-connection",
		"keep-alive",
		"proxy-authenticate",
		"proxy-authorization",
		"te",
		"trailer",
		"transfer-encoding",
		"upgrade",
		"content-length":
		return true
	default:
		return false
	}
}

var _ GitHubProxyRouteService = (*services.GitHubProxyService)(nil)

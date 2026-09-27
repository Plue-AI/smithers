package routes

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/previewgateway"
)

// RepoGatewayRouteService defines the interface expected by RepoGatewayHandler.
type RepoGatewayRouteService interface {
	GetRepoGatewayConnectionInfo(ctx context.Context, input services.RepoGatewayConnectionInput) (services.RepoGatewayConnectionInfo, error)
}

type RepoGatewayRelayService interface {
	AuthorizeRelay(ctx context.Context, gatewayID, token string) (services.RepoGatewayRelayTarget, error)
}

// RepoGatewayHandler serves the per-repo smithers gateway endpoint.
type RepoGatewayHandler struct {
	Service         RepoGatewayRouteService
	RelayService    RepoGatewayRelayService
	RelayServiceURL string
	// RelayToken is presented to the preview gateway on every relayed
	// request (previewgateway.RelayTokenHeader): the gateway refuses
	// smithers-gw-* and smithers-desk-* domains without it.
	RelayToken      string
	RepositoryJobs  RepositoryJobRouteService
	SourceRetention interface {
		Retain(context.Context, int64, int64, services.RepositorySourceRetentionInput) (services.RepositorySourceRetentionResult, error)
	}
	PushTokens interface {
		Mint(context.Context, string, string, services.GatewayPushTokenInput) (services.GatewayPushTokenResult, error)
	}
}

// MintPushToken handles POST /api/gateways/{gatewayID}/push-token.
func (h *RepoGatewayHandler) MintPushToken(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if h.PushTokens == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("gateway push credentials unavailable"))
		return
	}
	var input services.GatewayPushTokenInput
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid push credential request"))
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("push credential request must contain one JSON object"))
		return
	}
	result, err := h.PushTokens.Mint(r.Context(), chi.URLParam(r, "gatewayID"), bearerToken(r.Header.Get("Authorization")), input)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusCreated, result)
}

// PostRepoGateway handles POST /api/repos/{owner}/{repo}/gateway.
//
// It provisions (first call) or resumes (subsequent calls) the durable
// `smithers gateway` Microsandbox VM for the requesting user + repo and returns
// {base_url, token, expires_at}. This route is POST because resolving gateway
// connection details can provision or resume a VM. The token is returned
// in-memory on this response and never persisted in plaintext.
func (h *RepoGatewayHandler) PostRepoGateway(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return
	}

	var input struct {
		WorkspaceID string `json:"workspace_id"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil && err != io.EOF {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid gateway request"))
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("gateway request must contain one JSON object"))
		return
	}
	info, svcErr := h.Service.GetRepoGatewayConnectionInfo(r.Context(), services.RepoGatewayConnectionInput{
		RepositoryID:        repoCtx.Repository.ID,
		WorkspaceID:         input.WorkspaceID,
		UserID:              user.ID,
		RepoOwner:           repoCtx.Owner,
		RepoName:            repoCtx.Repository.Name,
		RepoDefaultBookmark: repoCtx.Repository.DefaultBookmark,
	})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	// The response carries a plaintext gateway operator token — never let a
	// browser or intermediary cache store it.
	w.Header().Set("Cache-Control", "no-store")
	// Relay gateway traffic through the API origin. Cloudflare Universal SSL
	// cannot terminate *.preview.jjhub.tech, while api.jjhub.tech already has a
	// managed certificate and supports WebSocket upgrades. The original direct
	// URL remains an implementation detail between the relay and preview service.
	info.BaseURL = requestOrigin(r) + "/api/gateways/" + info.GatewayID
	pkgerrors.WriteJSON(w, http.StatusOK, info)
}

func requestOrigin(r *http.Request) string {
	scheme := "https"
	if forwarded := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0]); forwarded != "" {
		scheme = forwarded
	} else if r.TLS == nil && (strings.HasPrefix(r.Host, "localhost") || strings.HasPrefix(r.Host, "127.0.0.1")) {
		scheme = "http"
	}
	return scheme + "://" + r.Host
}

func bearerToken(header string) string {
	parts := strings.Fields(header)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return ""
	}
	return parts[1]
}

// Relay proxies both HTTP RPC and WebSocket upgrades to the private preview
// gateway service after validating the per-gateway operator token.
func (h *RepoGatewayHandler) Relay(w http.ResponseWriter, r *http.Request) {
	gatewayID := chi.URLParam(r, "gatewayID")
	if h.RelayService == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("gateway relay unavailable"))
		return
	}
	target, err := h.RelayService.AuthorizeRelay(r.Context(), gatewayID, bearerToken(r.Header.Get("Authorization")))
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	relayToPreviewGateway(w, r, h.RelayServiceURL, previewRelayTarget{
		Domain: target.Domain,
		Prefix: "/api/gateways/" + gatewayID,
		Token:  h.RelayToken,
		// The gateway VM validates its operator token itself.
		ForwardAuthorization: true,
		Principal:            revocation.Principal{GatewayID: gatewayID, UserID: target.UserID, RepositoryID: target.RepositoryID, WorkspaceID: target.WorkspaceID, SandboxID: target.SandboxID},
	})
}

// previewRelayTarget is one authorized hop to the private preview gateway.
type previewRelayTarget struct {
	// Domain is the preview hostname the gateway resolves to a sandbox port.
	Domain string
	// Prefix is the public path prefix stripped before forwarding.
	Prefix string
	// Token is the preview gateway's relay credential. The client never
	// supplies it: whatever it sent under that header is replaced.
	Token string
	// ForwardAuthorization keeps the client's Authorization header. Set it
	// only when the guest itself validates that credential (the repo gateway
	// operator token); every other API-origin credential is always stripped.
	ForwardAuthorization bool
	// Principal tracks upstream connections for revocation.
	Principal revocation.Principal
	// ResponseHeaders are added to every relayed response.
	ResponseHeaders map[string]string
}

// relayToPreviewGateway proxies HTTP and WebSocket traffic for an already
// authorized target to the preview gateway service. Shared by the repo
// gateway relay and the workspace desktop relay.
func relayToPreviewGateway(w http.ResponseWriter, r *http.Request, relayServiceURL string, target previewRelayTarget) {
	relayURL := strings.TrimSpace(relayServiceURL)
	if relayURL == "" {
		relayURL = "http://preview-gateway-preview-gateway.smithers.svc.cluster.local:3000"
	}
	upstream, parseErr := url.Parse(relayURL)
	if parseErr != nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("gateway relay is misconfigured").WithCause(parseErr))
		return
	}
	stripped := strings.TrimPrefix(r.URL.Path, target.Prefix)
	if stripped == "" {
		stripped = "/"
	}
	// The preview gateway routes by Host only for *.preview hostnames its own
	// load balancer terminates. This relay reaches it by cluster service name,
	// so it must use the /__preview/{domain}/{path} route
	// (previewgateway.RoutePrefix); the bare path 404s on every request.
	r.URL.Path = previewgateway.RoutePrefix + target.Domain + stripped
	proxy := httputil.NewSingleHostReverseProxy(upstream)
	proxy.ModifyResponse = func(response *http.Response) error {
		// The relay answers on the API origin: a guest cookie would land in
		// the API's cookie jar, where it could shadow the session or CSRF
		// cookie.
		response.Header.Del("Set-Cookie")
		for key, value := range target.ResponseHeaders {
			response.Header.Set(key, value)
		}
		return nil
	}
	proxy.ErrorHandler = func(writer http.ResponseWriter, _ *http.Request, proxyErr error) {
		writeRouteError(writer, r, pkgerrors.Internal("gateway relay unavailable: "+proxyErr.Error()))
	}
	// Revocation: the relay is authorized once, by the operator/session
	// token, then carries traffic for as long as the client keeps the
	// connection open. Every upstream connection is tracked under the
	// principal so a revocation (gateway torn down, owner disabled, owner
	// losing the repository) closes it; a plain HTTP request additionally has
	// its context cancelled.
	principal := target.Principal
	proxy.Transport = relayConns.transport(principal)
	if source := currentRevocationSource(); source != nil {
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		revoked := source.Watch(ctx, principal)
		go func() {
			select {
			case <-revoked:
				cancel()
			case <-ctx.Done():
			}
		}()
		r = r.WithContext(ctx)
	}
	request := r.Clone(r.Context())
	request.Host = target.Domain
	request.Header.Set("Host", target.Domain)
	stripAPICredentials(request.Header, target.ForwardAuthorization)
	if token := strings.TrimSpace(target.Token); token != "" {
		request.Header.Set(previewgateway.RelayTokenHeader, token)
	}
	proxy.ServeHTTP(w, request)
}

// stripAPICredentials removes what a browser or an auth proxy attaches to a
// request on the API origin: the session and CSRF cookies, proxy and
// identity-provider headers (workspacePreviewCredentialHeaders) and the relay
// token, which only the relay sets. The relay has already authorized on the
// path token or the bearer token; the guest behind it is user-controlled and
// must see none of them. Authorization survives only for a guest that
// validates that credential itself.
func stripAPICredentials(header http.Header, forwardAuthorization bool) {
	var authorization []string
	if forwardAuthorization {
		authorization = header.Values("Authorization")
	}
	for _, name := range workspacePreviewCredentialHeaders {
		header.Del(name)
	}
	header.Del(previewgateway.RelayTokenHeader)
	if len(authorization) > 0 {
		header["Authorization"] = authorization
	}
}

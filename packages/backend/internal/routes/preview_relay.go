package routes

import (
	"context"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/previewgateway"
)

func requestOrigin(r *http.Request) string {
	scheme := "https"
	if forwarded := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0]); forwarded != "" {
		scheme = forwarded
	} else if r.TLS == nil && (strings.HasPrefix(r.Host, "localhost") || strings.HasPrefix(r.Host, "127.0.0.1")) {
		scheme = "http"
	}
	return scheme + "://" + r.Host
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
	// Principal tracks upstream connections for revocation.
	Principal revocation.Principal
	// ResponseHeaders are added to every relayed response.
	ResponseHeaders map[string]string
}

// relayToPreviewGateway proxies HTTP and WebSocket traffic for an already
// authorized target (the workspace desktop relay) to the preview gateway
// service.
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
	// Revocation: the relay is authorized once, by the session token, then
	// carries traffic for as long as the client keeps the connection open.
	// Every upstream connection is tracked under the principal so a revocation
	// (share removed, owner disabled, owner losing the repository) closes it;
	// a plain HTTP request additionally has its context cancelled.
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
	stripAPICredentials(request.Header)
	if token := strings.TrimSpace(target.Token); token != "" {
		request.Header.Set(previewgateway.RelayTokenHeader, token)
	}
	proxy.ServeHTTP(w, request)
}

// stripAPICredentials removes what a browser or an auth proxy attaches to a
// request on the API origin: the session and CSRF cookies, proxy and
// identity-provider headers (workspacePreviewCredentialHeaders) and the relay
// token, which only the relay sets. The relay has already authorized on the
// path token; the guest behind it is user-controlled and must see none of
// them.
func stripAPICredentials(header http.Header) {
	for _, name := range workspacePreviewCredentialHeaders {
		header.Del(name)
	}
	header.Del(previewgateway.RelayTokenHeader)
}

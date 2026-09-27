package previewgateway

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"github.com/coder/websocket"

	"github.com/smithersai/smithers/packages/backend/internal/observability"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const RoutePrefix = "/__preview/"

// RelayTokenHeader carries the shared relay credential on requests for
// platform domains (isPlatformDomain). The gateway is reachable from the
// public internet for user previews, so those domains, whose only authorized
// caller is the API relay (which has already checked the desktop session
// token), are refused without it. The header is stripped before the box sees
// the request.
const RelayTokenHeader = "X-Plue-Preview-Relay-Token"

type PortDialer interface {
	Dial(context.Context, string) (net.Conn, error)
}

type ControllerDialer struct {
	ControllerURL string
	HTTPClient    *http.Client
	APIKey        string
}

func (d *ControllerDialer) Dial(ctx context.Context, domain string) (net.Conn, error) {
	endpoint, err := url.Parse(strings.TrimRight(strings.TrimSpace(d.ControllerURL), "/") + "/v1/domains/" + url.PathEscape(domain) + "/port")
	if err != nil {
		return nil, err
	}
	switch endpoint.Scheme {
	case "http":
		endpoint.Scheme = "ws"
	case "https":
		endpoint.Scheme = "wss"
	default:
		return nil, errors.New("unsupported controller URL scheme")
	}
	headers := http.Header{}
	if key := strings.TrimSpace(d.APIKey); key != "" {
		headers.Set("Authorization", "Bearer "+key)
	}
	socket, response, err := websocket.Dial(ctx, endpoint.String(), &websocket.DialOptions{
		HTTPClient: d.HTTPClient, HTTPHeader: headers,
	})
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if err != nil {
		return nil, fmt.Errorf("open preview port stream: %w", err)
	}
	return websocket.NetConn(ctx, socket, websocket.MessageBinary), nil
}

type Handler struct {
	dialer          PortDialer
	allowedSuffixes []string
	relayToken      string
	logger          *slog.Logger
	metrics         *Metrics
}

// SetMetrics records every request's outcome and latency. Nil disables it.
func (h *Handler) SetMetrics(metrics *Metrics) { h.metrics = metrics }

// SetRelayToken installs the credential platform domains must present. An
// empty token fails closed: every platform-domain request is refused, never
// served to an unauthenticated caller.
func (h *Handler) SetRelayToken(token string) { h.relayToken = strings.TrimSpace(token) }

func NewHandler(dialer PortDialer, allowedSuffixes []string, logger *slog.Logger) *Handler {
	if logger == nil {
		logger = slog.Default()
	}
	clean := make([]string, 0, len(allowedSuffixes))
	for _, suffix := range allowedSuffixes {
		suffix = strings.ToLower(strings.TrimSpace(suffix))
		if suffix != "" {
			clean = append(clean, strings.TrimPrefix(suffix, "*"))
		}
	}
	return &Handler{dialer: dialer, allowedSuffixes: clean, logger: logger}
}

func (h *Handler) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	domain, upstreamPath, ok := h.route(request.URL.Path)
	if !ok {
		// The *.preview.jjhub.tech load balancer terminates TLS and forwards
		// the bare request, no /__preview/ prefix, so an approved Host is the
		// domain and owns its whole path space, /healthz included. The API
		// relay and the health probes arrive under other hosts.
		domain, upstreamPath, ok = h.routeHost(request.Host, request.URL.Path)
	}
	if !ok && request.URL.Path == "/healthz" {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"status":"ok"}`))
		return
	}
	startedAt := time.Now()
	outcome := outcomeServed
	defer func() { h.metrics.observe(outcome, time.Since(startedAt)) }()
	if !ok {
		outcome = outcomeNotFound
		// The one envelope, not http.NotFound's text/plain: a preview URL is
		// fetched by the same app that reads every other plue failure, and it
		// branches on `code`, never on a sentence.
		pkgerrors.WriteError(writer, pkgerrors.NotFound("no preview is served at this path"))
		return
	}
	if isPlatformDomain(domain) && !h.relayAuthorized(request) {
		outcome = outcomeUnauthorized
		// The domain, never the presented or expected token.
		h.logger.Warn("preview relay credential refused", "domain", domain,
			"token_configured", h.relayToken != "", "token_presented", request.Header.Get(RelayTokenHeader) != "")
		pkgerrors.WriteError(writer, pkgerrors.Unauthorized("preview relay credential required"))
		return
	}
	if h.dialer == nil {
		outcome = outcomeUnavailable
		h.logger.Error("preview gateway has no port dialer", "domain", domain)
		pkgerrors.WriteError(writer, pkgerrors.New(pkgerrors.CodeServiceUnavailable,
			"preview gateway unavailable"))
		return
	}

	transport := &http.Transport{
		ForceAttemptHTTP2: false,
		DisableKeepAlives: true,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return h.dialer.Dial(ctx, domain)
		},
	}
	defer transport.CloseIdleConnections()
	proxy := &httputil.ReverseProxy{
		Transport:     observability.NewHTTPTransport(transport),
		FlushInterval: -1,
		Rewrite: func(proxyRequest *httputil.ProxyRequest) {
			proxyRequest.Out.URL.Scheme = "http"
			proxyRequest.Out.URL.Host = "microsandbox-preview.internal"
			proxyRequest.Out.URL.Path = upstreamPath
			proxyRequest.Out.URL.RawPath = ""
			proxyRequest.Out.URL.RawQuery = request.URL.RawQuery
			proxyRequest.Out.Host = domain
			proxyRequest.Out.Header.Del("X-Plue-Access-Token")
			proxyRequest.Out.Header.Del(RelayTokenHeader)
			proxyRequest.Out.Header.Del("X-Plue-Placement-Generation")
			proxyRequest.SetXForwarded()
		},
		ErrorHandler: func(response http.ResponseWriter, _ *http.Request, err error) {
			outcome = outcomeUpstreamError
			h.logger.Warn("preview proxy failed", "domain", domain, "error", err)
			// preview_unavailable is registered as infra: the box is the
			// caller's, but plue could not reach the port it is serving.
			pkgerrors.WriteError(response, pkgerrors.New(pkgerrors.CodePreviewUnavailable,
				"preview target unavailable"))
		},
	}
	proxy.ServeHTTP(writer, request)
}

func (h *Handler) relayAuthorized(request *http.Request) bool {
	if h.relayToken == "" {
		return false
	}
	presented := strings.TrimSpace(request.Header.Get(RelayTokenHeader))
	return subtle.ConstantTimeCompare([]byte(presented), []byte(h.relayToken)) == 1
}

// isPlatformDomain matches the domains only the API relay may reach: desktop
// streams (services.workspaceDesktopDomain), derivable from vm_id, which every
// workspace response carries, so the domain itself is no secret. Any suffix
// counts: an operator allowlisting another suffix does not reopen the door.
//
// smithers-gw-* are the retired box gateways' domains (#2198). Nothing relays
// to them any more; they stay refused until the one-release convergence
// (services.RepoGatewayRetirement) has revoked every one, and go with it.
func isPlatformDomain(domain string) bool {
	return strings.HasPrefix(domain, "smithers-gw-") || strings.HasPrefix(domain, "smithers-desk-")
}

func (h *Handler) route(requestPath string) (string, string, bool) {
	if !strings.HasPrefix(requestPath, RoutePrefix) {
		return "", "", false
	}
	remainder := strings.TrimPrefix(requestPath, RoutePrefix)
	parts := strings.SplitN(remainder, "/", 2)
	domain := strings.ToLower(strings.TrimSpace(parts[0]))
	if !validHostname(domain) || !h.allowedDomain(domain) {
		return "", "", false
	}
	upstreamPath := "/"
	if len(parts) == 2 {
		upstreamPath += parts[1]
	}
	return domain, upstreamPath, true
}

// routeHost treats an approved preview hostname in Host as the domain and the
// request path, unchanged, as the upstream path.
func (h *Handler) routeHost(host, requestPath string) (string, string, bool) {
	if bare, _, err := net.SplitHostPort(host); err == nil {
		host = bare
	}
	domain := strings.ToLower(strings.TrimSpace(host))
	if !validHostname(domain) || !h.allowedDomain(domain) {
		return "", "", false
	}
	if requestPath == "" {
		requestPath = "/"
	}
	return domain, requestPath, true
}

func (h *Handler) allowedDomain(domain string) bool {
	for _, suffix := range h.allowedSuffixes {
		if strings.HasSuffix(domain, suffix) && len(domain) > len(suffix) {
			return true
		}
	}
	return false
}

func validHostname(host string) bool {
	if len(host) == 0 || len(host) > 253 || strings.HasPrefix(host, ".") || strings.HasSuffix(host, ".") {
		return false
	}
	for _, label := range strings.Split(host, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, character := range label {
			if !((character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character == '-') {
				return false
			}
		}
	}
	return true
}

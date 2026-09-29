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
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/smithersai/smithers/packages/backend/internal/observability"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// RoutePrefix is reserved for callers authenticated with the relay token.
const RoutePrefix = "/__preview/"

// RelayTokenHeader carries the shared relay credential. Platform domains
// (isPlatformDomain), whose only authorized caller is the API relay (which
// has already checked the desktop session token), are refused without it;
// user previews accept it or a preview session (see ticket.go). The header is
// stripped before the box sees the request.
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
	tickets         *Tickets
	authorizer      GrantAuthorizer
	logger          *slog.Logger
	metrics         *Metrics

	// grantsMu guards grants: session tickets the API confirmed, until when.
	// A preview page loads many assets; one API check covers a burst of them
	// and still bounds how long a revoked grant keeps working.
	grantsMu     sync.Mutex
	grants       map[string]time.Time
	publicGrants map[string]publicPreviewGrantCache
	now          func() time.Time
}

// grantRecheckInterval bounds how long a confirmed grant is trusted before
// the API is asked again.
const grantRecheckInterval = 5 * time.Second

const maxCachedGrants = 4096

// SetMetrics records every request's outcome and latency. Nil disables it.
func (h *Handler) SetMetrics(metrics *Metrics) { h.metrics = metrics }

// SetRelayToken installs the credential platform domains must present and
// the secret preview tickets are signed with. An empty token fails closed:
// every platform-domain and user-preview request is refused, never served to
// an unauthenticated caller.
func (h *Handler) SetRelayToken(token string) {
	h.relayToken = strings.TrimSpace(token)
	h.tickets = NewTickets(h.relayToken)
}

// SetGrantAuthorizer installs the live recheck of a viewer's access (the
// API, see APIAuthorizer). Without one every user preview is refused: a
// signature alone cannot notice a removed share or a suspended user.
func (h *Handler) SetGrantAuthorizer(authorizer GrantAuthorizer) { h.authorizer = authorizer }

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
	return &Handler{dialer: dialer, allowedSuffixes: clean, logger: logger,
		grants: map[string]time.Time{}, publicGrants: map[string]publicPreviewGrantCache{}, now: time.Now}
}

func (h *Handler) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	domain, upstreamPath, ok := h.route(request.URL.Path)
	pathRouted := ok
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
	if (pathRouted || isPlatformDomain(domain)) && !h.relayAuthorized(request) {
		outcome = outcomeUnauthorized
		// The domain, never the presented or expected token.
		h.logger.Warn("preview relay credential refused", "domain", domain,
			"token_configured", h.relayToken != "", "token_presented", request.Header.Get(RelayTokenHeader) != "")
		pkgerrors.WriteError(writer, pkgerrors.Unauthorized("preview relay credential required"))
		return
	}
	if !isPlatformDomain(domain) && !h.relayAuthorized(request) {
		if ticket := request.URL.Query().Get(TicketQueryParameter); ticket != "" {
			if !h.exchangeTicket(writer, request, domain, ticket) {
				outcome = outcomeUnauthorized
			}
			return
		}
		if status := h.authorizeSession(request, domain); status != http.StatusOK {
			if status == http.StatusServiceUnavailable {
				outcome = outcomeUnavailable
				pkgerrors.WriteError(writer, pkgerrors.New(pkgerrors.CodeServiceUnavailable,
					"preview authorization unavailable"))
				return
			}
			outcome = outcomeUnauthorized
			pkgerrors.WriteError(writer, pkgerrors.Unauthorized("preview credential required"))
			return
		}
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
			connection, err := h.dialer.Dial(ctx, domain)
			if err != nil || isPlatformDomain(domain) || h.relayAuthorized(request) {
				return connection, err
			}
			return h.watchPreviewConnection(request, domain, connection), nil
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
			removeSessionCookie(proxyRequest.Out.Header)
			proxyRequest.SetXForwarded()
		},
		// The guest may not overwrite or clear the viewer's preview session.
		ModifyResponse: func(response *http.Response) error {
			var kept []string
			for _, value := range response.Header.Values("Set-Cookie") {
				if name, _, _ := strings.Cut(strings.TrimSpace(value), "="); name != SessionCookieName {
					kept = append(kept, value)
				}
			}
			response.Header.Del("Set-Cookie")
			for _, value := range kept {
				response.Header.Add("Set-Cookie", value)
			}
			return nil
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

// watchPreviewConnection also revokes upgraded sockets and streaming HTTP
// responses: those do not return to ServeHTTP for another request check.
func (h *Handler) watchPreviewConnection(request *http.Request, domain string, connection net.Conn) net.Conn {
	watched := &previewConnection{Conn: connection, done: make(chan struct{})}
	go func() {
		ticker := time.NewTicker(grantRecheckInterval)
		defer ticker.Stop()
		defer watched.Close()
		for {
			select {
			case <-watched.done:
				return
			case <-request.Context().Done():
				return
			case <-ticker.C:
				ctx, cancel := context.WithTimeout(request.Context(), grantRecheckInterval)
				status := h.authorizeSessionFresh(request.WithContext(ctx), domain, false)
				cancel()
				if status != http.StatusOK {
					return
				}
			}
		}
	}()
	return watched
}

type previewConnection struct {
	net.Conn
	done chan struct{}
	once sync.Once
}

func (c *previewConnection) Close() error {
	c.once.Do(func() { close(c.done) })
	return c.Conn.Close()
}

// exchangeTicket turns the API's short-lived URL ticket into the host-only
// session cookie and redirects to the same URL without the ticket, so it
// never reaches guest code, a Referer, or the page's history entry.
func (h *Handler) exchangeTicket(writer http.ResponseWriter, request *http.Request, domain, ticket string) bool {
	grant, err := h.tickets.Verify(ticket, PurposeExchange, domain)
	if err != nil {
		h.logger.Warn("preview ticket refused", "domain", domain, "tickets_configured", h.tickets != nil)
		pkgerrors.WriteError(writer, pkgerrors.Unauthorized("preview credential required"))
		return false
	}
	session, err := h.tickets.Issue(grant, PurposeSession, SessionTicketTTL)
	if err != nil {
		pkgerrors.WriteError(writer, pkgerrors.Unauthorized("preview credential required"))
		return false
	}
	http.SetCookie(writer, &http.Cookie{
		Name: SessionCookieName, Value: session, Path: "/",
		MaxAge: int(SessionTicketTTL / time.Second), Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode,
	})
	location := url.URL{Path: request.URL.Path, RawPath: request.URL.RawPath, RawQuery: withoutTicket(request.URL.RawQuery)}
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Referrer-Policy", "no-referrer")
	http.Redirect(writer, request, location.String(), http.StatusFound)
	return true
}

// authorizeSession returns 200 when the request carries a session cookie for
// domain whose grant the API still confirms, 503 when the API cannot answer,
// and 401 otherwise.
func (h *Handler) authorizeSession(request *http.Request, domain string) int {
	return h.authorizeSessionFresh(request, domain, true)
}

func (h *Handler) authorizeSessionFresh(request *http.Request, domain string, allowCached bool) int {
	status := h.authorizePrivateSession(request, domain, allowCached)
	if status == http.StatusUnauthorized {
		return h.authorizePublicPreview(request.Context(), domain, allowCached)
	}
	return status
}

type publicPreviewGrantCache struct {
	until  time.Time
	status int
}

func (h *Handler) authorizePublicPreview(ctx context.Context, domain string, allowCached bool) int {
	public, ok := h.authorizer.(PublicPreviewAuthorizer)
	if !ok || h.tickets == nil {
		return http.StatusUnauthorized
	}
	now := h.now()
	h.grantsMu.Lock()
	cached, found := h.publicGrants[domain]
	h.grantsMu.Unlock()
	if allowCached && found && now.Before(cached.until) {
		return cached.status
	}
	status := http.StatusOK
	if err := public.AuthorizePublicPreview(ctx, domain); err != nil {
		if !errors.Is(err, ErrGrantRevoked) {
			return http.StatusServiceUnavailable
		}
		status = http.StatusUnauthorized
	}
	h.grantsMu.Lock()
	if len(h.publicGrants) >= maxCachedGrants {
		for key, value := range h.publicGrants {
			if !now.Before(value.until) {
				delete(h.publicGrants, key)
			}
		}
		if len(h.publicGrants) >= maxCachedGrants {
			h.publicGrants = map[string]publicPreviewGrantCache{}
		}
	}
	h.publicGrants[domain] = publicPreviewGrantCache{until: now.Add(grantRecheckInterval), status: status}
	h.grantsMu.Unlock()
	return status
}

func (h *Handler) authorizePrivateSession(request *http.Request, domain string, allowCached bool) int {
	cookie, err := request.Cookie(SessionCookieName)
	if err != nil {
		return http.StatusUnauthorized
	}
	if _, err := h.tickets.Verify(cookie.Value, PurposeSession, domain); err != nil {
		h.logger.Warn("preview session refused", "domain", domain, "tickets_configured", h.tickets != nil)
		return http.StatusUnauthorized
	}
	if h.authorizer == nil {
		h.logger.Error("preview gateway has no grant authorizer: refusing user previews", "domain", domain)
		return http.StatusUnauthorized
	}
	now := h.now()
	h.grantsMu.Lock()
	until, cached := h.grants[cookie.Value]
	h.grantsMu.Unlock()
	if allowCached && cached && now.Before(until) {
		return http.StatusOK
	}
	if err := h.authorizer.AuthorizeGrant(request.Context(), cookie.Value); err != nil {
		h.grantsMu.Lock()
		delete(h.grants, cookie.Value)
		h.grantsMu.Unlock()
		if errors.Is(err, ErrGrantRevoked) {
			h.logger.Info("preview grant revoked", "domain", domain)
			return http.StatusUnauthorized
		}
		h.logger.Warn("preview grant check failed", "domain", domain, "error", err)
		return http.StatusServiceUnavailable
	}
	h.grantsMu.Lock()
	if len(h.grants) >= maxCachedGrants {
		for ticket, expiry := range h.grants {
			if !now.Before(expiry) {
				delete(h.grants, ticket)
			}
		}
		if len(h.grants) >= maxCachedGrants {
			h.grants = map[string]time.Time{}
		}
	}
	h.grants[cookie.Value] = now.Add(grantRecheckInterval)
	h.grantsMu.Unlock()
	return http.StatusOK
}

// withoutTicket drops the ticket from a raw query and keeps every other
// parameter exactly as the client sent it, order and encoding included.
func withoutTicket(rawQuery string) string {
	kept := make([]string, 0, strings.Count(rawQuery, "&")+1)
	for _, pair := range strings.Split(rawQuery, "&") {
		key, _, _ := strings.Cut(pair, "=")
		if unescaped, err := url.QueryUnescape(key); pair == "" || (err == nil && unescaped == TicketQueryParameter) {
			continue
		}
		kept = append(kept, pair)
	}
	return strings.Join(kept, "&")
}

// removeSessionCookie drops the preview session from a Cookie header and
// keeps the guest application's own cookies.
func removeSessionCookie(header http.Header) {
	values := header.Values("Cookie")
	if len(values) == 0 {
		return
	}
	var kept []string
	for _, value := range values {
		for _, pair := range strings.Split(value, ";") {
			pair = strings.TrimSpace(pair)
			if name, _, _ := strings.Cut(pair, "="); pair != "" && name != SessionCookieName {
				kept = append(kept, pair)
			}
		}
	}
	header.Del("Cookie")
	if len(kept) > 0 {
		header.Set("Cookie", strings.Join(kept, "; "))
	}
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

package routes

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/previewgateway"
)

const previewTicketWorkspace = "11111111-1111-4111-8111-111111111111"

type revocablePreviewAuthorizer struct {
	mu      sync.Mutex
	revoked bool
	calls   []int64
}

func (a *revocablePreviewAuthorizer) AuthorizeWorkspacePreview(_ context.Context, workspaceID string, repositoryID, userID int64) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.calls = append(a.calls, userID)
	if a.revoked || workspaceID != previewTicketWorkspace || repositoryID != 200 {
		return pkgerrors.Forbidden("access denied")
	}
	return nil
}

type guestDialer struct {
	mu     sync.Mutex
	dialed int
}

func (d *guestDialer) Dial(context.Context, string) (net.Conn, error) {
	d.mu.Lock()
	d.dialed++
	d.mu.Unlock()
	client, server := net.Pipe()
	go func() {
		defer server.Close()
		request, err := http.ReadRequest(bufio.NewReader(server))
		if err != nil {
			return
		}
		_ = request.Body.Close()
		_, _ = io.WriteString(server, "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nguest")
	}()
	return client, nil
}

// The whole W2 chain: the API's preview route mints a ticket into its
// redirect, the gateway swaps it for a session cookie and asks the API's
// grant check (behind the relay token) on each request, and removing the
// viewer's share ends the preview.
func TestHostedPreviewTicketFlowEndsOnRevocation(t *testing.T) {
	t.Parallel()
	const relayToken = "relay-secret"
	domain := "3000-" + previewTicketWorkspace + ".preview.jjhub.tech"
	tickets := previewgateway.NewTickets(relayToken)

	authorizer := &revocablePreviewAuthorizer{}
	api := httptest.NewServer(middleware.RequireSharedBearerToken(relayToken)(http.HandlerFunc(
		(&WorkspacePreviewTicketHandler{Service: authorizer, Tickets: tickets}).Authorize)))
	t.Cleanup(api.Close)
	guest := &guestDialer{}
	gateway := previewgateway.NewHandler(guest, []string{".preview.jjhub.tech"}, nil)
	gateway.SetRelayToken(relayToken)
	gateway.SetGrantAuthorizer(&previewgateway.APIAuthorizer{URL: api.URL, RelayToken: relayToken, HTTPClient: api.Client()})

	// The API's hosted redirect carries an exchange ticket and keeps the
	// requested path and query.
	h := &WorkspaceHandler{
		Service:        &previewRouteService{access: services.WorkspacePreviewAccess{URL: "https://" + domain + "/"}},
		PreviewTickets: tickets,
	}
	request := previewRequest(t, "3000", "app/page?x=%2F&x=2")
	request = withRouteParams(request, map[string]string{"id": previewTicketWorkspace, "port": "3000", "*": "app/page"})
	rec := httptest.NewRecorder()
	h.ProxyWorkspacePreview(rec, request)
	require.Equal(t, http.StatusTemporaryRedirect, rec.Code, rec.Body.String())
	assert.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
	location, err := url.Parse(rec.Header().Get("Location"))
	require.NoError(t, err)
	assert.Equal(t, domain, location.Host)
	assert.Equal(t, "/app/page", location.Path)
	assert.True(t, strings.HasPrefix(location.RawQuery, "x=%2F&x=2&"+previewgateway.TicketQueryParameter+"="), location.RawQuery)

	// Without the ticket the gateway refuses; with it, a cookie.
	serve := func(request *http.Request) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		gateway.ServeHTTP(recorder, request)
		return recorder
	}
	assert.Equal(t, http.StatusUnauthorized, serve(httptest.NewRequest(http.MethodGet, "https://"+domain+"/app/page", nil)).Code)
	exchanged := serve(httptest.NewRequest(http.MethodGet, location.String(), nil))
	require.Equal(t, http.StatusFound, exchanged.Code)
	assert.Equal(t, "/app/page?x=%2F&x=2", exchanged.Header().Get("Location"))
	cookies := exchanged.Result().Cookies()
	require.Len(t, cookies, 1)

	viewer := httptest.NewRequest(http.MethodGet, "https://"+domain+"/app/page", nil)
	viewer.AddCookie(cookies[0])
	served := serve(viewer)
	require.Equal(t, http.StatusOK, served.Code, served.Body.String())
	assert.Equal(t, "guest", served.Body.String())
	assert.Equal(t, []int64{1}, authorizer.calls, "the grant check names the viewer the API authenticated")

	// Share removed: a fresh gateway (no cached confirmation) refuses the
	// same cookie before dialing the guest.
	authorizer.mu.Lock()
	authorizer.revoked = true
	authorizer.mu.Unlock()
	fresh := previewgateway.NewHandler(guest, []string{".preview.jjhub.tech"}, nil)
	fresh.SetRelayToken(relayToken)
	fresh.SetGrantAuthorizer(&previewgateway.APIAuthorizer{URL: api.URL, RelayToken: relayToken, HTTPClient: api.Client()})
	dialed := guest.dialed
	revoked := httptest.NewRecorder()
	viewer = httptest.NewRequest(http.MethodGet, "https://"+domain+"/app/page", nil)
	viewer.AddCookie(cookies[0])
	fresh.ServeHTTP(revoked, viewer)
	assert.Equal(t, http.StatusUnauthorized, revoked.Code)
	assert.Equal(t, dialed, guest.dialed, "a revoked viewer reached the guest")
}

func TestWorkspacePreviewTicketAuthorizeRefusals(t *testing.T) {
	t.Parallel()
	tickets := previewgateway.NewTickets("relay-secret")
	authorizer := &revocablePreviewAuthorizer{}
	handler := middleware.RequireSharedBearerToken("relay-secret")(http.HandlerFunc(
		(&WorkspacePreviewTicketHandler{Service: authorizer, Tickets: tickets}).Authorize))
	issue := func(domain, workspaceID string, purpose previewgateway.TicketPurpose) string {
		ticket, err := tickets.Issue(previewgateway.Grant{Domain: domain, WorkspaceID: workspaceID, RepositoryID: 200, UserID: 1}, purpose, previewgateway.SessionTicketTTL)
		require.NoError(t, err)
		return ticket
	}
	post := func(bearer, ticket string) int {
		request := httptest.NewRequest(http.MethodPost, "/internal/workspace-previews/authorize", strings.NewReader(`{"ticket":"`+ticket+`"}`))
		request.Header.Set("Authorization", "Bearer "+bearer)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		return recorder.Code
	}
	valid := issue("3000-"+previewTicketWorkspace+".preview.jjhub.tech", previewTicketWorkspace, previewgateway.PurposeSession)

	assert.Equal(t, http.StatusNoContent, post("relay-secret", valid))
	assert.Equal(t, http.StatusUnauthorized, post("wrong", valid), "only the gateway may ask")
	assert.Equal(t, http.StatusForbidden, post("relay-secret", issue("3000-"+previewTicketWorkspace+".preview.jjhub.tech", previewTicketWorkspace, previewgateway.PurposeExchange)),
		"an exchange ticket is not a session")
	assert.Equal(t, http.StatusForbidden, post("relay-secret", issue("3000-22222222-2222-4222-8222-222222222222.preview.jjhub.tech", previewTicketWorkspace, previewgateway.PurposeSession)),
		"a grant naming another workspace's host")
	assert.Equal(t, http.StatusForbidden, post("relay-secret", issue("smithers-desk-vm-1.preview.jjhub.tech", previewTicketWorkspace, previewgateway.PurposeSession)))
	assert.Equal(t, http.StatusForbidden, post("relay-secret", valid[:len(valid)-2]+"AA"))
}

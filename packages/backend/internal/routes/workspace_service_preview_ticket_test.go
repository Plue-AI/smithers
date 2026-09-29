package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/previewgateway"
	"github.com/stretchr/testify/require"
)

type previewServiceListing struct {
	mockWorkspaceRouteService
	domain string
}

func (s *previewServiceListing) ResolveWorkspacePreview(context.Context, string, int64, int64, uint16, string) (services.WorkspacePreviewAccess, error) {
	return services.WorkspacePreviewAccess{URL: "https://" + s.domain}, nil
}

func TestWorkspaceServiceURLsCarryPreviewHandoff(t *testing.T) {
	const domain = "3000-" + previewTicketWorkspace + ".preview.jjhub.tech"
	tickets := previewgateway.NewTickets("secret")
	service := &mockWorkspaceRouteService{
		listWorkspaceServicesFn: func(context.Context, string, int64, int64) ([]services.WorkspaceManagedService, error) {
			return []services.WorkspaceManagedService{{Name: "web", Port: 3000, URL: "https://" + domain}}, nil
		},
		manageWorkspaceServiceFn: func(context.Context, string, int64, int64, string, string) (services.WorkspaceManagedService, error) {
			return services.WorkspaceManagedService{Name: "web", Port: 3000, URL: "https://" + domain}, nil
		},
	}
	handler := &WorkspaceHandler{Service: &previewServiceListing{mockWorkspaceRouteService: *service, domain: domain}, PreviewTickets: tickets}
	for _, listing := range []bool{true, false} {
		request := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workspaces/ws-1/services", nil)
		request = withRouteParams(request, map[string]string{"id": previewTicketWorkspace, "name": "web", "action": "restart"})
		request = withWorkspaceRepoCtx(request, "alice", "demo")
		request = withAuth(request, 7, "alice")
		response := httptest.NewRecorder()
		var result services.WorkspaceManagedService
		if listing {
			handler.ListWorkspaceServices(response, request)
			var rows []services.WorkspaceManagedService
			require.Equal(t, http.StatusOK, response.Code, response.Body.String())
			require.NoError(t, json.Unmarshal(response.Body.Bytes(), &rows))
			require.Len(t, rows, 1)
			result = rows[0]
		} else {
			handler.ManageWorkspaceService(response, request)
			require.Equal(t, http.StatusOK, response.Code, response.Body.String())
			require.NoError(t, json.Unmarshal(response.Body.Bytes(), &result))
		}
		require.Equal(t, "https://example.com/api/repos/alice/demo/workspaces/"+previewTicketWorkspace+"/preview/3000", result.URL)
		parsedURL, err := url.Parse(result.URL)
		require.NoError(t, err)
		require.True(t, parsedURL.IsAbs())
		require.Equal(t, "example.com", parsedURL.Host)
		anonymous := withRouteParams(httptest.NewRequest(http.MethodGet, result.URL, nil), map[string]string{"id": previewTicketWorkspace, "port": "3000"})
		denied := httptest.NewRecorder()
		handler.ProxyWorkspacePreview(denied, anonymous)
		require.Equal(t, http.StatusUnauthorized, denied.Code)
		clicked := withAuth(withWorkspaceRepoCtx(anonymous, "alice", "demo"), 42, "bob")
		redirect := httptest.NewRecorder()
		handler.ProxyWorkspacePreview(redirect, clicked)
		require.Equal(t, http.StatusTemporaryRedirect, redirect.Code)
		target, err := url.Parse(redirect.Header().Get("Location"))
		require.NoError(t, err)
		grant, err := tickets.Verify(target.Query().Get(previewgateway.TicketQueryParameter), previewgateway.PurposeExchange, domain)
		require.NoError(t, err, "listing=%v: legacy service URL lacks preview handoff", listing)
		require.Equal(t, int64(42), grant.UserID, "ticket belongs to clicking viewer, never listing viewer")
		require.Equal(t, int64(200), grant.RepositoryID)
		require.Equal(t, previewTicketWorkspace, grant.WorkspaceID)
		api := httptest.NewServer(middleware.RequireSharedBearerToken("secret")(http.HandlerFunc(
			(&WorkspacePreviewTicketHandler{Service: &revocablePreviewAuthorizer{}, Tickets: tickets}).Authorize)))
		t.Cleanup(api.Close)
		gateway := previewgateway.NewHandler(&guestDialer{}, []string{".preview.jjhub.tech"}, nil)
		gateway.SetRelayToken("secret")
		gateway.SetGrantAuthorizer(&previewgateway.APIAuthorizer{URL: api.URL, RelayToken: "secret", HTTPClient: api.Client()})
		exchange := httptest.NewRecorder()
		gateway.ServeHTTP(exchange, httptest.NewRequest(http.MethodGet, target.String(), nil))
		require.Equal(t, http.StatusFound, exchange.Code)
		cookies := exchange.Result().Cookies()
		require.Len(t, cookies, 1)
		preview := httptest.NewRequest(http.MethodGet, "https://"+domain+"/", nil)
		preview.AddCookie(cookies[0])
		served := httptest.NewRecorder()
		gateway.ServeHTTP(served, preview)
		require.Equal(t, http.StatusOK, served.Code, served.Body.String())
		require.Equal(t, "guest", served.Body.String())
	}
}

func TestWorkspaceServiceURLDoesNotExposeViewerTicket(t *testing.T) {
	service := &mockWorkspaceRouteService{listWorkspaceServicesFn: func(context.Context, string, int64, int64) ([]services.WorkspaceManagedService, error) {
		return []services.WorkspaceManagedService{{Name: "web", Port: 3000, URL: "https://3000-" + previewTicketWorkspace + ".preview.jjhub.tech"}}, nil
	}}
	handler := &WorkspaceHandler{Service: service, PreviewTickets: previewgateway.NewTickets("secret")}
	req := withAuth(withWorkspaceRepoCtx(withRouteParams(httptest.NewRequest(http.MethodGet, "/", nil), map[string]string{"id": previewTicketWorkspace}), "alice", "demo"), 7, "alice")
	rec := httptest.NewRecorder()
	handler.ListWorkspaceServices(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	var rows []services.WorkspaceManagedService
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &rows))
	require.Len(t, rows, 1)
	require.Equal(t, "https://example.com/api/repos/alice/demo/workspaces/"+previewTicketWorkspace+"/preview/3000", rows[0].URL, "listed URLs must not convey the owner's credential")
}

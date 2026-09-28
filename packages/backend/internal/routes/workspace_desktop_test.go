package routes

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/previewgateway"
)

type stubDesktopService struct {
	token  string
	target services.WorkspaceDesktopRelayTarget
}

func (s *stubDesktopService) CheckWorkspaceDesktopAccess(context.Context, string, int64, int64) error {
	return nil
}

func (s *stubDesktopService) CreateDesktopSession(context.Context, string, int64, int64) (services.WorkspaceDesktopSessionResponse, error) {
	return services.WorkspaceDesktopSessionResponse{}, pkgerrors.Internal("unused")
}

func (s *stubDesktopService) AuthorizeDesktopRelay(_ context.Context, workspaceID, token string) (services.WorkspaceDesktopRelayTarget, error) {
	if workspaceID != s.target.WorkspaceID || token != s.token {
		return services.WorkspaceDesktopRelayTarget{}, pkgerrors.Unauthorized("invalid desktop session")
	}
	return s.target, nil
}

func newDesktopRelayRouter(handler *WorkspaceDesktopHandler) http.Handler {
	r := chi.NewRouter()
	r.Handle("/api/workspaces/{workspaceID}/desktop/{token}", http.HandlerFunc(handler.Relay))
	r.Handle("/api/workspaces/{workspaceID}/desktop/{token}/*", http.HandlerFunc(handler.Relay))
	return r
}

func TestWorkspaceDesktopRelayProxiesAuthorizedSessionsToPreviewGateway(t *testing.T) {
	var gotPath, gotHost, gotRelayToken string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotHost = r.Host
		gotRelayToken = r.Header.Get(previewgateway.RelayTokenHeader)
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<html>novnc</html>"))
	}))
	defer upstream.Close()

	svc := &stubDesktopService{token: "smithers_desk_ok", target: services.WorkspaceDesktopRelayTarget{
		Domain: "smithers-desk-vm-1.preview.jjhub.tech", WorkspaceID: "ws-1", UserID: 1, RepositoryID: 2,
	}}
	router := newDesktopRelayRouter(&WorkspaceDesktopHandler{Service: svc, RelayServiceURL: upstream.URL, RelayToken: "relay-secret"})

	rec := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/workspaces/ws-1/desktop/smithers_desk_ok/vnc.html?autoconnect=1", nil)
	request.Header.Set(previewgateway.RelayTokenHeader, "forged")
	router.ServeHTTP(rec, request)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, previewgateway.RoutePrefix+"smithers-desk-vm-1.preview.jjhub.tech/vnc.html", gotPath)
	assert.Equal(t, "smithers-desk-vm-1.preview.jjhub.tech", gotHost)
	// The gateway refuses smithers-desk-* without the relay credential; the
	// browser's own value for that header is replaced, never forwarded.
	assert.Equal(t, "relay-secret", gotRelayToken)
	assert.Equal(t, "no-referrer", rec.Header().Get("Referrer-Policy"))
	assert.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
	// The app origins run with COEP require-corp: the framed document must
	// opt in or the iframe never paints. A framed DOCUMENT also needs its own
	// COEP; with CORP alone Chrome blocks the navigation
	// (ERR_BLOCKED_BY_RESPONSE).
	assert.Equal(t, "cross-origin", rec.Header().Get("Cross-Origin-Resource-Policy"))
	assert.Equal(t, "require-corp", rec.Header().Get("Cross-Origin-Embedder-Policy"))
	assert.Equal(t, "<html>novnc</html>", rec.Body.String())

	// Every asset the viewer loads needs the same opt-in, not just the document.
	for _, asset := range []string{"app/ui.js", "app/styles/base.css", "app/images/icons/novnc-icon.svg", "package.json"} {
		rec = httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/workspaces/ws-1/desktop/smithers_desk_ok/"+asset, nil))
		require.Equal(t, http.StatusOK, rec.Code, asset)
		assert.Equal(t, previewgateway.RoutePrefix+"smithers-desk-vm-1.preview.jjhub.tech/"+asset, gotPath)
		assert.Equal(t, "cross-origin", rec.Header().Get("Cross-Origin-Resource-Policy"), asset)
		assert.Equal(t, "no-referrer", rec.Header().Get("Referrer-Policy"), asset)
	}

	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/workspaces/ws-1/desktop/smithers_desk_ok", nil))
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, previewgateway.RoutePrefix+"smithers-desk-vm-1.preview.jjhub.tech/", gotPath)
	assert.Equal(t, "cross-origin", rec.Header().Get("Cross-Origin-Resource-Policy"))
}

func TestWorkspaceDesktopRelayRejectsBadTokens(t *testing.T) {
	upstreamHits := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { upstreamHits++ }))
	defer upstream.Close()
	svc := &stubDesktopService{token: "smithers_desk_ok", target: services.WorkspaceDesktopRelayTarget{WorkspaceID: "ws-1", Domain: "d"}}
	router := newDesktopRelayRouter(&WorkspaceDesktopHandler{Service: svc, RelayServiceURL: upstream.URL})

	for _, path := range []string{
		"/api/workspaces/ws-1/desktop/smithers_desk_wrong/vnc.html",
		"/api/workspaces/ws-2/desktop/smithers_desk_ok/vnc.html",
		"/api/workspaces/ws-1/desktop/smithers_desk_wrong/websockify",
	} {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		assert.Equal(t, http.StatusUnauthorized, rec.Code, path)
		assert.Contains(t, rec.Body.String(), "invalid desktop session", path)
		// The error is rendered inside the app's COEP require-corp iframe too:
		// without CORP and COEP the viewer shows an empty frame instead of the 401.
		assert.Equal(t, "cross-origin", rec.Header().Get("Cross-Origin-Resource-Policy"), path)
		assert.Equal(t, "require-corp", rec.Header().Get("Cross-Origin-Embedder-Policy"), path)
		assert.Equal(t, "no-referrer", rec.Header().Get("Referrer-Policy"), path)
		assert.Equal(t, "no-store", rec.Header().Get("Cache-Control"), path)
	}
	assert.Equal(t, 0, upstreamHits, "nothing reaches the preview gateway without a valid token")

	rec := httptest.NewRecorder()
	newDesktopRelayRouter(&WorkspaceDesktopHandler{}).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/workspaces/ws-1/desktop/x/vnc.html", nil))
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.Equal(t, "cross-origin", rec.Header().Get("Cross-Origin-Resource-Policy"))
}

func TestWorkspaceDesktopRelayErrorStatusesCarryCORP(t *testing.T) {
	// Every status the handler writes itself (not proxied) must carry CORP and
	// COEP.
	for _, tc := range []struct {
		err    error
		status int
	}{
		{pkgerrors.Unauthorized("desktop session expired"), http.StatusUnauthorized},
		{pkgerrors.NotFound("workspace not found"), http.StatusNotFound},
		{pkgerrors.Conflict("desktop workspace is not running"), http.StatusConflict},
		{pkgerrors.Internal("load workspace: down"), http.StatusInternalServerError},
	} {
		svc := &erroringDesktopService{err: tc.err}
		rec := httptest.NewRecorder()
		newDesktopRelayRouter(&WorkspaceDesktopHandler{Service: svc}).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/workspaces/ws-1/desktop/tok/vnc.html", nil))
		assert.Equal(t, tc.status, rec.Code, tc.err.Error())
		assert.Equal(t, "cross-origin", rec.Header().Get("Cross-Origin-Resource-Policy"), tc.err.Error())
		assert.Equal(t, "require-corp", rec.Header().Get("Cross-Origin-Embedder-Policy"), tc.err.Error())
		assert.Equal(t, "no-store", rec.Header().Get("Cache-Control"), tc.err.Error())
	}
}

func TestWorkspaceDesktopSessionNotReadyReturnsRetryable503(t *testing.T) {
	handler := &WorkspaceDesktopHandler{Service: &erroringDesktopService{
		err: pkgerrors.DesktopNotReady("desktop is still starting; retry shortly"),
	}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workspaces/ws-1/desktop/session", nil)
	req = withAuth(req, 7, "alice")
	req = withRepoContext(req, "alice", "demo")
	req = withRouteParams(req, map[string]string{"id": "ws-1"})
	rec := httptest.NewRecorder()

	handler.PostDesktopSession(rec, req)

	require.Equal(t, http.StatusServiceUnavailable, rec.Code)
	assert.Equal(t, "2", rec.Header().Get("Retry-After"))
	assert.JSONEq(t, `{"code":"desktop_not_ready","fault":"wait","retry_after":2,"message":"desktop is still starting; retry shortly"}`, rec.Body.String())
}

func TestWorkspaceDesktopSessionInternalErrorMessageIsSanitized(t *testing.T) {
	handler := &WorkspaceDesktopHandler{Service: &erroringDesktopService{
		err: pkgerrors.Internal("load workspace: password=super-secret"),
	}}
	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workspaces/ws-1/desktop/session", nil)
	req = withAuth(req, 7, "alice")
	req = withRepoContext(req, "alice", "demo")
	req = withRouteParams(req, map[string]string{"id": "ws-1"})
	rec := httptest.NewRecorder()

	handler.PostDesktopSession(rec, req)

	require.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.JSONEq(t, `{"code":"internal","fault":"bug","message":"internal server error"}`, rec.Body.String())
	assert.NotContains(t, rec.Body.String(), "super-secret")
}

type erroringDesktopService struct{ err error }

func (s *erroringDesktopService) CheckWorkspaceDesktopAccess(context.Context, string, int64, int64) error {
	return s.err
}

func (s *erroringDesktopService) CreateDesktopSession(context.Context, string, int64, int64) (services.WorkspaceDesktopSessionResponse, error) {
	return services.WorkspaceDesktopSessionResponse{}, s.err
}

func (s *erroringDesktopService) AuthorizeDesktopRelay(context.Context, string, string) (services.WorkspaceDesktopRelayTarget, error) {
	return services.WorkspaceDesktopRelayTarget{}, s.err
}

func (s *erroringDesktopService) ObserveDesktop(context.Context, string, int64, int64, services.DesktopObserveRequest) (services.DesktopObservation, error) {
	return services.DesktopObservation{}, s.err
}

func (s *erroringDesktopService) InputDesktop(context.Context, string, int64, int64, services.DesktopInputRequest) (services.DesktopInputResponse, error) {
	return services.DesktopInputResponse{}, s.err
}

func (s *stubDesktopService) ObserveDesktop(context.Context, string, int64, int64, services.DesktopObserveRequest) (services.DesktopObservation, error) {
	return services.DesktopObservation{}, pkgerrors.Internal("unused")
}

func (s *stubDesktopService) InputDesktop(context.Context, string, int64, int64, services.DesktopInputRequest) (services.DesktopInputResponse, error) {
	return services.DesktopInputResponse{}, pkgerrors.Internal("unused")
}

// loopbackPortDialer stands in for the preview gateway's sandbox dialer: every
// preview domain resolves to one local guest server.
type loopbackPortDialer string

func (d loopbackPortDialer) Dial(ctx context.Context, _ string) (net.Conn, error) {
	return (&net.Dialer{}).DialContext(ctx, "tcp", string(d))
}

// The desktop relay answers on the API origin, so the browser attaches the
// product session and CSRF cookies to vnc.html and to the websockify upgrade;
// an auth proxy in front of the API may add identity headers. The guest is
// user-controlled: none of that may cross either proxy hop, and a cookie the
// guest sets must not land in the API's cookie jar.
func TestWorkspaceDesktopRelayStripsAPICredentialsAcrossBothHops(t *testing.T) {
	received := make(chan http.Header, 2)
	guest := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received <- r.Header.Clone()
		if r.URL.Path == "/websockify" {
			ws, err := websocket.Accept(w, r, nil)
			if err != nil {
				return
			}
			defer ws.CloseNow()
			_, _, _ = ws.Read(r.Context())
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "smithers_session", Value: "forged"})
		_, _ = w.Write([]byte("<html>novnc</html>"))
	}))
	defer guest.Close()
	gateway := previewgateway.NewHandler(loopbackPortDialer(strings.TrimPrefix(guest.URL, "http://")), []string{".preview.jjhub.tech"}, nil)
	gateway.SetRelayToken("relay-secret")
	hop := httptest.NewServer(gateway)
	defer hop.Close()
	svc := &stubDesktopService{token: "desktop-token", target: services.WorkspaceDesktopRelayTarget{WorkspaceID: "ws1", Domain: "smithers-desk-vm.preview.jjhub.tech"}}
	api := httptest.NewServer(newDesktopRelayRouter(&WorkspaceDesktopHandler{Service: svc, RelayServiceURL: hop.URL, RelayToken: "relay-secret"}))
	defer api.Close()

	headers := http.Header{}
	for _, key := range workspacePreviewCredentialHeaders {
		headers.Set(key, "platform-secret")
	}
	headers.Set("Cookie", "smithers_session=session-secret; smithers_csrf=csrf-secret")
	headers.Set(previewgateway.RelayTokenHeader, "forged")

	for _, path := range []string{"vnc.html", "websockify"} {
		t.Run(path, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			endpoint := api.URL + "/api/workspaces/ws1/desktop/desktop-token/" + path
			if path == "websockify" {
				ws, _, err := websocket.Dial(ctx, endpoint, &websocket.DialOptions{HTTPHeader: headers.Clone()})
				require.NoError(t, err)
				defer ws.CloseNow()
			} else {
				req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
				require.NoError(t, err)
				req.Header = headers.Clone()
				res, err := http.DefaultClient.Do(req)
				require.NoError(t, err)
				res.Body.Close()
				require.Equal(t, http.StatusOK, res.StatusCode)
				assert.Empty(t, res.Header.Values("Set-Cookie"), "a guest cookie must not reach the API origin")
			}
			select {
			case got := <-received:
				for key := range headers {
					assert.Empty(t, got.Values(key), key)
				}
			case <-ctx.Done():
				t.Fatal("guest never saw the relayed request")
			}
		})
	}
}

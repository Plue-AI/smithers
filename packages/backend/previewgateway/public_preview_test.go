package previewgateway

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

type publicPreviewGrant struct {
	public bool
	calls  int
}

func (a *publicPreviewGrant) AuthorizeGrant(context.Context, string) error { return ErrGrantRevoked }
func (a *publicPreviewGrant) AuthorizePublicPreview(context.Context, string) error {
	a.calls++
	if a.public {
		return nil
	}
	return ErrGrantRevoked
}

func TestPublicPreviewRequiresLiveExplicitGrant(t *testing.T) {
	for _, prefix := range []string{"https://", "http://"} {
		domain := "3000-ws-1.preview.jjhub.tech"
		target := prefix + domain + "/"
		dialer := &testDialer{}
		authorizer := &publicPreviewGrant{}
		handler := NewHandler(dialer, []string{".preview.jjhub.tech"}, nil)
		handler.SetRelayToken("secret")
		handler.SetGrantAuthorizer(authorizer)
		now := time.Now()
		handler.now = func() time.Time { return now }
		request := func() int {
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, target, nil))
			return response.Code
		}
		require.Equal(t, http.StatusUnauthorized, request())
		require.Empty(t, dialer.domain)
		require.Equal(t, http.StatusUnauthorized, request())
		require.Equal(t, 1, authorizer.calls, "private hosts share a bounded deny cache")
		authorizer.public = true
		now = now.Add(grantRecheckInterval)
		require.Equal(t, http.StatusOK, request(), "explicit public port must serve anonymous visitors")
		authorizer.public = false
		require.Equal(t, http.StatusOK, request(), "asset bursts share a bounded allow cache")
		require.Equal(t, 2, authorizer.calls)
		now = now.Add(grantRecheckInterval)
		dialer.domain = ""
		require.Equal(t, http.StatusUnauthorized, request())
		require.Empty(t, dialer.domain, "switch to private must deny before auto-wake")
	}
}

func TestAPIAuthorizerChecksPublicDomain(t *testing.T) {
	for _, status := range []int{http.StatusNoContent, http.StatusForbidden, http.StatusServiceUnavailable} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.Equal(t, http.MethodPost, r.Method)
				require.Equal(t, "Bearer relay-secret", r.Header.Get("Authorization"))
				var body AuthorizeRequest
				require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
				require.Equal(t, "3000-ws-1.preview.jjhub.tech", body.Domain)
				require.Empty(t, body.Ticket)
				w.WriteHeader(status)
			}))
			defer server.Close()
			authorizer := &APIAuthorizer{URL: server.URL, RelayToken: "relay-secret", HTTPClient: server.Client()}
			err := authorizer.AuthorizePublicPreview(context.Background(), "3000-ws-1.preview.jjhub.tech")
			switch status {
			case http.StatusNoContent:
				require.NoError(t, err)
			case http.StatusForbidden:
				require.ErrorIs(t, err, ErrGrantRevoked)
			default:
				require.Error(t, err)
				require.NotErrorIs(t, err, ErrGrantRevoked)
			}
		})
	}
}

func TestPublicPreviewAcceptsVisitorWithStalePrivateCookie(t *testing.T) {
	for _, signed := range []bool{false, true} {
		const domain = "3000-ws-1.preview.jjhub.tech"
		handler := NewHandler(&testDialer{}, []string{".preview.jjhub.tech"}, nil)
		handler.SetRelayToken("secret")
		handler.SetGrantAuthorizer(&publicPreviewGrant{public: true})
		cookie := "expired-private-session"
		if signed {
			var err error
			cookie, err = handler.tickets.Issue(Grant{Domain: domain, WorkspaceID: "ws-1", RepositoryID: 1, UserID: 1}, PurposeSession, SessionTicketTTL)
			require.NoError(t, err)
		}
		request := httptest.NewRequest(http.MethodGet, "https://"+domain+"/", nil)
		request.AddCookie(&http.Cookie{Name: SessionCookieName, Value: cookie})
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		require.Equal(t, http.StatusOK, response.Code, "public consent permits stale or revoked private cookies: signed=%v", signed)
	}
}

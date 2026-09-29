package previewgateway

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/require"
)

type previewTCPDialer struct{ address string }

func (d previewTCPDialer) Dial(ctx context.Context, _ string) (net.Conn, error) {
	return (&net.Dialer{}).DialContext(ctx, "tcp", d.address)
}

type revocablePreviewGrant struct {
	revoked, down atomic.Bool
	public        atomic.Bool
}

func (a *revocablePreviewGrant) AuthorizeGrant(context.Context, string) error {
	if a.down.Load() {
		return errors.New("authorization unavailable")
	}
	if a.revoked.Load() {
		return ErrGrantRevoked
	}
	return nil
}

func (a *revocablePreviewGrant) AuthorizePublicPreview(ctx context.Context, _ string) error {
	if !a.public.Load() {
		return ErrGrantRevoked
	}
	return a.AuthorizeGrant(ctx, "")
}
func TestActivePreviewWebSocketEndsOnRevocation(t *testing.T) {
	for _, reason := range []string{"share removed", "authorization outage", "session expired", "public disabled"} {
		t.Run(reason, func(t *testing.T) {
			t.Parallel()
			const domain = "3000-ws-1.preview.jjhub.tech"
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				socket, err := websocket.Accept(w, r, nil)
				if err != nil {
					return
				}
				defer socket.CloseNow()
				for {
					typ, body, err := socket.Read(r.Context())
					if err != nil {
						return
					}
					if socket.Write(r.Context(), typ, body) != nil {
						return
					}
				}
			}))
			defer upstream.Close()
			authorizer := &revocablePreviewGrant{}
			authorizer.public.Store(reason == "public disabled")
			handler := NewHandler(previewTCPDialer{strings.TrimPrefix(upstream.URL, "http://")}, []string{".preview.jjhub.tech"}, nil)
			handler.SetRelayToken("secret")
			handler.SetGrantAuthorizer(authorizer)
			var clockOffset atomic.Int64
			handler.tickets.now = func() time.Time { return time.Now().Add(time.Duration(clockOffset.Load())) }
			gateway := httptest.NewServer(handler)
			defer gateway.Close()
			ticket, err := handler.tickets.Issue(Grant{Domain: domain, WorkspaceID: "ws-1", RepositoryID: 1, UserID: 1}, PurposeSession, SessionTicketTTL)
			require.NoError(t, err)
			ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
			defer cancel()
			headers := http.Header{}
			if reason != "public disabled" {
				headers.Set("Cookie", SessionCookieName+"="+ticket)
			}
			socket, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(gateway.URL, "http")+"/", &websocket.DialOptions{HTTPHeader: headers, Host: domain})
			require.NoError(t, err)
			defer socket.CloseNow()
			require.NoError(t, socket.Write(ctx, websocket.MessageText, []byte("hello")))
			_, body, err := socket.Read(ctx)
			require.NoError(t, err)
			require.Equal(t, "hello", string(body))
			switch reason {
			case "public disabled":
				authorizer.public.Store(false)
			case "authorization outage":
				authorizer.down.Store(true)
			case "session expired":
				clockOffset.Store(int64(SessionTicketTTL + time.Hour))
			default:
				authorizer.revoked.Store(true)
			}
			_, _, err = socket.Read(ctx)
			require.Error(t, err)
			require.NoError(t, ctx.Err(), "revoked socket survived until caller timeout")
		})
	}
}

func TestActivePreviewHTTPStreamEndsOnRevocation(t *testing.T) {
	for _, public := range []bool{false, true} {
		name := "private share removed"
		if public {
			name = "public disabled"
		}
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			const domain = "3000-ws-1.preview.jjhub.tech"
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(w, "ready\n")
				w.(http.Flusher).Flush()
				<-r.Context().Done()
			}))
			defer upstream.Close()
			authorizer := &revocablePreviewGrant{}
			authorizer.public.Store(public)
			handler := NewHandler(previewTCPDialer{strings.TrimPrefix(upstream.URL, "http://")}, []string{".preview.jjhub.tech"}, nil)
			handler.SetRelayToken("secret")
			handler.SetGrantAuthorizer(authorizer)
			gateway := httptest.NewServer(handler)
			defer gateway.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
			defer cancel()
			request, err := http.NewRequestWithContext(ctx, http.MethodGet, gateway.URL+"/", nil)
			require.NoError(t, err)
			request.Host = domain
			if !public {
				ticket, err := handler.tickets.Issue(Grant{Domain: domain, WorkspaceID: "ws-1", RepositoryID: 1, UserID: 1}, PurposeSession, SessionTicketTTL)
				require.NoError(t, err)
				request.AddCookie(&http.Cookie{Name: SessionCookieName, Value: ticket})
			}
			response, err := gateway.Client().Do(request)
			require.NoError(t, err)
			defer response.Body.Close()
			require.Equal(t, http.StatusOK, response.StatusCode)
			reader := bufio.NewReader(response.Body)
			ready, err := reader.ReadString('\n')
			require.NoError(t, err)
			require.Equal(t, "ready\n", ready)
			if public {
				authorizer.public.Store(false)
			} else {
				authorizer.revoked.Store(true)
			}
			_, err = io.ReadAll(reader)
			require.Error(t, err)
			require.NoError(t, ctx.Err(), "revoked stream survived until caller timeout")
		})
	}
}

package services

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/previewgateway"
)

type repoGatewayProbeDialerFunc func(context.Context, string) (net.Conn, error)

func (f repoGatewayProbeDialerFunc) Dial(ctx context.Context, domain string) (net.Conn, error) {
	return f(ctx, domain)
}

// Exercise the real preview proxy so its duplicated gateway-domain rule stays
// aligned with repoGatewayDomain, including normalized Microsandbox VM IDs.
func TestRepoGatewayHealthProbe_RealDomainRoutesToLoopbackHost(t *testing.T) {
	for _, tt := range []struct {
		vmID   string
		domain string
	}{
		{vmID: "vm-123", domain: "smithers-gw-vm-123.preview.jjhub.tech"},
		{vmID: " msb_ABC123 ", domain: "smithers-gw-msb-abc123.preview.jjhub.tech"},
	} {
		t.Run(tt.vmID, func(t *testing.T) {
			require.Equal(t, tt.domain, repoGatewayDomain(tt.vmID))
			guest := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				// The product host rejects the public domain with 421.
				if r.Host != "localhost" {
					w.WriteHeader(http.StatusMisdirectedRequest)
					return
				}
				assert.Equal(t, "/health", r.URL.RequestURI())
				assert.Equal(t, tt.domain, r.Header.Get("X-Forwarded-Host"))
				w.WriteHeader(http.StatusOK)
			}))
			defer guest.Close()

			dialer := repoGatewayProbeDialerFunc(func(ctx context.Context, domain string) (net.Conn, error) {
				assert.Equal(t, tt.domain, domain)
				return (&net.Dialer{}).DialContext(ctx, "tcp", guest.Listener.Addr().String())
			})
			proxy := previewgateway.NewHandler(dialer, []string{".preview.jjhub.tech"}, nil)
			proxy.SetRelayToken("relay-secret")
			ingress := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				assert.Equal(t, http.MethodGet, r.Method)
				assert.Equal(t, "/__preview/"+tt.domain+"/health", r.URL.RequestURI())
				proxy.ServeHTTP(w, r)
			}))
			defer ingress.Close()

			svc := newTestRepoGatewayService(&fakeRepoGatewayQuerier{}, &fakeRepoGatewayVMClient{},
				WithRepoGatewayHealthProbe(ingress.URL, ingress.Client()), WithPreviewRelayToken("relay-secret"))
			fastRepoGatewaySleep(svc)
			require.NoError(t, svc.probeGatewayHealthChecked(context.Background(), tt.vmID, nil))
		})
	}
}

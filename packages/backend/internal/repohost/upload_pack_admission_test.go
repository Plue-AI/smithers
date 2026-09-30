package repohost

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestClientProxyUploadPackAdmissionRefusal(t *testing.T) {
	for _, tc := range []struct {
		code         string
		status       int
		retry        string
		retrySeconds int
	}{
		{UploadPackQueueFullCode, http.StatusServiceUnavailable, "1", 1},
		{UploadPackQueueTimeoutCode, http.StatusGatewayTimeout, "", 0},
		{UploadPackNegotiationTooLargeCode, http.StatusRequestEntityTooLarge, "", 0},
	} {
		t.Run(tc.code, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.Equal(t, "/repos/alice/demo/git/upload-pack", r.URL.Path)
				_, _ = io.Copy(io.Discard, r.Body)
				w.Header().Set("X-Smithers-Error-Code", tc.code)
				if tc.retry != "" {
					w.Header().Set("Retry-After", tc.retry)
				}
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, "secret upstream details")
			}))
			t.Cleanup(server.Close)
			client := NewClient(&StaticStorageSetResolver{URL: server.URL}, "token")
			var out bytes.Buffer
			err := client.ProxyUploadPack(context.Background(), "alice", "demo", bytes.NewReader(nil), &out)
			var status *StatusError
			require.ErrorAs(t, err, &status)
			require.Equal(t, tc.status, status.StatusCode)
			require.Equal(t, tc.code, status.Code)
			require.Equal(t, tc.retrySeconds, status.RetryAfter)
			require.Empty(t, status.Message)
			require.Empty(t, out.String())
			require.NotContains(t, err.Error(), "secret")
		})
	}
}

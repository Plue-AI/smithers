package modelproxy

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestFastGatewayRedactsKeyAcrossEveryWriteBoundary(t *testing.T) {
	const key = "private-provider-key-for-this-test"
	for split := 0; split <= len(key); split++ {
		t.Run(strings.Repeat("x", split), func(t *testing.T) {
			response := httptest.NewRecorder()
			response.Header().Set("X-Request-ID", key)
			writer := &secretWriter{ResponseWriter: response, secret: []byte(key)}
			writer.WriteHeader(200)
			_, err := writer.Write([]byte("before " + key[:split]))
			require.NoError(t, err)
			writer.Flush()
			_, err = writer.Write([]byte(key[split:] + " after " + key))
			require.NoError(t, err)
			writer.finish()
			require.Equal(t, "before [redacted] after [redacted]", response.Body.String())
			require.Equal(t, "[redacted]", response.Header().Get("X-Request-ID"))
		})
	}
}

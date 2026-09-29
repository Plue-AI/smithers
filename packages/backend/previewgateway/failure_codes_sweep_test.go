package previewgateway

import (
	"context"
	"encoding/json"
	stdErrors "errors"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type failingDialer struct{}

func (failingDialer) Dial(context.Context, string) (net.Conn, error) {
	return nil, stdErrors.New("no route to box")
}

func decode(t *testing.T, rec *httptest.ResponseRecorder) pkgerrors.APIError {
	t.Helper()
	require.Equal(t, "application/json", rec.Header().Get("Content-Type"),
		"a text/plain refusal carries no code for anything downstream to read")
	var body pkgerrors.APIError
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body), "body was %q", rec.Body.String())
	return body
}

// TestPreviewGatewayAnswersTheOneEnvelope pins the three refusals the preview
// gateway can produce.
//
// All three were text/plain — http.NotFound and http.Error — so a consumer
// that fetches a preview URL had to tell "the box's own 404" apart from "plue
// has no such preview" by string-matching English. Every other plue refusal
// carries a code; these now do too.
func TestPreviewGatewayAnswersTheOneEnvelope(t *testing.T) {
	t.Parallel()

	t.Run("unroutable path", func(t *testing.T) {
		handler := NewHandler(failingDialer{}, []string{".preview.test"}, nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/__preview/nope.example.com/", nil))

		assert.Equal(t, http.StatusNotFound, rec.Code)
		assert.Equal(t, pkgerrors.CodeNotFound, decode(t, rec).Code)
	})

	t.Run("gateway has no dialer", func(t *testing.T) {
		handler := NewHandler(nil, []string{".preview.test"}, nil)
		handler.SetRelayToken("relay-secret")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, relayRequest("/__preview/box.preview.test/"))

		body := decode(t, rec)
		assert.Equal(t, http.StatusServiceUnavailable, rec.Code)
		assert.Equal(t, pkgerrors.CodeServiceUnavailable, body.Code)
		assert.Equal(t, pkgerrors.FaultInfra, body.Fault)
	})

	t.Run("box port unreachable", func(t *testing.T) {
		handler := NewHandler(failingDialer{}, []string{".preview.test"}, nil)
		handler.SetRelayToken("relay-secret")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, relayRequest("/__preview/box.preview.test/"))

		body := decode(t, rec)
		// preview_unavailable is registered at 503, and the registry is the
		// authority for a code's status: nothing upstream answered badly, it
		// did not answer at all, which is not what 502 means.
		assert.Equal(t, http.StatusServiceUnavailable, rec.Code)
		assert.Equal(t, pkgerrors.CodePreviewUnavailable, body.Code)
		assert.Equal(t, pkgerrors.FaultInfra, body.Fault,
			"the caller's box is fine; plue could not reach the port it serves")
	})
}

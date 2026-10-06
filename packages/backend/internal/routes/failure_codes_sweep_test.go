package routes

import (
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// decodeAPIError reads what actually went on the wire, not what the handler
// built: the code and fault a client branches on are produced by WriteError,
// and a handler that leaves Code empty is indistinguishable from one that set
// it until you look at the bytes.
func decodeAPIError(t *testing.T, rec *httptest.ResponseRecorder) pkgerrors.APIError {
	t.Helper()
	var body pkgerrors.APIError
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body), "body was %q", rec.Body.String())
	return body
}

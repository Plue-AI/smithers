package routes

import (
	"encoding/json"
	stdErrors "errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
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

// TestMissingTableDegradesToFeatureNotEnabled pins the endpoints that
// answer 503 when their table is absent.
//
// Before this sweep every one of them wrote a bare composite and inherited
// `service_unavailable` from WriteError's status backfill — the same code plue
// uses when a component it needs is down. The two conditions call for
// different interfaces: "a dependency is flapping, try again" versus "this
// deployment was never migrated, so retrying is pointless". A client cannot
// tell them apart from one code, so the deployment case gets its own.
func TestMissingTableDegradesToFeatureNotEnabled(t *testing.T) {
	undefinedTable := &pgconn.PgError{Code: "42P01", Message: "relation does not exist"}

	for name, write := range map[string]func(http.ResponseWriter, error){
		"app timeline sync": appTimelineErr,
	} {
		t.Run(name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			write(rec, undefinedTable)

			body := decodeAPIError(t, rec)
			assert.Equal(t, http.StatusServiceUnavailable, rec.Code)
			assert.Equal(t, pkgerrors.CodeFeatureNotEnabled, body.Code)
			assert.Equal(t, pkgerrors.FaultInfra, body.Fault,
				"an unmigrated deployment is plue's problem, never the caller's")
			assert.NotEmpty(t, body.Message, "the sentence names which feature is off")
		})
	}
}

// TestSSEStreamCapIsARateLimit pins the per-user live-stream cap onto the
// budget code it has always been. It answered 429 with no code, so WriteError
// backfilled rate_limit_exceeded from the status; naming it at the call site
// makes the backfill unnecessary here and survives any later change to the
// status.
func TestSSEStreamCapIsARateLimit(t *testing.T) {
	capped := wikiSubscribeError(&sse.ErrTooManyStreams{UserID: 7, Max: 8})
	assert.Equal(t, pkgerrors.CodeRateLimitExceeded, capped.Code)
	assert.Equal(t, pkgerrors.FaultUser, capped.Fault)
	assert.Equal(t, http.StatusTooManyRequests, capped.Status)

	// Everything else behind a refused subscription is still plue's defect.
	other := wikiSubscribeError(stdErrors.New("listener died"))
	assert.Equal(t, pkgerrors.CodeInternal, other.Code)
	assert.Equal(t, pkgerrors.FaultBug, other.Fault)
}

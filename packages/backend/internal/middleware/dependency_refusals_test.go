package middleware

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	apierrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func heldRefusal() *apierrors.APIError {
	refusal := apierrors.New(apierrors.CodeRepositoryHeld, "Repository is busy")
	refusal.RetryAfter = 5
	return refusal
}

// serveRefusal runs a handler that records refusal (if any) and then answers
// with respond.
func serveRefusal(refusal *apierrors.APIError, respond func(http.ResponseWriter)) *httptest.ResponseRecorder {
	handler := DependencyRefusals(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		apierrors.RecordRefusal(r.Context(), refusal)
		respond(w)
	}))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/bookmarks", nil))
	return rec
}

// A server error after a recorded refusal becomes the refusal, whatever the
// handler wrote: JSON with its code and Retry-After, or git's plain text.
func TestDependencyRefusalsAnswersServerErrorsWithTheRefusal(t *testing.T) {
	rec := serveRefusal(heldRefusal(), func(w http.ResponseWriter) {
		apierrors.WriteError(w, apierrors.Internal("failed to create bookmark"))
	})
	require.Equal(t, http.StatusServiceUnavailable, rec.Code)
	assert.Equal(t, "5", rec.Header().Get("Retry-After"))
	assert.Contains(t, rec.Body.String(), `"code":"repository_held"`)
	assert.NotContains(t, rec.Body.String(), "failed to create bookmark")

	rec = serveRefusal(heldRefusal(), func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = io.WriteString(w, "internal server error\n")
	})
	require.Equal(t, http.StatusServiceUnavailable, rec.Code)
	assert.Equal(t, "5", rec.Header().Get("Retry-After"))
	assert.Equal(t, "repository_held", rec.Header().Get("X-Smithers-Error-Code"))
	assert.Equal(t, "Repository is busy\n", rec.Body.String())

	// A panic after the refusal answers with it too.
	handler := DependencyRefusals(JSONRecoverer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		apierrors.RecordRefusal(r.Context(), heldRefusal())
		panic("after a held call")
	})))
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/land", nil))
	require.Equal(t, http.StatusServiceUnavailable, rec.Code)
	assert.Contains(t, rec.Body.String(), "repository_held")
}

// Without a refusal, or with a success or client error, the response is the
// handler's own.
func TestDependencyRefusalsLeavesOtherResponsesAlone(t *testing.T) {
	rec := serveRefusal(nil, func(w http.ResponseWriter) {
		apierrors.WriteError(w, apierrors.Internal("boom"))
	})
	require.Equal(t, http.StatusInternalServerError, rec.Code)

	// A handler's own 503 or 504, with its own code, stands.
	rec = serveRefusal(heldRefusal(), func(w http.ResponseWriter) {
		apierrors.WriteError(w, apierrors.New(apierrors.CodeCodingOutcomeUnknown, "retry the identical request"))
	})
	require.Equal(t, http.StatusServiceUnavailable, rec.Code)
	assert.Contains(t, rec.Body.String(), "coding_outcome_unknown")

	for _, status := range []int{http.StatusOK, http.StatusConflict, http.StatusGatewayTimeout} {
		rec = serveRefusal(heldRefusal(), func(w http.ResponseWriter) {
			w.WriteHeader(status)
			_, _ = io.WriteString(w, "own")
		})
		require.Equal(t, status, rec.Code)
		assert.Equal(t, "own", rec.Body.String())
	}

	// An implicit 200 from Write, and Flush, pass through.
	rec = serveRefusal(heldRefusal(), func(w http.ResponseWriter) {
		_, _ = io.WriteString(w, "streamed")
		http.NewResponseController(w).Flush()
	})
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "streamed", rec.Body.String())
	assert.True(t, rec.Flushed)
}

// Only the request's own context carries its refusals.
func TestRecordRefusalWithoutRecorderIsANoop(t *testing.T) {
	apierrors.RecordRefusal(context.Background(), heldRefusal())
	assert.Nil(t, apierrors.RecordedRefusal(context.Background()))
}

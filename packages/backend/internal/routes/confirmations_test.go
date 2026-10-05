package routes

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// Without a confirmation service every route answers 503
// confirmation_unavailable before any authorization or effect (spec §5.4.1),
// and a press without an Idempotency-Key is 400.
func TestConfirmationRoutesUnavailableAndKeyed(t *testing.T) {
	for _, handler := range []*ConfirmationsHandler{nil, {}} {
		for _, serve := range []http.HandlerFunc{handler.List, handler.Approve, handler.Deny} {
			rec := httptest.NewRecorder()
			serve(rec, httptest.NewRequest(http.MethodPost, "/api/confirmations/x/approve", nil))
			require.Equal(t, http.StatusServiceUnavailable, rec.Code)
			require.JSONEq(t, `{"code":"confirmation_unavailable","class":"infra","message":"Confirmations are unavailable"}`, rec.Body.String())
		}
	}
	handler := &ConfirmationsHandler{Service: (*services.ApprovalsService)(nil)}
	for _, serve := range []http.HandlerFunc{handler.Approve, handler.Deny} {
		rec := httptest.NewRecorder()
		serve(rec, httptest.NewRequest(http.MethodPost, "/api/confirmations/x/approve", strings.NewReader("")))
		require.Equal(t, http.StatusBadRequest, rec.Code)
		require.Contains(t, rec.Body.String(), `"code":"idempotency_key_required"`)
	}
}

package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

type grantRouteProbe struct {
	calls   int
	result  services.AdminGrantResult
	err     error
	request services.AdminGrantRequest
}

func (s *grantRouteProbe) Grant(_ context.Context, _ *db.User, r services.AdminGrantRequest) (services.AdminGrantResult, error) {
	s.calls++
	s.request = r
	return s.result, s.err
}
func TestAdminGrantHandlerStrictWireContract(t *testing.T) {
	for _, body := range []string{``, `{}`, `{"login":"x","amountUsd":"25","operationKey":"k"}`, `{"amountUsd":null}`, `{"amountUsd":true}`, `{"amountUsd":[]}`, `{"amountUsd":{}}`, `{"amountUsd":25,"extra":true}`, `{"amountUsd":25} {}`, `{"amountUsd":25} broken`, `{"amountUsd":` + strings.Repeat("1", 65) + `}`} {
		t.Run(body, func(t *testing.T) {
			s := &grantRouteProbe{}
			w := httptest.NewRecorder()
			(&AdminGrantHandler{s}).Grant(w, httptest.NewRequest("POST", "/api/admin/grant", strings.NewReader(body)))
			require.Equal(t, 400, w.Code, w.Body.String())
			require.Zero(t, s.calls)
		})
	}
	for _, duplicate := range []bool{false, true} {
		t.Run(map[bool]string{false: "fresh", true: "duplicate"}[duplicate], func(t *testing.T) {
			s := &grantRouteProbe{result: services.AdminGrantResult{Granted: true, GrantID: "credit-grant:1", Login: "x", AmountUSD: "25", OperationKey: "k", Duplicate: duplicate}}
			w := httptest.NewRecorder()
			(&AdminGrantHandler{s}).Grant(w, httptest.NewRequest("POST", "/api/admin/grant", strings.NewReader(`{"login":"x","amountUsd":2.5e1,"operationKey":"k"}`)))
			require.Equal(t, http.StatusOK, w.Code)
			require.Equal(t, json.Number("2.5e1"), s.request.AmountUSD)
			var result services.AdminGrantResult
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &result))
			require.Equal(t, s.result, result)
		})
	}
	s := &grantRouteProbe{err: pkgerrors.Conflict("key reused")}
	w := httptest.NewRecorder()
	(&AdminGrantHandler{s}).Grant(w, httptest.NewRequest("POST", "/api/admin/grant", strings.NewReader(`{"login":"x","amountUsd":25,"operationKey":"k"}`)))
	require.Equal(t, http.StatusConflict, w.Code)
	require.Equal(t, 1, s.calls)
}

func TestAdminGrantMissingServiceRefuses(t *testing.T) {
	for _, handler := range []*AdminGrantHandler{nil, {}} {
		w := httptest.NewRecorder()
		handler.Grant(w, httptest.NewRequest("POST", "/api/admin/grant", strings.NewReader(`{"login":"x","amountUsd":25,"operationKey":"k"}`)))
		require.Equal(t, 500, w.Code)
	}
}

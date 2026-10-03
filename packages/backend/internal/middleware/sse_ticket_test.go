package middleware

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type mockSSETicketValidator struct {
	validateFn func(ctx context.Context, rawTicket string) (*SSETicketPrincipal, error)
}

type memberAuthorizerFunc func(context.Context, int64) *errors.APIError

func (f memberAuthorizerFunc) AuthorizeMember(ctx context.Context, userID int64) *errors.APIError {
	return f(ctx, userID)
}

func (m *mockSSETicketValidator) ValidateTicket(ctx context.Context, rawTicket string) (*SSETicketPrincipal, error) {
	if m.validateFn != nil {
		return m.validateFn(ctx, rawTicket)
	}
	return nil, errors.Unauthorized("invalid SSE ticket")
}

func TestSSETicketAuth_NoTicket_PassThrough(t *testing.T) {
	t.Parallel()

	validator := &mockSSETicketValidator{}
	mw := SSETicketAuth(validator, nil)

	handlerCalled := false
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handlerCalled = true
		// No user should be set by ticket auth.
		assert.Nil(t, UserFromContext(r.Context()))
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest("GET", "/api/notifications", nil)
	rec := httptest.NewRecorder()

	mw(inner).ServeHTTP(rec, req)

	assert.True(t, handlerCalled)
	assert.Equal(t, http.StatusOK, rec.Code)
}

func TestSSETicketAuth_ValidTicket_SetsContext(t *testing.T) {
	t.Parallel()

	expectedUser := &db.User{
		ID:       42,
		Username: "alice",
		IsActive: true,
	}

	validator := &mockSSETicketValidator{
		validateFn: func(_ context.Context, rawTicket string) (*SSETicketPrincipal, error) {
			assert.Equal(t, "myvalidticket", rawTicket)
			return &SSETicketPrincipal{User: expectedUser}, nil
		},
	}
	mw := SSETicketAuth(validator, nil)

	handlerCalled := false
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handlerCalled = true
		user := UserFromContext(r.Context())
		require.NotNil(t, user)
		assert.Equal(t, int64(42), user.ID)
		assert.Equal(t, "alice", user.Username)

		// Auth info should be session-like (no token scopes).
		authInfo := AuthInfoFromContext(r.Context())
		require.NotNil(t, authInfo)
		assert.False(t, authInfo.IsTokenAuth)
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest("GET", "/api/notifications?ticket=myvalidticket", nil)
	rec := httptest.NewRecorder()

	mw(inner).ServeHTTP(rec, req)

	assert.True(t, handlerCalled)
	assert.Equal(t, http.StatusOK, rec.Code)
}

func TestSSETicketAuth_RejectsNonMemberPrincipal(t *testing.T) {
	t.Parallel()

	validator := &mockSSETicketValidator{validateFn: func(context.Context, string) (*SSETicketPrincipal, error) {
		return &SSETicketPrincipal{User: &db.User{ID: 42, Username: "foreign"}}, nil
	}}
	boundary := memberAuthorizerFunc(func(_ context.Context, userID int64) *errors.APIError {
		assert.Equal(t, int64(42), userID)
		return errors.New(errors.CodeNotAMember, "not a member of this install")
	})
	nextCalled := false
	handler := SSETicketAuth(validator, nil, boundary)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		nextCalled = true
	}))

	req := httptest.NewRequest(http.MethodGet, "/events/stream?ticket=foreign", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusForbidden, rec.Code)
	assert.False(t, nextCalled)
}

func TestSSETicketAuth_TokenMintedTicket_EnforcesTokenScopes(t *testing.T) {
	t.Parallel()

	validator := &mockSSETicketValidator{
		validateFn: func(context.Context, string) (*SSETicketPrincipal, error) {
			return &SSETicketPrincipal{
				User:        &db.User{ID: 42, Username: "alice"},
				IsTokenAuth: true,
				RawScopes:   "read:user",
				TokenHash:   "token-hash-42",
			}, nil
		},
	}
	mw := SSETicketAuth(validator, nil)

	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authInfo := AuthInfoFromContext(r.Context())
		require.NotNil(t, authInfo)
		assert.True(t, authInfo.IsTokenAuth)
		assert.Equal(t, "token-hash-42", authInfo.TokenHash)
		assert.True(t, authInfo.Scopes.Has(ScopeReadUser))
		assert.False(t, authInfo.Scopes.Has(ScopeReadRepository))
		w.WriteHeader(http.StatusOK)
	})

	// RequireScope for a scope the minting token lacks must reject the request:
	// tickets must not escalate past the minting token's scopes.
	req := httptest.NewRequest("GET", "/api/repos/o/r/runs/1/logs?ticket=tokenticket", nil)
	rec := httptest.NewRecorder()
	mw(RequireScope(ScopeReadRepository)(inner)).ServeHTTP(rec, req)
	assert.Equal(t, http.StatusForbidden, rec.Code)

	// A scope the minting token holds still passes.
	req = httptest.NewRequest("GET", "/api/user?ticket=tokenticket", nil)
	rec = httptest.NewRecorder()
	mw(RequireScope(ScopeReadUser)(inner)).ServeHTTP(rec, req)
	assert.Equal(t, http.StatusOK, rec.Code)
}

func TestSSETicketAuth_InvalidTicket_Returns401(t *testing.T) {
	t.Parallel()

	validator := &mockSSETicketValidator{
		validateFn: func(context.Context, string) (*SSETicketPrincipal, error) {
			return nil, errors.Unauthorized("invalid or expired SSE ticket")
		},
	}
	mw := SSETicketAuth(validator, nil)

	handlerCalled := false
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handlerCalled = true
	})

	req := httptest.NewRequest("GET", "/api/notifications?ticket=badticket", nil)
	rec := httptest.NewRecorder()

	mw(inner).ServeHTTP(rec, req)

	assert.False(t, handlerCalled)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)

	var resp errors.APIError
	require.NoError(t, json.NewDecoder(rec.Body).Decode(&resp))
	assert.Contains(t, resp.Message, "invalid or expired SSE ticket")
}

func TestSSETicketAuth_SuspendedUser_Returns401(t *testing.T) {
	t.Parallel()

	validator := &mockSSETicketValidator{
		validateFn: func(context.Context, string) (*SSETicketPrincipal, error) {
			return nil, errors.Forbidden("account is suspended")
		},
	}
	mw := SSETicketAuth(validator, nil)

	handlerCalled := false
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handlerCalled = true
	})

	req := httptest.NewRequest("GET", "/api/notifications?ticket=suspendedticket", nil)
	rec := httptest.NewRecorder()

	mw(inner).ServeHTTP(rec, req)

	assert.False(t, handlerCalled)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestSSETicketAuth_MetricsRecorded_Success(t *testing.T) {
	t.Parallel()

	validator := &mockSSETicketValidator{
		validateFn: func(context.Context, string) (*SSETicketPrincipal, error) {
			return &SSETicketPrincipal{User: &db.User{ID: 1, Username: "test"}}, nil
		},
	}

	counter := prometheus.NewCounterVec(
		prometheus.CounterOpts{Name: "test_sse_tickets_validated_total"},
		[]string{"result"},
	)
	metrics := &SSETicketMetrics{TicketsValidated: counter}
	mw := SSETicketAuth(validator, metrics)

	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest("GET", "/api/notifications?ticket=goodticket", nil)
	rec := httptest.NewRecorder()

	mw(inner).ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)

	var m dto.Metric
	require.NoError(t, counter.WithLabelValues("success").(prometheus.Metric).Write(&m))
	assert.Equal(t, float64(1), m.GetCounter().GetValue())
}

func TestSSETicketAuth_MetricsRecorded_Invalid(t *testing.T) {
	t.Parallel()

	validator := &mockSSETicketValidator{
		validateFn: func(context.Context, string) (*SSETicketPrincipal, error) {
			return nil, errors.Unauthorized("invalid")
		},
	}

	counter := prometheus.NewCounterVec(
		prometheus.CounterOpts{Name: "test_sse_tickets_validated_total_invalid"},
		[]string{"result"},
	)
	metrics := &SSETicketMetrics{TicketsValidated: counter}
	mw := SSETicketAuth(validator, metrics)

	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})

	req := httptest.NewRequest("GET", "/api/notifications?ticket=badticket", nil)
	rec := httptest.NewRecorder()

	mw(inner).ServeHTTP(rec, req)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)

	var m dto.Metric
	require.NoError(t, counter.WithLabelValues("invalid").(prometheus.Metric).Write(&m))
	assert.Equal(t, float64(1), m.GetCounter().GetValue())
}

func TestSSETicketAuth_MetricsRecorded_Suspended(t *testing.T) {
	t.Parallel()

	validator := &mockSSETicketValidator{
		validateFn: func(context.Context, string) (*SSETicketPrincipal, error) {
			return nil, errors.Forbidden("account is suspended")
		},
	}

	counter := prometheus.NewCounterVec(
		prometheus.CounterOpts{Name: "test_sse_tickets_validated_total_suspended"},
		[]string{"result"},
	)
	metrics := &SSETicketMetrics{TicketsValidated: counter}
	mw := SSETicketAuth(validator, metrics)

	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})

	req := httptest.NewRequest("GET", "/api/notifications?ticket=suspendedticket", nil)
	rec := httptest.NewRecorder()

	mw(inner).ServeHTTP(rec, req)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)

	var m dto.Metric
	require.NoError(t, counter.WithLabelValues("suspended").(prometheus.Metric).Write(&m))
	assert.Equal(t, float64(1), m.GetCounter().GetValue())
}

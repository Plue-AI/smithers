package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type mockBillingRouteService struct {
	getUserPlansFn       func(context.Context, *db.User) (services.BillingPlansResponse, error)
	getUserOverviewFn    func(ctx context.Context, user *db.User) (services.BillingOverview, error)
	getOrgOverviewFn     func(ctx context.Context, actor *db.User, orgName string) (services.BillingOverview, error)
	createUserCheckoutFn func(ctx context.Context, user *db.User, planKey, interval string) (services.BillingSessionResult, error)
	createOrgCheckoutFn  func(ctx context.Context, actor *db.User, orgName, planKey, interval string) (services.BillingSessionResult, error)
	createUserPortalFn   func(ctx context.Context, user *db.User) (services.BillingSessionResult, error)
	createOrgPortalFn    func(ctx context.Context, actor *db.User, orgName string) (services.BillingSessionResult, error)
	refreshUserFn        func(ctx context.Context, user *db.User) (services.BillingOverview, error)
	refreshOrgFn         func(ctx context.Context, actor *db.User, orgName string) (services.BillingOverview, error)
	handleWebhookFn      func(ctx context.Context, payload []byte, signature string) error
}

func (m *mockBillingRouteService) GetUserOverview(ctx context.Context, user *db.User) (services.BillingOverview, error) {
	if m.getUserOverviewFn != nil {
		return m.getUserOverviewFn(ctx, user)
	}
	return services.BillingOverview{}, nil
}

func (m *mockBillingRouteService) GetOrgOverview(ctx context.Context, actor *db.User, orgName string) (services.BillingOverview, error) {
	if m.getOrgOverviewFn != nil {
		return m.getOrgOverviewFn(ctx, actor, orgName)
	}
	return services.BillingOverview{}, nil
}

func (m *mockBillingRouteService) CreateUserCheckout(ctx context.Context, user *db.User, planKey, interval string) (services.BillingSessionResult, error) {
	if m.createUserCheckoutFn != nil {
		return m.createUserCheckoutFn(ctx, user, planKey, interval)
	}
	return services.BillingSessionResult{}, nil
}

func (m *mockBillingRouteService) CreateOrgCheckout(ctx context.Context, actor *db.User, orgName, planKey, interval string) (services.BillingSessionResult, error) {
	if m.createOrgCheckoutFn != nil {
		return m.createOrgCheckoutFn(ctx, actor, orgName, planKey, interval)
	}
	return services.BillingSessionResult{}, nil
}

func (m *mockBillingRouteService) CreateUserPortal(ctx context.Context, user *db.User) (services.BillingSessionResult, error) {
	if m.createUserPortalFn != nil {
		return m.createUserPortalFn(ctx, user)
	}
	return services.BillingSessionResult{}, nil
}

func (m *mockBillingRouteService) CreateOrgPortal(ctx context.Context, actor *db.User, orgName string) (services.BillingSessionResult, error) {
	if m.createOrgPortalFn != nil {
		return m.createOrgPortalFn(ctx, actor, orgName)
	}
	return services.BillingSessionResult{}, nil
}

func (m *mockBillingRouteService) RefreshUserBilling(ctx context.Context, user *db.User) (services.BillingOverview, error) {
	if m.refreshUserFn != nil {
		return m.refreshUserFn(ctx, user)
	}
	return services.BillingOverview{}, nil
}

func (m *mockBillingRouteService) RefreshOrgBilling(ctx context.Context, actor *db.User, orgName string) (services.BillingOverview, error) {
	if m.refreshOrgFn != nil {
		return m.refreshOrgFn(ctx, actor, orgName)
	}
	return services.BillingOverview{}, nil
}

func (m *mockBillingRouteService) HandleStripeWebhook(ctx context.Context, payload []byte, signature string) error {
	if m.handleWebhookFn != nil {
		return m.handleWebhookFn(ctx, payload, signature)
	}
	return nil
}

func TestBillingHandler_GetUserBilling_RequiresAuth(t *testing.T) {
	t.Parallel()

	h := &BillingHandler{Service: &mockBillingRouteService{}}
	req := httptest.NewRequest(http.MethodGet, "/api/billing", nil)
	rec := httptest.NewRecorder()
	h.GetUserBilling(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestBillingHandler_GetUserBilling_Success(t *testing.T) {
	t.Parallel()

	h := &BillingHandler{Service: &mockBillingRouteService{
		getUserOverviewFn: func(ctx context.Context, user *db.User) (services.BillingOverview, error) {
			assert.Equal(t, int64(1), user.ID)
			return services.BillingOverview{PlanKey: "pro", OwnerType: "user"}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/billing", nil)
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.GetUserBilling(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var overview services.BillingOverview
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &overview))
	assert.Equal(t, "pro", overview.PlanKey)
}

func TestBillingHandler_GetUserBalance_Success(t *testing.T) {
	t.Parallel()
	h := &BillingHandler{Service: &mockBillingRouteService{
		getUserOverviewFn: func(context.Context, *db.User) (services.BillingOverview, error) {
			return services.BillingOverview{CreditBalanceNanos: 2_500_000_000, CreditBalanceCents: 250, LifetimeChargedNanos: 1_000_000_001, ChargeCount: 1}, nil
		},
	}}
	req := withAuth(httptest.NewRequest(http.MethodGet, "/api/billing/balance", nil), 1, "alice")
	rec := httptest.NewRecorder()
	h.GetUserBalance(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	var body map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "ok", body["state"])
	assert.Equal(t, true, body["allowedToStartWork"])
	assert.Equal(t, "2.50", body["balance"].(map[string]any)["totalUsd"])
	assert.Equal(t, "1.00", body["balance"].(map[string]any)["lifetimeChargedUsd"])
	assert.Equal(t, float64(1), body["balance"].(map[string]any)["chargeCount"])
}

func TestBillingHandler_GetUserBalance_SubCentCreditIsSpendable(t *testing.T) {
	t.Parallel()
	h := &BillingHandler{Service: &mockBillingRouteService{
		getUserOverviewFn: func(context.Context, *db.User) (services.BillingOverview, error) {
			return services.BillingOverview{CreditBalanceNanos: 4_000_000}, nil
		},
	}}
	rec := httptest.NewRecorder()
	h.GetUserBalance(rec, withAuth(httptest.NewRequest(http.MethodGet, "/api/billing/balance", nil), 1, "alice"))
	require.Equal(t, http.StatusOK, rec.Code)
	var body map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "low", body["state"])
	assert.Equal(t, true, body["allowedToStartWork"])
}

func TestBillingHandler_PostUserCheckout_Success(t *testing.T) {
	t.Parallel()

	h := &BillingHandler{Service: &mockBillingRouteService{
		createUserCheckoutFn: func(ctx context.Context, user *db.User, planKey, interval string) (services.BillingSessionResult, error) {
			assert.Equal(t, "pro", planKey)
			assert.Equal(t, "monthly", interval)
			return services.BillingSessionResult{URL: "https://checkout.stripe.com/session"}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodPost, "/api/billing/checkout", strings.NewReader(`{"plan":"pro","interval":"monthly"}`))
	req.Header.Set("Content-Type", "application/json")
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.PostUserCheckout(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
	var result services.BillingSessionResult
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &result))
	assert.Contains(t, result.URL, "stripe.com")
}

func TestBillingHandler_GetOrgBilling_RequiresAuth(t *testing.T) {
	t.Parallel()

	h := &BillingHandler{Service: &mockBillingRouteService{}}
	req := httptest.NewRequest(http.MethodGet, "/api/orgs/myorg/billing", nil)
	req = withRouteParams(req, map[string]string{"org": "myorg"})
	rec := httptest.NewRecorder()
	h.GetOrgBilling(rec, req)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestBillingHandler_GetOrgBilling_Success(t *testing.T) {
	t.Parallel()

	h := &BillingHandler{Service: &mockBillingRouteService{
		getOrgOverviewFn: func(ctx context.Context, actor *db.User, orgName string) (services.BillingOverview, error) {
			assert.Equal(t, "myorg", orgName)
			return services.BillingOverview{PlanKey: "team", OwnerType: "org"}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/orgs/myorg/billing", nil)
	req = withRouteParams(req, map[string]string{"org": "myorg"})
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.GetOrgBilling(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
}

func TestBillingHandler_PostUserCheckout_ServiceError(t *testing.T) {
	t.Parallel()

	h := &BillingHandler{Service: &mockBillingRouteService{
		createUserCheckoutFn: func(ctx context.Context, user *db.User, planKey, interval string) (services.BillingSessionResult, error) {
			return services.BillingSessionResult{}, pkgerrors.BadRequest("invalid plan")
		},
	}}

	req := httptest.NewRequest(http.MethodPost, "/api/billing/checkout", strings.NewReader(`{"plan":"invalid","interval":"monthly"}`))
	req.Header.Set("Content-Type", "application/json")
	req = withAuth(req, 1, "alice")
	rec := httptest.NewRecorder()
	h.PostUserCheckout(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestBillingHandler_PostStripeWebhook_Success(t *testing.T) {
	t.Parallel()

	h := &BillingHandler{Service: &mockBillingRouteService{
		handleWebhookFn: func(ctx context.Context, payload []byte, signature string) error {
			assert.Equal(t, "sig_test", signature)
			return nil
		},
	}}

	req := httptest.NewRequest(http.MethodPost, "/api/billing/webhook", strings.NewReader(`{"type":"checkout.session.completed"}`))
	req.Header.Set("Stripe-Signature", "sig_test")
	rec := httptest.NewRecorder()
	h.PostStripeWebhook(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
}

func (m *mockBillingRouteService) GetUserPlans(ctx context.Context, user *db.User) (services.BillingPlansResponse, error) {
	if m.getUserPlansFn != nil {
		return m.getUserPlansFn(ctx, user)
	}
	return services.BillingPlansResponse{}, nil
}

func TestBillingHandler_GetUserPlans(t *testing.T) {
	for _, tc := range []struct {
		name    string
		auth    bool
		failure error
		want    int
	}{
		{name: "auth required", want: 401},
		{name: "catalog", auth: true, want: 200},
		{name: "service failure", auth: true, failure: pkgerrors.Internal("database failure"), want: 500},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := &BillingHandler{Service: &mockBillingRouteService{getUserPlansFn: func(_ context.Context, user *db.User) (services.BillingPlansResponse, error) {
				assert.Equal(t, int64(7), user.ID)
				return services.BillingPlansResponse{CurrentPlanKey: "free", Plans: []services.BillingPlanSummary{{Key: "max", PriceCents: 50000}}}, tc.failure
			}}}
			req := httptest.NewRequest(http.MethodGet, "/api/billing/plans", nil)
			if tc.auth {
				req = withAuth(req, 7, "ada")
			}
			rec := httptest.NewRecorder()
			h.GetUserPlans(rec, req)
			require.Equal(t, tc.want, rec.Code)
			if tc.want == 200 {
				assert.Contains(t, rec.Body.String(), `"price_cents":50000`)
				assert.Contains(t, rec.Body.String(), `"current_plan_key":"free"`)
			}
		})
	}
}

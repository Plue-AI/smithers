package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// The organization cap lives in the billing policy; an OrgService built
// without it admits every create. Pin that the composed service receives the
// same policy as the repository service.
func TestComposedOrgServiceReceivesBillingPolicy(t *testing.T) {
	t.Parallel()

	file, err := parser.ParseFile(token.NewFileSet(), "main.go", nil, 0)
	require.NoError(t, err)

	constructors, wired := 0, 0
	ast.Inspect(file, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok || !isServicesCall(call, "NewOrgServiceWithPool") {
			return true
		}
		constructors++
		for _, arg := range call.Args {
			option, ok := arg.(*ast.CallExpr)
			if !ok || !isServicesCall(option, "WithOrgBillingPolicy") || len(option.Args) != 1 {
				continue
			}
			if ident, ok := option.Args[0].(*ast.Ident); ok && ident.Name == "billingPolicy" {
				wired++
			}
		}
		return true
	})
	require.Equal(t, 1, constructors, "main.go should build one OrgService")
	require.Equal(t, 1, wired, "the OrgService must receive services.WithOrgBillingPolicy(billingPolicy)")
}

func isServicesCall(call *ast.CallExpr, name string) bool {
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok || sel.Sel.Name != name {
		return false
	}
	pkg, ok := sel.X.(*ast.Ident)
	return ok && pkg.Name == "services"
}

// smithersai/plue#593: the repo-host client meters every attributed push
// against the same billing policy.
func TestComposedRepoHostClientMetersPushes(t *testing.T) {
	t.Parallel()

	file, err := parser.ParseFile(token.NewFileSet(), "main.go", nil, 0)
	require.NoError(t, err)

	wired := 0
	ast.Inspect(file, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || sel.Sel.Name != "SetPushMeter" || len(call.Args) != 1 {
			return true
		}
		if receiver, ok := sel.X.(*ast.Ident); !ok || receiver.Name != "repoHostClient" {
			return true
		}
		meter, ok := call.Args[0].(*ast.CallExpr)
		if !ok || !isServicesCall(meter, "NewGitStorageMeter") || len(meter.Args) != 2 {
			return true
		}
		if policy, ok := meter.Args[0].(*ast.Ident); ok && policy.Name == "billingPolicy" {
			wired++
		}
		return true
	})
	require.Equal(t, 1, wired, "main.go must call repoHostClient.SetPushMeter(services.NewGitStorageMeter(billingPolicy, ...))")
}

// Keep the real PostgreSQL billing service behind the production router. The
// payment transport is a double because this regression must never charge a
// real customer; database, auth, middleware and billing policy are real.
type deferredBillingPayment struct{ services.StripeBillingClient }

func (deferredBillingPayment) CreateCustomer(_ context.Context, input services.StripeCreateCustomerInput) (string, error) {
	return "cus_" + input.Metadata["owner_type"] + "_" + input.Metadata["owner_id"], nil
}
func (deferredBillingPayment) CreateCheckoutSession(_ context.Context, input services.StripeCreateCheckoutSessionInput) (services.StripeCheckoutSessionResult, error) {
	return services.StripeCheckoutSessionResult{ID: "cs_" + input.CustomerID, URL: "https://payments.invalid/checkout"}, nil
}
func (deferredBillingPayment) CreatePortalSession(context.Context, services.StripeCreatePortalSessionInput) (string, error) {
	return "https://payments.invalid/portal", nil
}
func (deferredBillingPayment) GetLatestCheckoutSession(context.Context, string) (services.StripeCheckoutSessionSnapshot, bool, error) {
	return services.StripeCheckoutSessionSnapshot{}, false, nil
}
func (deferredBillingPayment) ListActiveEntitlements(context.Context, string) ([]string, error) {
	return nil, nil
}

func TestDeferredBillingHTTPPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	ctx := t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "billingowner", LowerUsername: "billingowner"})
	require.NoError(t, err)
	org, err := q.CreateOrganization(ctx, db.CreateOrganizationParams{Name: "billingteam", LowerName: "billingteam", Visibility: "public"})
	require.NoError(t, err)
	_, err = q.AddOrgMember(ctx, db.AddOrgMemberParams{OrganizationID: org.ID, UserID: owner.ID, Role: "owner"})
	require.NoError(t, err)
	session := strings.Repeat("b", 64)
	sessionDigest := sha256.Sum256([]byte(session))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{SessionKey: hex.EncodeToString(sessionDigest[:]), UserID: owner.ID, Username: owner.Username, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	service := services.NewBillingService(q, deferredBillingPayment{}, services.BillingServiceConfig{BaseURL: "https://billing.invalid", ProMonthlyPriceID: "price_pro", TeamMonthlyPriceID: "price_team", StripeWebhookSecret: "whsec_deferred"})
	deps := conformanceServices{pool: pool, billing: &routes.BillingHandler{Service: service}, jobs: &routes.RepositoryJobHandler{RepositoryJobs: services.NewRepositoryJobService(q, nil, pool)}}
	cases := []struct {
		method, path, body string
		plue               int
	}{
		{"GET", "/api/billing", "", 200}, {"GET", "/api/billing/plans", "", 200}, {"GET", "/api/billing/balance", "", 200},
		{"POST", "/api/billing/checkout", `{"plan":"pro","interval":"monthly"}`, 201},
		{"POST", "/api/billing/portal", `{}`, 201}, {"POST", "/api/billing/refresh", `{}`, 200},
		{"GET", "/api/orgs/billingteam/billing", "", 200},
		{"POST", "/api/orgs/billingteam/billing/checkout", `{"plan":"team","interval":"monthly"}`, 201},
		{"POST", "/api/orgs/billingteam/billing/portal", `{}`, 201}, {"POST", "/api/orgs/billingteam/billing/refresh", `{}`, 200},
		{"POST", "/api/billing/webhook", `{}`, 400},
	}
	for _, mode := range []string{config.AuthModeSelfHosted, config.AuthModeMultitenant} {
		t.Run(mode, func(t *testing.T) {
			cfg := testConfigAllFlagsOn()
			cfg.Auth.Mode = mode
			router := hostStatusProductionRouter(cfg, q, &services.InstallCapacityService{}, deps)
			for _, tc := range cases {
				t.Run(tc.method+tc.path, func(t *testing.T) {
					req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
					req.Header.Set("Content-Type", "application/json")
					if tc.path != "/api/billing/webhook" {
						req.AddCookie(&http.Cookie{Name: "smithers_session", Value: session})
						req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "billing-csrf"})
						req.Header.Set("X-CSRF-Token", "billing-csrf")
					}
					rec := httptest.NewRecorder()
					router.ServeHTTP(rec, req)
					want := tc.plue
					if mode == config.AuthModeSelfHosted {
						want = 404
					}
					require.Equal(t, want, rec.Code, rec.Body.String())
					if mode == config.AuthModeMultitenant && tc.plue == 201 {
						require.Contains(t, rec.Body.String(), "https://payments.invalid/")
					}
					if mode == config.AuthModeMultitenant && tc.path == "/api/billing/webhook" {
						require.Contains(t, rec.Body.String(), "invalid stripe webhook signature")
					}
				})
			}
			if mode == config.AuthModeSelfHosted {
				rec := httptest.NewRecorder()
				router.ServeHTTP(rec, httptest.NewRequest("GET", "/api/orgs", nil))
				require.Equal(t, 404, rec.Code)
				var accounts int
				require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM billing_accounts`).Scan(&accounts))
				require.Zero(t, accounts)
			}
		})
	}
}

package routes

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type BillingRouteService interface {
	GetUserPlans(ctx context.Context, user *db.User) (services.BillingPlansResponse, error)
	GetUserOverview(ctx context.Context, user *db.User) (services.BillingOverview, error)
	GetOrgOverview(ctx context.Context, actor *db.User, orgName string) (services.BillingOverview, error)
	CreateUserCheckout(ctx context.Context, user *db.User, planKey, interval string) (services.BillingSessionResult, error)
	CreateOrgCheckout(ctx context.Context, actor *db.User, orgName, planKey, interval string) (services.BillingSessionResult, error)
	CreateUserPortal(ctx context.Context, user *db.User) (services.BillingSessionResult, error)
	CreateOrgPortal(ctx context.Context, actor *db.User, orgName string) (services.BillingSessionResult, error)
	RefreshUserBilling(ctx context.Context, user *db.User) (services.BillingOverview, error)
	RefreshOrgBilling(ctx context.Context, actor *db.User, orgName string) (services.BillingOverview, error)
	HandleStripeWebhook(ctx context.Context, payload []byte, signature string) error
}

type BillingHandler struct {
	Service BillingRouteService
}

type billingCheckoutRequest struct {
	Plan     string `json:"plan"`
	Interval string `json:"interval"`
}

// GetUserBalance is the small browser contract used during session refresh.
func (h *BillingHandler) GetUserBalance(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	overview, svcErr := h.Service.GetUserOverview(r.Context(), user)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	const nanosPerUSD = 1_000_000_000
	state := "empty"
	if overview.CreditBalanceNanos > 0 {
		state = "ok"
		if overview.CreditBalanceNanos < nanosPerUSD {
			state = "low"
		}
	}
	errors.WriteJSON(w, http.StatusOK, map[string]any{
		"state":              state,
		"allowedToStartWork": overview.CreditBalanceNanos > 0,
		"balance": map[string]any{
			"totalUsd":           strconv.FormatFloat(float64(overview.CreditBalanceNanos)/nanosPerUSD, 'f', 2, 64),
			"lifetimeChargedUsd": strconv.FormatFloat(float64(overview.LifetimeChargedNanos)/nanosPerUSD, 'f', 2, 64),
			"chargeCount":        overview.ChargeCount,
		},
	})
}

func (h *BillingHandler) GetUserBilling(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	overview, svcErr := h.Service.GetUserOverview(r.Context(), user)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	errors.WriteJSON(w, http.StatusOK, overview)
}

func (h *BillingHandler) PostUserCheckout(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	var req billingCheckoutRequest
	if decodeErr := decodeBillingCheckoutRequest(w, r, &req); decodeErr != nil {
		errors.WriteError(w, decodeErr)
		return
	}
	result, svcErr := h.Service.CreateUserCheckout(r.Context(), user, req.Plan, req.Interval)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	errors.WriteJSON(w, http.StatusCreated, result)
}

func (h *BillingHandler) PostUserPortal(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	result, svcErr := h.Service.CreateUserPortal(r.Context(), user)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	errors.WriteJSON(w, http.StatusCreated, result)
}

func (h *BillingHandler) PostUserRefresh(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	overview, svcErr := h.Service.RefreshUserBilling(r.Context(), user)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	errors.WriteJSON(w, http.StatusOK, overview)
}

func (h *BillingHandler) GetOrgBilling(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	orgName, err := routeParam(r, "org", "organization name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	overview, svcErr := h.Service.GetOrgOverview(r.Context(), user, orgName)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	errors.WriteJSON(w, http.StatusOK, overview)
}

func (h *BillingHandler) PostOrgCheckout(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	orgName, err := routeParam(r, "org", "organization name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	var req billingCheckoutRequest
	if decodeErr := decodeBillingCheckoutRequest(w, r, &req); decodeErr != nil {
		errors.WriteError(w, decodeErr)
		return
	}
	result, svcErr := h.Service.CreateOrgCheckout(r.Context(), user, orgName, req.Plan, req.Interval)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	errors.WriteJSON(w, http.StatusCreated, result)
}

func (h *BillingHandler) PostOrgPortal(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	orgName, err := routeParam(r, "org", "organization name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	result, svcErr := h.Service.CreateOrgPortal(r.Context(), user, orgName)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	errors.WriteJSON(w, http.StatusCreated, result)
}

func (h *BillingHandler) PostOrgRefresh(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	orgName, err := routeParam(r, "org", "organization name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	overview, svcErr := h.Service.RefreshOrgBilling(r.Context(), user, orgName)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	errors.WriteJSON(w, http.StatusOK, overview)
}

func (h *BillingHandler) PostStripeWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		errors.WriteError(w, errors.BadRequest("failed to read request body"))
		return
	}
	signature := r.Header.Get("Stripe-Signature")
	if svcErr := h.Service.HandleStripeWebhook(r.Context(), body, signature); svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func decodeBillingCheckoutRequest(w http.ResponseWriter, r *http.Request, req *billingCheckoutRequest) *errors.APIError {
	r.Body = http.MaxBytesReader(w, r.Body, middleware.MaxRequestBodySize)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		if middleware.IsMaxBytesError(err) {
			return errors.RequestEntityTooLarge("request body too large")
		}
		return errors.BadRequest("invalid request body")
	}
	defer func() { _ = r.Body.Close() }()
	if err := json.Unmarshal(body, req); err != nil {
		return errors.BadRequest("invalid request body")
	}
	return nil
}

func (h *BillingHandler) GetUserPlans(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	plans, err := h.Service.GetUserPlans(r.Context(), user)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, plans)
}

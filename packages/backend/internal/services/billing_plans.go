package services

import (
	"context"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type SandboxEntitlement struct {
	EgressBytesPerDay   int64     `json:"egress_bytes_per_day"`
	PlanKey             string    `json:"plan_key"`
	ConcurrentSandboxes int64     `json:"concurrent_sandboxes"`
	ConcurrentInUse     int64     `json:"concurrent_in_use"`
	IdleTimeoutSecs     int64     `json:"idle_timeout_secs"`
	HoursPerDay         int64     `json:"hours_per_day"`
	SecondsUsedToday    int64     `json:"seconds_used_today"`
	DayResetsAt         time.Time `json:"day_resets_at"`
	ConcurrentChildren  int64     `json:"concurrent_children"`
	ChildMaxTTLSecs     int64     `json:"child_max_ttl_secs"`
}

// workspaceChildPlanLimits are each plan's child workspace limits (#2802):
// how many live children a user may hold and how long one may live. Plans not
// listed include no children. MaxWorkspaceChildren caps every plan.
var workspaceChildPlanLimits = map[string]struct{ concurrent, maxTTLSecs int64 }{
	BillingPlanPro:        {concurrent: 16, maxTTLSecs: 4 * 3600},
	BillingPlanTeam:       {concurrent: 16, maxTTLSecs: 4 * 3600},
	BillingPlanEnterprise: {concurrent: 16, maxTTLSecs: 4 * 3600},
	BillingPlanCustom:     {concurrent: 16, maxTTLSecs: 4 * 3600},
	BillingPlanMax:        {concurrent: 16, maxTTLSecs: 8 * 3600},
}

type BillingPlanSummary struct {
	Key               string                  `json:"key"`
	DisplayName       string                  `json:"display_name"`
	PriceCents        int64                   `json:"price_cents"`
	Interval          string                  `json:"interval"`
	Limits            BillingPlanLimitSummary `json:"limits"`
	CheckoutAvailable bool                    `json:"checkout_available"`
}

type BillingPlanLimitSummary struct {
	EgressBytesPerDay   int64 `json:"egress_bytes_per_day"`
	ConcurrentSandboxes int64 `json:"concurrent_sandboxes"`
	IdleTimeoutSecs     int64 `json:"idle_timeout_secs"`
	HoursPerDay         int64 `json:"hours_per_day"`
	PrivateRepos        int64 `json:"private_repos"`
	StorageBytes        int64 `json:"storage_bytes"`
	CIMinutes           int64 `json:"ci_minutes"`
	AgentRuns           int64 `json:"agent_runs"`
	Seats               int64 `json:"seats"`
}

type BillingPlansResponse struct {
	Plans          []BillingPlanSummary `json:"plans"`
	CurrentPlanKey string               `json:"current_plan_key"`
}

func (s *BillingService) GetUserPlans(ctx context.Context, user *db.User) (BillingPlansResponse, error) {
	if user == nil {
		return BillingPlansResponse{}, pkgerrors.Unauthorized("authentication required")
	}
	current, err := s.resolvePlan(ctx, billingOwnerRef{OwnerType: BillingOwnerTypeUser, OwnerID: user.ID})
	if err != nil {
		return BillingPlansResponse{}, err
	}
	out := BillingPlansResponse{CurrentPlanKey: current.Key, Plans: make([]BillingPlanSummary, 0, 3)}
	for _, key := range []string{BillingPlanFree, BillingPlanPro, BillingPlanMax} {
		plan := s.checkoutPlans[BillingOwnerTypeUser][key+":"+BillingIntervalMonthly]
		if key == BillingPlanFree {
			plan = s.defaultPlan(BillingOwnerTypeUser)
		}
		if plan.Unlisted {
			continue
		}
		l := plan.Limits
		out.Plans = append(out.Plans, BillingPlanSummary{
			Key: key, DisplayName: billingPlanDisplayName(key), PriceCents: plan.PriceCents, Interval: BillingIntervalMonthly,
			Limits:            BillingPlanLimitSummary{EgressBytesPerDay: l.EgressBytesPerDay, ConcurrentSandboxes: l.ConcurrentSandboxes, IdleTimeoutSecs: l.SandboxIdleTimeoutSecs, HoursPerDay: sandboxJSONQuantity(l.SandboxHoursPerDay), PrivateRepos: l.PrivateRepos, StorageBytes: l.StorageBytes, CIMinutes: l.CIMinutes, AgentRuns: l.AgentRuns, Seats: l.Seats},
			CheckoutAvailable: s.stripe != nil && plan.PriceID != "",
		})
	}
	return out, nil
}

func billingPlanDisplayName(key string) string {
	switch key {
	case BillingPlanFree:
		return "Free"
	case BillingPlanPro:
		return "Pro"
	case BillingPlanMax:
		return "Max"
	case BillingPlanPersonal:
		return "Personal"
	case BillingPlanTeam:
		return "Team"
	case BillingPlanEnterprise:
		return "Enterprise"
	default:
		return "Custom"
	}
}

func sandboxJSONQuantity(quantity int64) int64 {
	if quantity >= unlimitedBillingQuantity {
		return -1
	}
	return quantity
}

package services

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func ownerFromMetadata(metadata map[string]string) (billingOwnerRef, bool) {
	ownerType := strings.TrimSpace(metadata["owner_type"])
	if ownerType != BillingOwnerTypeUser && ownerType != BillingOwnerTypeOrg {
		return billingOwnerRef{}, false
	}
	rawID := strings.TrimSpace(metadata["owner_id"])
	ownerID, err := strconv.ParseInt(rawID, 10, 64)
	if err != nil || ownerID <= 0 {
		return billingOwnerRef{}, false
	}
	return billingOwnerRef{
		OwnerType: ownerType,
		OwnerID:   ownerID,
	}, true
}

func billingOwnerDisplayName(account db.BillingAccount) string {
	if strings.TrimSpace(account.StripeCustomerName) != "" {
		return strings.TrimSpace(account.StripeCustomerName)
	}
	return account.OwnerType + ":" + strconv.FormatInt(account.OwnerID, 10)
}

func nonEmpty(value, fallback string) string {
	if strings.TrimSpace(value) != "" {
		return strings.TrimSpace(value)
	}
	return strings.TrimSpace(fallback)
}

func snapshotFromWebhookSubscription(payload stripeSubscriptionPayload, raw json.RawMessage) StripeSubscriptionSnapshot {
	snapshot := StripeSubscriptionSnapshot{
		ID:                 strings.TrimSpace(payload.ID),
		CustomerID:         strings.TrimSpace(payload.Customer),
		Status:             strings.TrimSpace(payload.Status),
		CancelAtPeriodEnd:  payload.CancelAtPeriodEnd,
		CanceledAt:         unixToTime(payload.CanceledAt),
		CurrentPeriodStart: unixToTime(payload.CurrentPeriodStart),
		CurrentPeriodEnd:   unixToTime(payload.CurrentPeriodEnd),
		TrialEnd:           unixToTime(payload.TrialEnd),
		Metadata:           payload.Metadata,
		RawPayload:         raw,
	}
	if len(payload.Items.Data) > 0 {
		first := payload.Items.Data[0]
		snapshot.Quantity = first.Quantity
		snapshot.PriceID = strings.TrimSpace(first.Price.ID)
		snapshot.Interval = normalizeStripeInterval(first.Price.Recurring.Interval)
		// Stripe's Basil API moved subscription periods onto subscription
		// items. Prefer those fields while retaining the top-level values above
		// as a compatibility fallback for pre-Basil webhook payloads.
		if periodStart := unixToTime(first.CurrentPeriodStart); !periodStart.IsZero() {
			snapshot.CurrentPeriodStart = periodStart
		}
		if periodEnd := unixToTime(first.CurrentPeriodEnd); !periodEnd.IsZero() {
			snapshot.CurrentPeriodEnd = periodEnd
		}
	}
	if snapshot.Quantity <= 0 {
		snapshot.Quantity = 1
	}
	return snapshot
}

func billingPeriodWindow(now time.Time) (time.Time, time.Time) {
	utc := now.UTC()
	start := time.Date(utc.Year(), utc.Month(), 1, 0, 0, 0, 0, time.UTC)
	end := start.AddDate(0, 1, 0)
	return start, end
}

func normalizeBillingInterval(interval string) string {
	switch strings.ToLower(strings.TrimSpace(interval)) {
	case BillingIntervalMonthly, "month":
		return BillingIntervalMonthly
	case BillingIntervalAnnual, "year":
		return BillingIntervalAnnual
	default:
		return ""
	}
}

func normalizeStripeInterval(interval string) string {
	return normalizeBillingInterval(interval)
}

func overageQuantity(consumed, included int64) int64 {
	if included >= unlimitedBillingQuantity || consumed <= included {
		return 0
	}
	return consumed - included
}

// subscriptionGrantsPaidAccess reports whether a subscription row still grants
// paid entitlements. Active and trialing always do. past_due keeps paid access
// only through the dunning grace period after the first persisted transition
// into past_due. current_period_end cannot anchor this window: Stripe advances
// it to the newly invoiced period even when that invoice remains unpaid.
// Legacy rows/test fakes without past_due_since fall back to updated_at.
// Note this is deliberately stricter than paidSubscriptionStatus, which keeps
// treating any past_due row as live for checkout duplicate guards — the
// subscription still exists in Stripe and a second checkout would double-charge.
func (s *BillingService) subscriptionGrantsPaidAccess(subscription *db.BillingSubscription) bool {
	if subscription.PaymentReversedAt.Valid {
		return false // refunded or disputed; an invoice settled after it clears it
	}
	switch strings.ToLower(strings.TrimSpace(subscription.Status)) {
	case "trialing", "active":
		return true
	case "past_due":
		anchor := subscription.UpdatedAt
		if subscription.PastDueSince.Valid {
			anchor = subscription.PastDueSince.Time
		}
		// Persisted rows always have updated_at, but callers and test fakes may
		// construct a snapshot without either timestamp. Do not interpret that
		// missing anchor as year one and revoke paid access immediately; start
		// the grace window when the incomplete snapshot is evaluated instead.
		if anchor.IsZero() {
			anchor = s.now()
		}
		return s.now().Before(anchor.Add(billingDunningGracePeriod))
	default:
		return false
	}
}

func paidSubscriptionStatus(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "trialing", "active", "past_due":
		return true
	default:
		return false
	}
}

// hasCheckoutMetadata reports whether a subscription snapshot carries all four
// metadata keys our checkout flow stamps (billing_stripe.go). Only our checkout
// creates subscriptions with plan_key+interval, so requiring all four protects
// manually-created enterprise/custom subs from the duplicate auto-cancel.
func hasCheckoutMetadata(metadata map[string]string) bool {
	for _, key := range []string{"owner_type", "owner_id", "plan_key", "interval"} {
		if strings.TrimSpace(metadata[key]) == "" {
			return false
		}
	}
	return true
}

func dedupeStrings(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	seen := map[string]struct{}{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	sort.Strings(out)
	return out
}

func orderUsageSummaries(usage map[string]BillingUsageSummary) []BillingUsageSummary {
	order := []string{
		BillingMetricPrivateRepos,
		BillingMetricStorageBytes,
		BillingMetricCIMinutes,
		BillingMetricAgentRuns,
		BillingMetricSeats,
		BillingMetricSandboxHours,
	}
	out := make([]BillingUsageSummary, 0, len(usage))
	for _, key := range order {
		if summary, ok := usage[key]; ok {
			out = append(out, summary)
		}
	}
	for key, summary := range usage {
		if key == BillingMetricPrivateRepos || key == BillingMetricStorageBytes || key == BillingMetricCIMinutes || key == BillingMetricAgentRuns || key == BillingMetricSeats || key == BillingMetricSandboxHours {
			continue
		}
		out = append(out, summary)
	}
	return out
}

func nullableTimestamptz(value time.Time) pgtype.Timestamptz {
	if value.IsZero() {
		return pgtype.Timestamptz{}
	}
	return pgtype.Timestamptz{Time: value.UTC(), Valid: true}
}

func nullableTime(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	t := value.Time
	return &t
}

func unixToTime(raw int64) time.Time {
	if raw <= 0 {
		return time.Time{}
	}
	return time.Unix(raw, 0).UTC()
}

func billingTextValue(value pgtype.Text) string {
	if !value.Valid {
		return ""
	}
	return strings.TrimSpace(value.String)
}

func formatMoneyCents(amount int64, currency string) string {
	currency = strings.ToUpper(strings.TrimSpace(currency))
	if currency == "" {
		currency = "USD"
	}
	sign := ""
	var magnitude uint64
	if amount < 0 {
		sign = "-"
		// Avoid overflowing when amount is math.MinInt64.
		magnitude = uint64(-(amount + 1)) + 1
	} else {
		magnitude = uint64(amount)
	}
	if stripeZeroDecimalCurrency(currency) {
		return fmt.Sprintf("%s%d %s", sign, magnitude, currency)
	}
	return fmt.Sprintf("%s%d.%02d %s", sign, magnitude/100, magnitude%100, currency)
}

// Stripe represents charge and invoice amounts in the currency's API minor
// unit. Its presentment API defaults to two decimals except for this documented
// zero-decimal set. UGX is deliberately absent: Stripe's backwards-compatible
// charge representation still uses two decimal positions ending in 00.
func stripeZeroDecimalCurrency(currency string) bool {
	switch currency {
	case "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA",
		"PYG", "RWF", "VND", "VUV", "XAF", "XOF", "XPF":
		return true
	default:
		return false
	}
}

func formatDurationDays(d time.Duration) string {
	days := int64(d / (24 * time.Hour))
	if days == 1 {
		return "1-day"
	}
	return fmt.Sprintf("%d-day", days)
}

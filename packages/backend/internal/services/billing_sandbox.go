package services

import (
	"context"
	"fmt"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func (s *BillingService) SandboxEntitlement(ctx context.Context, userID int64) (SandboxEntitlement, error) {
	if userID <= 0 {
		return SandboxEntitlement{}, pkgerrors.BadRequest("invalid sandbox billing user ID")
	}
	plan, err := s.resolvePlan(ctx, billingOwnerRef{OwnerType: BillingOwnerTypeUser, OwnerID: userID})
	if err != nil {
		return SandboxEntitlement{}, err
	}
	q, ok := s.queries.(BillingQuerier)
	if !ok {
		return SandboxEntitlement{}, pkgerrors.Internal("sandbox metering store unavailable")
	}
	live, err := q.CountActiveSandboxesForUser(ctx, userID)
	if err != nil {
		return SandboxEntitlement{}, err
	}
	// The metering count excludes workspace-backed agent sessions already
	// included in CountActiveSandboxesForUser, so each VM counts once.
	agents, err := q.CountActiveAgentSessionVMsForUser(ctx, userID)
	if err != nil {
		return SandboxEntitlement{}, err
	}
	now := s.now().UTC()
	midnight := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	seconds, err := q.SumSandboxAwakeSecondsForUserSince(ctx, userID, midnight)
	if err != nil {
		return SandboxEntitlement{}, err
	}
	return SandboxEntitlement{
		EgressBytesPerDay: plan.Limits.EgressBytesPerDay,
		PlanKey:           plan.Key, ConcurrentSandboxes: plan.Limits.ConcurrentSandboxes,
		ConcurrentInUse: int64(live) + agents, IdleTimeoutSecs: plan.Limits.SandboxIdleTimeoutSecs,
		HoursPerDay: sandboxJSONQuantity(plan.Limits.SandboxHoursPerDay), SecondsUsedToday: seconds,
		DayResetsAt: midnight.AddDate(0, 0, 1),
	}, nil
}

// AuthorizeSandboxStart is the sandbox-hours admission authority. It meters awake
// runtime per user from sandbox_usage_intervals against the plan's
// sandbox_hours_per_day, and plan concurrency. Every VM start reaches it:
// workspace provisioning (create, fork, session create), workspace resume,
// and agent dispatch. Request middleware must not add a second hours bucket;
// it cannot see runtime. CleanupOverQuotaWorkspaces enforces the same daily
// limit while workspaces remain running.
func (s *BillingService) AuthorizeSandboxStart(ctx context.Context, userID int64) error {
	if s == nil {
		return nil
	}
	entitlement, err := s.SandboxEntitlement(ctx, userID)
	if err != nil {
		return err
	}
	return authorizeSandboxEntitlement(entitlement)
}

// AuthorizeCountedSandboxResume checks the current plan against an exact
// owned workspace and VM. One DB statement counts all other reservations and
// confirms that the row still names this VM, so a stale caller cannot
// discount another sandbox after a concurrent workspace transition.
func (s *BillingService) AuthorizeCountedSandboxResume(ctx context.Context, userID int64, workspaceID, vmID string) error {
	if s == nil {
		return nil
	}
	entitlement, err := s.SandboxEntitlement(ctx, userID)
	if err != nil {
		return err
	}
	querier, ok := s.queries.(interface {
		CountOtherActiveSandboxesForWorkspaceResume(context.Context, db.CountOtherActiveSandboxesForWorkspaceResumeParams) (db.CountOtherActiveSandboxesForWorkspaceResumeRow, error)
	})
	if !ok {
		return s.AuthorizeSandboxStart(ctx, userID)
	}
	row, err := querier.CountOtherActiveSandboxesForWorkspaceResume(ctx, db.CountOtherActiveSandboxesForWorkspaceResumeParams{UserID: userID, WorkspaceID: workspaceID, VmID: vmID})
	if err != nil {
		return err
	}
	if !row.Matches {
		return pkgerrors.Conflict("workspace VM changed during resume; retry")
	}
	entitlement.ConcurrentInUse = int64(row.Others)
	return authorizeSandboxEntitlement(entitlement)
}

func authorizeSandboxEntitlement(entitlement SandboxEntitlement) error {
	name := billingPlanDisplayName(entitlement.PlanKey)
	upgrade, capacity := "", int64(0)
	switch entitlement.PlanKey {
	case BillingPlanFree:
		upgrade, capacity = BillingPlanPro, 3
	}
	if entitlement.ConcurrentSandboxes < unlimitedBillingQuantity && entitlement.ConcurrentInUse >= entitlement.ConcurrentSandboxes {
		noun := "sandboxes"
		if entitlement.ConcurrentSandboxes == 1 {
			noun = "sandbox"
		}
		message := fmt.Sprintf("Your %s plan allows %d running %s. ", name, entitlement.ConcurrentSandboxes, noun)
		if upgrade != "" {
			message += fmt.Sprintf("Upgrade to %s for %d, or suspend one to continue.", billingPlanDisplayName(upgrade), capacity)
		} else {
			message += "Suspend one to continue."
		}
		return sandboxPlanLimitError(entitlement, "concurrent_sandboxes", entitlement.ConcurrentSandboxes, upgrade, message)
	}
	if sandboxDailyHoursExhausted(entitlement) {
		message := fmt.Sprintf("Your %s plan includes %d sandbox-hours per day; you have used them. ", name, entitlement.HoursPerDay)
		if upgrade != "" {
			message += fmt.Sprintf("Upgrade to %s for unlimited hours, or try again after %s.", billingPlanDisplayName(upgrade), entitlement.DayResetsAt.Format(time.RFC3339))
		} else {
			message += fmt.Sprintf("Try again after %s.", entitlement.DayResetsAt.Format(time.RFC3339))
		}
		e := sandboxPlanLimitError(entitlement, "sandbox_hours_per_day", entitlement.HoursPerDay, upgrade, message)
		e.ResetAt = &entitlement.DayResetsAt
		return e
	}
	return nil
}

func sandboxDailyHoursExhausted(entitlement SandboxEntitlement) bool {
	// Compare whole hours to avoid overflowing when a policy supplies a large cap.
	return entitlement.HoursPerDay >= 0 && entitlement.SecondsUsedToday >= 0 &&
		entitlement.SecondsUsedToday/3600 >= entitlement.HoursPerDay
}

func authorizeCountedSandboxResumeForUser(ctx context.Context, policy BillingPolicy, userID int64, workspaceID, vmID string) error {
	if admitted, ok := ctx.Value(sandboxStartAdmissionKey{}).(int64); ok && admitted == userID {
		return nil
	}
	if policy == nil {
		return nil
	}
	if counted, ok := policy.(interface {
		AuthorizeCountedSandboxResume(context.Context, int64, string, string) error
	}); ok {
		return counted.AuthorizeCountedSandboxResume(ctx, userID, workspaceID, vmID)
	}
	// Other billing policies retain their normal admission semantics.
	return authorizeSandboxStartForUser(ctx, policy, userID)
}

func sandboxPlanLimitError(entitlement SandboxEntitlement, kind string, quantity int64, upgrade, message string) *pkgerrors.APIError {
	e := pkgerrors.New(pkgerrors.CodePlanLimitExceeded, message)
	limit, remaining := int(quantity), 0
	e.Limit, e.Remaining = &limit, &remaining
	e.PlanKey, e.LimitKind, e.UpgradePlanKey = entitlement.PlanKey, kind, upgrade
	return e
}

// sandboxStartAdmissionKey is set only by agent dispatch after its plan check,
// before reserving a fleet slot. The workspace belongs to that same admission;
// checking again would count the dispatch's own agent reservation as another VM.
type sandboxStartAdmissionKey struct{}

func authorizeSandboxStartForUser(ctx context.Context, policy BillingPolicy, userID int64) error {
	if admitted, ok := ctx.Value(sandboxStartAdmissionKey{}).(int64); ok && admitted == userID {
		return nil
	}
	if policy == nil {
		return nil
	}
	return policy.AuthorizeSandboxStart(ctx, userID)
}

func sandboxEntitlementForUser(ctx context.Context, policy BillingPolicy, userID int64) (SandboxEntitlement, error) {
	if policy == nil {
		return SandboxEntitlement{ConcurrentSandboxes: unlimitedBillingQuantity, HoursPerDay: -1}, nil
	}
	return policy.SandboxEntitlement(ctx, userID)
}

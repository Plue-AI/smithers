package services

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// The monitoring snapshot of GET /api/repos/{owner}/{repo}/mythical. Field
// names and shapes are @smthrs/rpc/Mythical's MythicalStackSchema exactly.

type MythicalStackView struct {
	FactoryState string               `json:"factoryState,omitempty"`
	FactoryError string               `json:"factoryError,omitempty"`
	Repository   string               `json:"repository"`
	State        string               `json:"state"`
	Reason       string               `json:"reason,omitempty"`
	Generation   int64                `json:"generation"`
	Tip          *MythicalTipView     `json:"tip,omitempty"`
	LandedMain   string               `json:"landedMain,omitempty"`
	MainBehind   bool                 `json:"mainBehind"`
	Changes      []MythicalChangeView `json:"changes"`
	Items        []MythicalItemView   `json:"items"`
	Lanes        []MythicalLaneView   `json:"lanes"`
	Limits       MythicalLimitsView   `json:"limits"`
	LastError    string               `json:"lastError,omitempty"`
	UpdatedAt    string               `json:"updatedAt,omitempty"`
	Wiki         *MythicalWikiView    `json:"wiki,omitempty"`
}

type MythicalTipView struct {
	ChangeID string `json:"changeId"`
	CommitID string `json:"commitId"`
}

type MythicalChangeView struct {
	ChangeID    string `json:"changeId"`
	CommitID    string `json:"commitId"`
	Title       string `json:"title"`
	Kind        string `json:"kind"`
	State       string `json:"state"`
	ItemID      string `json:"itemId,omitempty"`
	Issue       int64  `json:"issue,omitempty"`
	Predecessor string `json:"predecessor,omitempty"`
}

type MythicalIssueView struct {
	Number int64  `json:"number"`
	Title  string `json:"title"`
	URL    string `json:"url"`
}

type MythicalRunsView struct {
	Request string `json:"request,omitempty"`
	Vibe    string `json:"vibe,omitempty"`
	Verify  string `json:"verify,omitempty"`
}

type MythicalPullRequestView struct {
	Number int64  `json:"number"`
	URL    string `json:"url"`
	State  string `json:"state"`
}

type MythicalItemView struct {
	ID          string             `json:"id"`
	Issue       *MythicalIssueView `json:"issue,omitempty"`
	State       string             `json:"state"`
	Reason      string             `json:"reason,omitempty"`
	Attempt     int32              `json:"attempt"`
	Lane        *int32             `json:"lane,omitempty"`
	Runs        MythicalRunsView   `json:"runs"`
	Plan        json.RawMessage    `json:"plan,omitempty"`
	Integration json.RawMessage    `json:"integration,omitempty"`
	// Checks is the verification of the item's candidate: pending while it
	// runs, passed, or failed with the failed checks' ids.
	Checks *MythicalChecksView `json:"checks,omitempty"`
	// Todo is how far a TODO's plan got; absent for an item that is none.
	Todo *MythicalTodoView `json:"todo,omitempty"`
	// Route is how Jev routed a TODO, and how its outcome went once settled.
	Route *MythicalRouteView `json:"route,omitempty"`
	// HumanEdited is whether a person took over one of the item's runs.
	HumanEdited bool `json:"humanEdited,omitempty"`
	// ReviewHeld is whether a proposed TODO waits on a review of its current
	// head that did not finish; a person may retry it (RetryItem).
	ReviewHeld bool `json:"reviewHeld,omitempty"`
	// Request is the request id of the Smithers filing that made this TODO.
	Request string `json:"request,omitempty"`
	// Failure is why the item stopped or retries, typed; Reason is then its
	// sentence (mythicalFailureOf), never an error's text.
	Failure *MythicalFailureView `json:"failure,omitempty"`
	// CostNanos is the settled platform-key model cost of the item's lanes,
	// in USD nanos; pending calls and pooled subscription calls count for none.
	CostNanos int64 `json:"costNanos,omitempty"`
	// Placement is the machine the item's latest lane was placed on, or the
	// typed refusal it stopped at.
	Placement   *MythicalPlacement       `json:"placement,omitempty"`
	PullRequest *MythicalPullRequestView `json:"pullRequest,omitempty"`
	DependsOn   []string                 `json:"dependsOn"`
	UpdatedAt   string                   `json:"updatedAt"`
	// CreatedAt is when the service first observed the issue and inserted this
	// item row, whatever its state then (often skipped, waiting for a label);
	// it is not when the issue became actionable.
	CreatedAt string `json:"createdAt,omitempty"`
}

// MythicalChecksView is the verification of an item's candidate, with the
// receipts of the run that measured it.
type MythicalChecksView struct {
	State    string                `json:"state"`
	Failed   []string              `json:"failed"`
	Receipts []MythicalReceiptView `json:"receipts,omitempty"`
}

// MythicalReceiptView is one check's receipt on the candidate's commit: the
// run that recorded it and how long the check ran, when the receipt names them.
type MythicalReceiptView struct {
	Check      string `json:"check"`
	Tier       string `json:"tier"`
	Status     string `json:"status"`
	Fault      string `json:"fault,omitempty"`
	Commit     string `json:"commit"`
	RunID      string `json:"runId,omitempty"`
	DurationMs *int64 `json:"durationMs,omitempty"`
}

// mythicalChecksView reads the candidate's verification from the item's
// verify outcome; nil while nothing was verified.
func mythicalChecksView(item db.MythicalItem) *MythicalChecksView {
	var view *MythicalChecksView
	switch outcome := item.VerifyOutcome; {
	case outcome == "passed" || outcome == "" && item.CandidateVerified:
		view = &MythicalChecksView{State: "passed", Failed: []string{}}
	case strings.HasPrefix(outcome, "failed: "):
		view = &MythicalChecksView{State: "failed", Failed: strings.Split(strings.TrimPrefix(outcome, "failed: "), ", ")}
	case outcome == "" && item.State == "verifying":
		view = &MythicalChecksView{State: "pending", Failed: []string{}}
	default:
		return nil
	}
	view.Receipts = mythicalReceiptsView(item)
	return view
}

// mythicalReceiptsView is the kept receipts when they measured the item's
// current candidate; an earlier candidate's receipts are not its evidence.
// Nil when there are none.
func mythicalReceiptsView(item db.MythicalItem) []MythicalReceiptView {
	stored := mythicalChecksOf(item).Receipts
	if !stored.measures(item.CandidateHead) {
		return nil
	}
	views := make([]MythicalReceiptView, 0, len(stored.Checks))
	for _, receipt := range stored.Checks {
		views = append(views, MythicalReceiptView{Check: receipt.Check, Tier: receipt.Tier, Status: receipt.Status,
			Fault: receipt.Fault, Commit: receipt.Commit, RunID: stored.Run, DurationMs: receipt.DurationMs})
	}
	return views
}

// MythicalTodoView is a TODO's progress for display: the replans so far
// (the item runs plan replans+1 of 3), whether it runs its one very-hard
// continuation, and the typed fault it retries after or stopped at.
type MythicalTodoView struct {
	Replans  int                `json:"replans"`
	VeryHard bool               `json:"veryHard,omitempty"`
	Fault    *MythicalFaultView `json:"fault,omitempty"`
}

// MythicalFaultView is one typed failure: the failure registry's class and
// the error's tag.
type MythicalFaultView struct {
	Class string `json:"class"`
	Tag   string `json:"tag"`
}

// mythicalTodoView projects an item's checks onto the wire; the checks
// column itself is the stack's bookkeeping and never leaves the service.
func mythicalTodoView(item db.MythicalItem) *MythicalTodoView {
	checks := mythicalChecksOf(item)
	if !checks.Todo && checks.AutoTodo == "" {
		return nil
	}
	view := &MythicalTodoView{Replans: checks.Replans, VeryHard: checks.VeryHard}
	if checks.Fault != nil {
		view.Fault = &MythicalFaultView{Class: checks.Fault.Class, Tag: checks.Fault.Tag}
	}
	return view
}

// MythicalRouteView is the route Jev gave a TODO (as) and the one its
// outcome took (landed): "change" when it landed, "close" when the planner
// declined it. A misroute is a close that landed a change, or an implement
// or bug that closed; a feature that closed asked its author questions, as
// routed.
type MythicalRouteView struct {
	As     string `json:"as"`
	Landed string `json:"landed,omitempty"`
}

func mythicalRouteView(item db.MythicalItem) *MythicalRouteView {
	route := mythicalChecksOf(item).Route
	if route == "" {
		return nil
	}
	view := &MythicalRouteView{As: route}
	switch item.State {
	case "landed":
		view.Landed = "change"
	case "declined":
		view.Landed = "close"
	}
	return view
}

type MythicalLaneView struct {
	Index       int32  `json:"index"`
	WorkspaceID string `json:"workspaceId,omitempty"`
	ItemID      string `json:"itemId,omitempty"`
	State       string `json:"state"`
	// StartedAt is when the lane launched its item's current attempt.
	StartedAt string               `json:"startedAt,omitempty"`
	Account   *MythicalAccountView `json:"account,omitempty"`
	// Seat is the seat alias (or model id) most of the lane's calls ran on.
	Seat string `json:"seat,omitempty"`
}

// MythicalAccountView is the pooled account that took the lane's latest
// model call. Label is shown only to the account's owner (an organization's
// account: a repository admin); Count is how many accounts served the attempt
// (the pool rotates per call).
type MythicalAccountView struct {
	Provider string `json:"provider"`
	Label    string `json:"label,omitempty"`
	Count    int64  `json:"count"`
}

type MythicalLimitsView struct {
	MaxParallel int32 `json:"maxParallel"`
}

// Snapshot reads the repository's stack for the monitoring UI. mainCommit is
// the repository's current main commit when the caller knows it ("" skips
// the behind check). viewer decides whose account names the lanes show;
// every reader sees the provider and seat. A repository without a stack is
// `absent`, not an error.
func (s *MythicalService) Snapshot(ctx context.Context, repositoryID int64, slug, mainCommit string, viewer MythicalViewer) (MythicalStackView, error) {
	view := MythicalStackView{Repository: slug, State: "absent", Changes: []MythicalChangeView{}, Items: []MythicalItemView{},
		Lanes: []MythicalLaneView{}, Limits: MythicalLimitsView{MaxParallel: 2}}
	q := s.queries()
	stack, err := q.GetMythicalStack(ctx, repositoryID)
	if errors.Is(err, pgx.ErrNoRows) {
		return view, nil
	}
	if err != nil {
		return view, err
	}
	view.State, view.Reason, view.Generation, view.LandedMain = stack.State, stack.Reason, stack.Generation, stack.LandedMain
	view.Limits.MaxParallel = stack.MaxParallel
	view.LastError = stack.LastError
	view.FactoryState, view.FactoryError = stack.FactoryState, stack.FactoryError
	if stack.TipCommit != "" {
		view.Tip = &MythicalTipView{ChangeID: stack.TipChange, CommitID: stack.TipCommit}
	}
	view.MainBehind = mainCommit != "" && stack.LandedMain != "" && mainCommit != stack.LandedMain
	if wiki, err := q.GetMythicalWikiSummary(ctx, repositoryID); err == nil {
		view.Wiki = mythicalWikiView(wiki, stack.LandedMain)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return view, err
	}
	if stack.UpdatedAt.Valid {
		view.UpdatedAt = stack.UpdatedAt.Time.UTC().Format(time.RFC3339Nano)
	}
	latestItemUpdate, err := q.LatestMythicalItemUpdate(ctx, repositoryID)
	if err != nil {
		return view, err
	}
	if latestItemUpdate.Valid && (!stack.UpdatedAt.Valid || latestItemUpdate.Time.After(stack.UpdatedAt.Time)) {
		view.UpdatedAt = latestItemUpdate.Time.UTC().Format(time.RFC3339Nano)
	}
	changes, err := q.ListRecentMythicalChanges(ctx, repositoryID, mythicalRecentChanges)
	if err != nil {
		return view, err
	}
	landedPosition := int32(-1)
	if stack.LandedMain != "" {
		landedPosition, err = q.MythicalLandedPosition(ctx, repositoryID, stack.LandedMain)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return view, err
		}
	}
	for _, change := range changes {
		state := "landed"
		if change.ItemID.Valid && change.Position > landedPosition {
			state = "pending"
		}
		row := MythicalChangeView{ChangeID: change.ChangeID, CommitID: change.CommitID, Title: change.Title, Kind: change.Kind,
			State: state, Predecessor: change.Predecessor}
		if change.ItemID.Valid {
			row.ItemID = uuidString(change.ItemID)
		}
		if change.IssueNumber.Valid {
			row.Issue = change.IssueNumber.Int64
		}
		view.Changes = append(view.Changes, row)
	}
	items, err := q.ListMythicalItems(ctx, repositoryID, 500)
	if err != nil {
		return view, err
	}
	ids := make([]pgtype.UUID, len(items))
	for i, item := range items {
		ids[i] = item.ID
	}
	costs, err := q.MythicalItemCosts(ctx, repositoryID, ids)
	if err != nil {
		return view, err
	}
	lanes := map[int32]MythicalLaneView{}
	var workspaces []string
	for _, item := range items {
		row := mythicalItemView(item)
		row.CostNanos = costs[item.ID.Bytes]
		view.Items = append(view.Items, row)
		if row.Lane != nil && !mythicalSettled(item.State) {
			lane := MythicalLaneView{Index: *row.Lane, WorkspaceID: item.WorkspaceID, ItemID: row.ID, State: "busy"}
			lanes[*row.Lane] = lane
			// A retrying item waits for its next attempt: the failed one's
			// clock and accounts are not what the lane runs now.
			if item.State == "retrying" {
				continue
			}
			if item.LaneStartedAt.Valid {
				lane.StartedAt = item.LaneStartedAt.Time.UTC().Format(time.RFC3339)
			}
			lanes[*row.Lane] = lane
			if mythicalWorkspaceID.MatchString(item.WorkspaceID) {
				workspaces = append(workspaces, item.WorkspaceID)
			}
		}
	}
	// The accounts are a detail of the lanes: when they cannot be read, the
	// snapshot still answers, without them.
	uses, err := q.ListLatestWorkspaceProviderUses(ctx, workspaces)
	if err != nil && ctx.Err() == nil {
		s.logger.Warn("mythical.lane_accounts_failed", "repository_id", repositoryID, "error", err)
	}
	latest := map[string]db.WorkspaceProviderUse{}
	for _, use := range uses {
		latest[use.WorkspaceID] = use
	}
	// A lane above a lowered limit still shows while it holds an item.
	for index := int32(0); index < stack.MaxParallel || len(lanes) > 0; index++ {
		lane, ok := lanes[index]
		delete(lanes, index)
		if !ok {
			if index >= stack.MaxParallel {
				continue
			}
			lane = MythicalLaneView{Index: index, State: "idle"}
		}
		if use, ok := latest[lane.WorkspaceID]; ok && lane.WorkspaceID != "" {
			lane.Account = &MythicalAccountView{Provider: use.Provider, Count: use.Accounts}
			if viewer.owns(use) {
				lane.Account.Label = providerAccountLabel(use)
			}
			lane.Seat = mythicalSeat(use.Model)
		}
		view.Lanes = append(view.Lanes, lane)
	}
	return view, nil
}

// MythicalViewer is who reads a snapshot: the signed-in user (0: nobody)
// and whether they administer the repository.
type MythicalViewer struct {
	UserID int64
	Admin  bool
}

// owns reports whether the viewer may see which account this is: a user's
// own account, or an organization's account to a repository admin.
func (v MythicalViewer) owns(use db.WorkspaceProviderUse) bool {
	switch use.OwnerType {
	case "user":
		return v.UserID > 0 && use.OwnerUserID == v.UserID
	case "org":
		return v.Admin
	}
	return false
}

// providerAccountLabel names an account the way the accounts card does: its
// email, else its label. A browser request label ("web-…") is an internal
// idempotency key, not a name.
func providerAccountLabel(use db.WorkspaceProviderUse) string {
	if use.AccountEmail != "" {
		return use.AccountEmail
	}
	if strings.HasPrefix(use.Label, "web-") {
		return ""
	}
	return use.Label
}

// mythicalSeatAliases mirrors @smthrs/cli Providers seatAliases (#1752): the
// model each seat alias names, answered as its alias. Keep them in step;
// TestMythicalSeatAliasesMatchProviders reads Providers.ts.
var mythicalSeatAliases = map[string]string{
	"gpt-6.1-sol":       "sol",
	"gpt-6-luna":        "luna",
	"claude-opus-5-5":   "opus",
	"claude-sonnet-5-5": "sonnet",
	"claude-fable-5-1":  "fable",
	"kimi-k3":           "kimi",
	"qwen-3.8-27b":      "qwen",
}

// mythicalSeat answers a model call's seat: its alias, else the model id.
func mythicalSeat(model string) string {
	if alias, ok := mythicalSeatAliases[model]; ok {
		return alias
	}
	return model
}

func mythicalSettled(state string) bool {
	switch state {
	case "skipped", "declined", "cancelled", "landed", "rejected", "blocked":
		return true
	}
	return false
}

func mythicalItemView(item db.MythicalItem) MythicalItemView {
	row := MythicalItemView{ID: uuidString(item.ID), State: item.State, Reason: item.Reason, Attempt: item.Attempt,
		Runs: MythicalRunsView{Request: item.RequestRunID, Vibe: item.VibeRunID, Verify: item.VerifyRunID},
		Plan: item.Plan, Integration: item.Integration, Checks: mythicalChecksView(item), Todo: mythicalTodoView(item), Route: mythicalRouteView(item),
		Placement:   mythicalChecksOf(item).Placement,
		HumanEdited: len(mythicalDrivers(item.Checks)) > 0, ReviewHeld: item.Source == "issue" && mythicalReviewHeld(item), DependsOn: []string{},
		Request: mythicalChecksOf(item).FiledRequest}
	if failure, sentence := mythicalFailureOf(item); failure != nil {
		row.Failure, row.Reason = failure, sentence
	} else if mythicalDiagnostic(item.Reason) {
		row.Reason = ""
	}
	if item.IssueNumber.Valid {
		row.Issue = &MythicalIssueView{Number: item.IssueNumber.Int64, Title: item.IssueTitle, URL: item.IssueURL}
	}
	if item.Lane.Valid {
		lane := item.Lane.Int32
		row.Lane = &lane
	}
	if item.PRNumber.Valid && item.PRURL != "" {
		state := item.PRState
		if state != "open" && state != "closed" && state != "merged" {
			state = "open"
		}
		row.PullRequest = &MythicalPullRequestView{Number: item.PRNumber.Int64, URL: item.PRURL, State: state}
	}
	if item.UpdatedAt.Valid {
		row.UpdatedAt = item.UpdatedAt.Time.UTC().Format(time.RFC3339)
	}
	if item.CreatedAt.Valid {
		row.CreatedAt = item.CreatedAt.Time.UTC().Format(time.RFC3339)
	}
	return row
}

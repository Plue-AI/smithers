package services

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// The monitoring snapshot of GET /api/repos/{owner}/{repo}/mythical. Field
// names and shapes are @smthrs/rpc/Mythical's MythicalStackSchema exactly.

type MythicalStackView struct {
	Repository string               `json:"repository"`
	State      string               `json:"state"`
	Reason     string               `json:"reason,omitempty"`
	Generation int64                `json:"generation"`
	Tip        *MythicalTipView     `json:"tip,omitempty"`
	LandedMain string               `json:"landedMain,omitempty"`
	MainBehind bool                 `json:"mainBehind"`
	Changes    []MythicalChangeView `json:"changes"`
	Items      []MythicalItemView   `json:"items"`
	Lanes      []MythicalLaneView   `json:"lanes"`
	Limits     MythicalLimitsView   `json:"limits"`
	LastError  string               `json:"lastError,omitempty"`
	UpdatedAt  string               `json:"updatedAt,omitempty"`
	Wiki       *MythicalWikiView    `json:"wiki,omitempty"`
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
	ID          string                   `json:"id"`
	Issue       *MythicalIssueView       `json:"issue,omitempty"`
	State       string                   `json:"state"`
	Reason      string                   `json:"reason,omitempty"`
	Attempt     int32                    `json:"attempt"`
	Lane        *int32                   `json:"lane,omitempty"`
	Runs        MythicalRunsView         `json:"runs"`
	Plan        json.RawMessage          `json:"plan,omitempty"`
	Integration json.RawMessage          `json:"integration,omitempty"`
	Checks      json.RawMessage          `json:"checks,omitempty"`
	PullRequest *MythicalPullRequestView `json:"pullRequest,omitempty"`
	DependsOn   []string                 `json:"dependsOn"`
	UpdatedAt   string                   `json:"updatedAt"`
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
		view.UpdatedAt = stack.UpdatedAt.Time.UTC().Format(time.RFC3339)
	}
	changes, err := q.ListRecentMythicalChanges(ctx, repositoryID, mythicalRecentChanges)
	if err != nil {
		return view, err
	}
	for _, change := range changes {
		row := MythicalChangeView{ChangeID: change.ChangeID, CommitID: change.CommitID, Title: change.Title, Kind: change.Kind,
			State: "landed", Predecessor: change.Predecessor}
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
	lanes := map[int32]MythicalLaneView{}
	var workspaces []string
	for _, item := range items {
		row := mythicalItemView(item)
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
	"gpt-6-sol":        "sol",
	"gpt-6-astra":      "astra",
	"gpt-6-luna":       "luna",
	"claude-opus-5-5":  "opus",
	"claude-fable-5-1": "fable",
	"qwen-3.8-27b":     "qwen",
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
		Plan: item.Plan, Integration: item.Integration, Checks: item.Checks, DependsOn: []string{}}
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
	return row
}

package services

import (
	"fmt"
	"sort"
	"strings"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// gitHubReviewInput is fetched data, never a webhook authority assertion.
// No existing input retains review batching and original line anchors. This
// normalizer is deliberately unmounted until the fetched-fact decision and
// current-membership providers can admit it transactionally.
type gitHubReviewInput struct {
	ID       int64              `json:"id"`
	Body     string             `json:"body"`
	State    string             `json:"state"`
	User     gitHubActor        `json:"user"`
	Comments []gitHubReviewLine `json:"comments"`
}

type gitHubReviewLine struct {
	ID               int64       `json:"id"`
	Body             string      `json:"body"`
	Path             string      `json:"path"`
	Line             *int64      `json:"line"`
	OriginalLine     *int64      `json:"original_line"`
	CommitID         string      `json:"commit_id"`
	OriginalCommitID string      `json:"original_commit_id"`
	User             gitHubActor `json:"user"`
}

// gitHubReviewFact is supplied from fetched GitHub data and the locked input
// receipt. ActiveMember and OwnApp are resolved by the install, never from a
// webhook's author_association or login. Membership must be checked again when
// a held input is delivered. This is not a persisted or public actor model.
type gitHubReviewFact struct {
	State        string // submitted review state; unused for standalone comments
	Change       string // created, edited, deleted, or deliver-held
	ActiveMember bool
	OwnApp       bool
	Duplicate    bool
	Stale        bool
	Held         bool
	Consumed     bool
}

type gitHubReviewEffect struct {
	Activity string // upsert or hide; empty when delivering an existing held input
	Input    string // steer, hold, withdraw, or empty for record-only activity
	PRReview bool   // project the GitHub review; never a Smithers approval
}

// decideGitHubReview extends the same decision seam used by PR lifecycle
// consumers. It decides no authority from GitHub text and performs no I/O.
// An input effect alone does not authorize dispatch: ordered admission, current
// member resolution, and the production runtime remain consumer preconditions.
func decideGitHubReview(f mythicalGitHubFact, item mythicalGitHubFactItem) mythicalGitHubFactDecision {
	r := f.Review
	if r == nil {
		return mythicalGitHubFactDecision{Noop: "review_facts_missing"}
	}
	if r.OwnApp {
		return mythicalGitHubFactDecision{Noop: "own_app"}
	}
	if r.Duplicate {
		return mythicalGitHubFactDecision{Noop: "duplicate"}
	}
	if r.Stale {
		return mythicalGitHubFactDecision{Noop: "stale"}
	}
	if r.Change != "created" && r.Change != "edited" && r.Change != "deleted" && r.Change != "deliver-held" {
		return mythicalGitHubFactDecision{Noop: "unknown_review_change"}
	}
	effect := &gitHubReviewEffect{Activity: "upsert", PRReview: f.Kind == "review"}
	decision := mythicalGitHubFactDecision{Review: effect}
	if r.Change == "deleted" {
		effect.Activity = "hide"
		if r.Held && !r.Consumed {
			effect.Input = "withdraw"
		}
		return decision
	}
	if r.Change == "deliver-held" {
		effect.Activity, effect.PRReview = "", false
		if !r.Held || r.Consumed {
			return mythicalGitHubFactDecision{Noop: "input_not_held"}
		}
	}
	if f.Kind == "review" && r.State != "CHANGES_REQUESTED" && r.State != "COMMENTED" {
		// Approval, dismissal and pending review state are PR facts only.
		// They must neither create a steer nor grant checks.Land authority.
		return decision
	}
	if !r.ActiveMember {
		// Revocation also withdraws an input that was held while its author
		// was a member. Already consumed input remains historical evidence.
		if r.Held && !r.Consumed {
			effect.Input = "withdraw"
		}
		return decision
	}
	if r.Consumed {
		return decision
	}
	switch item.State {
	case "queued", "starting", "failed", "paused":
		effect.Input = "hold"
	case "working", "needs_you":
		effect.Input = "steer"
	case "in_review":
		effect.Input, decision.Event = "steer", "working"
	case "merged", "dropped":
		// A review cannot reopen a settled TODO or revive its closed run.
		if r.Held {
			effect.Input = "withdraw"
		}
	default:
		// Review consumers supply todoState's canonical product state. An
		// unknown state records the fact without admitting executable input.
		decision.Noop = "unknown_todo_state"
	}
	return decision
}

// normalizeGitHubReviewText only formats data. Authorization, TODO state,
// lifecycle versions and delivery identity belong to the shared decision and
// steer providers; neither a login nor an author association grants authority.
// The caller supplies the install App's stable GitHub user id (not its login).
func normalizeGitHubReviewText(review gitHubReviewInput, appUserID int64) (string, error) {
	if review.ID <= 0 || review.User.ID <= 0 || strings.TrimSpace(review.User.Login) == "" {
		return "", fmt.Errorf("github review: object and author identities are required")
	}
	if appUserID > 0 && review.User.ID == appUserID {
		return "", nil
	}
	lines := append([]gitHubReviewLine(nil), review.Comments...)
	sort.Slice(lines, func(i, j int) bool { return lines[i].ID < lines[j].ID })
	parts := []string{}
	if strings.TrimSpace(review.Body) != "" {
		parts = append(parts, review.Body)
	}
	var previous int64
	for _, comment := range lines {
		if comment.ID <= 0 {
			return "", fmt.Errorf("github review: comment identity is required")
		}
		// Repeated fetched objects cannot duplicate an anchor in a submission.
		if comment.ID == previous {
			continue
		}
		previous = comment.ID
		if appUserID > 0 && comment.User.ID == appUserID {
			continue
		}
		// A reply by another author is a standalone input, never authority inherited
		// from the review submitter.
		if comment.User.ID != review.User.ID {
			continue
		}
		line, commit := comment.Line, comment.CommitID
		if line == nil {
			line, commit = comment.OriginalLine, comment.OriginalCommitID
		}
		if line == nil || *line <= 0 || strings.TrimSpace(comment.Path) == "" || strings.TrimSpace(commit) == "" {
			return "", fmt.Errorf("github review: comment %d has no committed line anchor", comment.ID)
		}
		parts = append(parts, fmt.Sprintf("%s:%d @ %s\n%s", comment.Path, *line, commit, comment.Body))
	}
	return strings.Join(parts, "\n\n"), nil
}

// The existing webhook receipt/retry path retains hints until fetched facts,
// current membership and transactional TODO input admission are composed.
func gitHubReviewUnavailable() error {
	return &gitHubTodoUnavailableError{pkgerrors.New(pkgerrors.CodeServiceUnavailable, "GitHub review admission is not configured")}
}

// normalizeGitHubCommentText reuses submission formatting for standalone line
// comments; conversation comments have no anchor. Neither path admits a steer.
func normalizeGitHubCommentText(comment gitHubReviewLine, lineComment bool, appUserID int64) (string, error) {
	review := gitHubReviewInput{ID: comment.ID, User: comment.User}
	if lineComment {
		review.Comments = []gitHubReviewLine{comment}
	} else {
		review.Body = comment.Body
	}
	return normalizeGitHubReviewText(review, appUserID)
}

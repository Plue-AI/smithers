package services

import (
	"context"
	"errors"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// A clean rebase can retain an earlier review only for the same stable patch.
// The original reviewed head, candidate and run stay intact; publication binds
// the equivalent candidate to its new PR head separately.
type mythicalReviewRebase struct {
	Base      string `json:"base"`
	Candidate string `json:"candidate"`
	Head      string `json:"head,omitempty"`
	PatchID   string `json:"patchId"`
}

func mythicalReviewCurrent(review *mythicalReview, item db.MythicalItem) bool {
	if review == nil {
		return false
	}
	if review.Head == item.PRHead && (review.Candidate == "" || review.Candidate == item.CandidateHead) {
		return true
	}
	rebase := review.Rebase
	return rebase != nil && rebase.Head != "" && rebase.Head == item.PRHead &&
		rebase.Candidate == item.CandidateHead && rebase.Base == item.CandidateBase && rebase.PatchID != ""
}

func (g mythicalGit) stablePatchID(ctx context.Context, base, head string) (string, error) {
	if !mythicalSHA.MatchString(base) || !mythicalSHA.MatchString(head) {
		return "", errors.New("patch identity requires immutable commits")
	}
	diff, err := g.command(ctx, nil, "diff", "--binary", "--full-index", "--no-renames", base, head, "--")
	if err != nil {
		return "", err
	}
	if len(diff) == 0 {
		return "empty", nil
	}
	result, err := g.command(ctx, diff, "patch-id", "--stable")
	if err != nil {
		return "", err
	}
	fields := strings.Fields(string(result))
	if len(fields) != 2 || !mythicalSHA.MatchString(fields[0]) {
		return "", errors.New("stable patch identity unavailable")
	}
	return fields[0], nil
}

func (st *mythicalItemStep) cleanRebaseReview(ctx context.Context, item db.MythicalItem, base, head string) (*mythicalReview, error) {
	checks := mythicalChecksOf(item)
	review := checks.Review
	if checks.ConflictReservation != nil && checks.ConflictReservation.Onto == base || checks.ForeignBring != nil || !mythicalReviewCurrent(review, item) ||
		(review.Verdict != "approve" && review.Verdict != "request-changes") || review.RunID == "" ||
		(review.Candidate != item.CandidateHead && (review.Rebase == nil || review.Rebase.Candidate != item.CandidateHead)) {
		return nil, nil
	}
	before, err := st.r.g.stablePatchID(ctx, item.CandidateBase, item.CandidateHead)
	if err != nil {
		return nil, err
	}
	after, err := st.r.g.stablePatchID(ctx, base, head)
	if err != nil {
		return nil, err
	}
	if before != after || review.Rebase != nil && review.Rebase.PatchID != before {
		return nil, nil
	}
	retained := *review
	retained.Rebase = &mythicalReviewRebase{Base: base, Candidate: head, PatchID: after}
	retained.Posted = false
	return &retained, nil
}

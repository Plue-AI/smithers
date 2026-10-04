package services

import (
	"fmt"
	"sort"
	"strings"
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

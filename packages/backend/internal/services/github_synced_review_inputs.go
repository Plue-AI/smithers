package services

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Attach consumer deliveries to the existing pull-facts reader's cache
// transaction. The reader owns pagination, credentials, budgets and scheduling.
func (s *GitHubSyncedRepoService) admitFetchedReviewSnapshot(ctx context.Context, tx pgx.Tx, row db.GithubSyncedRepo, number int64, facts map[string]any) error {
	prefix := "pulls/" + strconv.FormatInt(number, 10)
	reviews, _ := facts[prefix+"/reviews"].([]json.RawMessage)
	comments, _ := facts[prefix+"/comments"].([]json.RawMessage)
	type line struct {
		gitHubReviewLine
		ReviewID  int64     `json:"pull_request_review_id"`
		UpdatedAt time.Time `json:"updated_at"`
	}
	lines := make([]line, len(comments))
	seen := map[int64]bool{}
	for i, raw := range comments {
		if json.Unmarshal(raw, &lines[i]) != nil || lines[i].ID <= 0 {
			return errors.New("invalid fetched review comment")
		}
		seen[lines[i].ID] = true
	}
	var old json.RawMessage
	if err := tx.QueryRow(ctx, `SELECT related_facts->'reviews' FROM github_synced_issues WHERE synced_repo_id=$1 AND resource='pulls' AND number=$2`, row.ID, number).Scan(&old); err != nil {
		return err
	}
	var previous map[string]json.RawMessage
	if len(old) > 0 {
		if err := json.Unmarshal(old, &previous); err != nil {
			return err
		}
	}
	var previousObjects []json.RawMessage
	var previousLines []line
	if raw := previous[prefix+"/comments"]; len(raw) > 0 {
		if err := json.Unmarshal(raw, &previousLines); err != nil {
			return err
		}
		if err := json.Unmarshal(raw, &previousObjects); err != nil {
			return err
		}
	}
	previousBatched := map[int64]bool{}
	var previousReviews []gitHubReviewInput
	if raw := previous[prefix+"/reviews"]; len(raw) > 0 {
		if err := json.Unmarshal(raw, &previousReviews); err != nil {
			return err
		}
	}
	for _, review := range previousReviews {
		for _, comment := range previousLines {
			if comment.ReviewID == review.ID && comment.User.ID == review.User.ID {
				previousBatched[comment.ID] = true
			}
		}
	}
	deletedReviews := map[int64]bool{}
	for _, previous := range previousLines {
		if !seen[previous.ID] && previousBatched[previous.ID] {
			deletedReviews[previous.ReviewID] = true
		}
	}
	batched := map[int64]bool{}
	for _, raw := range reviews {
		var review struct {
			gitHubReviewInput
			SubmittedAt time.Time `json:"submitted_at"`
			UpdatedAt   time.Time `json:"updated_at"`
		}
		if json.Unmarshal(raw, &review) != nil || review.ID <= 0 {
			return errors.New("invalid fetched review")
		}
		for _, comment := range lines {
			if comment.ReviewID == review.ID && comment.User.ID == review.User.ID {
				batched[comment.ID] = true
				review.Comments = append(review.Comments, comment.gitHubReviewLine)
				if comment.UpdatedAt.After(review.UpdatedAt) {
					review.UpdatedAt = comment.UpdatedAt
				}
			}
		}
		if review.State == "PENDING" {
			continue
		}
		if review.SubmittedAt.IsZero() {
			return errors.New("review has no submission timestamp")
		}
		if review.SubmittedAt.After(review.UpdatedAt) {
			review.UpdatedAt = review.SubmittedAt
		}
		if deletedReviews[review.ID] {
			review.UpdatedAt = s.now().UTC()
		}
		// Preserve all fetched fields, including the stable performed-via-App id.
		var object map[string]json.RawMessage
		if err := json.Unmarshal(raw, &object); err != nil {
			return err
		}
		object["comments"], _ = json.Marshal(review.Comments)
		object["updated_at"], _ = json.Marshal(review.UpdatedAt)
		canonical, err := json.Marshal(object)
		if err != nil {
			return err
		}
		if err := s.admitFetchedObject(ctx, tx, row, gitHubReviews, review.ID, number, canonical); err != nil {
			return err
		}
	}
	for i, raw := range comments {
		if batched[lines[i].ID] {
			continue
		}
		if err := s.admitFetchedObject(ctx, tx, row, gitHubReviewComments, lines[i].ID, number, raw); err != nil {
			return err
		}
	}
	// A complete per-pull comment read, unlike a since page, proves deletion.
	// Withdraw standalone held inputs; batched line deletion edits its submission.
	for index, previous := range previousLines {
		if seen[previous.ID] || previousBatched[previous.ID] {
			continue
		}
		var object map[string]json.RawMessage
		if err := json.Unmarshal(previousObjects[index], &object); err != nil {
			return err
		}
		if object == nil {
			continue
		}
		object["deleted"] = json.RawMessage(`true`)
		object["updated_at"], _ = json.Marshal(s.now().UTC())
		raw, err := json.Marshal(object)
		if err != nil {
			return err
		}
		if err := s.admitFetchedObject(ctx, tx, row, gitHubReviewComments, previous.ID, number, raw); err != nil {
			return err
		}
	}
	return nil
}

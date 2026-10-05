package githubfake

import (
	"hash/fnv"
	"strconv"
	"strings"
	"time"
)

// PullReviewLine is one more line comment a review carried (SubmitReview),
// with its own id, as pulls/{n}/comments lists it. Line 0 is a comment on
// the whole file; Outdated is a comment whose line left the diff.
type PullReviewLine struct {
	ID       int64  `json:"id"`
	Path     string `json:"path"`
	Line     int    `json:"line,omitempty"`
	Body     string `json:"body"`
	Outdated bool   `json:"outdated,omitempty"`
}

// ReviewLine is a line comment a SubmitReview carries: a file path, a line
// of the pull request head (0: a comment on the whole file) and its text.
type ReviewLine struct {
	Path string
	Line int
	Body string
}

// ReviewSubmission is a review as a person (or, with Bot, an App's bot
// account) submits it on GitHub: APPROVED, CHANGES_REQUESTED or COMMENTED,
// an optional body, and line comments, each its own comment.
type ReviewSubmission struct {
	Login    string
	Bot      bool
	State    string
	Body     string
	Comments []ReviewLine
}

// SubmitReview submits review on repo#number against its current head, as
// GitHub records it: one review with a new id, and its line comments, each
// with its own id. An APPROVED or CHANGES_REQUESTED review is also login's
// latest review state for the review rule; a COMMENTED one is not, as on
// GitHub. It answers the review's id, 0 for an unknown pull request.
func (s *Server) SubmitReview(repo string, number int64, review ReviewSubmission) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := repo + "/" + strconv.FormatInt(number, 10)
	if _, ok := s.pulls[key]; !ok {
		return 0
	}
	login := review.Login
	if review.Bot && !strings.HasSuffix(login, "[bot]") {
		login += "[bot]"
	}
	s.reviewIDs++
	submitted := PullReview{ID: s.reviewIDs, Login: login, Bot: review.Bot, State: review.State, Body: review.Body,
		CommitID: s.current(key).Head.SHA, SubmittedAt: time.Now().UTC()}
	for _, line := range review.Comments {
		s.reviewIDs++
		submitted.Comments = append(submitted.Comments, PullReviewLine{ID: s.reviewIDs, Path: line.Path, Line: line.Line, Body: line.Body})
	}
	s.pullReviews[key] = append(s.pullReviews[key], submitted)
	if review.State != "COMMENTED" {
		if s.reviews[key] == nil {
			s.reviews[key] = map[string]string{}
		}
		s.reviews[key][login] = review.State
	}
	return submitted.ID
}

// OutdateReviewComments makes every line comment on repo#number outdated,
// as a push that moves the lines away does: line becomes null, and
// original_line and original_commit_id keep where it was written.
func (s *Server) OutdateReviewComments(repo string, number int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := repo + "/" + strconv.FormatInt(number, 10)
	for i := range s.pullReviews[key] {
		s.pullReviews[key][i].Outdated = true
		for j := range s.pullReviews[key][i].Comments {
			s.pullReviews[key][i].Comments[j].Outdated = true
		}
	}
}

// reviewUser is a reviewer's GitHub account as the REST API names it: the
// owner is id 7, a collaborator (SetCollaborator) its id, anyone else a
// stable id of their login; a bot is type "Bot".
func (s *Server) reviewUser(login string, bot bool) map[string]any {
	if bot {
		return map[string]any{"id": 41000000 + stableID(login), "login": login, "type": "Bot"}
	}
	if strings.EqualFold(login, s.config.OwnerLogin) {
		return map[string]any{"id": int64(7), "login": s.config.OwnerLogin, "type": "User"}
	}
	for id, known := range s.accounts {
		if strings.EqualFold(known, login) {
			return map[string]any{"id": id, "login": known, "type": "User"}
		}
	}
	return map[string]any{"id": 40000000 + stableID(login), "login": login, "type": "User"}
}

func stableID(login string) int64 {
	digest := fnv.New32a()
	_, _ = digest.Write([]byte(strings.ToLower(login)))
	return int64(digest.Sum32() % 1000000)
}

// reviewComment is one line comment as pulls/{n}/comments lists it: line is
// null for a comment on the whole file or an outdated one, original_line
// keeps where it was written.
func reviewComment(id, review int64, user map[string]any, path string, line int, outdated bool, body, commit string, at time.Time) map[string]any {
	comment := map[string]any{"id": id, "pull_request_review_id": review, "user": user, "body": body, "path": path,
		"line": nil, "original_line": nil, "commit_id": commit, "original_commit_id": commit, "created_at": at, "updated_at": at}
	if line > 0 {
		comment["original_line"] = line
		if !outdated {
			comment["line"] = line
		}
	}
	return comment
}

// reviewListing is pulls/{n}/reviews (comments false) or pulls/{n}/comments
// (comments true) for the reviews of one pull request.
func (s *Server) reviewListing(reviews []PullReview, comments bool) []map[string]any {
	result := []map[string]any{}
	for _, review := range reviews {
		user := s.reviewUser(review.Login, review.Bot)
		if !comments {
			result = append(result, map[string]any{"id": review.ID, "user": user, "state": review.State, "body": review.Body,
				"commit_id": review.CommitID, "submitted_at": review.SubmittedAt})
			continue
		}
		if review.Path != "" {
			result = append(result, reviewComment(review.ID, review.ID, user, review.Path, review.Line, review.Outdated, review.Body, review.CommitID, review.SubmittedAt))
		}
		for _, line := range review.Comments {
			result = append(result, reviewComment(line.ID, review.ID, user, line.Path, line.Line, line.Outdated, line.Body, review.CommitID, review.SubmittedAt))
		}
	}
	return result
}
